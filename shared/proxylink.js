// 单个节点与策略组：分享链接解析、各协议与策略组的表单字段。LuCI 与 Magisk 共用这一份（纯函数，无 I/O）。
// LuCI 由 luci/scripts/sync-template.sh 包装为 mihomo/proxylink.js；Magisk 构建时原样复制，页面中为 globalThis.mihomoProxyLink。
// 解析得到的是 mihomo 的 proxies 条目；协议细节由内核在保存前的 mihomo -t 校验兜底。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports !== undefined) module.exports = api;
  else root.mihomoProxyLink = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_LINKS = 256;

  /* ---------- 基础 ---------- */

  function decode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  // base64 / base64url → UTF-8 文本；不是合法 base64 时返回 null
  function b64(s) {
    let t = String(s || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!t || /[^A-Za-z0-9+/=]/.test(t)) return null;
    t = t.replace(/=+$/, '');
    if (t.length % 4 === 1) return null;
    while (t.length % 4) t += '=';
    try {
      const bin = atob(t);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  function bool(v) {
    return v === '1' || v === 'true' || v === 'yes' || v === true;
  }

  function list(v) {
    return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  function int(v) {
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  }

  // scheme://[userinfo@]host[:port][/path][?query][#fragment]，host 可为 [IPv6]
  function splitUrl(link) {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^#]*)(?:#(.*))?$/i.exec(link);
    if (!m) return null;
    let rest = m[2], query = '';
    const q = rest.indexOf('?');
    if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
    let path = '';
    const at = rest.lastIndexOf('@');
    const slash = rest.indexOf('/', at + 1);
    if (slash >= 0) { path = rest.slice(slash); rest = rest.slice(0, slash); }
    let user = null, hostport = rest;
    if (at >= 0) { user = rest.slice(0, at); hostport = rest.slice(at + 1); }
    let host = hostport, port = null;
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostport);
    if (v6) { host = v6[1]; port = v6[2] || null; }
    else {
      const c = hostport.lastIndexOf(':');
      if (c >= 0 && /^\d*$/.test(hostport.slice(c + 1))) { host = hostport.slice(0, c); port = hostport.slice(c + 1) || null; }
    }
    const params = {};
    for (const kv of query.split('&')) {
      if (!kv) continue;
      const e = kv.indexOf('=');
      const k = decode(e < 0 ? kv : kv.slice(0, e));
      params[k] = e < 0 ? '' : decode(kv.slice(e + 1));
    }
    return { scheme: m[1].toLowerCase(), user: user, host: decode(host), port: port, path: path, params: params, name: m[3] != null ? decode(m[3]).trim() : '' };
  }

  function needHostPort(u) {
    if (!u.host) throw new Error('缺少服务器地址');
    const port = int(u.port);
    if (port == null || port < 1 || port > 65535) throw new Error('端口无效');
    return port;
  }

  function put(o, k, v) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
    o[k] = v;
  }

  // TLS 相关查询参数（vless / trojan / anytls 等通用）
  function tlsOpts(node, p, sniKey) {
    put(node, sniKey, p.sni || p.peer || p.host_sni);
    if (bool(p.allowInsecure) || bool(p.insecure) || bool(p.allow_insecure)) node['skip-cert-verify'] = true;
    put(node, 'client-fingerprint', p.fp);
    put(node, 'alpn', list(p.alpn));
  }

  // 传输层：tcp / ws / httpupgrade / grpc / h2 / http / xhttp
  function transport(node, net, p) {
    net = (net || 'tcp').toLowerCase();
    const host = p.host || '';
    const path = p.path || '';
    if (net === 'tcp' && (p.headerType || p.type) === 'http') {
      node.network = 'http';
      node['http-opts'] = {};
      put(node['http-opts'], 'path', list(path || '/'));
      if (host) node['http-opts'].headers = { Host: list(host) };
      return;
    }
    if (net === 'ws' || net === 'httpupgrade') {
      node.network = 'ws';
      const o = {};
      put(o, 'path', path || '/');
      if (host) o.headers = { Host: host };
      if (net === 'httpupgrade') o['v2ray-http-upgrade'] = true;
      node['ws-opts'] = o;
    } else if (net === 'grpc') {
      node.network = 'grpc';
      node['grpc-opts'] = {};
      put(node['grpc-opts'], 'grpc-service-name', p.serviceName || p.path || '');
    } else if (net === 'h2') {
      node.network = 'h2';
      const o = {};
      put(o, 'host', list(host));
      put(o, 'path', path || '/');
      node['h2-opts'] = o;
    } else if (net === 'xhttp' || net === 'splithttp') {
      node.network = 'xhttp';
      const o = {};
      put(o, 'path', path || '/');
      put(o, 'host', host);
      put(o, 'mode', p.mode);
      node['xhttp-opts'] = o;
    } else if (net !== 'tcp' && net !== 'raw' && net !== '') {
      throw new Error('不支持的传输方式：' + net);
    }
  }

  /* ---------- 各协议 ---------- */

  function ssPlugin(node, spec) {
    const parts = spec.split(';').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const name = parts.shift();
    const o = {};
    for (const kv of parts) {
      const e = kv.indexOf('=');
      o[e < 0 ? kv : kv.slice(0, e)] = e < 0 ? true : kv.slice(e + 1);
    }
    if (name === 'obfs-local' || name === 'simple-obfs' || name === 'obfs') {
      node.plugin = 'obfs';
      node['plugin-opts'] = {};
      put(node['plugin-opts'], 'mode', o.obfs || 'http');
      put(node['plugin-opts'], 'host', o['obfs-host']);
    } else if (name === 'v2ray-plugin') {
      node.plugin = 'v2ray-plugin';
      node['plugin-opts'] = { mode: o.mode === 'quic' ? 'quic' : 'websocket' };
      if (o.tls === true || o.tls === 'true') node['plugin-opts'].tls = true;
      put(node['plugin-opts'], 'host', o.host);
      put(node['plugin-opts'], 'path', o.path);
    } else if (name === 'shadow-tls') {
      node.plugin = 'shadow-tls';
      node['plugin-opts'] = {};
      put(node['plugin-opts'], 'host', o.host);
      put(node['plugin-opts'], 'password', o.password);
      if (int(o.version) != null) node['plugin-opts'].version = int(o.version);
    } else {
      throw new Error('不支持的 Shadowsocks 插件：' + name);
    }
  }

  function parseSs(link) {
    let u = splitUrl(link);
    if (!u) throw new Error('链接格式无效');
    // 旧格式：ss://base64(method:password@host:port)#name
    if (u.user == null) {
      const body = link.slice(5).split('#')[0].split('?')[0];
      const plain = b64(decode(body));
      if (!plain || plain.indexOf('@') < 0) throw new Error('链接格式无效');
      const name = u.name;
      u = splitUrl('ss://' + plain + (link.indexOf('?') >= 0 ? '?' + link.split('?')[1].split('#')[0] : ''));
      if (!u) throw new Error('链接格式无效');
      u.user = encodeURIComponent(u.user);
      u.name = name;
    }
    let info = decode(u.user);
    if (info.indexOf(':') < 0) info = b64(u.user) || '';
    const c = info.indexOf(':');
    if (c <= 0) throw new Error('缺少加密方式或密码');
    const node = { name: u.name, type: 'ss', server: u.host, port: needHostPort(u), cipher: info.slice(0, c), password: info.slice(c + 1), udp: true };
    if (u.params.plugin) ssPlugin(node, u.params.plugin);
    if (bool(u.params.uot) || bool(u.params['udp-over-tcp'])) node['udp-over-tcp'] = true;
    return node;
  }

  function parseSsr(link) {
    const body = b64(link.slice(6));
    if (!body) throw new Error('链接格式无效');
    const q = body.indexOf('/?');
    const main = q >= 0 ? body.slice(0, q) : body;
    const parts = main.split(':');
    if (parts.length < 6) throw new Error('链接格式无效');
    const pass = b64(parts.pop());
    const obfs = parts.pop(), cipher = parts.pop(), protocol = parts.pop(), port = int(parts.pop());
    const server = parts.join(':');
    if (!server || port == null || port < 1 || port > 65535 || pass == null) throw new Error('链接格式无效');
    const p = {};
    for (const kv of (q >= 0 ? body.slice(q + 2) : '').split('&')) {
      const e = kv.indexOf('=');
      if (e > 0) p[kv.slice(0, e)] = b64(kv.slice(e + 1)) || '';
    }
    const node = { name: p.remarks || '', type: 'ssr', server: server, port: port, cipher: cipher, password: pass, obfs: obfs, protocol: protocol, udp: true };
    put(node, 'obfs-param', p.obfsparam);
    put(node, 'protocol-param', p.protoparam);
    return node;
  }

  function parseVmess(link) {
    const text = b64(link.slice(8));
    let j = null;
    try { j = text && JSON.parse(text); } catch (e) { j = null; }
    if (!j || typeof j !== 'object') throw new Error('不是 v2rayN 格式的 vmess 链接');
    const u = { host: String(j.add || ''), port: String(j.port || '') };
    const node = { name: String(j.ps || '').trim(), type: 'vmess', server: u.host, port: needHostPort(u), uuid: String(j.id || ''),
      alterId: int(j.aid) || 0, cipher: j.scy || 'auto', udp: true };
    if (j.tls === 'tls') {
      node.tls = true;
      put(node, 'servername', j.sni || j.host);
    }
    if (bool(j.allowInsecure) || bool(j['skip-cert-verify'])) node['skip-cert-verify'] = true;
    put(node, 'client-fingerprint', j.fp);
    put(node, 'alpn', list(j.alpn));
    transport(node, j.net, { host: j.host, path: j.path, type: j.type, serviceName: j.path });
    return node;
  }

  function parseVless(link) {
    const u = splitUrl(link);
    if (!u || !u.user) throw new Error('缺少 UUID');
    const p = u.params;
    const node = { name: u.name, type: 'vless', server: u.host, port: needHostPort(u), uuid: decode(u.user), udp: true };
    put(node, 'flow', p.flow);
    if (p.encryption && p.encryption !== 'none') node.encryption = p.encryption;
    const sec = (p.security || '').toLowerCase();
    if (sec === 'tls' || sec === 'reality' || sec === 'xtls') {
      node.tls = true;
      tlsOpts(node, p, 'servername');
      if (sec === 'reality') {
        node['reality-opts'] = {};
        put(node['reality-opts'], 'public-key', p.pbk);
        put(node['reality-opts'], 'short-id', p.sid);
        if (!node['client-fingerprint']) node['client-fingerprint'] = 'chrome';
      }
    }
    transport(node, p.type, p);
    return node;
  }

  function parseTrojan(link) {
    const u = splitUrl(link);
    if (!u || !u.user) throw new Error('缺少密码');
    const p = u.params;
    const node = { name: u.name, type: 'trojan', server: u.host, port: needHostPort(u), password: decode(u.user), udp: true };
    tlsOpts(node, p, 'sni');
    transport(node, p.type, p);
    return node;
  }

  function parseHysteria2(link) {
    const u = splitUrl(link);
    if (!u) throw new Error('链接格式无效');
    const p = u.params;
    if (!u.host) throw new Error('缺少服务器地址');
    // 端口可写成 443,20000-30000（端口跳跃）
    let port = int(u.port);
    const node = { name: u.name, type: 'hysteria2', server: u.host };
    const hop = u.port == null ? /^(.+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)+|\d+-\d+)$/.exec(u.host) : null;
    if (hop) {
      node.server = hop[1].replace(/^\[(.*)\]$/, '$1');
      node.ports = hop[2];
      port = int(hop[2].split(/[,-]/)[0]);
    }
    if (port == null || port < 1 || port > 65535) throw new Error('端口无效');
    node.port = port;
    put(node, 'ports', p.mport || p.ports);
    put(node, 'password', decode(u.user || p.auth || ''));
    tlsOpts(node, p, 'sni');
    if (p.obfs && p.obfs !== 'none') { node.obfs = p.obfs; put(node, 'obfs-password', p['obfs-password']); }
    put(node, 'up', p.upmbps || p.up);
    put(node, 'down', p.downmbps || p.down);
    put(node, 'fingerprint', p.pinSHA256);
    return node;
  }

  function parseHysteria(link) {
    const u = splitUrl(link);
    if (!u) throw new Error('链接格式无效');
    const p = u.params;
    const node = { name: u.name, type: 'hysteria', server: u.host, port: needHostPort(u) };
    put(node, 'ports', p.mport);
    put(node, 'protocol', p.protocol);
    put(node, 'auth-str', p.auth || p.auth_str);
    tlsOpts(node, p, 'sni');
    put(node, 'up', p.upmbps || p.up || '20');
    put(node, 'down', p.downmbps || p.down || '100');
    put(node, 'obfs', p.obfsParam || p.obfs);
    return node;
  }

  function parseTuic(link) {
    const u = splitUrl(link);
    if (!u || !u.user) throw new Error('缺少 UUID 与密码');
    const p = u.params;
    const info = decode(u.user), c = info.indexOf(':');
    const node = { name: u.name, type: 'tuic', server: u.host, port: needHostPort(u) };
    if (c > 0) { node.uuid = info.slice(0, c); node.password = info.slice(c + 1); } else node.token = info;
    tlsOpts(node, p, 'sni');
    put(node, 'congestion-controller', p.congestion_control || p.congestion_controller);
    put(node, 'udp-relay-mode', p.udp_relay_mode);
    if (bool(p.reduce_rtt)) node['reduce-rtt'] = true;
    if (bool(p.disable_sni)) node['disable-sni'] = true;
    node.udp = true;
    return node;
  }

  function parseAnytls(link) {
    const u = splitUrl(link);
    if (!u || !u.user) throw new Error('缺少密码');
    const node = { name: u.name, type: 'anytls', server: u.host, port: needHostPort(u), password: decode(u.user), udp: true };
    tlsOpts(node, u.params, 'sni');
    return node;
  }

  function parseSocks(link) {
    const u = splitUrl(link);
    if (!u) throw new Error('链接格式无效');
    const node = { name: u.name, type: 'socks5', server: u.host, port: needHostPort(u), udp: true };
    if (u.user) {
      let info = decode(u.user);
      if (info.indexOf(':') < 0) info = b64(u.user) || info;
      const c = info.indexOf(':');
      put(node, 'username', c >= 0 ? info.slice(0, c) : info);
      put(node, 'password', c >= 0 ? info.slice(c + 1) : '');
    }
    return node;
  }

  function parseWireguard(link) {
    const u = splitUrl(link);
    if (!u || !u.user) throw new Error('缺少私钥');
    const p = u.params;
    const node = { name: u.name, type: 'wireguard', server: u.host, port: needHostPort(u), 'private-key': decode(u.user), udp: true };
    put(node, 'public-key', p.publickey || p.publicKey);
    put(node, 'pre-shared-key', p.presharedkey || p.preSharedKey);
    for (const a of list(p.address || p.ip)) {
      const ip = a.replace(/\/\d+$/, '');
      if (ip.indexOf(':') >= 0) put(node, 'ipv6', ip); else put(node, 'ip', ip);
    }
    if (int(p.mtu)) node.mtu = int(p.mtu);
    if (p.reserved) {
      const r = list(p.reserved).map(int);
      node.reserved = r.length === 3 && r.every(n => n != null) ? r : p.reserved;
    }
    return node;
  }

  const PARSERS = {
    ss: parseSs, ssr: parseSsr, vmess: parseVmess, vless: parseVless, trojan: parseTrojan,
    hysteria2: parseHysteria2, hy2: parseHysteria2, hysteria: parseHysteria, tuic: parseTuic, anytls: parseAnytls,
    socks: parseSocks, socks5: parseSocks, wireguard: parseWireguard, wg: parseWireguard
  };

  // 解析一条分享链接 → mihomo 节点；无名称时用「类型 服务器:端口」
  function parseLink(link) {
    const s = String(link || '').trim();
    const m = /^([a-z0-9]+):\/\//i.exec(s);
    const fn = m && PARSERS[m[1].toLowerCase()];
    if (!fn) throw new Error('不支持的链接类型' + (m ? '：' + m[1] : ''));
    const node = fn(s);
    if (!node.name) node.name = node.type + ' ' + node.server + ':' + node.port;
    node.name = node.name.replace(/[\x00-\x1f\x7f]/g, '').replace(/,/g, '，').slice(0, 128).trim();
    return node;
  }

  // 解析粘贴的文本：每行一条链接，或整体 base64 编码的订阅内容。名称与 taken 及彼此不重复
  function parseText(text, taken) {
    let t = String(text || '').trim();
    if (!/:\/\//.test(t)) {
      const dec = b64(t);
      if (dec && /:\/\//.test(dec)) t = dec;
    }
    const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length > MAX_LINKS) throw new Error('一次最多导入 ' + MAX_LINKS + ' 条链接');
    const used = new Set(taken || []);
    const nodes = [], errors = [];
    lines.forEach((line, i) => {
      try {
        const node = parseLink(line);
        node.name = uniqueName(node.name, used);
        used.add(node.name);
        nodes.push(node);
      } catch (e) {
        errors.push({ line: i + 1, text: line.length > 60 ? line.slice(0, 57) + '…' : line, error: e.message });
      }
    });
    return { nodes: nodes, errors: errors };
  }

  function uniqueName(name, used) {
    if (!used.has(name)) return name;
    for (let k = 2; ; k++) if (!used.has(name + ' ' + k)) return name + ' ' + k;
  }

  /* ---------- 表单字段 ---------- */

  // 字段：key 为点路径（ws-opts.headers.Host）；kind：text secret int bool enum list policy；adv 为高级项；
  // when：{ key, in: [...] } 仅在另一字段取这些值时显示（bool 字段用 true）。
  const F = (key, label, kind, extra) => Object.assign({ key: key, label: label, kind: kind }, extra || {});

  const CIPHERS_SS = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm',
    '2022-blake3-chacha20-poly1305', 'xchacha20-ietf-poly1305', 'aes-128-ctr', 'aes-256-cfb', 'rc4-md5', 'none'];
  const FINGERPRINTS = ['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random'];
  const NETWORKS = [['tcp', 'TCP（默认）'], ['ws', 'WebSocket'], ['grpc', 'gRPC'], ['h2', 'HTTP/2'], ['http', 'HTTP 伪装'], ['xhttp', 'XHTTP']];

  const SNI_HELP = '握手时声明的域名（SNI），留空时使用服务器地址';
  const INSECURE = F('skip-cert-verify', '跳过证书验证', 'bool', { adv: true, help: '不检查服务器证书。只在自签证书时开启，会降低安全性' });
  const FP = F('client-fingerprint', 'TLS 指纹', 'enum', { options: FINGERPRINTS, adv: true, help: '模拟浏览器的 TLS 握手特征，Reality 必填' });
  const ALPN = F('alpn', 'ALPN', 'list', { adv: true, help: '多个用逗号分隔，例如 h2,http/1.1' });

  function transportFields(nets) {
    const when = (v) => ({ key: 'network', in: v });
    return [
      F('network', '传输方式', 'enum', { options: NETWORKS.filter(n => nets.indexOf(n[0]) >= 0), help: '与服务端保持一致；不确定时保持 TCP' }),
      F('ws-opts.path', 'WebSocket 路径', 'text', { when: when(['ws']), placeholder: '/' }),
      F('ws-opts.headers.Host', 'WebSocket Host', 'text', { when: when(['ws']), help: '伪装的域名，留空时使用服务器地址' }),
      F('ws-opts.v2ray-http-upgrade', 'HTTPUpgrade', 'bool', { when: when(['ws']), adv: true, help: '服务端使用 httpupgrade 传输时开启' }),
      F('grpc-opts.grpc-service-name', 'gRPC 服务名', 'text', { when: when(['grpc']) }),
      F('h2-opts.host', 'HTTP/2 Host', 'list', { when: when(['h2']) }),
      F('h2-opts.path', 'HTTP/2 路径', 'text', { when: when(['h2']), placeholder: '/' }),
      F('http-opts.path', 'HTTP 路径', 'list', { when: when(['http']), placeholder: '/' }),
      F('http-opts.headers.Host', 'HTTP Host', 'list', { when: when(['http']) }),
      F('xhttp-opts.path', 'XHTTP 路径', 'text', { when: when(['xhttp']), placeholder: '/' }),
      F('xhttp-opts.host', 'XHTTP Host', 'text', { when: when(['xhttp']) }),
      F('xhttp-opts.mode', 'XHTTP 模式', 'enum', { when: when(['xhttp']), options: ['', 'auto', 'packet-up', 'stream-up', 'stream-one'], adv: true })
    ];
  }

  // 所有类型共有的高级字段
  const COMMON = [
    F('udp', '允许 UDP', 'bool', { adv: true, help: '游戏、语音通话、QUIC 等需要 UDP；服务端不支持时关闭' }),
    F('dialer-proxy', '前置代理', 'policy', { adv: true, help: '先经过这个节点或策略组再连接本节点（链式代理）' }),
    F('ip-version', 'IP 版本', 'enum', { adv: true, options: ['', 'dual', 'ipv4', 'ipv6', 'ipv4-prefer', 'ipv6-prefer'], help: '解析服务器域名时使用的地址类型' }),
    F('tfo', 'TCP Fast Open', 'bool', { adv: true }),
    F('interface-name', '出站网卡', 'text', { adv: true, help: '指定从哪个网卡连接服务器，一般留空' })
  ];

  const PROTOCOLS = [
    { type: 'ss', label: 'Shadowsocks', fields: [
      F('cipher', '加密方式', 'enum', { options: CIPHERS_SS, required: true }),
      F('password', '密码', 'secret', { required: true }),
      F('plugin', '插件', 'enum', { options: [['', '不使用'], ['obfs', 'simple-obfs'], ['v2ray-plugin', 'v2ray-plugin'], ['shadow-tls', 'ShadowTLS']] }),
      F('plugin-opts.mode', '插件模式', 'enum', { when: { key: 'plugin', in: ['obfs', 'v2ray-plugin'] }, options: ['http', 'tls', 'websocket'] }),
      F('plugin-opts.host', '插件 Host', 'text', { when: { key: 'plugin', in: ['obfs', 'v2ray-plugin', 'shadow-tls'] } }),
      F('plugin-opts.path', '插件路径', 'text', { when: { key: 'plugin', in: ['v2ray-plugin'] } }),
      F('plugin-opts.tls', '插件 TLS', 'bool', { when: { key: 'plugin', in: ['v2ray-plugin'] } }),
      F('plugin-opts.password', 'ShadowTLS 密码', 'secret', { when: { key: 'plugin', in: ['shadow-tls'] } }),
      F('plugin-opts.version', 'ShadowTLS 版本', 'int', { when: { key: 'plugin', in: ['shadow-tls'] }, placeholder: '3' }),
      F('udp-over-tcp', 'UDP over TCP', 'bool', { adv: true, help: '把 UDP 封装在 TCP 里传输，服务端需要支持' })
    ] },
    { type: 'vmess', label: 'VMess', fields: [
      F('uuid', 'UUID', 'secret', { required: true }),
      F('alterId', 'alterId', 'int', { adv: true, placeholder: '0', help: '新服务端都是 0' }),
      F('cipher', '加密方式', 'enum', { options: ['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305'] }),
      F('tls', 'TLS', 'bool'),
      F('servername', 'SNI', 'text', { when: { key: 'tls', in: [true] }, help: SNI_HELP }),
      ...transportFields(['tcp', 'ws', 'grpc', 'h2', 'http']),
      INSECURE, FP, ALPN
    ] },
    { type: 'vless', label: 'VLESS', fields: [
      F('uuid', 'UUID', 'secret', { required: true }),
      F('flow', '流控', 'enum', { options: [['', '无'], ['xtls-rprx-vision', 'xtls-rprx-vision']], help: '与服务端一致，Reality 通常为 xtls-rprx-vision' }),
      F('tls', 'TLS', 'bool', { help: '使用 TLS 或 Reality 时开启' }),
      F('servername', 'SNI', 'text', { when: { key: 'tls', in: [true] }, help: SNI_HELP }),
      F('reality-opts.public-key', 'Reality 公钥', 'text', { when: { key: 'tls', in: [true] }, help: '使用 Reality 时填写（pbk），留空即普通 TLS' }),
      F('reality-opts.short-id', 'Reality Short ID', 'text', { when: { key: 'tls', in: [true] } }),
      ...transportFields(['tcp', 'ws', 'grpc', 'h2', 'http', 'xhttp']),
      F('encryption', '加密', 'text', { adv: true, help: '一般留空（none）' }),
      INSECURE, FP, ALPN
    ] },
    { type: 'trojan', label: 'Trojan', fields: [
      F('password', '密码', 'secret', { required: true }),
      F('sni', 'SNI', 'text', { help: SNI_HELP }),
      ...transportFields(['tcp', 'ws', 'grpc']),
      INSECURE, FP, ALPN
    ] },
    { type: 'hysteria2', label: 'Hysteria2', fields: [
      F('password', '密码', 'secret', { required: true }),
      F('sni', 'SNI', 'text', { help: SNI_HELP }),
      F('ports', '端口跳跃', 'text', { adv: true, placeholder: '20000-30000', help: '服务端开启端口跳跃时填写，例如 443,20000-30000' }),
      F('obfs', '混淆', 'enum', { options: [['', '不使用'], ['salamander', 'salamander']] }),
      F('obfs-password', '混淆密码', 'secret', { when: { key: 'obfs', in: ['salamander'] } }),
      F('up', '上行带宽', 'text', { adv: true, placeholder: '50 Mbps', help: '留空时使用 BBR 拥塞控制' }),
      F('down', '下行带宽', 'text', { adv: true, placeholder: '200 Mbps' }),
      INSECURE, ALPN
    ] },
    { type: 'tuic', label: 'TUIC', fields: [
      F('uuid', 'UUID', 'secret', { required: true }),
      F('password', '密码', 'secret', { required: true }),
      F('sni', 'SNI', 'text', { help: SNI_HELP }),
      F('congestion-controller', '拥塞控制', 'enum', { options: ['', 'bbr', 'cubic', 'new_reno'] }),
      F('udp-relay-mode', 'UDP 转发模式', 'enum', { adv: true, options: ['', 'native', 'quic'] }),
      F('reduce-rtt', '0-RTT', 'bool', { adv: true, help: '减少握手延迟，服务端需要支持' }),
      INSECURE, ALPN
    ] },
    { type: 'anytls', label: 'AnyTLS', fields: [
      F('password', '密码', 'secret', { required: true }),
      F('sni', 'SNI', 'text', { help: SNI_HELP }),
      INSECURE, FP, ALPN
    ] },
    { type: 'hysteria', label: 'Hysteria（v1）', fields: [
      F('auth-str', '认证密码', 'secret'),
      F('protocol', '协议', 'enum', { options: ['', 'udp', 'wechat-video', 'faketcp'] }),
      F('up', '上行带宽', 'text', { required: true, placeholder: '20 Mbps' }),
      F('down', '下行带宽', 'text', { required: true, placeholder: '100 Mbps' }),
      F('sni', 'SNI', 'text', { help: SNI_HELP }),
      F('obfs', '混淆密码', 'secret', { adv: true }),
      INSECURE, ALPN
    ] },
    { type: 'ssr', label: 'ShadowsocksR', fields: [
      F('cipher', '加密方式', 'text', { required: true }),
      F('password', '密码', 'secret', { required: true }),
      F('obfs', '混淆', 'text', { required: true, placeholder: 'plain' }),
      F('obfs-param', '混淆参数', 'text', { adv: true }),
      F('protocol', '协议', 'text', { required: true, placeholder: 'origin' }),
      F('protocol-param', '协议参数', 'text', { adv: true })
    ] },
    { type: 'socks5', label: 'SOCKS5', fields: [
      F('username', '用户名', 'text'),
      F('password', '密码', 'secret'),
      F('tls', 'TLS', 'bool', { adv: true }),
      INSECURE
    ] },
    { type: 'http', label: 'HTTP', fields: [
      F('username', '用户名', 'text'),
      F('password', '密码', 'secret'),
      F('tls', 'HTTPS', 'bool'),
      F('sni', 'SNI', 'text', { when: { key: 'tls', in: [true] }, help: SNI_HELP }),
      INSECURE
    ] },
    { type: 'wireguard', label: 'WireGuard', fields: [
      F('private-key', '本机私钥', 'secret', { required: true }),
      F('public-key', '服务端公钥', 'text', { required: true }),
      F('ip', 'IPv4 地址', 'text', { placeholder: '172.16.0.2', help: '分配给本机的隧道地址' }),
      F('ipv6', 'IPv6 地址', 'text', { adv: true }),
      F('pre-shared-key', '预共享密钥', 'secret', { adv: true }),
      F('reserved', 'reserved', 'text', { adv: true, help: 'Cloudflare WARP 使用，例如 1,2,3' }),
      F('mtu', 'MTU', 'int', { adv: true, placeholder: '1408' })
    ] }
  ];

  // 第一组：所有类型都有的基本字段
  const BASE = [
    F('name', '名称', 'text', { required: true, help: '在策略组和规则里引用这个名字，不能包含英文逗号' }),
    F('server', '服务器', 'text', { required: true, help: '域名或 IP' }),
    F('port', '端口', 'int', { required: true })
  ];

  function protocol(type) {
    return PROTOCOLS.find(p => p.type === type) || null;
  }

  // 某类型的全部表单字段（基本 + 协议 + 通用高级）
  function fields(type) {
    const p = protocol(type);
    return p ? BASE.concat(p.fields, COMMON) : BASE.concat(COMMON);
  }

  function getPath(o, key) {
    let v = o;
    for (const k of key.split('.')) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
      v = v[k];
    }
    return v;
  }

  // 设置点路径；值为空时删除，并删掉因此变空的上级映射
  function setPath(o, key, value) {
    const ks = key.split('.');
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
    const chain = [o];
    let cur = o;
    for (let i = 0; i < ks.length - 1; i++) {
      if (!cur[ks[i]] || typeof cur[ks[i]] !== 'object' || Array.isArray(cur[ks[i]])) {
        if (empty) return o;
        cur[ks[i]] = {};
      }
      cur = cur[ks[i]];
      chain.push(cur);
    }
    if (empty) delete cur[ks[ks.length - 1]];
    else cur[ks[ks.length - 1]] = value;
    for (let i = ks.length - 2; i >= 0 && empty; i--)
      if (!Object.keys(chain[i + 1]).length) delete chain[i][ks[i]];
    return o;
  }

  function visible(field, node) {
    if (!field.when) return true;
    const v = getPath(node, field.when.key);
    return field.when.in.some(x => x === true ? v === true : (v == null ? x === '' || x === 'tcp' : v === x));
  }

  // 表单值 → 节点：从 base（原节点）出发只改表单里的字段，保留表单未覆盖的字段；隐藏字段的值清除
  function applyForm(base, type, values) {
    const node = JSON.parse(JSON.stringify(base || {}));
    node.type = type;
    const list = fields(type);
    for (const f of list) if (f.key in values) setPath(node, f.key, values[f.key]);
    for (const f of list) if (!visible(f, node)) setPath(node, f.key, null);
    if (node.network === 'tcp') delete node.network;
    return node;
  }

  // 必填项检查，返回错误文字或 null
  function check(node) {
    if (!node || typeof node !== 'object') return '节点无效';
    if (!protocol(node.type)) return '不支持的类型：' + node.type;
    const name = String(node.name || '');
    if (!name.trim() || name !== name.trim()) return '名称不能为空，首尾不能有空格';
    if (/[,\x00-\x1f\x7f]/.test(name) || name.length > 128) return '名称不能包含英文逗号，最长 128 个字符';
    if (!node.server || /\s/.test(String(node.server))) return '服务器地址无效';
    if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) return '端口无效';
    for (const f of fields(node.type))
      if (f.required && visible(f, node) && (getPath(node, f.key) == null || getPath(node, f.key) === '')) return '请填写' + f.label;
    return null;
  }

  // 字段值 → 输入框文字（bool 保持布尔）
  function toInput(field, v) {
    if (field.kind === 'bool') return v == null ? field.def === true : v === true;
    if (field.kind === 'members' || field.kind === 'providers') return Array.isArray(v) ? v.map(String) : [];
    if (v == null) return '';
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  }

  // 输入框文字 → 字段值；格式不对时抛出带字段名的错误
  function fromInput(field, raw) {
    if (field.kind === 'bool') {
      // 与默认值相同时不写；默认开启的字段（def: true）关闭时才写 false
      const on = raw === true || raw === 'true';
      return on === (field.def === true) ? null : on;
    }
    if (field.kind === 'members' || field.kind === 'providers') {
      const out = [];
      for (const x of Array.isArray(raw) ? raw : String(raw || '').split(/[,\n]/)) {
        const t = String(x).trim();
        if (t && out.indexOf(t) < 0) out.push(t);
      }
      return out.length ? out : null;
    }
    const s = String(raw == null ? '' : raw).trim();
    if (s === '') return null;
    if (field.kind === 'num') {
      if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(field.label + '需要填写数字');
      return Number(s);
    }
    if (field.kind === 'int') {
      if (!/^\d+$/.test(s)) throw new Error(field.label + '需要填写整数');
      return Number(s);
    }
    if (field.kind === 'list') return s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);
    // WireGuard reserved：三个数字写成列表，否则按 base64 字符串
    if (field.key === 'reserved' && /^\d+\s*,\s*\d+\s*,\s*\d+$/.test(s)) return s.split(',').map(x => Number(x.trim()));
    return s;
  }

  // 表单当前值：{ 字段: 输入框文字 }
  function formValues(node, type) {
    const out = {};
    for (const f of fields(type)) out[f.key] = toInput(f, getPath(node || {}, f.key));
    return out;
  }

  // 由输入框文字生成节点：base 为原节点（新增时为 {}），保留表单未覆盖的字段。返回 { node } 或 { error }
  function buildNode(base, type, raw) {
    try {
      const values = {};
      for (const f of fields(type)) if (f.key in raw) values[f.key] = fromInput(f, raw[f.key]);
      // 换了类型：只保留基本字段，避免旧协议的字段混进来
      const start = base && base.type === type ? base : { name: base && base.name, server: base && base.server, port: base && base.port };
      const node = applyForm(start, type, values);
      const err = check(node);
      return err ? { error: err } : { node: node };
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ---------- 策略组表单 ---------- */

  // 类型与字段对齐 liuran001/mihomo（vernesong smart 分支）：relay 已被内核移除，链式代理改用节点的 dialer-proxy
  const AUTO_GROUPS = ['smart', 'url-test', 'fallback', 'load-balance'];
  const PREFER_GROUPS = ['smart', 'url-test', 'load-balance'];
  const GROUP_TYPES = [
    { type: 'select', label: '手动选择', help: '在面板里自己点选用哪个出站，适合「节点选择」这类总开关' },
    { type: 'smart', label: 'Smart 智能择优', help: '按每个连接的实际表现自动挑选成员，并记住哪个节点更适合哪类目标' },
    { type: 'url-test', label: '自动测速', help: '定期测延迟，自动使用最快的成员' },
    { type: 'fallback', label: '故障转移', help: '按顺序使用第一个能连通的成员，挂了自动换下一个' },
    { type: 'load-balance', label: '负载均衡', help: '把连接分散到多个成员上' }
  ];
  const onAuto = { key: 'type', in: AUTO_GROUPS };
  const onPrefer = { key: 'type', in: PREFER_GROUPS };
  const onSmart = { key: 'type', in: ['smart'] };

  // members：有序的出站名列表（节点、策略组、DIRECT 等）；providers：订阅名列表
  const GROUP_FIELDS = [
    F('name', '名称', 'text', { required: true, help: '规则和其他策略组用这个名字引用它，不能包含英文逗号' }),
    F('type', '类型', 'enum', { required: true, options: GROUP_TYPES.map(t => [t.type, t.label]) }),
    F('proxies', '成员', 'members', { help: '按顺序排列；可以选单个节点、其他策略组，或 DIRECT（直连）、REJECT（拦截）' }),
    F('use', '订阅', 'providers', { help: '把所选订阅里的节点加进来' }),
    F('include-all-providers', '包含全部订阅', 'bool', { help: '以后新增的订阅也会自动加入' }),
    F('include-all-proxies', '包含全部单个节点', 'bool', { help: '配置里直接写的节点全部加入' }),
    F('filter', '筛选节点', 'text', { help: '只保留名称匹配这个正则的节点（只作用于订阅和自动包含的节点），例如 (?i)港|hk' }),
    F('url', '测速地址', 'text', { when: onAuto, placeholder: 'https://www.gstatic.com/generate_204' }),
    F('interval', '测速间隔（秒）', 'int', { when: onAuto, placeholder: '300' }),
    F('prefer-udp', '优先能转发 UDP 的成员', 'bool', { when: onPrefer, help: '经探测确认 UDP 可用的成员优先，适合游戏、语音通话、QUIC' }),
    F('prefer-ipv6', '优先有 IPv6 的成员', 'bool', { when: onPrefer, help: '经探测确认 IPv6 出站可用的成员优先' }),
    F('penalize-unstable', '降权不稳定的成员', 'bool', { when: onPrefer, help: '经常连上却收不到数据（断流）的成员排到后面，不会直接剔除' }),
    F('prefer-asn', '同一服务固定出口', 'bool', { when: onSmart, help: '按目标所属网络（ASN）归类，同一服务尽量走同一个成员，减少跳变' }),
    F('policy-priority', '成员优先级', 'text', { when: onSmart,
      help: '按名称调整优先级，格式「正则:系数」，多条用英文分号分隔；系数大于 1 更优先、小于 1 靠后，例如 (?i)iplc:1.5;备用:0.3' }),
    F('tolerance', '切换容差（毫秒）', 'int', { when: { key: 'type', in: ['url-test', 'smart'] }, adv: true, help: '新成员要比当前快这么多才切换，避免来回跳' }),
    F('strategy', '分配方式', 'enum', { when: { key: 'type', in: ['load-balance'] },
      options: [['', '默认（同一目标走同一出站）'], ['consistent-hashing', 'consistent-hashing'], ['round-robin', '轮流使用'], ['sticky-sessions', 'sticky-sessions']] }),
    F('uselightgbm', '使用 LightGBM 模型', 'bool', { when: onSmart, adv: true, help: '用机器学习模型给成员打分，需要模型文件（全局的 lgbm-url）' }),
    F('collectdata', '收集择优数据', 'bool', { when: onSmart, adv: true, help: '记录连接表现，用于训练模型' }),
    F('sample-rate', '采样比例', 'num', { when: onSmart, adv: true, placeholder: '1', help: '只影响 LightGBM 训练样本的采集比例（0–1），不是省电开关' }),
    F('lazy', '闲置时不测速', 'bool', { when: onAuto, adv: true, def: true, help: '没有流量经过时暂停测速，省电省流量' }),
    F('timeout', '测速超时（毫秒）', 'int', { when: onAuto, adv: true, placeholder: '5000' }),
    F('max-failed-times', '失败几次后重新测速', 'int', { when: onAuto, adv: true, placeholder: '5' }),
    F('expected-status', '期望的状态码', 'text', { when: onAuto, adv: true, help: '例如 204 或 200/204' }),
    F('empty-fallback', '组为空时使用', 'policy', { adv: true, help: '筛选后一个成员都没有时改用这个出站（只能选节点或 DIRECT 等，不能选策略组），默认 COMPATIBLE' }),
    F('include-all', '包含全部节点与订阅', 'bool', { adv: true, help: '等于同时勾选「包含全部订阅」和「包含全部单个节点」' }),
    F('exclude-filter', '排除节点', 'text', { adv: true, help: '名称匹配这个正则的节点不加入' }),
    F('exclude-type', '排除协议', 'text', { adv: true, help: '按协议排除，例如 Shadowsocks|Http' }),
    F('disable-udp', '禁用 UDP', 'bool', { adv: true }),
    F('hidden', '在面板中隐藏', 'bool', { adv: true }),
    F('icon', '图标', 'text', { adv: true, help: '面板里显示的图标地址' })
  ];

  function groupType(type) {
    return GROUP_TYPES.find(t => t.type === type) || null;
  }

  function groupValues(group) {
    const out = {};
    for (const f of GROUP_FIELDS) out[f.key] = toInput(f, getPath(group || {}, f.key));
    return out;
  }

  // 策略组的检查：返回错误文字或 null
  function checkGroup(group) {
    const name = String(group.name || '');
    if (!name.trim() || name !== name.trim()) return '名称不能为空，首尾不能有空格';
    if (/[,\x00-\x1f\x7f]/.test(name) || name.length > 128) return '名称不能包含英文逗号，最长 128 个字符';
    if (!groupType(group.type)) return '请选择类型';
    const members = Array.isArray(group.proxies) ? group.proxies : [];
    if (members.indexOf(name) >= 0) return '成员里不能包含自己';
    const sources = members.length || (Array.isArray(group.use) && group.use.length) ||
      group['include-all'] === true || group['include-all-proxies'] === true || group['include-all-providers'] === true;
    if (!sources) return '至少要有一个成员、订阅，或勾选「包含全部」';
    return null;
  }

  // 由表单值生成策略组：保留表单未覆盖的字段，隐藏字段清除。返回 { group } 或 { error }
  function buildGroup(base, raw) {
    try {
      const group = JSON.parse(JSON.stringify(base || {}));
      for (const f of GROUP_FIELDS) if (f.key in raw) setPath(group, f.key, fromInput(f, raw[f.key]));
      for (const f of GROUP_FIELDS) if (!visible(f, group)) setPath(group, f.key, null);
      // 名称与类型放在最前面
      const out = { name: group.name, type: group.type };
      for (const k of Object.keys(group)) if (k !== 'name' && k !== 'type') out[k] = group[k];
      const err = checkGroup(out);
      return err ? { error: err } : { group: out };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 列表展示用的摘要：类型 · 成员 · 订阅
  function groupSummary(group) {
    const g = group || {};
    const t = groupType(g.type);
    const parts = [t ? t.label : String(g.type || '?')];
    const members = Array.isArray(g.proxies) ? g.proxies.length : 0;
    if (members) parts.push(members + ' 个成员');
    if (g['include-all'] === true) parts.push('全部节点与订阅');
    else {
      if (g['include-all-providers'] === true) parts.push('全部订阅');
      else if (Array.isArray(g.use) && g.use.length) parts.push('订阅 ' + g.use.join('、'));
      if (g['include-all-proxies'] === true) parts.push('全部单个节点');
    }
    if (g.filter) parts.push('筛选 ' + g.filter);
    return parts.join(' · ');
  }

  // 列表展示用的摘要：类型 · 服务器:端口 · 传输
  function summary(node) {
    const p = protocol(node && node.type);
    const parts = [p ? p.label : String((node && node.type) || '?')];
    if (node && node.server) parts.push((String(node.server).indexOf(':') >= 0 ? '[' + node.server + ']' : node.server) + ':' + node.port);
    if (node && node.network && node.network !== 'tcp') parts.push(node.network);
    if (node && node['reality-opts']) parts.push('Reality');
    else if (node && node.tls) parts.push('TLS');
    return parts.join(' · ');
  }

  return Object.freeze({ MAX_LINKS, PROTOCOLS, BASE, COMMON, parseLink, parseText, uniqueName, protocol, fields, getPath, setPath, visible, applyForm, check,
    toInput, fromInput, formValues, buildNode, summary, b64,
    GROUP_TYPES, GROUP_FIELDS, groupType, groupValues, checkGroup, buildGroup, groupSummary });
});
