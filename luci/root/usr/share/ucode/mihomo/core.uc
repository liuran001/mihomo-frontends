'use strict';

// 内核（mihomo-ebpf 二进制）的安装、检查更新、更新与回滚。
// 下载线路：服务运行时先经它的 mixed-port 走代理，再走镜像前缀（为空时直连）；一律用 checksums.txt 校验 sha256。
import * as fs from 'fs';
import * as uci from 'uci';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import * as Y from 'mihomo.yaml';
import * as S from 'mihomo.service';

const DEFAULTS = { repo: 'liuran001/mihomo', tag: 'Prerelease-Alpha', mirror: 'https://ghfast.top/' };
const VERSION_RE = regexp('^[A-Za-z0-9._-]{1,64}$');
const REPO_RE = regexp('^[A-Za-z0-9_.-]{1,64}/[A-Za-z0-9_.-]{1,100}$');
const TAG_RE = regexp('^[A-Za-z0-9._-]{1,64}$');
const MIRROR_RE = regexp('^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%/+=-]*)?$');
const SUM_RE = regexp('^([0-9A-Fa-f]{64})[ \t]+[*]?([^ \t]+)[ \t]*$');
// 剩余空间低于这个值时不保留旧版内核
const KEEP_MIN_FREE = 4 * 1024 * 1024;

/* ---------- 纯函数 ---------- */

// machine：uname -m；cpuinfo：/proc/cpuinfo 的内容。返回发布文件名中的平台部分，不支持时返回 null
function asset_for(machine, cpuinfo) {
	if (machine == 'aarch64' || machine == 'arm64')
		return 'linux-arm64';
	if (machine != 'x86_64' && machine != 'amd64')
		return null;
	let m = match(cpuinfo ?? '', /flags[ \t]*:([^\n]*)/);
	let flags = {};
	for (let f in split(trim(m ? m[1] : ''), /[ \t]+/))
		flags[f] = true;
	if (flags.avx2 && flags.bmi2 && flags.fma)
		return 'linux-amd64-v3';
	if (flags.sse4_2 && flags.popcnt)
		return 'linux-amd64-v2';
	return 'linux-amd64-v1';
}

function valid_version(v) {
	return type(v) == 'string' && match(v, VERSION_RE) != null;
}

// sha256sum 格式：<64 位十六进制>  [*]<文件名>；兼容 ./ 前缀，规范化后同名取第一条
function parse_checksums(text) {
	let res = {};
	for (let line in split(text ?? '', '\n')) {
		let m = match(trim(line), SUM_RE);
		if (!m)
			continue;
		let name = replace(m[2], /^(\.\/)+/, '');
		if (res[name] == null)
			res[name] = lc(m[1]);
	}
	return res;
}

function release_url(s, file, base) {
	if (base)
		return base + file;
	return sprintf('https://github.com/%s/releases/download/%s/%s', s.repo, s.tag, file);
}

// 按顺序尝试的下载线路；镜像与直连显式忽略环境里的 http_proxy 等变量，线路名称与实际走向一致
function routes(s, proxy_port) {
	let list = [];
	if (proxy_port)
		push(list, { name: 'proxy', label: '本机代理', prefix: '', args: ['-x', 'http://127.0.0.1:' + proxy_port] });
	if (s.mirror)
		push(list, { name: 'mirror', label: '镜像', prefix: s.mirror, args: ['--noproxy', '*'] });
	else
		push(list, { name: 'direct', label: '直连', prefix: '', args: ['--noproxy', '*'] });
	return list;
}

// -v 的输出：Mihomo Meta <版本> <系统> <架构> ...
function parse_version(out) {
	let m = match(out ?? '', /Mihomo Meta ([^ \n]+)/);
	return m ? m[1] : null;
}

/* ---------- 设置（UCI mihomo.core） ---------- */

function cursor() {
	return uci.cursor(P.UCI_DIR);
}

// 没有 core 节时全部用默认值；有 core 节时缺少 mirror 表示不用镜像（直连）
function settings() {
	let c = cursor();
	let sec = c.get_all(P.UCI_CONF, 'core');
	if (type(sec) != 'object')
		return { ...DEFAULTS };
	return {
		repo: (type(sec.repo) == 'string' && match(sec.repo, REPO_RE)) ? sec.repo : DEFAULTS.repo,
		tag: (type(sec.tag) == 'string' && match(sec.tag, TAG_RE)) ? sec.tag : DEFAULTS.tag,
		mirror: (type(sec.mirror) == 'string' && match(sec.mirror, MIRROR_RE)) ? sec.mirror : ''
	};
}

function norm_mirror(m) {
	m = trim(m ?? '');
	if (m == '')
		return '';
	if (!match(m, MIRROR_RE))
		return null;
	return (substr(m, -1) == '/') ? m : m + '/';
}

function settings_set(a) {
	let repo = trim(a?.repo ?? ''), tag = trim(a?.tag ?? ''), mirror = norm_mirror(a?.mirror);
	if (!match(repo, REPO_RE))
		return { ok: false, error: '仓库应写成 用户名/仓库名' };
	if (!match(tag, TAG_RE))
		return { ok: false, error: '发布标签只能包含字母、数字、点、下划线与连字符' };
	if (mirror == null)
		return { ok: false, error: '镜像前缀应以 http:// 或 https:// 开头，且不含空格' };
	let path = P.UCI_DIR + '/' + P.UCI_CONF;
	if (!fs.stat(path) && fs.writefile(path, '') == null)
		return { ok: false, error: '无法创建 ' + path };
	let c = cursor();
	if (c.get(P.UCI_CONF, 'core') == null)
		c.set(P.UCI_CONF, 'core', 'core');
	c.set(P.UCI_CONF, 'core', 'repo', repo);
	c.set(P.UCI_CONF, 'core', 'tag', tag);
	if (mirror == '')
		c.delete(P.UCI_CONF, 'core', 'mirror');
	else
		c.set(P.UCI_CONF, 'core', 'mirror', mirror);
	if (!c.commit(P.UCI_CONF))
		return { ok: false, error: '保存设置失败' };
	return { ok: true };
}

/* ---------- 环境 ---------- */

function machine() {
	return trim(U.run('uname -m', { stderr: false }).out);
}

function asset() {
	return asset_for(machine(), fs.readfile('/proc/cpuinfo'));
}

function version_of(path) {
	return fs.access(path, 'x') ? parse_version(U.run(U.shq(path) + ' -v').out) : null;
}

// dir 所在文件系统的剩余空间（KB）
function free_kb(dir) {
	let lines = split(trim(U.run('df -Pk ' + U.shq(dir), { stderr: false }).out), '\n');
	let f = split(trim(lines[length(lines) - 1] ?? ''), /[ \t]+/);
	return (length(f) >= 4 && match(f[3], /^[0-9]+$/)) ? +f[3] : null;
}

// 服务在运行时，经它的 mixed-port（没有时用 port）下载
function proxy_port() {
	if (!S.running())
		return null;
	let p = Y.query(P.CONFIG, '.["mixed-port"] // .port // 0');
	return (type(p) == 'int' && p > 0 && p < 65536) ? p : null;
}

function sha256(path) {
	let m = match(U.run('sha256sum ' + U.shq(path), { stderr: false }).out, /^([0-9a-f]{64})/);
	return m ? m[1] : null;
}

/* ---------- 下载 ---------- */

// curl 的错误只保留退出码与不含地址的说明
function curl_error(r) {
	let msg = trim(replace(U.tail_lines(r.out, 1), /^curl: /, ''));
	msg = replace(msg, /[a-z]+:\/\/[^ ]*/g, '…');
	msg = replace(msg, /host: [^ ]+/g, 'host');
	msg = replace(msg, /to [^ ]+ port [0-9]+/g, 'to … port …');
	return msg != '' ? msg : '退出码 ' + r.code;
}

// 依次尝试各条线路下载 url 到 out；opts.routes 指定线路（默认按当前设置计算），opts.args 是附加的 curl 参数（如 User-Agent）。
// 超时：opts.big 用于内核文件；opts.quick 用于同步 rpc 里的小文件（两条线路合计不超过约 16 秒，低于 LuCI 的 rpc 超时）
function fetch(url, out, opts) {
	opts ??= {};
	let list = opts.routes ?? routes(settings(), proxy_port());
	let extra = join(' ', map(opts.args ?? [], U.shq));
	// max_time：在 RPC 里同步下载时限制每条线路的总时长，避免超过 LuCI 的调用超时
	let timing = opts.big ? '--connect-timeout 10 --max-time 600 --retry 1'
		: opts.quick ? '--connect-timeout 5 --max-time 8'
		: opts.max_time ? sprintf('--connect-timeout 5 --max-time %d', opts.max_time) : '--connect-timeout 10 --max-time 30 --retry 1';
	let errs = [];
	for (let r in list) {
		fs.unlink(out);
		let cmd = sprintf('%s -fsSL %s %s %s -o %s %s',
			U.shq(P.CURL), timing, join(' ', map(r.args, U.shq)), extra, U.shq(out), U.shq(r.prefix + url));
		let res = U.run(cmd);
		if (res.code == 0 && fs.stat(out)?.type == 'file')
			return { ok: true, route: r.name, label: r.label };
		push(errs, r.label + '：' + curl_error(res));
	}
	fs.unlink(out);
	return { ok: false, error: join('；', errs) };
}

/* ---------- 只读信息与检查更新 ---------- */

function info() {
	let installed = fs.access(P.BIN, 'x') == true;
	return {
		ok: true,
		arch: machine(),
		asset: asset(),
		installed: installed,
		version: installed ? S.version() : null,
		prev_version: version_of(P.BIN_PREV),
		latest: U.read_json(P.CORE_LATEST),
		settings: settings(),
		free_kb: free_kb(fs.dirname(P.BIN)),
		running: S.running()
	};
}

// 取远端 version.txt；成功时写入缓存
function latest_version(work, s) {
	let file = work + '/version.txt';
	let r = fetch(release_url(s, 'version.txt', P.RELEASE_BASE), file, { quick: true });
	if (!r.ok)
		return { ok: false, error: '获取最新版本失败：' + r.error };
	let v = trim(fs.readfile(file) ?? '');
	fs.unlink(file);
	if (!valid_version(v))
		return { ok: false, error: '远端版本号格式不正确' };
	U.write_json(P.CORE_LATEST, { version: v, checked: time(), route: r.route });
	return { ok: true, version: v, route: r.route, label: r.label };
}

function check() {
	U.mkdir_p(P.RUN_DIR);
	let l = latest_version(P.RUN_DIR, settings());
	if (!l.ok)
		return l;
	let cur = fs.access(P.BIN, 'x') ? S.version() : null;
	return { ok: true, latest: l.version, current: cur, update_available: cur != l.version, route: l.label };
}

/* ---------- 任务体（在 apply-job 进程内、持有锁时执行） ---------- */

// ctx：{ step(name), finish(state, extra), validate(bin) -> {ok,error,detail}, restart() -> bool, log() -> text }
function update_in(ctx, work, args) {
	let step = ctx.step, finish = ctx.finish;
	let s = settings();
	let plat = asset();
	if (!plat)
		return finish('failed', { error: '该架构没有 eBPF 构建：' + machine() });

	step('check');
	let l = latest_version(work, s);
	if (!l.ok)
		return finish('failed', { error: l.error });
	let ver = l.version;
	let installed = fs.access(P.BIN, 'x') == true;
	if (installed && S.version() == ver && !args?.force)
		return finish('done', { version: ver, route: l.label, note: '已是最新版本' });

	step('download');
	let name = sprintf('mihomo-%s-%s.gz', plat, ver);
	let r = fetch(release_url(s, 'checksums.txt', P.RELEASE_BASE), work + '/checksums.txt');
	if (!r.ok)
		return finish('failed', { error: '获取校验文件失败：' + r.error });
	let want = parse_checksums(fs.readfile(work + '/checksums.txt'))[name];
	if (!want)
		return finish('failed', { error: '校验文件中没有 ' + name });
	let gz = work + '/core.gz';
	r = fetch(release_url(s, name, P.RELEASE_BASE), gz, { big: true });
	if (!r.ok)
		return finish('failed', { error: '下载内核失败：' + r.error });

	step('verify');
	if (sha256(gz) != want)
		return finish('failed', { error: 'sha256 校验失败，下载的文件不完整或已被篡改' });

	step('unpack');
	let bin = work + '/core-new';
	if (U.run(sprintf('gzip -dc %s > %s', U.shq(gz), U.shq(bin))).code != 0 || !(fs.stat(bin)?.size > 0))
		return finish('failed', { error: '解压失败' });
	fs.unlink(gz);
	fs.chmod(bin, 0o755);

	step('selftest');
	let out = U.run(U.shq(bin) + ' -v').out;
	if (parse_version(out) != ver)
		return finish('failed', { error: '新内核无法在本机运行，或版本与发布信息不符', detail: U.tail_lines(out, 5) });

	if (installed && fs.stat(P.CONFIG)) {
		step('validate');
		let v = ctx.validate(bin);
		if (!v.ok)
			return finish('failed', { error: '新内核不接受当前配置：' + v.error, detail: v.detail });
	}

	step('replace');
	let dir = fs.dirname(P.BIN);
	U.mkdir_p(dir);
	let size = fs.stat(bin).size;
	let free = (free_kb(dir) ?? 0) * 1024;
	if (free < size + 1024 * 1024 && fs.stat(P.BIN_PREV)) {
		fs.unlink(P.BIN_PREV);
		free = (free_kb(dir) ?? 0) * 1024;
	}
	if (free < size + 1024 * 1024)
		return finish('failed', { error: sprintf('%s 空间不足：需要约 %d MB', dir, size / 1048576 + 1) });
	let tmp = P.BIN + '.new';
	if (U.run(sprintf('cp %s %s', U.shq(bin), U.shq(tmp))).code != 0 || fs.stat(tmp)?.size != size) {
		fs.unlink(tmp);
		return finish('failed', { error: '复制新内核失败' });
	}
	fs.chmod(tmp, 0o755);
	let keep = installed && free - size >= KEEP_MIN_FREE;
	let was_running = S.running();
	if (keep)
		fs.rename(P.BIN, P.BIN_PREV);
	if (!fs.rename(tmp, P.BIN)) {
		fs.unlink(tmp);
		if (keep)
			fs.rename(P.BIN_PREV, P.BIN);
		return finish('failed', { error: '替换内核失败' });
	}

	let res = { version: ver, route: l.label, restarted: false, kept_prev: keep };
	if (!installed)
		res.note = '内核已安装';
	else if (!keep)
		res.note = '剩余空间不足，未保留旧版本';
	if (!was_running)
		return finish('done', res);

	step('restart');
	if (ctx.restart())
		return finish('done', { ...res, restarted: true });

	step('rollback');
	let log = ctx.log();
	if (!keep)
		return finish('failed', { error: '新内核启动失败，且没有保留旧版本，请查看日志', detail: log });
	fs.rename(P.BIN_PREV, P.BIN);
	let back = ctx.restart();
	return finish('rolled_back', {
		error: '新内核启动失败，已恢复旧版本' + (back ? '' : '（恢复后服务仍未就绪，请查看日志）'), detail: log
	});
}

function job_update(ctx, args) {
	U.mkdir_p(P.RUN_DIR);
	let work = P.RUN_DIR + '/core-' + U.rand_hex(4);
	U.mkdir_p(work);
	let res;
	try {
		res = update_in(ctx, work, args);
	} catch (e) {
		res = ctx.finish('failed', { error: '内核更新出错：' + e.message });
	}
	U.rm_tree(work);
	return res;
}

// 交换当前内核与 .prev，交换后仍可再换回
function swap() {
	let tmp = P.BIN + '.swap';
	return fs.rename(P.BIN, tmp) && fs.rename(P.BIN_PREV, P.BIN) && fs.rename(tmp, P.BIN_PREV);
}

function job_rollback(ctx) {
	let step = ctx.step, finish = ctx.finish;
	if (!fs.access(P.BIN_PREV, 'x'))
		return finish('failed', { error: '没有可回滚的旧版本' });
	if (!fs.access(P.BIN, 'x'))
		return finish('failed', { error: '当前没有安装内核' });
	let was_running = S.running();
	step('replace');
	if (!swap())
		return finish('failed', { error: '交换内核文件失败' });
	if (was_running) {
		step('restart');
		if (!ctx.restart()) {
			let log = ctx.log();
			swap();
			ctx.restart();
			return finish('failed', { error: '旧版本启动失败，已换回当前版本', detail: log });
		}
	}
	return finish('done', { version: S.version(), restarted: was_running });
}

export { DEFAULTS, asset_for, valid_version, parse_checksums, release_url, routes, parse_version, norm_mirror, settings, settings_set,
	asset, proxy_port,
	fetch, info, check, job_update, job_rollback };
