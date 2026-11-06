'use strict';
const assert = require('assert');
const { load, baseclass } = require('./harness');

const PL = require('../../../shared/proxylink.js');
const nodes = load('mihomo/nodes.js', { baseclass, ui: {}, mui: {}, PL });

const GROUPS = [
	{ name: '节点选择', type: 'select', auto: false, editable: true },
	{ name: '全部', type: 'select', auto: true, editable: true },
	{ name: '香港', type: 'smart', auto: false, editable: false }
];

/* 策略组勾选：自动包含的组勾选且禁用，继承自锚点的组禁用 */
const ch = nodes.groupChoices(GROUPS, [ '香港' ]);
assert.deepStrictEqual(ch.map(c => [ c.name, c.checked, c.disabled ]), [ [ '节点选择', false, false ], [ '全部', true, true ], [ '香港', true, true ] ]);
assert.match(ch[1].note, /自动包含/);
assert.match(ch[2].note, /锚点/);
assert.deepStrictEqual(nodes.pickedGroups(ch, { 节点选择: true, 全部: true, 香港: false }), [ '节点选择' ], '只提交可编辑、非自动的组');

/* 节点所在策略组的说明 */
assert.strictEqual(nodes.groupText({ groups: [ '节点选择' ] }, GROUPS), '节点选择（另自动包含于 1 个组）');
assert.strictEqual(nodes.groupText({ groups: [] }, GROUPS), '自动包含于 全部');
assert.strictEqual(nodes.groupText({ groups: [] }, [ GROUPS[0] ]), '');

/* 表单值往返：编辑后保留表单没有的字段，换协议时只带基本字段 */
const node = PL.parseLink('vless://u@h:443?security=reality&pbk=k&sid=1&type=grpc&serviceName=svc#R');
node.smux = { enabled: true };
const vals = PL.formValues(node, 'vless');
assert.strictEqual(vals['grpc-opts.grpc-service-name'], 'svc');
assert.strictEqual(vals.tls, true);
vals.port = '8443';
vals.alpn = 'h2, http/1.1';
let r = PL.buildNode(node, 'vless', vals);
assert.deepStrictEqual([ r.error, r.node.port, r.node.alpn, r.node.smux ], [ undefined, 8443, [ 'h2', 'http/1.1' ], { enabled: true } ]);
r = PL.buildNode(node, 'trojan', Object.assign(PL.formValues({ name: 'R', server: 'h', port: 443 }, 'trojan'), { password: 'p' }));
assert.deepStrictEqual(r.node, { name: 'R', server: 'h', port: 443, type: 'trojan', password: 'p' });
assert.strictEqual(PL.buildNode(node, 'vless', Object.assign({}, vals, { port: 'x' })).error, '端口需要填写整数');
assert.strictEqual(PL.buildNode({}, 'trojan', { name: 'n', server: 'h', port: '1' }).error, '请填写密码');
assert.deepStrictEqual(PL.fromInput({ key: 'reserved', kind: 'text' }, '1, 2,3'), [ 1, 2, 3 ]);
