'use strict';
const assert = require('assert');
const { load, baseclass } = require('./harness');

const declared = [];
const calls = [];
const rpc = { declare: o => { declared.push(o); return (...a) => { calls.push([ o.method, a ]); return Promise.resolve({ ok: true }); }; } };
const api = load('mihomo/api.js', { baseclass, rpc });

const methods = declared.map(o => o.object + '.' + o.method).sort();
// 前端声明的方法与 ACL 中授权的方法一一对应
const acl = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../root/usr/share/rpcd/acl.d/luci-app-mihomo.json'), 'utf8'))['luci-app-mihomo'];
const granted = acl.read.ubus['luci.mihomo'].concat(acl.write.ubus['luci.mihomo']).map(m => 'luci.mihomo.' + m).sort();
assert.deepStrictEqual(methods, granted);
// rpcd 插件注册的方法也与 ACL 一致
const entry = require('fs').readFileSync(require('path').join(__dirname, '../../root/usr/share/rpcd/ucode/luci.mihomo.uc'), 'utf8');
const registered = [...entry.matchAll(/^\t\t([a-z_]+):\s*\{/gm)].map(m => 'luci.mihomo.' + m[1]).sort();
assert.deepStrictEqual(registered, granted);
assert.deepStrictEqual(declared.find(o => o.method === 'sections').params, ['names']);
assert.deepStrictEqual(declared.find(o => o.method === 'provider_toggle').params, ['name', 'enabled', 'rev']);
assert.ok(methods.includes('luci.mihomo.devices') && methods.includes('luci.mihomo.rule_test'));
assert.deepStrictEqual(declared.find(o => o.method === 'rule_test').params, ['target']);
assert.deepStrictEqual(declared.find(o => o.method === 'save_raw').params, ['content', 'rev']);
// 每个方法声明的参数与 rpcd 插件 args 的键一致
const pluginArgs = {};
for (const m of entry.matchAll(/^\t\t([a-z_]+):\s*\{\s*args:\s*\{([^}]*)\}/gm))
	pluginArgs[m[1]] = [...m[2].matchAll(/([a-z_]+):/g)].map(x => x[1]).sort();
for (const o of declared)
	assert.deepStrictEqual((o.params || []).slice().sort(), pluginArgs[o.method] || [], o.method + ' 的参数与插件不一致');
// 按对象传参的包装：按声明顺序展开，缺省的键为 undefined（序列化时省略）
const named = (method, a) => Object.fromEntries(declared.find(o => o.method === method).params.map((p, i) => [ p, a[i] ]));
api.setupApply({ source: 'url', url: 'https://x', ua: '', adapt: true, start: false, rev: 'r1' });
assert.deepStrictEqual(calls[calls.length - 1][0], 'setup_apply');
assert.deepStrictEqual(JSON.parse(JSON.stringify(named('setup_apply', calls[calls.length - 1][1]))),
	{ source: 'url', url: 'https://x', ua: '', adapt: true, start: false, rev: 'r1' });
api.setupRender({ subs: [ { name: 'a', url: 'https://a' } ], lan: [ 'br-lan' ], secret: '' });
assert.deepStrictEqual(named('setup_render', calls[calls.length - 1][1]), { subs: [ { name: 'a', url: 'https://a' } ], lan: [ 'br-lan' ], secret: '' });
api.coreSettings({ repo: 'a/b', tag: 't', mirror: '' });
assert.deepStrictEqual(named('core_settings', calls[calls.length - 1][1]), { repo: 'a/b', tag: 't', mirror: '' });

assert.strictEqual(api.baseUrl({ scheme: 'http', host: null, port: 9090 }, '192.168.77.1'), 'http://192.168.77.1:9090');
assert.strictEqual(api.baseUrl({ scheme: 'https', host: 'fd00::1', port: 9443 }, 'x'), 'https://[fd00::1]:9443');
assert.strictEqual(api.baseUrl({ scheme: 'http', host: null, port: 9090 }, '[fd00::2]'), 'http://[fd00::2]:9090');
assert.strictEqual(api.withToken('/logs?level=info', 'a b'), '/logs?level=info&token=a%20b');
assert.strictEqual(api.withToken('/traffic', ''), '/traffic');

// 按页面协议选控制器：http 页面优先明文，https 页面只能用 TLS
const plainOk = { ok: true, listen: '0.0.0.0:9090', reachable: true, host: null, port: 9090, reason: null, tls: null };
const tlsOk = { listen: '0.0.0.0:9443', host: null, port: 9443, reachable: true, reason: null };
const tlsCtl = Object.assign({}, plainOk, { tls: tlsOk });
const pick = (c, p) => api.chooseEndpoint(c, p).endpoint;
assert.deepStrictEqual(pick(plainOk, 'http:'),
	{ scheme: 'http', listen: '0.0.0.0:9090', host: null, port: 9090, reachable: true, reason: null });
assert.strictEqual(pick(tlsCtl, 'http:').scheme, 'http', 'http 页面优先明文');
assert.strictEqual(pick(tlsCtl, 'https:').scheme, 'https', 'https 页面用 TLS');
assert.strictEqual(pick(Object.assign({}, plainOk, { reachable: false, reason: '只监听本机', tls: tlsOk }), 'http:').scheme,
	'https', '明文不可达时退回 TLS');
const httpsReason = api.chooseEndpoint(plainOk, 'https:').reason;
assert.ok(/external-controller-tls/.test(httpsReason), httpsReason);
assert.strictEqual(api.chooseEndpoint(tlsCtl, 'https:').endpoint.port, 9443);
assert.strictEqual(api.chooseEndpoint(Object.assign({}, plainOk, { tls: Object.assign({}, tlsOk, { reachable: false, reason: 'TLS 只监听本机' }) }), 'https:').reason,
	httpsReason, 'https 页面明文可达但 TLS 不可达时仍提示混合内容');
assert.strictEqual(api.chooseEndpoint(Object.assign({}, plainOk, { tls: Object.assign({}, tlsOk, { reachable: false, reason: 'TLS 只监听本机' }) }), 'http:').endpoint.scheme,
	'http', 'http 页面明文可用时不因 TLS 不可用而报错');
assert.strictEqual(api.chooseEndpoint(Object.assign({}, plainOk, { reachable: false, reason: '只监听本机' }), 'http:').reason, '只监听本机');
assert.strictEqual(api.chooseEndpoint({ ok: false, error: '无法读取配置文件' }, 'http:').reason, '无法读取配置文件');
assert.strictEqual(api.chooseEndpoint(null, 'http:').reason, '无法读取控制器设置');

// 面板链接：自动填好后端地址与 secret；不可用时给出原因
const ok = { ok: true, reachable: true, host: null, port: 9090, secret: '', ui: './dashboard', ui_name: null, tls: null };
assert.deepStrictEqual(api.dashboardUrl(ok, '192.168.77.1'),
	{ url: 'http://192.168.77.1:9090/ui/#/setup?hostname=192.168.77.1&port=9090&protocol=http', reason: null });
assert.strictEqual(api.dashboardUrl(Object.assign({}, ok, { secret: 'a b&c' }), 'r.lan').url,
	'http://r.lan:9090/ui/#/setup?hostname=r.lan&port=9090&protocol=http&secret=a%20b%26c');
assert.strictEqual(api.dashboardUrl(Object.assign({}, ok, { host: 'fd00::1' }), 'x').url,
	'http://[fd00::1]:9090/ui/#/setup?hostname=fd00%3A%3A1&port=9090&protocol=http');
assert.strictEqual(api.dashboardUrl(Object.assign({}, ok, { ui_name: 'zash' }), 'r').url,
	'http://r:9090/ui/zash/#/setup?hostname=r&port=9090&protocol=http');
assert.strictEqual(api.dashboardUrl(Object.assign({}, ok, { tls: tlsOk }), 'r', 'https:').url,
	'https://r:9443/ui/#/setup?hostname=r&port=9443&protocol=https', 'https 页面用 TLS 面板链接');
const noUi = api.dashboardUrl(Object.assign({}, ok, { ui: null }), 'r');
assert.strictEqual(noUi.url, null);
assert.ok(/external-ui/.test(noUi.reason) && /控制器与面板/.test(noUi.reason), noUi.reason);
assert.deepStrictEqual(api.dashboardUrl(Object.assign({}, ok, { reachable: false, reason: '只监听本机' }), 'r'), { url: null, reason: '只监听本机' });
assert.deepStrictEqual(api.dashboardUrl({ ok: false, error: '无法读取配置文件' }, 'r'), { url: null, reason: '无法读取配置文件' });
assert.strictEqual(api.dashboardUrl(null, 'r').reason, '无法读取控制器设置');
