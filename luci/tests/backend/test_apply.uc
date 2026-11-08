'use strict';

import * as fs from 'fs';
import * as A from 'mihomo.apply';
import * as U from 'mihomo.util';
import * as P from 'mihomo.paths';
import * as F from 'mihomo.forms';
import * as Y from 'mihomo.yaml';
import { ok, eq, done } from 'lib';

const ORIG = fs.readfile(P.CONFIG);

function wait_job(id) {
	for (let i = 0; i < 80; i++) {
		let s = A.job_status(id);
		if (s.state != 'running')
			return s;
		sleep(500);
	}
	return { state: 'timeout' };
}

function api(method, path, body) {
	return U.http(method, '127.0.0.1', 19090, path,
		{ secret: 'test-secret', body: body != null ? sprintf('%J', body) : null });
}

function pid() {
	return trim(fs.readfile(P.RUN_DIR + '/test.pid') ?? '');
}

function rev() {
	return A.config_read().rev;
}

// 校验
let v = A.validate_content(ORIG);
eq([v.ok, v.valid], [true, true], '合法配置校验通过');
v = A.validate_content('mode: rule\nfoo: [\n');
eq([v.ok, v.valid], [true, false], '语法错误校验不通过');
ok(index(v.error, 'yaml') >= 0, '返回 mihomo 的错误信息', v.error);
eq(length(filter(fs.lsdir(P.RUN_DIR) ?? [], (n) => match(n, /^validate-/))), 0, '校验后清理临时文件');
eq(A.validate_content('').ok, false, '空内容直接拒绝');

// 只查 YAML 语法（yq），返回出错行号
v = A.yaml_check(ORIG);
eq([v.ok, v.valid], [true, true], 'yaml_check 合法');
v = A.yaml_check('mode: rule\nproxies:\n  - a\n b: [\n');
ok(v.ok && v.valid === false && v.line >= 1 && index(v.error, 'Error') < 0, 'yaml_check 返回行号与精简错误', v);
eq(length(filter(fs.lsdir(P.RUN_DIR) ?? [], (n) => match(n, /^lint-/))), 0, 'yaml_check 清理临时文件');

eq(A.config_read().content, ORIG, 'config_read 返回内容');

// 启动测试实例
system(P.INIT + ' start');
sleep(2500);
eq(api('GET', '/version').status, 200, '测试实例已启动');
let pid0 = pid();

// rev 冲突
let r = A.begin('raw', { content: ORIG, rev: 'stale' });
eq(r, { ok: false, error: A.ERR_CONFLICT }, 'rev 不符时拒绝保存');
ok(!fs.stat(P.LOCK), '拒绝后释放锁');

// 校验失败
r = A.begin('raw', { content: 'mode: rule\nfoo: [\n', rev: rev() });
ok(r.ok && match(r.job, /^[0-9a-f]{16}$/), '发起保存返回任务编号', r);
let s = wait_job(r.job);
eq(s.state, 'failed', '非法配置任务失败');
ok(index(s.error, '校验失败') == 0, '失败原因为校验失败', s.error);
eq(fs.readfile(P.CONFIG), ORIG, '非法配置不改动原文件');
ok(!fs.stat(P.CANDIDATE), '删除候选文件');
eq(length(A.backups()), 0, '校验失败不产生备份');
ok(!fs.stat(P.LOCK), '任务结束释放锁');

// 只改 mode：在线生效
r = A.begin('raw', { content: replace(ORIG, 'mode: rule', 'mode: global'), rev: rev() });
s = wait_job(r.job);
eq([s.state, s.restarted], ['done', false], '只改 mode 不重启');
eq(pid(), pid0, '进程未变');
ok(index(api('GET', '/configs').body, '"mode":"global"') >= 0, '运行时模式已切换');
eq(length(A.backups()), 0, '在线修改不产生备份');

// patch mode.set（不带 rev）
r = A.begin('patch', { ops: [{ op: 'mode.set', mode: 'direct' }] });
s = wait_job(r.job);
eq(s.state, 'done', 'mode.set 完成');
ok(match(fs.readfile(P.CONFIG), /\nmode: direct\n/), 'mode.set 写回文件');
ok(index(api('GET', '/configs').body, '"mode":"direct"') >= 0, 'mode.set 在线生效');
eq(A.begin('patch', { ops: [{ op: 'mode.set', mode: 'x' }] }).ok, false, '非法操作在提交时拒绝');
ok(!fs.stat(P.LOCK), '提交被拒后释放锁');

// 控制器设置没变的修改：内核热重载（PUT /configs），进程不变
let cur = fs.readfile(P.CONFIG);
r = A.begin('raw', { content: replace(cur, 'mixed-port: 17890', 'mixed-port: 17891'), rev: rev() });
s = wait_job(r.job);
eq([s.state, s.restarted, s.reloaded], ['done', false, true], '改端口后热重载');
eq(pid(), pid0, '热重载不重启进程');
ok(index(api('GET', '/configs').body, '"mixed-port":17891') >= 0, '新端口已在线生效');
eq(length(A.backups()), 1, '生效前备份原配置');
eq(fs.readfile(P.BACKUP_DIR + '/' + A.backups()[0].name), cur, '备份内容为修改前的配置');
eq(fs.stat(P.CONFIG).mode & 0o777, 0o600, '配置文件权限 600');

// 启动失败自动回滚：控制器端口与 uhttpd 冲突，-t 能通过但服务起不来
let good = fs.readfile(P.CONFIG);
r = A.begin('raw', { content: replace(good, 'external-controller: 127.0.0.1:19090', 'external-controller: 127.0.0.1:80'), rev: rev() });
s = wait_job(r.job);
eq(s.state, 'rolled_back', '启动失败时回滚');
eq(fs.readfile(P.CONFIG), good, '回滚后内容与原配置一致');
eq(api('GET', '/version').status, 200, '回滚后服务恢复');

// 锁占用与残留锁
fs.mkdir(P.LOCK);
fs.writefile(P.LOCK + '/pid', fs.readlink('/proc/self'));
r = A.begin('raw', { content: good, rev: rev() });
eq(r, { ok: false, error: A.ERR_BUSY }, '锁被占用时拒绝');
A.lock_release();
fs.mkdir(P.LOCK);
fs.writefile(P.LOCK + '/pid', '999999');
ok(A.lock_acquire('x'), '清理进程已退出的残留锁');
A.lock_release();

// 备份：读取、恢复、保留数量、删除。最新的备份来自回滚用例（与当前内容相同），所以恢复最早的一份（改端口之前）
let b = A.backups();
eq(length(b), 2, '改端口与回滚各产生一份备份');
let oldest = b[length(b) - 1];
eq(A.backup_read('../config.yaml').ok, false, '拒绝非法备份名');
let want = A.backup_read(oldest.name).content;
ok(want != null && match(want, /mixed-port: 17890\n/), '读取备份');
r = A.begin('restore', { name: oldest.name });
s = wait_job(r.job);
eq([s.state, s.reloaded], ['done', true], '从备份恢复并热重载');
eq(fs.readfile(P.CONFIG), want, '恢复为备份内容');
for (let i = 0; i < 12; i++)
	U.write_file(sprintf('%s/config-20200101-0000%02d.yaml', P.BACKUP_DIR, i), good);
sleep(1100);
r = A.begin('raw', { content: replace(fs.readfile(P.CONFIG), 'mixed-port: 17890', 'mixed-port: 17880'), rev: rev() });
s = wait_job(r.job);
eq(s.state, 'done', '再次保存');
b = A.backups();
eq(length(b), 10, '只保留 10 份备份');
eq(length(filter(b, (x) => !match(x.name, /^config-2020/))), 4, '优先保留最新的备份');
eq(A.backup_delete(b[0].name).ok, true, '删除备份');
eq(length(A.backups()), 9, '删除后数量减一');
eq(A.backup_delete('../../x').ok, false, '删除时校验名称');
let n1 = A.backup_create(), n2 = A.backup_create();
ok(n1 && n2 && n1 != n2, '同一秒内的备份不会互相覆盖', [n1, n2]);
eq(A.backups()[0].name, n2, '后创建的备份排在最前');

eq(A.job_status('../../etc/passwd').ok, false, '拒绝非法任务编号');
eq(A.job_status('0000000000000000').ok, false, '不存在的任务');

// 订阅停用、启用、删除：post 动作只在任务成功后执行
const PDIR = P.HOME + '/proxy_provider';
U.mkdir_p(PDIR);
for (let n in ['F', 'H', 'G'])
	U.write_file(PDIR + '/' + n + '.yaml', sprintf('proxies:\n  - {name: %s1, type: socks5, server: 127.0.0.1, port: 1}\n', n));
let prov = replace(fs.readfile(P.CONFIG), 'proxy-groups:\n', 'proxy-providers:\n' +
	'  F:\n    type: file\n    path: ./proxy_provider/F.yaml\n' +
	'  H:\n    type: http\n    url: http://127.0.0.1:1/h\n    path: ./proxy_provider/H.yaml\n    interval: 86400\n' +
	'  G:\n    type: http\n    url: http://127.0.0.1:1/g\n    path: ./proxy_provider/G.yaml\n    interval: 86400\n' +
	'proxy-groups:\n  - name: 订阅组\n    type: select\n    use: [F, H]\n  - name: 只有G\n    type: select\n    use: [G]\n');
r = A.begin('raw', { content: prov, rev: rev() });
s = wait_job(r.job);
eq(s.state, 'done', '写入带订阅的配置');
function use_of(name) {
	let g = Y.query(P.CONFIG, '[.["proxy-groups"][] | {"key": .name, "value": .use}] | from_entries');
	return g ? g[name] : null;
}

r = A.begin('patch', { ops: [{ op: 'provider.toggle', name: 'F', enabled: false }], rev: rev() });
s = wait_job(r.job);
eq(s.state, 'done', '停用订阅');
ok(!match(fs.readfile(P.CONFIG), /\n  F:\n/), '停用后配置里没有该订阅');
eq(use_of('订阅组'), ['H'], '停用后从 use 列表移除');
eq(F.disabled_read().F?.def?.path, './proxy_provider/F.yaml', '停用列表保存完整定义');
ok(fs.stat(PDIR + '/F.yaml'), '停用不删除缓存文件');

r = A.begin('patch', { ops: [{ op: 'provider.toggle', name: 'F', enabled: true }], rev: rev() });
s = wait_job(r.job);
eq(s.state, 'done', '重新启用订阅');
ok(match(fs.readfile(P.CONFIG), /\n  F:\n/), '启用后写回配置');
eq(sort(use_of('订阅组')), ['F', 'H'], '启用后回到原来的 use 列表');
eq(F.disabled_read().F, null, '启用成功后从停用列表移除');

let before = fs.readfile(P.CONFIG);
r = A.begin('patch', { ops: [{ op: 'provider.delete', name: 'G' }], rev: rev() });
s = wait_job(r.job);
eq(s.state, 'failed', '删除后策略组为空：校验失败');
eq(fs.readfile(P.CONFIG), before, '失败时配置不变');
ok(fs.stat(PDIR + '/G.yaml'), '失败时不执行 post（缓存文件还在）');

r = A.begin('patch', { ops: [{ op: 'provider.delete', name: 'H' }], rev: rev() });
s = wait_job(r.job);
eq(s.state, 'done', '删除订阅');
ok(!match(fs.readfile(P.CONFIG), /\n  H:\n/), '删除后配置里没有该订阅');
ok(!fs.stat(PDIR + '/H.yaml'), '删除成功后清理缓存文件');
eq(use_of('订阅组'), ['F'], '删除后从 use 列表移除');

system(P.INIT + ' stop');
done();
