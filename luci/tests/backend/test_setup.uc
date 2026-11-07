'use strict';

import * as fs from 'fs';
import * as A from 'mihomo.apply';
import * as SU from 'mihomo.setup';
import * as U from 'mihomo.util';
import * as P from 'mihomo.paths';
import * as Y from 'mihomo.yaml';
import { ok, eq, done } from 'lib';

const T = '/tmp/mlt';
const MIRROR = 'https://ghfast.top/';
const UI = 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip';
const FIP = 'https://github.com/DustinWin/ruleset_geodata/raw/refs/heads/mihomo-ruleset/fakeip-filter.mrs';

let seq = 0;
// 把文本写到临时文件并用 yq 解析（展开锚点）
function parse(text) {
	let f = sprintf('%s/parse-%d.yaml', P.RUN_DIR, ++seq);
	fs.writefile(f, text);
	let x = Y.query(f, 'explode(.)');
	fs.unlink(f);
	return x;
}

function group(x, name) {
	for (let g in x['proxy-groups'] ?? [])
		if (g.name == name)
			return g;
	return null;
}

function wait_job(id) {
	for (let i = 0; i < 120; i++) {
		let s = A.job_status(id);
		if (s.state != 'running')
			return s;
		sleep(500);
	}
	return { state: 'timeout' };
}

U.mkdir_p(P.RUN_DIR);

/* ---------- 模板渲染 ---------- */

const SUB_A = { name: '机场A', url: 'https://a.example/sub?token=abc&flag=meta' };
const SUB_B = { name: 'B "q" 🚀', url: 'https://b.example/s', ua: 'clash-verge/v2.0' };
let r = SU.render({ subs: [SUB_A, SUB_B], lan: ['br-lan', 'eth1'], secret: 'abc123', mirror: MIRROR });
ok(r.ok, '渲染成功', r.error);
ok(!match(r.content, /(^|\n) *#@[a-z-]+[ \t]*(\n|$)/), '占位符全部替换');
ok(index(lc(r.content), 'tailscale') < 0 && index(r.content, 'TS-Server') < 0, '模板不含 Tailscale');
let x = parse(r.content);
ok(type(x) == 'object', '渲染结果是合法 YAML');
eq(sort(keys(x['proxy-providers'])), sort([SUB_A.name, SUB_B.name]), '两个订阅');
let pa = x['proxy-providers'][SUB_A.name], pb = x['proxy-providers'][SUB_B.name];
eq([pa.type, pa.url, pa.path, pa.override['additional-prefix'], pa.header, pa.interval],
	['http', SUB_A.url, './proxy_provider/机场A.yaml', '[机场A]', null, 3600], '订阅 A（继承 p 锚点）');
eq([pb.url, pb.path, pb.override['additional-prefix'], pb.header],
	[SUB_B.url, './proxy_provider/B "q" 🚀.yaml', '[B "q" 🚀]', { 'User-Agent': ['clash-verge/v2.0'] }], '订阅 B 带 UA，名称含引号与 emoji');
eq(group(x, '香港').use, [SUB_A.name, SUB_B.name], 'use 锚点列出全部订阅');
eq(group(x, '全部节点').use, [SUB_A.name, SUB_B.name], '全部节点也用这些订阅');
eq(x.listeners[0].shared.interface, ['br-lan', 'eth1'], '下联接口');
eq([x.listeners[0].type, x.listeners[0].mode], ['ebpf', 'hybrid'], 'eBPF hybrid 入站');
eq(x.secret, 'abc123', '面板密钥');
eq(x['external-ui-url'], MIRROR + UI, '面板地址走镜像');
eq([x['rule-providers']['Fake-IP-Filter'].url, x['rule-providers']['Fake-IP-Filter'].proxy], [MIRROR + FIP, 'DIRECT'],
	'Fake-IP 规则集走镜像直连');
eq(x.rules[0], 'DST-PORT,53,DNS_Hijack', '首条规则接管 DNS');

r = SU.render({ subs: [SUB_A], lan: ['br-lan'], mirror: '' });
x = parse(r.content);
eq([x['external-ui-url'], x['rule-providers']['Fake-IP-Filter'].url, x['rule-providers']['Fake-IP-Filter'].proxy],
	[UI, FIP, '节点选择'], '镜像为空时用 GitHub 原地址，规则集走代理');
ok(match(x.secret, /^[0-9a-f]{32}$/), '未填密钥时随机生成 32 位十六进制', x.secret);
r = SU.render({ subs: [SUB_A], lan: ['br-lan'], mirror: 'https://mirror.example/gh' });
eq(parse(r.content)['external-ui-url'], 'https://mirror.example/gh/' + UI, '镜像前缀补全末尾斜杠');

let bad = (args, name) => {
	let b = SU.render(args);
	ok(!b.ok && type(b.error) == 'string', name, b);
	return b.error ?? '';
};
bad({ subs: [], lan: ['br-lan'] }, '至少一个订阅');
ok(index(bad({ subs: [{ name: 'a/b', url: 'https://x.example' }], lan: ['br-lan'] }, '订阅名称非法'), 'a/b') >= 0, '错误信息指出名称');
bad({ subs: [SUB_A, { name: SUB_A.name, url: 'https://y.example' }], lan: ['br-lan'] }, '订阅名称重复');
let e = bad({ subs: [{ name: 'x', url: 'ftp://secret-host.example/t0ken' }], lan: ['br-lan'] }, '订阅地址非法');
ok(index(e, 't0ken') < 0, '错误信息不含订阅地址', e);
bad({ subs: [{ name: 'x', url: 'https://x.example', ua: 'a\nb' }], lan: ['br-lan'] }, 'UA 含控制字符');
bad({ subs: [SUB_A], lan: [] }, '至少一个下联接口');
bad({ subs: [SUB_A], lan: ['bad name!'] }, '接口名非法');
bad({ subs: [SUB_A], lan: ['br-lan'], secret: 'a b' }, '密钥含空格');
bad({ subs: [SUB_A], lan: ['br-lan'], mirror: 'ftp://m' }, '镜像前缀非法');

// 渲染结果能通过内核校验（GEOSITE 等需要的数据文件由 main.sh 链接到 HOME）
r = SU.render({ subs: [SUB_A, SUB_B], lan: ['br-lan'], mirror: MIRROR });
fs.writefile(P.RUN_DIR + '/tpl.yaml', r.content);
let v = A.validate_file(P.RUN_DIR + '/tpl.yaml');
ok(v.ok, '模板渲染结果通过 mihomo -t', v);
fs.unlink(P.RUN_DIR + '/tpl.yaml');

/* ---------- 补全（adapt） ---------- */

const BASE = 'mixed-port: 17890\nexternal-controller: 0.0.0.0:19090\nsecret: s3\nexternal-ui: ./dashboard\n' +
	'log-level: warning\ntcp-concurrent: true\nfind-process-mode: off\nprofile:\n  store-selected: true\nsniffer:\n  enable: true\n' +
	'tun:\n  enable: false\n' +
	'dns:\n  enable: true\n  listen: 0.0.0.0:1053\n' +
	'proxies:\n  - {name: DNS_Hijack, type: dns}\n  - {name: dummy, type: socks5, server: 127.0.0.1, port: 1}\n' +
	'rules:\n  - DST-PORT,53,DNS_Hijack\n  - MATCH,DIRECT\n' +
	'listeners:\n  - {name: ebpf-in, type: ebpf, mode: local, network: [tcp, udp]}\n';
const AF = P.RUN_DIR + '/adapt.yaml';
const AARGS = { lan: ['eth9'], secret: 'gen-secret', mirror: MIRROR, host: { ipv6: true, mem_mb: 4096 } };

// 去掉 BASE 中以 key 开头的顶层段落，再接上 extra
function without(key, extra) {
	let out = [], skip = false;
	for (let line in split(BASE, '\n')) {
		if (line == '')
			continue;
		if (match(line, /^[^ ]/))
			skip = (substr(line, 0, length(key) + 1) == key + ':');
		if (!skip)
			push(out, line);
	}
	return join('\n', out) + '\n' + (extra ?? '');
}

function adapt(text, args) {
	fs.writefile(AF, text);
	let res = SU.adapt(AF, args ?? AARGS);
	return { r: res, x: Y.query(AF, 'explode(.)'), text: fs.readfile(AF) };
}

let has = (list, word) => length(filter(list ?? [], (s) => index(s, word) >= 0)) > 0;

let a = adapt(BASE);
eq([a.r.ok, a.r.adapted], [true, []], '齐全的配置不需要补全', a.r);
eq(a.text, BASE, '齐全的配置逐字节不变');

// 与模块向导一致的可选优化
let bare = 'mixed-port: 17890\nexternal-controller: 0.0.0.0:19090\nsecret: s3\nexternal-ui: ./dashboard\nipv6: true\n' +
	'tun:\n  enable: false\n' +
	'dns:\n  enable: true\n  listen: 0.0.0.0:1053\n  ipv6: true\n' +
	'proxies:\n  - {name: DNS_Hijack, type: dns}\n' +
	'rules:\n  - DST-PORT,53,DNS_Hijack\n  - GEOSITE,cn,DIRECT\n  - MATCH,DIRECT\n' +
	'listeners:\n  - {name: ebpf-in, type: ebpf, mode: local, network: [tcp, udp]}\n';
a = adapt(bare, { ...AARGS, host: { ipv6: false, mem_mb: 256 } });
let oids = map(filter(a.r.changes ?? [], (c) => c.applied), (c) => c.id);
eq(sort(oids), sort(['ipv6', 'geox', 'geodata', 'process', 'log', 'tcp', 'profile', 'sniffer']), '补全全部优化项', a.r);
eq([a.x.ipv6, a.x.dns.ipv6, a.x['geodata-loader'], a.x['find-process-mode'], a.x['log-level'], a.x['tcp-concurrent'], a.x.profile['store-selected']],
	[false, false, 'memconservative', 'off', 'warning', true, true], '优化项写入配置');
ok(match(a.x['geox-url'].geosite, /jsdelivr/) && a.x.sniffer.enable === true && a.x.sniffer.sniff.TLS.ports[0] == 443, 'GEO 镜像与嗅探设置');
fs.writefile(P.RUN_DIR + '/opt.yaml', a.text);
ok(A.validate_file(P.RUN_DIR + '/opt.yaml').ok, '优化后的配置通过 mihomo -t');
fs.unlink(P.RUN_DIR + '/opt.yaml');
a = adapt(bare, { ...AARGS, host: { ipv6: true, mem_mb: 4096 } });
oids = map(a.r.changes ?? [], (c) => c.id);
ok(index(oids, 'ipv6') < 0 && index(oids, 'geodata') < 0, '有 IPv6 出口、内存充足时不提示这两项', oids);
a = adapt(bare, { ...AARGS, host: { ipv6: false, mem_mb: 256 }, skip: ['ipv6', 'sniffer'] });
eq([a.x.ipv6, a.x.sniffer], [true, null], '跳过的可选项不应用');
a = adapt(replace(bare, 'GEOSITE,cn,DIRECT', 'PROCESS-NAME,curl,DIRECT'), { ...AARGS, host: { ipv6: true, mem_mb: 256 } });
oids = map(a.r.changes ?? [], (c) => c.id);
ok(index(oids, 'process') < 0 && index(oids, 'geox') < 0 && index(oids, 'geodata') < 0, '按进程分流时不关闭进程查找；没有 GEO 规则时不设 GEO', oids);

a = adapt(without('listeners'));
ok(a.r.ok && has(a.r.adapted, 'eBPF'), '没有入站时补 eBPF', a.r);
eq([a.x.listeners[0].type, a.x.listeners[0].mode, a.x.listeners[0].shared.interface], ['ebpf', 'hybrid', ['eth9']], 'eBPF 入站用所选接口');
ok(!has(adapt(BASE).r.adapted, 'eBPF'), '已有 eBPF 入站时不改');
a = adapt(without('listeners'), { mirror: MIRROR });
ok(!a.r.ok && index(a.r.error, '接口') >= 0, '需要补 eBPF 但没有接口时报错', a.r);

a = adapt(replace(BASE, 'external-controller: 0.0.0.0:19090', 'external-controller: 127.0.0.1:9090'));
eq([a.r.ok, a.x['external-controller']], [true, '0.0.0.0:9090'], '控制器只听本机时改为 0.0.0.0，端口不变');
a = adapt(without('external-controller'));
eq(a.x['external-controller'], '0.0.0.0:9090', '没有控制器时添加');
a = adapt(without('secret'));
eq([a.x.secret, has(a.r.adapted, '密钥')], ['gen-secret', true], '没有密钥时写入参数密钥');
a = adapt(without('secret'), { lan: ['eth9'], mirror: MIRROR });
ok(match(a.x.secret, /^[0-9a-f]{32}$/), '没有参数密钥时随机生成');
a = adapt(without('external-ui'));
eq([a.x['external-ui'], a.x['external-ui-url']], ['./dashboard', MIRROR + UI], '没有面板时写入目录与 zashboard 地址');
a = adapt(without('external-ui', 'external-ui-url: https://ui.example/x.zip\n'));
eq([a.x['external-ui'], a.x['external-ui-url']], ['./dashboard', 'https://ui.example/x.zip'], '已有面板地址时保留');

a = adapt(replace(BASE, 'tun:\n  enable: false', 'tun:\n  enable: true\n  stack: gvisor'));
eq([a.x.tun.enable, a.x.tun.stack, has(a.r.adapted, 'Tun')], [false, 'gvisor', true], '关闭 Tun，其他键不变');

a = adapt(without('dns'));
eq([a.x.dns.enable, a.x.dns.listen, a.x.dns['enhanced-mode'], length(a.x.dns.nameserver)],
	[true, '0.0.0.0:1053', 'redir-host', 2], '没有 dns 时补完整的最小设置');
a = adapt(replace(BASE, 'dns:\n  enable: true\n  listen: 0.0.0.0:1053', 'dns:\n  enable: false\n  ipv6: false\n  nameserver: [1.2.3.4]'));
eq([a.x.dns.enable, a.x.dns.listen, a.x.dns.ipv6, a.x.dns.nameserver], [true, '0.0.0.0:1053', false, ['1.2.3.4']],
	'dns 未启用时启用，补监听地址，其他键不变');

a = adapt(replace(replace(BASE, '  - {name: DNS_Hijack, type: dns}\n', ''), '  - DST-PORT,53,DNS_Hijack\n', ''));
eq([a.x.proxies[1], a.x.rules], [{ name: 'DNS_Hijack', type: 'dns' }, ['DST-PORT,53,DNS_Hijack', 'MATCH,DIRECT']],
	'没有 dns 出站时添加出站并插入首条规则');
a = adapt(replace(without('rules'), '  - {name: DNS_Hijack, type: dns}\n', ''));
eq(a.x.rules, ['DST-PORT,53,DNS_Hijack'], '没有 rules 时创建列表');
a = adapt(replace(replace(BASE, '  - {name: DNS_Hijack, type: dns}\n', ''), '  - DST-PORT,53,DNS_Hijack\n', '') +
	'proxy-groups:\n  - {name: DNS_Hijack, type: select, proxies: [DIRECT]}\n');
eq([a.x.proxies[1].name, a.x.rules[0]], ['DNS_Hijack-2', 'DST-PORT,53,DNS_Hijack-2'], '名称被占用时换一个');

a = adapt('mixed-port: 17890\nproxies:\n  - {name: dummy, type: socks5, server: 127.0.0.1, port: 1}\nrules:\n  - MATCH,DIRECT\n');
ok(a.r.ok && length(a.r.adapted) >= 5, '最小配置补全全部项目', a.r);
v = A.validate_file(AF);
ok(v.ok, '补全后通过 mihomo -t', v);

a = adapt('proxies: [\n');
ok(!a.r.ok, '语法错误时报错');

/* ---------- 补全：改动清单与跳过可选项 ---------- */

let ids = (r) => map(r.changes ?? [], (c) => c.id);
let ch = (r, id) => filter(r.changes ?? [], (c) => c.id == id)[0];

a = adapt(without('secret'), { ...AARGS, skip: ['secret'] });
eq([a.r.ok, a.x.secret, ch(a.r, 'secret')?.applied, ch(a.r, 'secret')?.optional], [true, null, false, true], '跳过可选项：列出但不应用');
eq(a.r.adapted, [], '跳过的项不算进已补全');
a = adapt(replace(BASE, 'tun:\n  enable: false', 'tun:\n  enable: true'), { ...AARGS, skip: ['tun'] });
eq([a.x.tun.enable, ch(a.r, 'tun')?.applied], [false, true], '必需项不能跳过');
a = adapt(BASE, { ...AARGS, skip: ['Bad Id'] });
ok(!a.r.ok, '跳过项格式无效时报错', a.r);

a = adapt(replace(BASE, 'listeners:\n', 'tproxy-port: 7893\nredir-port: 7892\nlisteners:\n  - {name: tp, type: tproxy, port: 7894}\n') +
	'  - {name: mx, type: mixed, port: 7895}\n');
eq([a.r.ok, map(a.x.listeners, (l) => l.name), a.x['tproxy-port'], a.x['redir-port']], [true, ['ebpf-in', 'mx'], null, null],
	'移除冲突的 tproxy 入站与透明代理端口，保留 mixed 入站', a.r);
eq([ch(a.r, 'listeners')?.optional, ch(a.r, 'ports')?.optional], [true, true], '冲突入站与端口是可选项');
a = adapt(replace(BASE, 'listeners:\n', 'tproxy-port: 7893\nlisteners:\n  - {name: tp, type: tproxy, port: 7894}\n'),
	{ ...AARGS, skip: ['listeners', 'ports'] });
eq([length(a.x.listeners), a.x['tproxy-port']], [2, 7893], '跳过后保留冲突入站与端口');

a = adapt(BASE + 'interface-name: nonexist9\n');
eq([a.x['interface-name'], ch(a.r, 'iface')?.optional], [null, false], '本机不存在的出站网卡绑定被移除');
a = adapt(BASE + 'interface-name: lo\n');
eq([a.x['interface-name'], ch(a.r, 'iface')], ['lo', null], '存在的网卡保留');

a = adapt(BASE + 'proxy-providers:\n  a:\n    type: http\n    url: https://a.example/s\n    path: /etc/openclash/proxy_provider/a.yaml\n' +
	'  b:\n    type: http\n    url: https://b.example/s\n    path: ' + P.HOME + '/proxy_provider/b.yaml\n' +
	'rule-providers:\n  r:\n    type: http\n    behavior: domain\n    url: https://r.example/r.yaml\n    path: ../r.yaml\n');
eq([a.x['proxy-providers'].a.path, a.x['proxy-providers'].b.path, a.x['rule-providers'].r.path],
	['./proxy_provider/a.yaml', P.HOME + '/proxy_provider/b.yaml', './rule_provider/r.yaml'], '配置目录以外的路径改为相对路径，目录内的保留');

a = adapt(replace(BASE, '  - DST-PORT,53,DNS_Hijack\n', ''));
eq([length(a.x.proxies), a.x.rules], [2, ['DST-PORT,53,DNS_Hijack', 'MATCH,DIRECT']], '已有 DNS 出站但缺规则时只补规则');
a = adapt(replace(BASE, '  - DST-PORT,53,DNS_Hijack\n', '  - DST-PORT,53,DIRECT\n'));
eq(a.x.rules[0], 'DST-PORT,53,DNS_Hijack', '53 端口规则指向别处时在最前面补上');

a = adapt(replace(BASE, '{name: ebpf-in, type: ebpf, mode: local, network: [tcp, udp]}',
	'{name: ebpf-in, type: ebpf, mode: local, network: [tcp, udp], dns-mode: hijack, local: {data-plane: cgroup}}'));
eq([a.r.ok, a.x.listeners[0]['dns-mode'], a.x.listeners[0].local['dns-mode'], ch(a.r, 'ebpf')?.title], [true, null, 'hijack', '规范 eBPF 入站'],
	'eBPF 旧写法展开到 local', a.r);
a = adapt(replace(replace(BASE, '{name: ebpf-in, type: ebpf, mode: local, network: [tcp, udp]}',
	'{name: ebpf-in, type: ebpf, mode: local, network: [tcp, udp], local: {data-plane: cgroup}}'),
	'  - {name: dummy,', '  - {name: ts, type: tailscale}\n  - {name: dummy,'));
eq(a.x.listeners[0].local['bypass-exclude'], ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'], '有 Tailscale 时补 Tailnet 的 bypass-exclude', a.r);

/* ---------- 补全预览 ---------- */

let before = fs.readfile(P.CONFIG);
let pv = SU.adapt_preview({ content: without('secret'), lan: ['eth9'], skip: [] });
ok(pv.ok && index(ids(pv), 'secret') >= 0 && match(pv.content, /\nsecret: /), '预览返回改动清单与补全后的内容', pv);
pv = SU.adapt_preview({ content: without('secret'), lan: ['eth9'], skip: ['secret'] });
ok(pv.ok && !match(pv.content, /\nsecret: /), '预览按跳过项生成');
eq(fs.readfile(P.CONFIG), before, '预览不改动正式配置');
eq(length(filter(fs.lsdir(P.RUN_DIR) ?? [], (n) => match(n, /^(preview|adapt|classify)-/))), 0, '预览清理临时文件');
eq(SU.adapt_preview({ content: '  ' }).ok, false, '预览拒绝空内容');

/* ---------- 识别内容 ---------- */

eq(SU.classify('vmess://abc\ntrojan://p@h:443#x\n\n').kind, 'subscription', '分享链接列表识别为节点订阅');
eq(SU.classify(b64enc('ss://YWVz@h:1#a\nvless://u@h:443?x=1#b\n')).kind, 'subscription', 'base64 订阅识别为节点订阅');
let cl = SU.classify(BASE);
eq([cl.kind, cl.summary], ['config', { proxies: 1, providers: 0, groups: 0, rules: 2 }], '完整配置识别并统计（不计 dns 出站）');
eq(SU.classify('mixed-port: 7890\n').kind, 'partial', '缺少节点与规则时为不完整配置');
eq(SU.classify('<html>blocked</html>').kind, 'invalid', '非 YAML 内容');
eq(SU.classify('').kind, 'invalid', '空内容');
eq(SU.fetch_config({ url: 'ftp://x' }).ok, false, '下载地址必须是 http(s)');
fs.unlink(AF);

/* ---------- status ---------- */

// 路由器上读真实的 /etc/config/network；本机的 uci 测试桩里预置同样的 lan 设备
if (getenv('MIHOMO_TEST_LOCAL'))
	fs.writefile(T + '/uci/stub.json', sprintf('%J', { network: { lan: { '.type': 'interface', device: 'br-lan' } } }));
let st = SU.status();
eq([st.ok, st.core, st.config, st.autostart, st.running, st.arch_ok], [true, true, true, false, false, true], 'status 字段');
eq(st.lan_default, ['br-lan'], '默认下联接口来自 network.lan');
eq(st.rev, U.file_rev(P.CONFIG), 'status 带当前配置的 rev，供向导覆盖时提交');

/* ---------- setup 任务 ---------- */

const ORIG = fs.readfile(P.CONFIG);
const RUN = ORIG; // 测试实例配置：只监听本机端口，可以与正式实例并行

// 已有配置时 rev 必须一致
let b = A.begin('setup', { source: 'import', content: RUN, rev: 'stale' });
eq([b.ok, b.error], [false, A.ERR_CONFLICT], '已有配置时 rev 不符被拒');

// 锁被占用
ok(A.lock_acquire('ffffffffffffffff'), '占用锁');
b = A.begin('setup', { source: 'import', content: RUN, rev: A.config_read().rev });
eq([b.ok, b.error], [false, A.ERR_BUSY], '锁被占用时返回忙');
A.lock_release();

// 来源参数
let perr = (args, name) => {
	let x2 = A.begin('setup', { ...args, rev: A.config_read().rev });
	ok(!x2.ok && type(x2.error) == 'string', name, x2);
};
perr({ source: 'nope' }, '未知来源');
perr({ source: 'import', content: '  ' }, '导入内容为空');
perr({ source: 'url', url: 'ftp://x.example/c' }, '下载地址非法');
perr({ source: 'import', content: RUN, adapt: true, lan: ['bad name!'] }, '补全时接口名非法');
perr({ source: 'template', subs: [], lan: ['br-lan'] }, '模板缺订阅');

// 校验失败时配置不变
b = A.begin('setup', { source: 'import', content: RUN + '\nrules:\n  - MATCH,不存在的组\n', rev: A.config_read().rev });
let j = b.ok ? wait_job(b.job) : b;
eq([j.state, fs.readfile(P.CONFIG) == ORIG], ['failed', true], '校验失败时配置不变', j);

// 导入 + 补全（不启动）：补全列表写进结果
let imp = replace(RUN, 'dns:\n  enable: false\n', 'dns:\n  enable: false\n  ipv6: false\n');
b = A.begin('setup', { source: 'import', content: imp, adapt: true, lan: ['br-lan'], start: false, rev: A.config_read().rev });
j = b.ok ? wait_job(b.job) : b;
ok(j.state == 'done' && has(j.adapted, 'eBPF') && has(j.adapted, 'DNS'), '导入并补全', j);
ok(j.opts == null, '任务状态不返回参数');
x = Y.query(P.CONFIG, 'explode(.)');
eq([x.listeners[0].type, x.dns.enable, x['external-controller']], ['ebpf', true, '0.0.0.0:19090'], '补全写入了配置');
ok(length(A.backups()) >= 1, '替换前做了备份');

// 模板来源（不启动）：首次安装场景，没有现有配置
fs.unlink(P.CONFIG);
b = A.begin('setup', { source: 'template', subs: [SUB_A], lan: ['br-lan'], start: false });
j = b.ok ? wait_job(b.job) : b;
x = Y.query(P.CONFIG, 'explode(.)');
eq([j.state, j.launched ?? false, type(x?.['proxy-providers']?.[SUB_A.name])], ['done', false, 'object'], '模板来源写入配置', j);
ok(index(sprintf('%J', j), 'token=abc') < 0, '任务结果不含订阅地址');

// 导入并启动：服务未运行时启用并启动
fs.writefile(P.CONFIG, ORIG);
b = A.begin('setup', { source: 'import', content: RUN, start: true, rev: A.config_read().rev });
j = b.ok ? wait_job(b.job) : b;
eq([j.state, j.launched, system(P.INIT + ' running') == 0], ['done', true, true], '导入并启动', j);
system(P.INIT + ' stop');

// 下载来源：用本机 HTTP 服务提供配置文件
const WWW = T + '/www';
U.mkdir_p(WWW);
fs.writefile(WWW + '/c.yaml', RUN);
let srv = null;
if (system('command -v uhttpd >/dev/null 2>&1') == 0)
	srv = sprintf('uhttpd -f -p 127.0.0.1:18080 -h %s', WWW);
else if (system('command -v python3 >/dev/null 2>&1') == 0)
	srv = sprintf('python3 -m http.server 18080 --bind 127.0.0.1 --directory %s', WWW);
if (srv) {
	system(sprintf('(%s >/dev/null 2>&1 & echo $! > %s/www.pid)', srv, T));
	// 等服务就绪（负载高时 python 启动较慢）
	for (let i = 0; i < 40 && system(P.CURL + ' -fs -o /dev/null http://127.0.0.1:18080/c.yaml') != 0; i++)
		sleep(250);
	b = A.begin('setup', { source: 'url', url: 'http://127.0.0.1:18080/c.yaml', ua: 'clash.meta', start: false,
		rev: A.config_read().rev });
	j = b.ok ? wait_job(b.job) : b;
	ok(j.state == 'done' && fs.readfile(P.CONFIG) == RUN, '下载来源写入配置', j);
	b = A.begin('setup', { source: 'url', url: 'http://127.0.0.1:18080/missing.yaml', rev: A.config_read().rev });
	j = b.ok ? wait_job(b.job) : b;
	ok(j.state == 'failed' && index(j.error, '下载') >= 0 && index(j.error, '18080') < 0, '下载失败时报错且不含地址', j);
	system(sprintf('kill $(cat %s/www.pid) 2>/dev/null', T));
} else
	print('# 没有 uhttpd 或 python3，跳过下载来源测试\n');

fs.writefile(P.CONFIG, ORIG);
done();
