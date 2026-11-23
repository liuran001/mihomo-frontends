'use strict';

import * as fs from 'fs';
import * as C from 'mihomo.core';
import * as A from 'mihomo.apply';
import * as U from 'mihomo.util';
import * as P from 'mihomo.paths';
import { ok, eq, done } from 'lib';

// main.sh 为本测试把 BIN 指到 /tmp/mlt 下，绝不能碰正式的内核
if (substr(P.BIN, 0, 9) != '/tmp/mlt/') {
	print('BIN 不在测试目录（', P.BIN, '），拒绝运行\n');
	exit(1);
}

/* ---------- 纯函数 ---------- */

eq(C.asset_for('aarch64', ''), 'linux-arm64', 'aarch64');
eq(C.asset_for('loongarch64', ''), 'linux-loong64-abi2', 'loongarch64 用 ABI2');
let flags = (f) => 'processor\t: 0\nflags\t\t: fpu ' + f + ' ht\n';
eq(C.asset_for('x86_64', flags('sse4_2 popcnt avx2 bmi2 fma')), 'linux-amd64-v3', 'x86_64 支持 avx2/bmi2/fma 用 v3');
eq(C.asset_for('x86_64', flags('sse4_2 popcnt')), 'linux-amd64-v2', 'x86_64 支持 sse4_2/popcnt 用 v2');
eq(C.asset_for('x86_64', flags('sse2')), 'linux-amd64-v1', '其他 x86_64 用 v1');
eq(C.asset_for('x86_64', ''), 'linux-amd64-v1', '读不到 cpuinfo 时用 v1');
eq(C.asset_for('mips', ''), null, '不支持的架构');

ok(C.valid_version('alpha-smart-e272b9d-ebpf'), '合法版本号');
ok(!C.valid_version('a b') && !C.valid_version('../x') && !C.valid_version('') && !C.valid_version(null), '非法版本号');
ok(!C.valid_version(sprintf('%065d', 1)), '版本号过长');

let sums = C.parse_checksums(
	'AB' + sprintf('%062d', 0) + '  mihomo-linux-arm64-v1.gz\n' +
	'garbage line\n' +
	sprintf('%064d', 1) + ' *mihomo-linux-amd64-v1-v1.gz\n' +
	sprintf('%064d', 2) + '  mihomo-linux-arm64-v1.gz\n');
eq(sums, { 'mihomo-linux-arm64-v1.gz': 'ab' + sprintf('%062d', 0), 'mihomo-linux-amd64-v1-v1.gz': sprintf('%064d', 1) },
	'解析校验和：转小写、接受二进制标记、忽略非法行、同名取第一条');

let S0 = { repo: 'liuran001/mihomo', tag: 'Prerelease-Alpha', mirror: 'https://ghfast.top/' };
eq(C.release_url(S0, 'version.txt'), 'https://github.com/liuran001/mihomo/releases/download/Prerelease-Alpha/version.txt', '发布地址');
eq(C.release_url(S0, 'version.txt', 'file:///r/'), 'file:///r/version.txt', '指定发布目录时直接拼接');
let names = (list) => map(list, (r) => r.name);
eq(names(C.routes(S0, 7890)), ['proxy', 'mirror'], '服务运行时先走本机代理，再走镜像');
eq(C.routes(S0, 7890)[0].args, ['-x', 'http://127.0.0.1:7890'], '代理参数');
eq(names(C.routes(S0, null)), ['mirror'], '服务未运行时只走镜像');
eq(names(C.routes({ ...S0, mirror: '' }, null)), ['direct'], '没有镜像时直连');
eq(names(C.routes({ ...S0, mirror: '' }, 7890)), ['proxy', 'direct'], '没有镜像时代理失败再直连');
eq(C.routes(S0, null)[0].prefix, 'https://ghfast.top/', '镜像前缀');
eq(C.routes(S0, null)[0].args, ['--noproxy', '*'], '镜像线路忽略环境里的代理变量');
eq(C.routes({ ...S0, mirror: '' }, null)[0].args, ['--noproxy', '*'], '直连线路忽略环境里的代理变量');

eq(C.parse_version('Mihomo Meta alpha-smart-x-ebpf linux arm64 with go1.26\nUse tags: x\n'), 'alpha-smart-x-ebpf', '解析 -v 输出');
eq(C.parse_version(''), null, '空输出');

/* ---------- 设置 ---------- */

let s = C.settings();
eq(s, { repo: 'liuran001/mihomo', tag: 'Prerelease-Alpha', mirror: 'https://ghfast.top/' }, '没有 UCI 时用默认值');
ok(!C.settings_set({ repo: 'a/b c', tag: 'x', mirror: '' }).ok, '拒绝非法仓库');
ok(!C.settings_set({ repo: 'a/b', tag: 'x/y', mirror: '' }).ok, '拒绝非法标签');
ok(!C.settings_set({ repo: 'a/b', tag: 'x', mirror: 'ftp://m/' }).ok, '拒绝非法镜像');
ok(!C.settings_set({ repo: 'a/b', tag: 'x', mirror: 'https://m/a b/' }).ok, '镜像不能含空格');
eq(C.settings_set({ repo: 'me/mihomo', tag: 'v1', mirror: 'https://mirror.example/gh' }).ok, true, '保存设置');
eq(C.settings(), { repo: 'me/mihomo', tag: 'v1', mirror: 'https://mirror.example/gh/' }, '读回设置，镜像补全末尾斜杠');
eq(C.settings_set({ repo: 'me/mihomo', tag: 'v1', mirror: '' }).ok, true, '清空镜像');
eq(C.settings().mirror, '', '镜像为空表示直连');

/* ---------- 下载 ---------- */

const REL = '/tmp/mlt/release';
U.mkdir_p(REL);
fs.writefile(REL + '/hello.txt', 'hi\n');
let out = P.RUN_DIR + '/dl.txt';
U.mkdir_p(P.RUN_DIR);
let direct = [{ name: 'direct', label: '直连', prefix: '', args: [] }];
let r = C.fetch('file://' + REL + '/hello.txt', out, { routes: direct });
eq([r.ok, r.route, fs.readfile(out)], [true, 'direct', 'hi\n'], 'file:// 下载成功');
r = C.fetch('file://' + REL + '/missing.txt', out, {
	routes: [{ name: 'mirror', label: '镜像', prefix: '', args: [] }, ...direct] });
ok(!r.ok && fs.stat(out) == null, '两条线路都失败时报错且不留文件');
ok(index(r.error, '镜像') >= 0 && index(r.error, '直连') >= 0, '错误信息列出每条线路', r.error);
r = C.fetch('https://user:pass@127.0.0.1:1/secret-path?token=abc', out, { routes: direct });
ok(!r.ok && index(r.error, 'token=abc') < 0 && index(r.error, 'secret-path') < 0, '错误信息不含地址', r.error);

/* ---------- 发布目录与假内核 ---------- */

const ASSET = C.asset_for(trim(U.run('uname -m').out), fs.readfile('/proc/cpuinfo'));
const FAKE = fs.readfile('/tmp/mlt/backend/fake-mihomo.sh');

// 生成版本 ver 的假内核；mode 为 exit 时启动后立刻退出（模拟起不来的新内核）
function fake_bin(ver, mode) {
	return replace(replace(FAKE, '@VERSION@', ver), '@MODE@', mode ?? 'run');
}

function sha256(path) {
	return split(U.run('sha256sum ' + U.shq(path)).out, ' ')[0];
}

// 发布 ver：version.txt、gz、checksums.txt；opts.bad_sum 写错校验和，opts.claim 让 -v 报告另一个版本
function publish(ver, opts) {
	opts ??= {};
	U.rm_tree(REL);
	U.mkdir_p(REL);
	let name = sprintf('mihomo-%s-%s.gz', ASSET, ver);
	fs.writefile(REL + '/raw', fake_bin(opts.claim ?? ver, opts.mode));
	U.run(sprintf('gzip -c %s > %s', U.shq(REL + '/raw'), U.shq(REL + '/' + name)));
	fs.unlink(REL + '/raw');
	let sum = opts.bad_sum ? sprintf('%064d', 0) : sha256(REL + '/' + name);
	fs.writefile(REL + '/checksums.txt', sprintf('%s  %s\n', sum, name));
	fs.writefile(REL + '/version.txt', ver + '\n');
}

function install_bin(ver) {
	U.mkdir_p(fs.dirname(P.BIN));
	fs.writefile(P.BIN, fake_bin(ver));
	fs.chmod(P.BIN, 0o755);
}

function wait_job(id) {
	for (let i = 0; i < 120; i++) {
		let st = A.job_status(id);
		if (st.state != 'running')
			return st;
		sleep(500);
	}
	return { state: 'timeout' };
}

function update(force) {
	let b = A.begin('core', { force: !!force });
	return b.ok ? wait_job(b.job) : b;
}

function leftovers() {
	// 最新版本缓存 core-latest.json 是有意保留的，其余 core-* 都是任务的临时文件
	return filter(fs.lsdir(P.RUN_DIR) ?? [], (n) => match(n, /^core-/) && P.RUN_DIR + "/" + n != P.CORE_LATEST);
}

// 测试配置不带控制器：重启后只看进程是否存活
const CONF = 'mode: rule\nlog-level: info\nproxies: []\nrules:\n  - MATCH,DIRECT\n';
fs.writefile(P.CONFIG, CONF);
U.rm_tree(fs.dirname(P.BIN));

// 首次安装
publish('v1');
let st = update();
eq([st.state, st.version, C.info().installed, C.info().version, fs.stat(P.BIN_PREV) == null],
	['done', 'v1', true, 'v1', true], '首次安装', st);
eq(st.route, '直连', '记录下载线路');
eq(leftovers(), [], '首次安装后不留临时文件');
eq(U.read_json(P.CORE_LATEST)?.version, 'v1', '缓存最新版本');
eq(U.read_json(P.CORE_LATEST)?.route, 'direct', '缓存里记录获取版本号的线路');

// 已是最新
let before = fs.readfile(P.BIN);
st = update();
eq([st.state, st.note, fs.readfile(P.BIN) == before], ['done', '已是最新版本', true], '已是最新时不下载', st);

// 检查更新
publish('v2');
let ck = C.check();
eq([ck.ok, ck.latest, ck.current, ck.update_available], [true, 'v2', 'v1', true], '检查更新', ck);
fs.writefile(REL + '/version.txt', 'bad version\n');
ok(!C.check().ok, '远端版本号非法时报错');

// 校验和不匹配
publish('v2', { bad_sum: true });
st = update();
eq([st.state, C.info().version], ['failed', 'v1'], '校验和不匹配时不替换', st);
ok(index(st.error, 'sha256') >= 0, '提示校验失败', st.error);

// 自检失败
publish('v2', { claim: 'v9' });
st = update();
eq([st.state, C.info().version], ['failed', 'v1'], '版本不符时不替换', st);

// 新内核拒绝当前配置
publish('v2');
fs.writefile(P.CONFIG, CONF + '# FAKE_INVALID\n');
st = update();
eq([st.state, C.info().version], ['failed', 'v1'], '新内核校验配置失败时不替换', st);
fs.writefile(P.CONFIG, CONF);

// 服务未运行时升级：保留旧版，不重启
st = update();
eq([st.state, st.version, st.restarted, st.kept_prev, C.info().version, C.info().prev_version],
	['done', 'v2', false, true, 'v2', 'v1'], '升级并保留旧版', st);
eq(leftovers(), [], '升级后不留临时文件');

// 回滚任务：交换当前与旧版
let rb = A.begin('core_rollback', {});
st = wait_job(rb.job);
eq([st.state, C.info().version, C.info().prev_version], ['done', 'v1', 'v2'], '回滚到旧版', st);
st = wait_job(A.begin('core_rollback', {}).job);
eq([st.state, C.info().version, C.info().prev_version], ['done', 'v2', 'v1'], '再次回滚换回新版', st);

// 服务运行中升级：重启成功
system(P.INIT + ' start');
sleep(1000);
ok(system(P.INIT + ' running') == 0, '假内核已启动');
publish('v3');
st = update();
eq([st.state, st.version, st.restarted, C.info().version, C.info().prev_version], ['done', 'v3', true, 'v3', 'v2'], '运行中升级并重启', st);
ok(system(P.INIT + ' running') == 0, '升级后服务在运行');

// 服务运行中升级：新内核起不来，自动回滚
publish('v4', { mode: 'exit' });
st = update();
eq([st.state, C.info().version], ['rolled_back', 'v3'], '新内核起不来时回滚', st);
ok(system(P.INIT + ' running') == 0, '回滚后服务恢复运行');
system(P.INIT + ' stop');

// 没有旧版时不能回滚
fs.unlink(P.BIN_PREV);
st = wait_job(A.begin('core_rollback', {}).job);
eq(st.state, 'failed', '没有旧版时回滚失败');

// info
let info = C.info();
eq([info.ok, info.asset, type(info.free_kb), info.settings.repo], [true, ASSET, 'int', 'me/mihomo'], 'info 字段');

done();
