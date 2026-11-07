'use strict';

import * as fs from 'fs';
import * as PL from 'mihomo.plugin';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import { ok, eq, done } from 'lib';

// main.sh 把版本文件、包管理器、release 地址与安装命令都指到 /tmp/mlt 下
if (substr(P.PLUGIN_VERSION, 0, 9) != '/tmp/mlt/' || substr(P.PLUGIN_INSTALL ?? '', 0, 9) != '/tmp/mlt/') {
	print('插件升级的路径不在测试目录，拒绝运行\n');
	exit(1);
}
const R = '/tmp/mlt/release';
const BASE = 'file://' + R + '/';
const DIRECT = { routes: [{ name: 'direct', label: '直连', prefix: '', args: ['--noproxy', '*'] }] };

/* ---------- 纯函数 ---------- */

eq(PL.code_of('V1.0.0-26110701'), 26110701, '构建号');
eq(PL.code_of(' V1.2.3-5\n'), 5, '忽略空白');
eq(PL.code_of('1.0.0-r26110701'), null, '包版本号不是发布版本号');
eq(PL.code_of(null), null, '空值');

let pkg = (fmt, url, sha) => ({ version: 'V1.0.1-26110801', versionCode: 26110801, zipUrl: 'x',
	luci: { version: '1.0.1-r26110801', [fmt]: { name: 'p.' + fmt, url: url, sha256: sha } } });
let SHA = sprintf('%064d', 7);
let good = PL.parse_manifest(sprintf('%J', pkg('apk', BASE + 'p.apk', SHA)), 'apk');
eq([good.ok, good.version, good.code, good.url], [true, 'V1.0.1-26110801', 26110801, BASE + 'p.apk'], '解析清单');
ok(!PL.parse_manifest(sprintf('%J', pkg('apk', BASE + 'p.apk', SHA)), 'ipk').ok, '没有本机格式的包');
ok(!PL.parse_manifest(sprintf('%J', pkg('apk', 'https://evil.example/p.apk', SHA)), 'apk').ok, '拒绝其它来源');
ok(!PL.parse_manifest(sprintf('%J', pkg('apk', BASE + '../p.apk', SHA)), 'apk').ok, '拒绝 ..');
ok(!PL.parse_manifest(sprintf('%J', pkg('apk', BASE + 'p.apk;id', SHA)), 'apk').ok, '扩展名必须匹配');
ok(!PL.parse_manifest(sprintf('%J', pkg('apk', BASE + 'p.apk', 'abc')), 'apk').ok, '拒绝无效 sha256');
ok(!PL.parse_manifest(sprintf('%J', { ...pkg('apk', BASE + 'p.apk', SHA), versionCode: 1 }), 'apk').ok, '版本号与构建号不一致');
ok(!PL.parse_manifest('not json', 'apk').ok, '拒绝非 JSON');

/* ---------- 检查与升级 ---------- */

U.mkdir_p(R);
fs.writefile(P.PLUGIN_VERSION, 'V1.0.0-26110701\n');
fs.writefile(R + '/apk', '#!/bin/sh\n');
fs.chmod(R + '/apk', 0o755);
eq(PL.format(), 'apk', '有 apk 时用 apk');
eq(PL.installed(), { version: 'V1.0.0-26110701', code: 26110701 }, '已安装版本');

fs.writefile(R + '/p.apk', 'package-bytes');
let real = substr(U.run('sha256sum ' + R + '/p.apk').out, 0, 64);
fs.writefile(R + '/update.json', sprintf('%J', pkg('apk', BASE + 'p.apk', real)));
let c = PL.check(DIRECT);
eq([c.ok, c.current, c.latest, c.update_available, c.format], [true, 'V1.0.0-26110701', 'V1.0.1-26110801', true, 'apk'], '检查更新');

// 假安装命令：记录收到的文件内容，并把版本文件改成新版本
fs.writefile(R + '/fake-install', '#!/bin/sh\ncat "$1" > ' + R + '/installed\necho V1.0.1-26110801 > ' + P.PLUGIN_VERSION + '\n');
fs.chmod(R + '/fake-install', 0o755);
let st = PL.run_upgrade(false, DIRECT);
eq([st.state, st.version], ['done', 'V1.0.1-26110801'], '升级完成');
eq(fs.readfile(R + '/installed'), 'package-bytes', '安装的是下载的包');
eq(PL.status().job.state, 'done', '状态文件');
eq(PL.check(DIRECT).update_available, false, '升级后已是最新');
eq(PL.run_upgrade(false, DIRECT).unchanged, true, '已是最新时不重复安装');

fs.writefile(P.PLUGIN_VERSION, 'V1.0.0-26110701\n');
fs.writefile(R + '/update.json', sprintf('%J', pkg('apk', BASE + 'p.apk', SHA)));
fs.unlink(R + '/installed');
st = PL.run_upgrade(false, DIRECT);
ok(st.state == 'failed' && index(st.error, 'sha256') >= 0, 'sha256 不符时放弃', st);
ok(!fs.stat(R + '/installed'), '校验失败时没有安装');

fs.writefile(R + '/update.json', sprintf('%J', pkg('apk', BASE + 'p.apk', real)));
fs.writefile(R + '/fake-install', '#!/bin/sh\necho "ERROR: broken" ; exit 3\n');
st = PL.run_upgrade(false, DIRECT);
ok(st.state == 'failed' && index(st.detail, 'broken') >= 0, '安装失败时带上输出', st);

ok(!PL.job_running({ state: 'running', pid: 999999999 }), '进程不在时不算运行中');
ok(PL.job_running({ state: 'running', started: time() }), '刚启动、还没 pid 时算运行中');
U.write_json(PL.STATUS, { state: 'running', pid: 999999999 });
eq(PL.status().job.state, 'failed', '进程意外退出时显示失败');
ok(!PL.upgrade({}).ok, '后台程序不存在时报告失败');

fs.unlink(R + '/apk');
eq(PL.format(), null, '没有包管理器');
ok(!PL.check(DIRECT).ok, '没有包管理器时无法检查');

done();
