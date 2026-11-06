'use strict';
const assert = require('assert');
const { load } = require('./harness');

const PL = require('../../../shared/proxylink.js');
const view = { extend: (o) => o };
const gv = load('view/mihomo/groups.js', { view, ui: {}, api: {}, mui: {}, header: {}, nodes: {}, PL });

const GROUPS = [
	{ name: '节点选择', type: 'select', data: { name: '节点选择', type: 'select', proxies: [ '香港', 'DIRECT' ] }, refs: [ '规则第 9 条', '规则集 ads 的下载方式' ], anchored: [] },
	{ name: '香港', type: 'smart', data: { name: '香港', type: 'smart', use: [ '甲' ] }, refs: [ '规则第 2 条' ], anchored: [] },
	{ name: '备用', type: 'select', data: { name: '备用', type: 'select', proxies: [ 'DIRECT' ] }, refs: [], anchored: [ '其他' ] }
];

/* 成员可选项：不含自己与 DNS 出站，按内置 / 策略组 / 节点分组 */
const ch = gv.memberChoices(GROUPS, [ { name: 'HK', type: 'trojan' }, { name: 'DNS_Hijack', type: 'dns' } ], '香港');
assert.deepStrictEqual(ch.map(c => c.label), [ '内置', '策略组', '单个节点' ]);
assert.deepStrictEqual(ch[1].items.map(i => i[0]), [ '节点选择', '备用' ]);
assert.deepStrictEqual(ch[2].items.map(i => i[0]), [ 'HK' ]);
assert.strictEqual(gv.memberChoices([], [], null).length, 1, '没有组和节点时只有内置');

/* 使用情况与删除限制 */
assert.deepStrictEqual(gv.memberOf('香港', GROUPS), [ '节点选择' ]);
assert.strictEqual(gv.usageText(GROUPS[0], GROUPS), '被 1 条规则，规则集 ads 的下载方式 使用');
assert.strictEqual(gv.usageText(GROUPS[1], GROUPS), '被 1 条规则，策略组 节点选择 的成员 使用');
assert.strictEqual(gv.usageText(GROUPS[2], GROUPS), '');
assert.match(gv.deleteBlock(GROUPS[2]), /锚点/);
assert.match(gv.deleteBlock(GROUPS[1]), /规则第 2 条/);
assert.strictEqual(gv.deleteBlock({ refs: [], anchored: [] }), null);

/* 表单：smart 专属字段在切到 select 时清掉；lazy 等于默认值时不写 */
const HK = { name: '香港', type: 'smart', use: [ '甲' ], 'prefer-asn': true, icon: 'x' };
const vals = PL.groupValues(HK);
assert.strictEqual(vals.lazy, true);
let r = PL.buildGroup(HK, Object.assign({}, vals, { type: 'select' }));
assert.deepStrictEqual(r.group, { name: '香港', type: 'select', use: [ '甲' ], icon: 'x' });
r = PL.buildGroup({}, Object.assign({}, PL.groupValues({}), { name: 'a', type: 'smart', 'include-all': true, lazy: false, 'sample-rate': '0.5' }));
assert.deepStrictEqual(r.group, { name: 'a', type: 'smart', lazy: false, 'sample-rate': 0.5, 'include-all': true });
assert.match(PL.buildGroup({}, { name: 'a', type: 'select' }).error, /至少/);
assert.match(PL.buildGroup({}, { name: 'a', type: 'relay', proxies: [ 'DIRECT' ] }).error, /类型/);
assert.ok(PL.GROUP_FIELDS.some(f => f.key === 'policy-priority' && f.when.in[0] === 'smart'));

console.log('test_groups ok');
