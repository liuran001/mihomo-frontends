'use strict';

// 共享的分享链接解析与节点表单（shared/proxylink.js），LuCI 与 Magisk 共用
const assert = require('node:assert/strict');
const { test } = require('node:test');
const L = require('../../shared/proxylink.js');

const enc = (s) => Buffer.from(s, 'utf8').toString('base64');
const encUrl = (s) => enc(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('Shadowsocks：SIP002、明文 userinfo、旧格式与插件', () => {
  assert.deepEqual(L.parseLink('ss://' + encUrl('aes-256-gcm:pa:ss') + '@1.2.3.4:8388#%F0%9F%87%AD%F0%9F%87%B0%20HK'),
    { name: '🇭🇰 HK', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'pa:ss', udp: true });
  assert.equal(L.parseLink('ss://2022-blake3-aes-128-gcm:YWJj%3D@h.example:443#x').password, 'YWJj=');
  const old = L.parseLink('ss://' + enc('chacha20-ietf-poly1305:pw@[2001:db8::1]:443') + '#old');
  assert.deepEqual([old.server, old.port, old.cipher, old.password, old.name], ['2001:db8::1', 443, 'chacha20-ietf-poly1305', 'pw', 'old']);
  const obfs = L.parseLink('ss://' + encUrl('aes-128-gcm:p') + '@h:80/?plugin=' + encodeURIComponent('obfs-local;obfs=http;obfs-host=a.example') + '#o');
  assert.deepEqual([obfs.plugin, obfs['plugin-opts']], ['obfs', { mode: 'http', host: 'a.example' }]);
  const v2 = L.parseLink('ss://' + encUrl('aes-128-gcm:p') + '@h:443?plugin=' + encodeURIComponent('v2ray-plugin;tls;host=c.example;path=/ws'));
  assert.deepEqual(v2['plugin-opts'], { mode: 'websocket', tls: true, host: 'c.example', path: '/ws' });
  assert.equal(v2.name, 'ss h:443', '无名称时用类型与地址');
});

test('ShadowsocksR', () => {
  const body = 'h.example:443:auth_aes128_md5:aes-256-cfb:tls1.2_ticket_auth:' + encUrl('pw') + '/?obfsparam=' + encUrl('o.example') + '&remarks=' + encUrl('日本');
  assert.deepEqual(L.parseLink('ssr://' + encUrl(body)), { name: '日本', type: 'ssr', server: 'h.example', port: 443, cipher: 'aes-256-cfb', password: 'pw',
    obfs: 'tls1.2_ticket_auth', protocol: 'auth_aes128_md5', udp: true, 'obfs-param': 'o.example' });
});

test('VMess：v2rayN JSON 与各传输方式', () => {
  const v = (o) => 'vmess://' + enc(JSON.stringify(o));
  assert.deepEqual(L.parseLink(v({ v: '2', ps: '美国', add: 'us.example', port: '443', id: 'uuid-1', aid: '0', scy: 'auto', net: 'ws', host: 'cdn.example', path: '/v', tls: 'tls', sni: 's.example' })),
    { name: '美国', type: 'vmess', server: 'us.example', port: 443, uuid: 'uuid-1', alterId: 0, cipher: 'auto', udp: true, tls: true, servername: 's.example',
      network: 'ws', 'ws-opts': { path: '/v', headers: { Host: 'cdn.example' } } });
  assert.deepEqual(L.parseLink(v({ add: 'h', port: 1, id: 'u', net: 'grpc', path: 'svc' }))['grpc-opts'], { 'grpc-service-name': 'svc' });
  const http = L.parseLink(v({ add: 'h', port: 80, id: 'u', net: 'tcp', type: 'http', host: 'a.com', path: '/x' }));
  assert.deepEqual([http.network, http['http-opts']], ['http', { path: ['/x'], headers: { Host: ['a.com'] } }]);
  assert.equal(L.parseLink(v({ add: 'h', port: 80, id: 'u', net: 'tcp' })).network, undefined);
  assert.throws(() => L.parseLink('vmess://not-json'), /v2rayN/);
});

test('VLESS：Reality、TLS + WebSocket、XHTTP', () => {
  assert.deepEqual(L.parseLink('vless://11111111-2222@r.example:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.apple.com&fp=chrome&pbk=PUBKEY&sid=ab12&type=tcp#R'),
    { name: 'R', type: 'vless', server: 'r.example', port: 443, uuid: '11111111-2222', udp: true, flow: 'xtls-rprx-vision', tls: true,
      servername: 'www.apple.com', 'client-fingerprint': 'chrome', 'reality-opts': { 'public-key': 'PUBKEY', 'short-id': 'ab12' } });
  const ws = L.parseLink('vless://u@h:443?security=tls&type=ws&host=cdn.example&path=%2Fpath%3Fed%3D2048&allowInsecure=1#w');
  assert.deepEqual([ws['ws-opts'], ws['skip-cert-verify']], [{ path: '/path?ed=2048', headers: { Host: 'cdn.example' } }, true]);
  const xh = L.parseLink('vless://u@h:443?security=tls&type=xhttp&path=/x&mode=auto');
  assert.deepEqual([xh.network, xh['xhttp-opts']], ['xhttp', { path: '/x', mode: 'auto' }]);
  assert.throws(() => L.parseLink('vless://h:443'), /UUID/);
  assert.throws(() => L.parseLink('vless://u@h:443?type=kcp'), /不支持的传输方式/);
});

test('Trojan、AnyTLS、TUIC', () => {
  assert.deepEqual(L.parseLink('trojan://p%40ss@t.example:443?sni=s.example&alpn=h2,http/1.1#T'),
    { name: 'T', type: 'trojan', server: 't.example', port: 443, password: 'p@ss', udp: true, sni: 's.example', alpn: ['h2', 'http/1.1'] });
  assert.deepEqual(L.parseLink('anytls://pw@a.example:443?insecure=1#A'),
    { name: 'A', type: 'anytls', server: 'a.example', port: 443, password: 'pw', udp: true, 'skip-cert-verify': true });
  assert.deepEqual(L.parseLink('tuic://uuid:pw@t.example:443?congestion_control=bbr&alpn=h3&udp_relay_mode=native#TU'),
    { name: 'TU', type: 'tuic', server: 't.example', port: 443, uuid: 'uuid', password: 'pw', alpn: ['h3'], 'congestion-controller': 'bbr', 'udp-relay-mode': 'native', udp: true });
});

test('Hysteria2：混淆与端口跳跃；Hysteria v1', () => {
  assert.deepEqual(L.parseLink('hy2://pw@h.example:443?sni=s.example&obfs=salamander&obfs-password=op&insecure=1#H'),
    { name: 'H', type: 'hysteria2', server: 'h.example', port: 443, password: 'pw', sni: 's.example', 'skip-cert-verify': true, obfs: 'salamander', 'obfs-password': 'op' });
  const hop = L.parseLink('hysteria2://pw@h.example:443,20000-30000/?sni=s#hop');
  assert.deepEqual([hop.server, hop.port, hop.ports], ['h.example', 443, '443,20000-30000']);
  assert.equal(L.parseLink('hysteria2://pw@h:443?mport=1000-2000').ports, '1000-2000');
  const v1 = L.parseLink('hysteria://h.example:443?protocol=udp&auth=a&peer=s&upmbps=10&downmbps=50#v1');
  assert.deepEqual([v1['auth-str'], v1.sni, v1.up, v1.down], ['a', 's', '10', '50']);
});

test('SOCKS5 与 WireGuard', () => {
  assert.deepEqual(L.parseLink('socks://' + encUrl('user:pass') + '@1.1.1.1:1080#S'),
    { name: 'S', type: 'socks5', server: '1.1.1.1', port: 1080, udp: true, username: 'user', password: 'pass' });
  assert.deepEqual(L.parseLink('wireguard://PRIV%3D@162.159.192.1:2408?publickey=PUB%3D&address=172.16.0.2/32,2606:4700::1/128&reserved=1,2,3&mtu=1280#WARP'),
    { name: 'WARP', type: 'wireguard', server: '162.159.192.1', port: 2408, 'private-key': 'PRIV=', udp: true, 'public-key': 'PUB=',
      ip: '172.16.0.2', ipv6: '2606:4700::1', mtu: 1280, reserved: [1, 2, 3] });
});

test('批量解析：逐行、base64 订阅、名称去重与错误行', () => {
  const text = 'trojan://a@h1:443#同名\n\nfoo://x\ntrojan://b@h2:443#同名\nvless://u@h:99999#bad';
  const r = L.parseText(text, ['同名']);
  assert.deepEqual(r.nodes.map(n => n.name), ['同名 2', '同名 3']);
  assert.deepEqual(r.errors.map(e => [e.line, e.error]), [[2, '不支持的链接类型：foo'], [4, '端口无效']]);
  assert.equal(L.parseText(enc('trojan://a@h:443#x\nanytls://b@h:443#y')).nodes.length, 2);
  assert.equal(L.parseLink('trojan://a@h:443#a,b').name, 'a，b', '英文逗号会破坏规则，替换为全角');
  assert.throws(() => L.parseText(Array(257).fill('trojan://a@h:1').join('\n')), /最多/);
});

test('表单：点路径、按条件显示、保留未知字段、必填检查', () => {
  const vmess = L.parseLink('vmess://' + enc(JSON.stringify({ add: 'h', port: 443, id: 'u', net: 'ws', path: '/p', host: 'x' })));
  vmess['smux'] = { enabled: true };
  assert.equal(L.getPath(vmess, 'ws-opts.headers.Host'), 'x');
  const ws = L.fields('vmess').find(f => f.key === 'ws-opts.path');
  assert.equal(L.visible(ws, vmess), true);
  // 改成 gRPC：WebSocket 字段被清掉，未知字段 smux 保留
  const g = L.applyForm(vmess, 'vmess', { network: 'grpc', 'grpc-opts.grpc-service-name': 'svc' });
  assert.deepEqual([g['ws-opts'], g['grpc-opts'], g.smux], [undefined, { 'grpc-service-name': 'svc' }, { enabled: true }]);
  assert.equal(L.applyForm(g, 'vmess', { network: 'tcp' }).network, undefined, 'TCP 是默认值，不写');
  assert.deepEqual(L.setPath({ a: { b: 1 } }, 'a.b', ''), {}, '清空后删除空的上级映射');
  assert.equal(L.check({ name: 'n', type: 'trojan', server: 'h', port: 443 }), '请填写密码');
  assert.equal(L.check({ name: 'a,b', type: 'trojan', server: 'h', port: 443, password: 'p' }), '名称不能包含英文逗号，最长 128 个字符');
  assert.equal(L.check({ name: 'n', type: 'trojan', server: 'h', port: 70000, password: 'p' }), '端口无效');
  assert.equal(L.check(L.parseLink('trojan://a@h:443#x')), null);
  assert.equal(L.summary(L.parseLink('vless://u@h:443?security=reality&pbk=k&type=grpc')), 'VLESS · h:443 · grpc · Reality');
  // 每个协议的字段 key 不重复
  for (const p of L.PROTOCOLS) {
    const keys = L.fields(p.type).map(f => f.key);
    assert.equal(new Set(keys).size, keys.length, p.type);
  }
});
