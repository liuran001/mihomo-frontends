'use strict';

// 配置引擎（webui/bridge/config.js）：解析、字段读写、导入分析与本机优化。
// 运行：node --test magisk/tests/config.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { webcrypto } = require('node:crypto');

const bridge = path.join(__dirname, '../webui/bridge');
const context = { crypto: webcrypto };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(bridge, 'vendor/yaml.min.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../shared/proxylink.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(bridge, 'config.js'), 'utf8'), context);
const C = context.mihomoConfig;
const Y = context.YAML;
const plain = (content) => JSON.parse(JSON.stringify(Y.parseDocument(content, { merge: true }).toJS({ maxAliasCount: -1 })));

const template = fs.readFileSync(path.join(__dirname, '../../shared/template.yaml'), 'utf8').replace(/\r/g, '');
const rendered = template.split('\n').map((line) => {
  const match = /^(\s*)#@(\S+)/.exec(line);
  if (!match) return line;
  const indent = match[1];
  return {
    providers: `${indent}"机场":\n${indent}  <<: *p\n${indent}  url: "https://example.com/sub"\n${indent}  path: "./providers/a.yaml"`,
    use: `${indent}- "机场"`, secret: 'secret: "abc"', 'ui-url': 'external-ui-url: "https://example.com/ui.zip"','fake-ip-filter-url': `${indent}url: "https://example.com/f.mrs"`,
    lan: `${indent}interface: []`,
  }[match[2]];
}).join('\n');

const routerConfig = `# 我的路由器配置
mixed-port: 7890
tproxy-port: 7894
routing-mark: 6666
allow-lan: true
bind-address: '*'
log-level: info
external-controller: 0.0.0.0:9090
tun:
  enable: true
  stack: mixed
dns:
  enable: false
  ipv6: true
proxies:
  - {name: 香港, type: ss, server: hk.example.com, port: 443, cipher: aes-128-gcm, password: x}
proxy-groups:
  - name: 节点选择
    type: select
    proxies: [香港, DIRECT]
rule-providers:
  cncidr:
    type: http
    behavior: ipcidr
    format: mrs
    url: https://example.com/cncidr.mrs
    path: ./rule/cncidr.mrs
rules:
  - PROCESS-NAME,com.tencent.mm,DIRECT
  - GEOSITE,cn,DIRECT
  - RULE-SET,cncidr,DIRECT
  - MATCH,节点选择
`;

const host = { ipv6: false, memMb: 4096, mirror: 'https://ghfast.top/' };

test('Tailscale-only schema matches the full schema without inspecting unrelated rules', () => {
  const content = routerConfig.replace('proxies:\n', 'proxies:\n  - {name: phone, type: tailscale, hostname: phone, serve: [{port: 80, target: "unix:run/webui.sock"}]}\n');
  const full = C.schema(content);
  const scoped = C.tailscale(content);
  assert.deepEqual(scoped.tailscale, full.tailscale);
  assert.deepEqual(scoped.tailscaleFields, full.tailscaleFields);
  assert.deepEqual(Object.keys(scoped).sort(), ['ok', 'tailscale', 'tailscaleFields']);
  const document = Y.parseDocument('proxies: []', { merge: true });
  document.toJS = () => ({ proxies: [], get rules() { throw new Error('unrelated rules accessed'); } });
  const isolated = vm.createContext({ YAML: { ...Y, parseDocument: () => document } });
  vm.runInContext(fs.readFileSync(path.join(bridge, 'config.js'), 'utf8'), isolated);
  assert.equal(isolated.mihomoConfig.tailscale('proxies: []').tailscale.length, 0);
});

function policyRender(content) {
  // 让优化结果过一遍运行时渲染（policy-yaml.awk），确保模块能接管。
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-config-'));
  const source = path.join(directory, 'config.yaml');
  const packages = path.join(directory, 'packages');
  fs.writeFileSync(source, content);
  fs.writeFileSync(packages, 'com.example.bank\n');
  try {
    return execFileSync('awk', ['-v', 'tethering=1', '-v', 'interfaces=ap0,rndis0', '-v', 'packages_file=' + packages.split(path.sep).join('/'),
      '-f', path.join(__dirname, '../scripts/policy-yaml.awk'), source], { encoding: 'utf8' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('template round trips byte-for-byte and keeps anchors', () => {
  const result = C.patch(rendered, [{ op: 'set', path: ['log-level'], value: 'error' }]);
  const before = rendered.split('\n');
  const after = result.content.split('\n');
  const changed = before.filter((line, index) => line !== after[index]);
  assert.deepEqual(changed, ['log-level: warning']);
  assert.match(result.content, /^p: &p$/m);
  assert.match(result.content, /<<: \*use/);
});

test('schema exposes LuCI-aligned sections with current values', () => {
  const schema = C.schema(rendered);
  const ids = schema.sections.map((section) => section.id);
  assert.deepEqual([...ids], ['basic', 'controller', 'dns', 'ebpf']);
  const field = (section, id) => schema.sections.find((item) => item.id === section).fields.find((item) => item.id === id);
  assert.equal(field('basic', 'log-level').value, 'warning');
  assert.equal(field('dns', 'dns.enhanced-mode').value, 'redir-host');
  assert.equal(field('ebpf', '@listener.network').value, 'tcp,udp');
  assert.deepEqual([...field('ebpf', '@listener.bypass-rule-set').choices], ['CN-IP', 'google-ip', 'netflix-ip', 'telegram-ip', 'twitter-ip']);
  assert.equal(schema.providers[0].name, '机场');
  assert.equal(schema.providers[0].fields.find((item) => item.id === 'interval').value, 3600, 'merged anchor value is visible');
  assert.equal(schema.ruleProviders.find((item) => item.name === 'CN-IP').used, true);
  assert.equal(schema.ruleProviders.find((item) => item.name === 'Fake-IP-Filter').used, false);
  assert.equal(schema.summary.ebpf, true);
});

test('patch validates values and edits listener fields in place', () => {
  assert.throws(() => C.patch(rendered, [{ op: 'set', path: ['mixed-port'], value: 70000 }]), /混合端口/);
  assert.throws(() => C.patch(rendered, [{ op: 'set', path: ['external-controller'], value: '' }]), /不能为空/);
  assert.throws(() => C.patch(rendered, [{ op: 'set', path: ['secret2'], value: 'x' }]), /不支持修改字段/);
  assert.throws(() => C.patch(rendered, [{ op: 'set', path: ['@listener', 'bypass-rule-set'], value: ['nope'] }]), /规则集不存在/);
  const result = C.patch(rendered, [
    { op: 'set', path: ['@listener', 'udp-timeout'], value: 120 },
    { op: 'set', path: ['@listener', 'shared', 'exclude-mac-address'], value: 'AA-BB-CC-DD-EE-FF\naa:bb:cc:dd:ee:ff' },
    { op: 'set', path: ['@listener', 'network'], value: 'tcp' },
    { op: 'set', path: ['dns', 'nameserver'], value: '223.5.5.5\n\n119.29.29.29' },
    { op: 'set', path: ['geodata-loader'], value: 'memconservative' },
    { op: 'set', path: ['unified-delay'], value: null },
  ]);
  const data = plain(result.content);
  assert.equal(data.listeners[0]['udp-timeout'], 120);
  assert.deepEqual(data.listeners[0].shared['exclude-mac-address'], ['aa:bb:cc:dd:ee:ff']);
  assert.deepEqual(data.listeners[0].network, ['tcp']);
  assert.deepEqual(data.dns.nameserver, ['223.5.5.5', '119.29.29.29']);
  assert.equal(data['geodata-loader'], 'memconservative');
  assert.equal('unified-delay' in data, false);
  assert.match(policyRender(result.content), /mode: hybrid/);
});

test('providers can be added, edited and removed while keeping group references', () => {
  let content = C.patch(rendered, [{ op: 'provider.add', name: '备用', values: { url: 'https://example.com/b', 'header.User-Agent': 'clash.meta' } }]).content;
  let data = plain(content);
  assert.equal(data['proxy-providers']['备用'].interval, 3600, 'new provider merges the shared anchor');
  assert.deepEqual(data['proxy-providers']['备用'].header, { 'User-Agent': ['clash.meta'] });
  assert.match(content, /"?备用"?:\n\s+<<: \*p/);
  assert.ok(data['proxy-groups'].find((group) => group.name === '香港').use.includes('备用'));
  content = C.patch(content, [{ op: 'provider.set', name: '备用', values: { interval: 600, 'override.additional-prefix': '[B]' } }]).content;
  data = plain(content);
  assert.equal(data['proxy-providers']['备用'].interval, 600);
  assert.equal(data['proxy-providers']['备用'].override['additional-prefix'], '[B]');
  content = C.patch(content, [{ op: 'provider.delete', name: '备用' }]).content;
  data = plain(content);
  assert.equal('备用' in data['proxy-providers'], false);
  assert.ok(!data['proxy-groups'].some((group) => (group.use || []).includes('备用')));
  assert.throws(() => C.patch(content, [{ op: 'provider.add', name: '机场', values: { url: 'https://x.y' } }]), /已存在/);
});

test('rule providers follow format/behavior rules and refuse deleting referenced sets', () => {
  assert.throws(() => C.patch(C.patch(rendered, [{ op: 'ruleProvider.add', name: 'x', values: { url: 'https://e/x.mrs', format: 'mrs', behavior: 'classical' } }]).content, []),
    /classical|没有要保存/);
  assert.throws(() => C.patch(rendered, [{ op: 'ruleProvider.delete', name: 'CN-IP' }]), /仍在引用/);
  const added = C.patch(rendered, [{ op: 'ruleProvider.add', name: 'ads', values: { url: 'https://e/ads.list', format: 'text', behavior: 'domain', proxy: 'DIRECT' } }]);
  const data = plain(added.content);
  assert.equal(data['rule-providers'].ads.path, './rule_provider/ads.list');
  assert.throws(() => C.patch(rendered, [{ op: 'ruleProvider.delete', name: 'AWAvenue-Ads' }]), /仍在引用/);
});

test('analyze distinguishes full configs, partial configs and raw subscriptions', () => {
  assert.equal(C.analyze(routerConfig).kind, 'config');
  assert.equal(C.analyze('mixed-port: 7890\n').kind, 'partial');
  assert.equal(C.analyze('vmess://abc\ntrojan://def@h:443\n').kind, 'subscription');
  assert.equal(C.analyze('dm1lc3M6Ly9hYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODlhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg==').kind, 'subscription');
  assert.throws(() => C.analyze('a: [1, 2'), /YAML 解析失败/);
});

test('optimize adapts a router config for the phone and the runtime renderer accepts it', () => {
  const result = C.optimize(routerConfig, host);
  const ids = result.changes.map((change) => change.id);
  for (const id of ['ebpf', 'tun', 'router', 'controller', 'secret', 'dashboard', 'lan', 'dns', 'dns-hijack', 'ipv6', 'geox', 'geodata', 'log']) {
    assert.ok(ids.includes(id), 'missing change ' + id);
  }
  const data = plain(result.content);
  assert.equal(data.listeners.length, 1);
  assert.equal(data.listeners[0].type, 'ebpf');
  assert.deepEqual(data.listeners[0]['bypass-rule-set'], ['cncidr']);
  assert.equal(data.listeners[0].local.ipv6, false);
  assert.equal(data.tun.enable, false);
  assert.equal(data['tproxy-port'], undefined);
  assert.equal(data['routing-mark'], undefined);
  assert.equal(data['external-controller'], '127.0.0.1:9090');
  assert.match(data.secret, /^[0-9a-f]{32}$/);
  assert.equal(data['external-ui-url'], 'https://ghfast.top/https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip');
  assert.equal(data['allow-lan'], false);
  assert.equal(data.dns.enable, true);
  assert.equal(data.rules[0], 'DST-PORT,53,DNS_Hijack');
  assert.equal(data.proxies[0].type, 'dns');
  assert.equal(data.ipv6, false);
  assert.equal(data['find-process-mode'], undefined, 'PROCESS-NAME rule keeps process lookup default');
  assert.equal(data['geodata-loader'], 'memconservative');
  assert.match(result.content, /^# 我的路由器配置/);
  const runtime = policyRender(result.content);
  assert.match(runtime, /exclude-package: \["com\.example\.bank"\]/);
  assert.match(runtime, /interface: \["ap0", "rndis0"\]/);
});

test('optimize honours skipped optional steps but never skips required ones', () => {
  const result = C.optimize(routerConfig, host, { skip: ['lan', 'log', 'ebpf', 'secret'] });
  const data = plain(result.content);
  assert.equal(data['allow-lan'], true);
  assert.equal(data['log-level'], 'info');
  assert.equal(data.secret, undefined);
  assert.equal(data.listeners[0].type, 'ebpf', 'eBPF listener is mandatory');
  assert.equal(result.changes.find((change) => change.id === 'ebpf').optional, false);
});

test('optimize is idempotent and the template needs no mandatory changes', () => {
  const once = C.optimize(routerConfig, host).content;
  const twice = C.optimize(once, host);
  assert.equal(twice.changes.filter((change) => !change.optional).length, 0, JSON.stringify(twice.changes));
  assert.equal(twice.content, C.optimize(twice.content, host).content);
  const templateResult = C.optimize(rendered, { ipv6: true, memMb: 12000 });
  assert.equal(templateResult.changes.filter((change) => !change.optional).length, 0, JSON.stringify(templateResult.changes));
});

test('optimize replaces multiple or flow-style listeners with one block listener', () => {
  const config = 'proxies: []\nlisteners:\n  - {name: a, type: ebpf, local: {data-plane: tc, bypass-port: [22]}}\n  - name: tp\n    type: tproxy\n    port: 7894\n';
  const result = C.optimize(config, { ipv6: true });
  const data = plain(result.content);
  assert.equal(data.listeners.length, 1);
  assert.equal(data.listeners[0].local['data-plane'], 'tc', 'existing role settings are kept');
  assert.deepEqual(data.listeners[0].local['bypass-port'], [22]);
  assert.match(result.changes.find((change) => change.id === 'ebpf').detail, /移除 1 个/);
  assert.match(policyRender(result.content), /mode: hybrid/);
});

test('optimize rewrites absolute paths outside the data directory', () => {
  const config = [
    'external-ui: /path/to/ui/folder/',
    'proxies: []',
    'proxy-providers:',
    '  a: {type: http, url: "https://e/a", path: /etc/clash/a.yaml}',
    'rule-providers:',
    '  r: {type: http, behavior: domain, url: "https://e/r", path: ../r.yaml}',
    '  ok: {type: http, behavior: domain, url: "https://e/o", path: ./rules/ok.yaml}',
    'geox-path: {geoip: /opt/geoip.dat}',
    '',
  ].join('\n');
  const result = C.optimize(config, { ipv6: true });
  const change = result.changes.find((item) => item.id === 'paths');
  assert.ok(change && change.optional === false);
  const data = plain(result.content);
  assert.equal(data['external-ui'], './dashboard');
  assert.equal(data['proxy-providers'].a.path, './proxy_provider/a.yaml');
  assert.equal(data['rule-providers'].r.path, './rule_provider/r.yaml');
  assert.equal(data['rule-providers'].ok.path, './rules/ok.yaml');
  assert.equal(data['geox-path'].geoip, './geoip.dat');
  assert.equal(C.optimize(result.content, { ipv6: true }).changes.some((item) => item.id === 'paths'), false);
});

test('optimize expands legacy listener keys and keeps Tailnet traffic inside mihomo', () => {
  // 与常见手机配置同形（地址均为虚构）：顶层 dns-mode / bypass-private-address、local.ipv6-mode、Tailscale 出站
  const config = [
    'proxies:',
    '  - {name: TS, type: tailscale, hostname: demo-node}',
    'rule-providers:',
    '  CN-IP: {type: http, behavior: ipcidr, format: mrs, url: "https://e/cn.mrs", path: ./rule_provider/cn.mrs}',
    'rules:',
    '  - IP-CIDR,100.64.0.0/10,TS,no-resolve',
    '  - MATCH,DIRECT',
    'listeners:',
    '  - name: ebpf-in',
    '    type: ebpf',
    '    mode: local',
    '    dns-mode: hijack',
    '    bypass-private-address: false',
    '    bypass-rule-set:',
    '      - CN-IP',
    '    local:',
    '      ipv6-mode: auto',
    '',
  ].join('\n');
  const result = C.optimize(config, { ipv6: true });
  const change = result.changes.find((item) => item.id === 'ebpf');
  assert.ok(change && change.optional === false);
  assert.match(change.detail, /dns-mode/);
  const listener = plain(result.content).listeners[0];
  for (const key of ['dns-mode', 'bypass-private-address', 'ipv6-mode']) assert.equal(listener[key], undefined, 'top-level ' + key);
  assert.equal(listener.local['ipv6-mode'], undefined);
  assert.equal(listener.local.ipv6, true);
  assert.equal(listener.local['dns-mode'], undefined, 'local DNS mode is generated by the module');
  assert.equal(listener.local['bypass-private-address'], false);
  assert.deepEqual(listener['bypass-rule-set'], ['CN-IP']);
  for (const role of ['local', 'shared']) {
    for (const cidr of ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']) assert.ok(listener[role]['bypass-exclude'].includes(cidr), role + ' ' + cidr);
  }
  assert.equal(C.optimize(result.content, { ipv6: true }).changes.some((item) => item.id === 'ebpf'), false, 'idempotent');
  assert.match(policyRender(result.content), /mode: hybrid/);
});

test('tailscale add inserts the proxy, Tailnet rules after DNS hijack and eBPF bypass-exclude', () => {
  const result = C.patch(rendered, [{ op: 'tailscale.add', name: 'Tailscale', values: { hostname: 'phone-node' } }]);
  const data = plain(result.content);
  const proxy = data.proxies.find((item) => item.name === 'Tailscale');
  assert.deepEqual([proxy.type, proxy.hostname, proxy.udp, proxy['auth-key']], ['tailscale', 'phone-node', true, undefined]);
  assert.match(data.rules[0], /^DST-PORT,53,/);
  const first = data.rules.findIndex((rule) => rule.includes('Tailscale'));
  assert.ok(data.rules.slice(0, first).every((rule) => /^DST-PORT,/.test(rule)), 'Tailnet rules follow the leading DST-PORT rules');
  assert.deepEqual(data.rules.slice(first, first + 2), ['IP-CIDR,100.64.0.0/10,Tailscale,no-resolve', 'IP-CIDR6,fd7a:115c:a1e0::/48,Tailscale,no-resolve']);
  for (const role of ['local', 'shared']) assert.deepEqual(data.listeners[0][role]['bypass-exclude'], ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']);
  assert.equal(C.optimize(result.content, { ipv6: true, memMb: 12000 }).changes.some((change) => change.id === 'ebpf'), false, 'optimizer accepts the result');
  assert.match(policyRender(result.content), /mode: hybrid/);
  const schema = C.schema(result.content);
  assert.equal(JSON.stringify(schema.tailscale.map((item) => [item.name, item.stateDir])), '[["Tailscale",""]]');
  assert.equal(schema.tailscale[0].fields.find((field) => field.id === 'hostname').value, 'phone-node');
});

test('tailscale add rejects bad names, duplicates and hostnames', () => {
  assert.throws(() => C.patch(rendered, [{ op: 'tailscale.add', name: 'a b', values: { hostname: 'x' } }]), /名称/);
  assert.throws(() => C.patch(rendered, [{ op: 'tailscale.add', name: '节点选择', values: { hostname: 'x' } }]), /名称/);
  assert.throws(() => C.patch(rendered, [{ op: 'tailscale.add', name: 'DIRECT', values: { hostname: 'x' } }]), /已被占用/);
  assert.throws(() => C.patch(rendered, [{ op: 'tailscale.add', name: 'TS', values: { hostname: 'bad_host' } }]), /设备名只能/);
  assert.throws(() => C.patch(rendered, [{ op: 'tailscale.add', name: 'TS', values: {} }]), /设备名不能为空/);
});

test('tailscale set edits fields; delete removes rules, group members and bypass-exclude', () => {
  const config = [
    'proxies:',
    '  - {name: TS, type: tailscale, hostname: old, auth-key: tskey-test}',
    'proxy-groups:',
    '  - {name: 选择, type: select, proxies: [TS, DIRECT]}',
    'rules:',
    '  - DST-PORT,53,DIRECT',
    '  - IP-CIDR,100.64.0.0/10,TS,no-resolve',
    '  - IP-CIDR6,fd7a:115c:a1e0::/48,TS,no-resolve',
    '  - DOMAIN,ts.example,TS',
    '  - MATCH,DIRECT',
    'listeners:',
    '  - name: ebpf-in',
    '    type: ebpf',
    '    local:',
    '      bypass-exclude: [10.0.0.0/8, 100.64.0.0/10, fd7a:115c:a1e0::/48]',
    '    shared:',
    '      bypass-exclude: [100.64.0.0/10, fd7a:115c:a1e0::/48]',
    '',
  ].join('\n');
  const edited = plain(C.patch(config, [{ op: 'tailscale.set', name: 'TS', values: { hostname: 'new-node', 'auth-key': '', 'accept-routes': true } }]).content);
  assert.deepEqual([edited.proxies[0].hostname, edited.proxies[0]['auth-key'], edited.proxies[0]['accept-routes']], ['new-node', undefined, true]);
  assert.throws(() => C.patch(config, [{ op: 'tailscale.set', name: 'Nope', values: {} }]), /不存在/);
  const removed = plain(C.patch(config, [{ op: 'tailscale.delete', name: 'TS' }]).content);
  assert.deepEqual(removed.proxies, []);
  assert.deepEqual(removed.rules, ['DST-PORT,53,DIRECT', 'MATCH,DIRECT']);
  assert.deepEqual(removed['proxy-groups'][0].proxies, ['DIRECT']);
  assert.deepEqual(removed.listeners[0].local['bypass-exclude'], ['10.0.0.0/8']);
  assert.equal(removed.listeners[0].shared['bypass-exclude'], undefined);
  const lonely = config.replace('proxies: [TS, DIRECT]', 'proxies: [TS]');
  assert.throws(() => C.patch(lonely, [{ op: 'tailscale.delete', name: 'TS' }]), /只包含 TS/);
  const dnsUse = config.replace('proxy-groups:', 'dns:\n  nameserver-policy:\n    +.tail.ts.net: [ts://TS]\nproxy-groups:');
  assert.throws(() => C.patch(dnsUse, [{ op: 'tailscale.delete', name: 'TS' }]), /ts:\/\/TS/);
});

test('tailscale webui publishes the management page on one outbound and advertise-routes is editable', () => {
  let content = C.patch(rendered, [
    { op: 'tailscale.add', name: 'TS-A', values: { hostname: 'a-node' } },
    { op: 'tailscale.add', name: 'TS-B', values: { hostname: 'b-node', 'advertise-routes': ['192.168.1.0/24', '10.0.0.0/8'] } },
  ]).content;
  const routes = plain(content).proxies.find((item) => item.name === 'TS-B')['advertise-routes'];
  assert.equal(JSON.stringify(routes), '["192.168.1.0/24","10.0.0.0/8"]');
  content = C.patch(content, [{ op: 'tailscale.webui', name: 'TS-A', enable: true }]).content;
  assert.equal(JSON.stringify(plain(content).proxies.find((item) => item.name === 'TS-A').serve), '[{"port":80,"target":"unix:run/webui.sock"}]');
  assert.equal(JSON.stringify(C.schema(content).tailscale.map((item) => [item.name, item.webui])), '[["TS-A",true],["TS-B",false]]');
  // 换到另一个出站时从原出站撤掉
  content = C.patch(content, [{ op: 'tailscale.webui', name: 'TS-B', enable: true }]).content;
  assert.equal(plain(content).proxies.find((item) => item.name === 'TS-A').serve, undefined);
  content = C.patch(content, [{ op: 'tailscale.webui', name: 'TS-B', enable: false }]).content;
  assert.equal(plain(content).proxies.find((item) => item.name === 'TS-B').serve, undefined);
  assert.throws(() => C.patch(content, [{ op: 'tailscale.webui', name: 'TS-B' }]), /enable/);
  assert.throws(() => C.patch(content, [{ op: 'tailscale.set', name: 'TS-B', values: { 'advertise-routes': ['nope'] } }]), /通告子网路由/);
});

test('tailscale serve replaces user forwards and keeps the management entry', () => {
  let content = C.patch(rendered, [{ op: 'tailscale.add', name: 'TS', values: { hostname: 'node' } }]).content;
  content = C.patch(content, [{ op: 'tailscale.webui', name: 'TS', enable: true }]).content;
  content = C.patch(content, [{ op: 'tailscale.serve', name: 'TS', serve: [
    { port: 8080, target: 'http://127.0.0.1:3000/' }, { port: 9000, target: 'unix:run/app.sock' },
  ] }]).content;
  assert.equal(JSON.stringify(plain(content).proxies.find((item) => item.name === 'TS').serve),
    '[{"port":80,"target":"unix:run/webui.sock"},{"port":8080,"target":"http://127.0.0.1:3000"},{"port":9000,"target":"unix:run/app.sock"}]');
  assert.equal(JSON.stringify(C.schema(content).tailscale[0].serve),
    '[{"port":8080,"target":"http://127.0.0.1:3000"},{"port":9000,"target":"unix:run/app.sock"}]');
  assert.throws(() => C.patch(content, [{ op: 'tailscale.serve', name: 'TS', serve: [{ port: 80, target: 'http://127.0.0.1:1' }] }]), /网页管理/);
  assert.throws(() => C.patch(content, [{ op: 'tailscale.serve', name: 'TS', serve: [{ port: 81, target: 'http://example.com:1' }] }]), /http:\/\/IP/);
  assert.throws(() => C.patch(content, [{ op: 'tailscale.serve', name: 'TS', serve: [{ port: 81, target: 'unix:a' }, { port: 81, target: 'unix:b' }] }]), /重复/);
  content = C.patch(content, [{ op: 'tailscale.serve', name: 'TS', serve: [] }]).content;
  assert.equal(JSON.stringify(plain(content).proxies.find((item) => item.name === 'TS').serve), '[{"port":80,"target":"unix:run/webui.sock"}]');
  content = C.patch(content, [{ op: 'tailscale.webui', name: 'TS', enable: false }]).content;
  assert.equal(plain(content).proxies.find((item) => item.name === 'TS').serve, undefined);
});

test('lint reports YAML errors with positions and never throws', () => {
  assert.equal(C.lint('a: 1\nb: 2\n').problems.length, 0);
  const bad = C.lint('a: 1\n  b: [1, 2\nc: 3\n').problems;
  assert.ok(bad.length > 0);
  assert.equal(bad[0].level, 'error');
  assert.ok(bad.every((item) => item.line >= 1 && item.col >= 1), JSON.stringify(bad));
  assert.match(C.lint('- 1\n- 2\n').problems[0].message, /映射/);
  assert.equal(C.lint('').problems.length, 0);
});

const nodeConfig = `# 节点测试
proxies:
  - {name: DNS_Hijack, type: dns}
  - name: 旧节点
    type: ss
    server: a.example
    port: 443
    cipher: aes-128-gcm
    password: x
x-group: &g
  type: select
  proxies: [旧节点]
proxy-groups:
  - name: 节点选择
    type: select
    proxies: [旧节点, DIRECT]
  - name: 继承
    <<: *g
  - name: 全部
    type: url-test
    include-all: true
  - name: 单独
    type: select
    use: [机场]
proxy-providers:
  机场: {type: http, url: "https://example.com/s", path: ./p.yaml}
rule-providers:
  cn: {type: http, behavior: domain, url: "https://example.com/cn.mrs", format: mrs, path: ./cn.mrs, proxy: 旧节点}
dns:
  nameserver: ["https://1.1.1.1/dns-query#旧节点"]
rules:
  # 注释保留
  - DOMAIN,a.test,旧节点
  - DOMAIN,b.test,旧节点,no-resolve
  - MATCH,节点选择
`;

test('node schema lists nodes with lock reasons and group editability', () => {
  const schema = JSON.parse(JSON.stringify(C.schema(nodeConfig).nodes));
  assert.deepEqual(schema.list.map((item) => [item.name, !!item.lock, item.groups.join('|')]), [['DNS_Hijack', true, ''], ['旧节点', false, '节点选择|继承']]);
  assert.deepEqual(schema.groups.map((group) => [group.name, group.auto, group.editable]), [['节点选择', false, true], ['继承', false, false], ['全部', true, true], ['单独', false, true]]);
  assert.equal(schema.list[1].data.cipher, 'aes-128-gcm');
});

test('proxy.add appends nodes and joins chosen groups', () => {
  const HK = { name: '🇭🇰 HK 01', type: 'trojan', server: 'hk.example', port: '443', password: 'pw', udp: true };
  const VL = { name: 'US/1', type: 'vless', server: 'us.example', port: 8443, uuid: 'u', network: 'ws', 'ws-opts': { path: '/v', headers: { Host: 'cdn.example' } } };
  const added = plain(C.patch(nodeConfig, [{ op: 'proxy.add', nodes: [HK, VL], groups: ['节点选择', '单独', '全部'] }]).content);
  assert.deepEqual([added.proxies.length, added.proxies[2].port, added.proxies[3]['ws-opts'].headers.Host], [4, 443, 'cdn.example']);
  assert.deepEqual(added['proxy-groups'][0].proxies, ['旧节点', 'DIRECT', '🇭🇰 HK 01', 'US/1']);
  assert.deepEqual(added['proxy-groups'][3].proxies, ['🇭🇰 HK 01', 'US/1']);
  assert.equal(added['proxy-groups'][2].proxies, undefined);
  const add = (node, groups) => () => C.patch(nodeConfig, [{ op: 'proxy.add', nodes: [node], groups }]);
  assert.throws(add({ ...HK, name: '节点选择' }), /已被占用/);
  assert.throws(add({ ...HK, name: '机场' }), /已被占用/);
  assert.throws(add({ ...HK, name: 'a,b' }), /名称无效/);
  assert.throws(add({ ...HK, type: 'snell' }), /不支持/);
  assert.throws(add({ ...HK, port: 70000 }), /端口无效/);
  assert.throws(add({ ...HK, server: 'a b' }), /服务器/);
  assert.throws(add({ ...HK, '<<': { x: 1 } }), /无效的字段/);
  assert.throws(add({ ...HK, extra: { a: { b: { c: { d: 1 } } } } }), /无效的字段/);
  assert.throws(add(HK, ['继承']), /继承自锚点/);
  assert.throws(add(HK, ['不存在']), /不存在/);
  assert.throws(() => C.patch(nodeConfig, [{ op: 'proxy.add', nodes: [HK, HK] }]), /已被占用/);
  const fresh = plain(C.patch('rules:\n  - MATCH,DIRECT\n', [{ op: 'proxy.add', nodes: [HK] }]).content);
  assert.equal(fresh.proxies[0].name, '🇭🇰 HK 01');
});

test('proxy.set renames references and keeps comments; unchanged nodes leave the file alone', () => {
  const node = C.schema(nodeConfig).nodes.list[1].data;
  const content = C.patch(nodeConfig, [{ op: 'proxy.set', name: '旧节点', data: { ...node, name: '新节点', port: 8443 }, groups: ['节点选择', '继承'] }]).content;
  const data = plain(content);
  assert.deepEqual([data.proxies[1].name, data.proxies[1].port, data.rules.slice(0, 2), data['rule-providers'].cn.proxy, data.dns.nameserver[0]],
    ['新节点', 8443, ['DOMAIN,a.test,新节点', 'DOMAIN,b.test,新节点,no-resolve'], '新节点', 'https://1.1.1.1/dns-query#新节点']);
  assert.deepEqual([data['proxy-groups'][0].proxies, data['proxy-groups'][1].proxies], [['新节点', 'DIRECT'], ['新节点']]);
  assert.match(content, /# 注释保留/);
  assert.match(content, /x-group: &g/);
  assert.equal(C.patch(nodeConfig, [{ op: 'proxy.set', name: '旧节点', data: { ...node }, groups: ['节点选择', '继承'] }]).content, nodeConfig);
  const left = plain(C.patch(nodeConfig, [{ op: 'proxy.set', name: '旧节点', data: node, groups: ['继承', '单独'] }]).content);
  assert.deepEqual([left['proxy-groups'][0].proxies, left['proxy-groups'][3].proxies], [['DIRECT'], ['旧节点']]);
  assert.throws(() => C.patch(nodeConfig, [{ op: 'proxy.set', name: '旧节点', data: node, groups: ['节点选择'] }]), /继承自锚点/);
  assert.throws(() => C.patch(nodeConfig, [{ op: 'proxy.set', name: '旧节点', data: { ...node, name: '节点选择' } }]), /已被占用/);
  assert.throws(() => C.patch(nodeConfig, [{ op: 'proxy.set', name: 'DNS_Hijack', data: node }]), /DNS 出站/);
  assert.throws(() => C.patch(nodeConfig, [{ op: 'proxy.set', name: 'Nope', data: node }]), /不存在/);
});

test('proxy.delete refuses referenced nodes and removes group members', () => {
  assert.throws(() => C.patch(nodeConfig, [{ op: 'proxy.delete', name: '旧节点' }]), (error) =>
    /规则第 2 条/.test(error.message) && /规则集 cn/.test(error.message) && /DNS 服务器/.test(error.message));
  const free = 'proxies:\n  - {name: a, type: socks5, server: 1.1.1.1, port: 1}\n  - {name: b, type: socks5, server: 1.1.1.1, port: 2}\n'
    + 'proxy-groups:\n  - {name: g, type: select, proxies: [a, b]}\n  - {name: h, type: select, proxies: [a], use: [p]}\n  - {name: i, type: select, proxies: [b]}\n'
    + 'proxy-providers:\n  p: {type: http, url: "https://e.com/s", path: ./p.yaml}\nrules:\n  - MATCH,g\n';
  const removed = plain(C.patch(free, [{ op: 'proxy.delete', name: 'a' }]).content);
  assert.deepEqual([removed.proxies.map((item) => item.name), removed['proxy-groups'][0].proxies, removed['proxy-groups'][1].proxies], [['b'], ['b'], undefined]);
  assert.throws(() => C.patch(free, [{ op: 'proxy.delete', name: 'b' }]), /只包含/);
  assert.throws(() => C.patch(nodeConfig, [{ op: 'proxy.delete', name: 'DNS_Hijack' }]), /DNS 出站/);
});

test('node links parse and forms round-trip through the engine', () => {
  const J = (value) => JSON.parse(JSON.stringify(value));
  const parsed = J(C.nodeParse('trojan://pw@hk.example:443?sni=s.example#HK' + String.fromCharCode(10) + 'bad://x', ['HK']));
  assert.deepEqual([parsed.nodes[0].node.name, parsed.nodes[0].summary, parsed.errors.length], ['HK 2', 'Trojan · hk.example:443', 1]);
  const form = J(C.nodeForm('vless', { name: 'a', type: 'vless', server: 's', port: 1, uuid: 'u', network: 'ws', foo: 1 }));
  assert.equal(form.values.network, 'ws');
  assert.deepEqual(form.extra, ['foo']);
  assert.deepEqual(form.fields.find((field) => field.key === 'ws-opts.path').when, { key: 'network', in: ['ws'] });
  assert.ok(form.types.some((item) => item.id === 'hysteria2'));
  const built = J(C.nodeBuild({ name: 'a', type: 'vless', server: 's', port: 1, uuid: 'u', foo: 1 }, 'vless', { ...form.values, port: '2', network: 'grpc', 'grpc-opts.grpc-service-name': 'svc' }));
  assert.deepEqual([built.node.port, built.node.foo, built.node['grpc-opts']['grpc-service-name']], [2, 1, 'svc']);
  assert.throws(() => C.nodeBuild({}, 'vless', { name: 'a', server: 's', port: '1' }), /UUID/);
});
