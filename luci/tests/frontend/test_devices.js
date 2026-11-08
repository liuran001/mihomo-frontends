'use strict';
const assert = require('assert');
const { load, baseclass } = require('./harness');

const dl = load('mihomo/devices.js', { baseclass });

// 名单条目：MAC 规范化、IP 补前缀
assert.deepStrictEqual(dl.entry('AA-BB-CC-00-11-22'), { kind: 'mac', value: 'aa:bb:cc:00:11:22' });
assert.deepStrictEqual(dl.entry('aabbcc001122'), { kind: 'mac', value: 'aa:bb:cc:00:11:22' });
assert.deepStrictEqual(dl.entry('192.168.1.20'), { kind: 'ip', value: '192.168.1.20/32' });
assert.deepStrictEqual(dl.entry('192.168.1.0/28'), { kind: 'ip', value: '192.168.1.0/28' });
assert.deepStrictEqual(dl.entry('fd00::5'), { kind: 'ip', value: 'fd00::5/128' });
[ '', 'aa:bb:cc', '192.168.1.300', '10.0.0.0/33', 'hello', 'aa:bb-cc:00:11:22' ].forEach(v => assert.strictEqual(dl.entry(v), null, v));

// 配置 → 模式：两种名单都空时是空黑名单（全部走代理）
assert.deepStrictEqual(dl.policy({}), { mode: 'exclude', entries: [], mixed: false });
assert.deepStrictEqual(dl.policy({ 'exclude-mac-address': [ 'aa:bb:cc:00:11:22' ], 'exclude-source-cidr': [ '10.0.0.5/32' ] }),
	{ mode: 'exclude', entries: [ 'aa:bb:cc:00:11:22', '10.0.0.5/32' ], mixed: false });
assert.strictEqual(dl.policy({ 'include-mac-address': [ 'aa:bb:cc:00:11:22' ], 'exclude-mac-address': [ 'aa:bb:cc:00:11:23' ] }).mixed, true);

// 模式 + 名单 → 四个列表；白名单不能为空，MAC 与 IP 可以混用
assert.deepStrictEqual(dl.data('exclude', [ 'aa:bb:cc:00:11:22', '10.0.0.5', 'AA:BB:CC:00:11:22' ]), {
	'include-mac-address': [], 'include-source-cidr': [], 'exclude-mac-address': [ 'aa:bb:cc:00:11:22' ], 'exclude-source-cidr': [ '10.0.0.5/32' ] });
assert.deepStrictEqual(dl.data('exclude', []), { 'include-mac-address': [], 'include-source-cidr': [], 'exclude-mac-address': [], 'exclude-source-cidr': [] });
assert.throws(() => dl.data('include', []), /至少/);
assert.deepStrictEqual(dl.data('include', [ 'aa:bb:cc:00:11:22', '10.0.0.5' ]), {
	'include-mac-address': [ 'aa:bb:cc:00:11:22' ], 'include-source-cidr': [ '10.0.0.5/32' ], 'exclude-mac-address': [], 'exclude-source-cidr': [] });

// 网段匹配与走不走代理（黑名单任一命中即直连，白名单任一命中才走代理）
assert.ok(dl.contains('192.168.1.0/28', '192.168.1.15'));
assert.ok(!dl.contains('192.168.1.0/28', '192.168.1.16'));
assert.ok(dl.contains('0.0.0.0/0', '8.8.8.8'));
assert.ok(dl.contains('fd00::5/128', 'FD00::5'));
assert.ok(!dl.contains('fd00::5/128', '192.168.1.5'));
const phone = { mac: 'aa:bb:cc:00:11:22', ip4: '192.168.1.20', ip6: [ 'fd00::20' ] };
assert.strictEqual(dl.proxied('exclude', [], phone), true);
assert.strictEqual(dl.proxied('exclude', [ 'aa:bb:cc:00:11:22' ], phone), false);
assert.strictEqual(dl.proxied('exclude', [ '192.168.1.16/28' ], phone), false);
assert.strictEqual(dl.proxied('include', [ 'fd00::20/128' ], phone), true);
assert.strictEqual(dl.proxied('include', [ '10.0.0.0/8' ], phone), false);

// 流量采样：相邻两次累计值相减得速率；IPv4 与 IPv6 地址合计
const s = dl.sampler();
const first = s.push([ { source: '192.168.1.20', upload: 100, download: 1000 } ], 0);
assert.deepStrictEqual(first['192.168.1.20'], { up: 100, down: 1000, upRate: 0, downRate: 0 });
const second = s.push([ { source: '192.168.1.20', upload: 300, download: 5000 }, { source: 'fd00::20', upload: 10, download: 20 } ], 2000);
assert.deepStrictEqual(second['192.168.1.20'], { up: 300, down: 5000, upRate: 100, downRate: 2000 });
assert.deepStrictEqual(dl.traffic(second, [ '192.168.1.20', 'fd00::20' ]), { up: 310, down: 5020, upRate: 100, downRate: 2000 });
assert.deepStrictEqual(dl.traffic(second, [ '192.168.1.16/28' ]).down, 5000);
assert.strictEqual(dl.traffic(second, [ '10.0.0.1' ]), null);
// 统计被重置（累计值变小）时速率不为负
assert.strictEqual(s.push([ { source: '192.168.1.20', upload: 0, download: 0 } ], 4000)['192.168.1.20'].downRate, 0);

console.log('test_devices ok');
