'use strict';

import * as fs from 'fs';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import * as Y from 'mihomo.yaml';
import * as S from 'mihomo.service';
import * as F from 'mihomo.forms';
import * as CORE from 'mihomo.core';
import * as SU from 'mihomo.setup';

const ERR_BUSY = '另一个保存正在进行，请稍后再试';
const ERR_CONFLICT = '配置已在别处修改，请刷新后重试';
const BACKUP_RE = /^config-[0-9]{8}-[0-9]{6}(-[0-9]+)?\.yaml$/;
const JOB_RE = /^[0-9a-f]{16}$/;
const JOB_KEEP = 20;

/* ---------- 读取与校验 ---------- */

function config_read() {
	let c = fs.readfile(P.CONFIG);
	if (c == null)
		return { ok: false, error: '配置文件不存在：' + P.CONFIG };
	return { ok: true, content: c, rev: U.file_rev(P.CONFIG) };
}

function first_error(out) {
	for (let line in split(out, '\n')) {
		let m = match(line, /level=(error|fatal) msg="(.*)"$/);
		if (m)
			return replace(m[2], /\\"/g, '"');
	}
	return U.tail_lines(out, 1);
}

// 校验用副本见 forms.validation_copy（避免 -t 启动的 tsnet 使用正式的 Tailscale 状态）；生成失败时直接校验原文件。
// bin 默认是当前内核；更新内核时用新内核校验当前配置
function validate_file(file, bin) {
	U.mkdir_p(P.RUN_DIR);
	let copy = P.RUN_DIR + '/check-' + U.rand_hex(4) + '.yaml';
	let target = F.validation_copy(file, copy) ? copy : file;
	let r = U.run(sprintf('%s -d %s -f %s -t', U.shq(bin ?? P.BIN), U.shq(P.HOME), U.shq(target)));
	fs.unlink(copy);
	U.rm_tree(P.HOME + '/' + F.TS_CHECK_DIR);
	let passed = r.code == 0 && index(r.out, 'test is successful') >= 0;
	return { ok: passed, error: passed ? null : first_error(r.out), detail: U.tail_lines(r.out, 40) };
}

function validate_content(content) {
	if (type(content) != 'string' || trim(content) == '')
		return { ok: false, error: '配置内容为空' };
	U.mkdir_p(P.RUN_DIR);
	let tmp = P.RUN_DIR + '/validate-' + U.rand_hex(4) + '.yaml';
	if (!U.write_file(tmp, content))
		return { ok: false, error: '无法写入临时文件' };
	let v = validate_file(tmp);
	fs.unlink(tmp);
	return { ok: true, valid: v.ok, error: v.error, detail: v.detail };
}

function yaml_check(content) {
	if (type(content) != 'string')
		return { ok: false, error: '配置内容为空' };
	if (length(content) > 4 * 1024 * 1024)
		return { ok: false, error: '配置太大' };
	U.mkdir_p(P.RUN_DIR);
	let tmp = P.RUN_DIR + '/lint-' + U.rand_hex(4) + '.yaml';
	if (!U.write_file(tmp, content))
		return { ok: false, error: '无法写入临时文件' };
	let r = Y.syntax(tmp);
	fs.unlink(tmp);
	if (r == null)
		return { ok: false, error: '没有安装 yq，无法检查语法' };
	return { ok: true, ...r };
}

/* ---------- 锁 ---------- */

function pid_alive(pid) {
	return pid > 0 && fs.stat('/proc/' + pid) != null;
}

function lock_release() {
	fs.unlink(P.LOCK + '/owner');
	fs.unlink(P.LOCK + '/pid');
	fs.rmdir(P.LOCK);
}

// mkdir 是原子操作；锁目录里记录任务进程 pid，进程已退出（崩溃、rpcd 重启）时视为残留锁
function lock_acquire(owner) {
	U.mkdir_p(P.RUN_DIR);
	for (let attempt = 0; attempt < 2; attempt++) {
		if (fs.mkdir(P.LOCK, 0o700)) {
			fs.writefile(P.LOCK + '/owner', owner);
			return true;
		}
		let pid = int(trim(fs.readfile(P.LOCK + '/pid') ?? '') || '0');
		let st = fs.stat(P.LOCK);
		let stale = pid ? !pid_alive(pid) : (st != null && time() - st.mtime > 60);
		if (!stale)
			return false;
		lock_release();
	}
	return false;
}

/* ---------- 备份 ---------- */

function backups() {
	let list = [];
	for (let name in (fs.lsdir(P.BACKUP_DIR) ?? [])) {
		if (!match(name, BACKUP_RE))
			continue;
		let st = fs.stat(P.BACKUP_DIR + '/' + name);
		push(list, { name: name, time: st?.mtime, size: st?.size });
	}
	// 名称即时间戳；同一秒内的备份带 -N 后缀，去掉扩展名再比较，后缀才会排在前面（更新）
	let key = (x) => substr(x.name, 0, length(x.name) - 5);
	return sort(list, (a, b) => (key(a) < key(b)) ? 1 : ((key(a) > key(b)) ? -1 : 0));
}

function stamp() {
	let t = localtime();
	return sprintf('%04d%02d%02d-%02d%02d%02d', t.year, t.mon, t.mday, t.hour, t.min, t.sec);
}

function backup_create() {
	let cur = fs.readfile(P.CONFIG);
	if (cur == null)
		return null;
	U.mkdir_p(P.BACKUP_DIR);
	let base = 'config-' + stamp();
	let name = base + '.yaml';
	for (let i = 1; fs.stat(P.BACKUP_DIR + '/' + name); i++)
		name = base + '-' + i + '.yaml';
	return U.write_file(P.BACKUP_DIR + '/' + name, cur) ? name : null;
}

function backup_prune() {
	let list = backups();
	for (let i = P.BACKUP_KEEP; i < length(list); i++)
		fs.unlink(P.BACKUP_DIR + '/' + list[i].name);
}

function backup_read(name) {
	if (type(name) != 'string' || !match(name, BACKUP_RE))
		return { ok: false, error: '备份名称无效' };
	let c = fs.readfile(P.BACKUP_DIR + '/' + name);
	return (c == null) ? { ok: false, error: '备份不存在' } : { ok: true, content: c };
}

function backup_delete(name) {
	if (type(name) != 'string' || !match(name, BACKUP_RE))
		return { ok: false, error: '备份名称无效' };
	return fs.unlink(P.BACKUP_DIR + '/' + name) ? { ok: true } : { ok: false, error: '删除失败：' + fs.error() };
}

/* ---------- 任务状态 ---------- */

function job_path(id) {
	return P.JOB_DIR + '/' + id + '.json';
}

function job_write(id, obj) {
	U.mkdir_p(P.JOB_DIR);
	U.write_json(job_path(id), obj);
}

function job_update(id, fields) {
	let j = U.read_json(job_path(id)) ?? {};
	for (let k, v in fields)
		j[k] = v;
	job_write(id, j);
	return j;
}

function job_prune() {
	let list = [];
	for (let n in (fs.lsdir(P.JOB_DIR) ?? []))
		push(list, { n: n, t: fs.stat(P.JOB_DIR + '/' + n)?.mtime ?? 0 });
	list = sort(list, (a, b) => b.t - a.t);
	for (let i = JOB_KEEP; i < length(list); i++)
		fs.unlink(P.JOB_DIR + '/' + list[i].n);
}

function job_status(id) {
	if (type(id) != 'string' || !match(id, JOB_RE))
		return { ok: false, error: '任务编号无效' };
	let j = U.read_json(job_path(id));
	if (!j)
		return { ok: false, error: '任务不存在' };
	if (j.state == 'running' && j.pid && !pid_alive(j.pid))
		j = job_update(id, { state: 'failed', step: 'done', error: '后台任务意外中断' });
	// opts 里可能有订阅地址等参数，只供任务进程使用
	delete j.opts;
	return { ok: true, ...j };
}

/* ---------- 发起保存 ---------- */

// 生成候选文件 config.yaml.new；返回 { error } 或 { post }（任务成功后执行的动作）
function prepare(kind, args) {
	let err = (e) => ({ error: e });
	if (kind == 'raw') {
		if (type(args.content) != 'string' || trim(args.content) == '')
			return err('配置内容为空');
		if ((args.rev ?? '') != U.file_rev(P.CONFIG))
			return err(ERR_CONFLICT);
		return U.write_file(P.CANDIDATE, args.content) ? {} : err('无法写入候选配置');
	}
	if (kind == 'patch') {
		if (args.rev && args.rev != U.file_rev(P.CONFIG))
			return err(ERR_CONFLICT);
		let cur = fs.readfile(P.CONFIG);
		if (cur == null)
			return err('配置文件不存在');
		if (!U.write_file(P.CANDIDATE, cur))
			return err('无法写入候选配置');
		return F.apply_ops(P.CANDIDATE, args.ops);
	}
	if (kind == 'restore') {
		let b = backup_read(args.name);
		if (!b.ok)
			return err(b.error);
		return U.write_file(P.CANDIDATE, b.content) ? {} : err('无法写入候选配置');
	}
	// 向导：已有配置时同样要求 rev 一致（替换前照常备份）
	if (kind == 'setup') {
		if (fs.stat(P.CONFIG) && (args.rev ?? '') != U.file_rev(P.CONFIG))
			return err(ERR_CONFLICT);
		return SU.prepare(args);
	}
	// 内核任务不写候选文件
	if (kind == 'core')
		return { opts: { force: !!args.force } };
	if (kind == 'core_rollback')
		return {};
	return err('未知的保存类型');
}

function begin(kind, args) {
	let id = U.rand_hex(8);
	if (!lock_acquire(id))
		return { ok: false, error: ERR_BUSY };
	// 首次安装时可能还没有配置目录，模板、文件和 URL 导入都需先创建它。
	if (index(['raw', 'patch', 'restore', 'setup'], kind) >= 0 && !U.mkdir_p(P.HOME)) {
		lock_release();
		return { ok: false, error: '无法创建配置目录：' + P.HOME };
	}
	let r = prepare(kind, args ?? {});
	if (r.error) {
		fs.unlink(P.CANDIDATE);
		lock_release();
		return { ok: false, error: r.error };
	}
	job_prune();
	let job = { state: 'running', step: 'queued', kind: kind, started: time() };
	if (type(r.post) == 'array' && length(r.post))
		job.post = r.post;
	if (r.opts)
		job.opts = r.opts;
	job_write(id, job);
	let rc = system(sprintf('setsid %s %s </dev/null >/dev/null 2>&1 &', U.shq(P.JOB_BIN), id));
	if (rc != 0) {
		fs.unlink(P.CANDIDATE);
		lock_release();
		job_update(id, { state: 'failed', step: 'done', error: '无法启动保存任务' });
		return { ok: false, error: '无法启动保存任务' };
	}
	return { ok: true, job: id };
}

/* ---------- 后台任务（apply-job 进程内执行） ---------- */

function replace_config() {
	return fs.chmod(P.CANDIDATE, 0o600) && fs.rename(P.CANDIDATE, P.CONFIG);
}

// 等待服务按新配置启动：控制器 /version 返回 200 且进程已更换；没有控制器时只看进程是否存活
function wait_ready(ctl, old_pid) {
	let start = time();
	while (time() - start < P.START_TIMEOUT) {
		sleep(1000);
		if (old_pid && S.instance()?.pid == old_pid)
			continue;
		if (!ctl?.addr) {
			if (time() - start >= 3)
				return S.running();
			continue;
		}
		let r = U.http('GET', Y.local_host(ctl.addr), ctl.addr.port, '/version', { secret: ctl.secret, timeout: 1000 });
		if (r.status == 200 && index(r.body, '"version"') >= 0)
			return true;
	}
	return false;
}

function restart_and_wait() {
	let old_pid = S.instance()?.pid;
	U.run(U.shq(P.INIT) + ' restart');
	return wait_ready(Y.controller_of(P.CONFIG), old_pid);
}

function patch_runtime(delta) {
	let ctl = Y.controller_of(P.CONFIG);
	if (!ctl?.addr)
		return false;
	let r = U.http('PATCH', Y.local_host(ctl.addr), ctl.addr.port, '/configs', { secret: ctl.secret, body: sprintf('%J', delta) });
	return r.status == 204 || r.status == 200;
}

// 让运行中的内核重新读取配置文件（PUT /configs?force=true），不重启进程；节点、规则、DNS、入站（含 eBPF）都会重建。
// 之后等控制器恢复响应，配置里有 eBPF 入站时还要等它重新挂好（/ebpf/summary 列出入站）。
function reload_runtime() {
	let ctl = Y.controller_of(P.CONFIG);
	if (!ctl?.addr)
		return false;
	let host = Y.local_host(ctl.addr), port = ctl.addr.port;
	let r = U.http('PUT', host, port, '/configs?force=true', { secret: ctl.secret, body: '{}', timeout: 60000 });
	if (r.status != 204 && r.status != 200)
		return false;
	let want_ebpf = (Y.ebpf_count(P.CONFIG) ?? 0) > 0;
	let start = time();
	while (time() - start < P.START_TIMEOUT) {
		if (!S.running())
			return false;
		let v = U.http('GET', host, port, '/version', { secret: ctl.secret, timeout: 1000 });
		if (v.status == 200) {
			if (!want_ebpf)
				return true;
			let e = U.http('GET', host, port, '/ebpf/summary', { secret: ctl.secret, timeout: 2000 });
			// 旧内核没有 summary 接口：控制器正常就算完成
			if (e.status == 404 || (e.status == 200 && match(e.body, /"inbounds"[[:space:]]*:[[:space:]]*\[[[:space:]]*\{/)))
				return true;
		}
		sleep(1000);
	}
	return false;
}

function service_log() {
	return U.tail_lines(U.run('logread -e ' + U.shq(P.LOG_TAG)).out, 50);
}

// 各类任务共用的回调：记录步骤、结束任务、校验、重启并等待、取服务日志
function job_ctx(id) {
	return {
		step: (s) => job_update(id, { step: s }),
		finish: (state, extra) => job_update(id, { state: state, step: 'done', finished: time(), ...(extra ?? {}) }),
		validate: (bin) => validate_file(P.CONFIG, bin),
		restart: restart_and_wait,
		log: service_log
	};
}

// 配置类任务（raw、patch、restore、setup）：校验 → 备份 → 替换 → 重启 → 失败回滚。
// opts.start 为真时（向导）：服务未运行也启用开机自启并启动；opts.adapted 原样写入结果
function config_body(ctx, opts) {
	let step = ctx.step, finish = ctx.finish;
	let start = !!opts?.start;
	let extra = type(opts?.adapted) == 'array' ? { adapted: opts.adapted } : {};

	step('validate');
	let v = validate_file(P.CANDIDATE);
	if (!v.ok) {
		fs.unlink(P.CANDIDATE);
		return finish('failed', { ...extra, error: '校验失败：' + v.error, detail: v.detail });
	}

	let was_running = S.running();
	let delta = (!start && fs.stat(P.CONFIG)) ? Y.runtime_delta(P.CONFIG, P.CANDIDATE) : null;

	if (delta != null) {
		// 只改了 mode、log-level 或注释：直接替换并在线生效，不重启、不备份
		step('replace');
		if (!replace_config())
			return finish('failed', { error: '替换配置文件失败' });
		if (was_running && length(delta)) {
			step('runtime');
			if (!patch_runtime(delta))
				return finish('done', { restarted: false, note: '配置已保存，但在线生效失败，重启服务后生效' });
		}
		return finish('done', { restarted: false });
	}

	step('backup');
	let backup = backup_create();
	step('replace');
	if (!replace_config())
		return finish('failed', { ...extra, error: '替换配置文件失败' });
	backup_prune();
	if (!was_running && !start)
		return finish('done', { ...extra, restarted: false, backup: backup, note: '服务未运行，新配置将在下次启动时生效' });

	// 控制器设置没变时先让内核热重载，不重启进程；不成功再走下面的重启（失败时回滚备份）
	if (was_running && !start && backup && Y.hub_same(P.BACKUP_DIR + '/' + backup, P.CONFIG)) {
		step('reload');
		if (reload_runtime())
			return finish('done', { ...extra, restarted: false, reloaded: true, backup: backup });
	}
	if (start)
		U.run(U.shq(P.INIT) + ' enable');
	step(was_running ? 'restart' : 'start');
	if (restart_and_wait())
		return finish('done', { ...extra, restarted: was_running, launched: !was_running, backup: backup });

	step('rollback');
	let log = service_log();
	if (!backup) {
		if (!was_running)
			U.run(U.shq(P.INIT) + ' stop');
		return finish('failed', { ...extra, detail: log,
			error: was_running ? '新配置启动失败，且没有可恢复的备份' : '服务没有成功启动，新配置已保存，请查看日志并在配置文件页修改' });
	}
	let saved = fs.readfile(P.BACKUP_DIR + '/' + backup);
	// 读不到备份时不能把空内容写回去；保留新配置并停在失败状态，交给用户处理
	if (saved == null || !U.write_file(P.CONFIG, saved)) {
		if (!was_running)
			U.run(U.shq(P.INIT) + ' stop');
		return finish('failed', { ...extra, detail: log, backup: backup,
			error: '新配置启动失败，恢复备份 ' + backup + ' 也失败了，请在「配置文件」页的备份里手动恢复' });
	}
	if (!was_running) {
		U.run(U.shq(P.INIT) + ' stop');
		return finish('rolled_back', { ...extra, error: '新配置启动失败，已恢复为原配置', detail: log, backup: backup });
	}
	let back = restart_and_wait();
	return finish('rolled_back', { ...extra,
		error: '新配置启动失败，已恢复为原配置' + (back ? '' : '（恢复后服务仍未就绪，请查看日志）'),
		detail: log, backup: backup
	});
}

function job_body(id) {
	let j = U.read_json(job_path(id)) ?? {};
	let ctx = job_ctx(id);
	if (j.kind == 'core')
		return CORE.job_update(ctx, j.opts);
	if (j.kind == 'core_rollback')
		return CORE.job_rollback(ctx);
	if (j.kind == 'setup') {
		// 下载与补全在配置流程之前；失败时不留候选文件
		let pre = SU.job_pre(ctx, j.opts);
		if (pre.error) {
			fs.unlink(P.CANDIDATE);
			return ctx.finish('failed', { error: pre.error });
		}
		return config_body(ctx, { start: j.opts?.start, adapted: pre.adapted });
	}
	return config_body(ctx, j.opts);
}

function run_job(id) {
	if (type(id) != 'string' || !match(id, JOB_RE))
		return;
	let pid = fs.readlink('/proc/self');
	fs.writefile(P.LOCK + '/pid', pid);
	job_update(id, { pid: +pid });
	try {
		let j = job_body(id);
		// 删除订阅缓存、更新停用列表等动作只在新配置生效后执行
		if (j?.state == 'done' && j.post)
			F.run_post(j.post);
	} catch (e) {
		job_update(id, { state: 'failed', step: 'done', finished: time(), error: '后台任务出错：' + e.message });
	}
	lock_release();
}

export { ERR_BUSY, ERR_CONFLICT, config_read, validate_file, validate_content, yaml_check, lock_acquire, lock_release,
	backups, backup_create, backup_read, backup_delete, job_status, begin, run_job, restart_and_wait };
