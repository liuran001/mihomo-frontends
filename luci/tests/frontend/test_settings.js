'use strict';
const assert = require('assert');
const { load } = require('./harness');

const view = { extend: o => o };
const st = load('view/mihomo/settings.js', { view, ui: {}, form: {}, api: {}, mui: {}, header: {} });

// 区段数据 → 表单：布尔为 '1'/'0'，数字为字符串，嵌套键的点号换成 __
const ebpf = {
	local_enable: true, shared_enable: false, network: [ 'tcp', 'udp' ], 'udp-timeout': 300, 'bypass-rule-set': [ 'CN-IP' ],
	'fakeip-icmp': null, 'tc-priority': null, 'bypass-tun-direct': null,
	local: { 'data-plane': 'cgroup', 'dns-mode': 'hijack', ipv6: true, 'bypass-private-address': false, 'bypass-exclude': [ '100.64.0.0/10' ], 'bypass-port': null },
	shared: { interface: [ 'br-lan' ], 'bypass-port': [ 22, 443 ] }
};
const f = st.toForm('ebpf', ebpf);
assert.deepStrictEqual([ f.local_enable, f.shared_enable, f['udp-timeout'], f['fakeip-icmp'], f['local__ipv6'], f['local__bypass-private-address'] ],
	[ '1', '0', '300', null, '1', '0' ]);
assert.deepStrictEqual([ f['shared__interface'], f['shared__bypass-port'], f['local__bypass-port'] ], [ [ 'br-lan' ], [ '22', '443' ], null ]);
assert.ok(!('local.ipv6' in f), '选项名不含点号');
assert.strictEqual(Object.keys(f).length, st.SPECS.ebpf.length);
assert.deepStrictEqual(st.toForm('basic', null)['mixed-port'], null, '没有数据时为 null');

// 表单 → data：只取指定的选项，按嵌套结构还原；空串、空列表表示删除
const form = Object.assign({}, f, { 'udp-timeout': ' 600 ', 'local__ipv6': '0', 'shared__interface': [ 'br-lan', ' lan2 ', '' ], 'tc-priority': '' });
assert.deepStrictEqual(st.fromForm('ebpf', form, [ 'udp-timeout', 'local__ipv6', 'shared__interface', 'tc-priority' ]),
	{ 'udp-timeout': 600, 'tc-priority': '', local: { ipv6: false }, shared: { interface: [ 'br-lan', 'lan2' ] } });
assert.deepStrictEqual(st.fromForm('basic', { 'sniffer__enable': '1', 'geox-url__mmdb': ' https://x/m.mmdb ', secret: null }, [ 'sniffer__enable', 'geox-url__mmdb', 'secret' ]),
	{ sniffer: { enable: true }, 'geox-url': { mmdb: 'https://x/m.mmdb' }, secret: '' });
assert.deepStrictEqual(st.fromForm('tailscale', { 'advertise-routes': null, 'listen-port': '41641' }, [ 'advertise-routes', 'listen-port' ]),
	{ 'advertise-routes': [], 'listen-port': 41641 });
// 往返：没有修改时 fromForm(toForm(x)) 与原数据一致
const basic = { 'mixed-port': 7890, 'allow-lan': true, 'bind-address': '*', 'external-controller': '0.0.0.0:9090', sniffer: { enable: true } };
const back = st.fromForm('basic', st.toForm('basic', basic), [ 'mixed-port', 'allow-lan', 'bind-address', 'external-controller', 'sniffer__enable' ]);
assert.deepStrictEqual(back, basic);

// 比较：忽略键顺序，null 与 '' 相同
assert.strictEqual(st.changed({ a: 1, b: [ 1, 2 ] }, { b: [ 1, 2 ], a: 1 }), false);
assert.strictEqual(st.changed([ 1, 2 ], [ 2, 1 ]), true, '列表顺序有意义');
assert.strictEqual(st.changed(null, ''), false);
assert.strictEqual(st.changed('0', '1'), true);
assert.deepStrictEqual(st.changedFields({ a: '1', b: [ 'x' ], c: null }, { a: '1', b: [ 'x', 'y' ], c: '' }), [ 'b' ]);

// DNS 策略表
const rows = st.policyRows([ { key: '+.lan', servers: [ '223.5.5.5', '119.29.29.29' ] }, { key: 'rule-set:Ads', servers: [ 'rcode://success' ] } ]);
assert.deepStrictEqual(rows, [ { key: '+.lan', servers: '223.5.5.5 119.29.29.29' }, { key: 'rule-set:Ads', servers: 'rcode://success' } ]);
assert.deepStrictEqual(st.policyData([ { key: ' +.lan ', servers: '223.5.5.5, 119.29.29.29' }, { key: '', servers: '' } ]),
	[ { key: '+.lan', servers: [ '223.5.5.5', '119.29.29.29' ] } ], '去掉空行，服务器按空格或逗号分隔');
assert.deepStrictEqual(st.policyData(st.policyRows([ { key: 'a', servers: [ 'x' ] } ])), [ { key: 'a', servers: [ 'x' ] } ]);

// serve 表格：去掉空行与结尾 /，严格模式下拒绝重复端口与非法目标
assert.deepStrictEqual(st.serveData([ { port: '8080', target: 'http://127.0.0.1:80/' }, { port: '', target: '' }, { port: 9000, target: 'unix:/tmp/a.sock' } ], true),
	[ { port: 8080, target: 'http://127.0.0.1:80' }, { port: 9000, target: 'unix:/tmp/a.sock' } ]);
assert.throws(() => st.serveData([ { port: 1, target: 'unix:a' }, { port: '1', target: 'unix:b' } ], true), /端口重复/);
assert.throws(() => st.serveData([ { port: 81, target: 'http://router.lan:80' } ], true), /目标/);
assert.throws(() => st.serveData([ { port: 0, target: 'unix:a' } ], true), /端口/);

const savedIdentity = { logged_in: true, login: 'old@example.invalid', tailnet: 'old.invalid', state_dir: '/tmp/tailscale' };
assert.strictEqual(st.tsIdentity({ state: 'NeedsLogin' }, savedIdentity).login, null);
assert.strictEqual(st.tsIdentity({ state: 'NeedsLogin' }, savedIdentity).logged_in, false);
assert.strictEqual(st.tsIdentity({ state: 'Running' }, savedIdentity).login, null);
assert.strictEqual(st.tsIdentity({ state: 'Running', login: 'device-owner@example.invalid' }, savedIdentity).login, 'device-owner@example.invalid');
assert.strictEqual(st.tsIdentity({ state: 'NotStarted' }, savedIdentity), savedIdentity);
assert.strictEqual(st.tsIdentity(null, savedIdentity), savedIdentity);
