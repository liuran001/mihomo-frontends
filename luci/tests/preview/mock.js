'use strict';
// 离线预览的样例数据：路由器不在线时，server.js 以 MIHOMO_PREVIEW_MOCK=1 启动，rpc 与控制器都由这里回答。
// - rpc：配置相关的方法取自 snapshot.sh 生成的 .cache/rpc.json（真实插件读脱敏样例 full.yaml 的结果），
//   依赖系统状态的方法（status、devices、tailscale 等）用手写的样例；写方法一律返回成功，不落盘。
// - 控制器：REST 与 WebSocket（/traffic /memory /connections /logs），数据随机生成，节点、策略组与样例配置一致。
// 页面地址带 ?fresh=1 时模拟「刚装好、没有内核与配置」的状态。
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SNAP_FILE = path.join(__dirname, '.cache/rpc.json');
const now = () => Date.now();
const iso = t => new Date(t).toISOString();
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];

function snapshot() {
	if (!fs.existsSync(SNAP_FILE)) throw new Error('缺少 ' + SNAP_FILE + '，先在 WSL 里运行 sh tests/preview/snapshot.sh');
	return JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'));
}

/* ---------- 节点与策略组 ---------- */

const REGIONS = [ [ '香港', 'HK' ], [ '台湾', 'TW' ], [ '日本', 'JP' ], [ '新加坡', 'SG' ], [ '美国', 'US' ], [ '英国', 'UK' ], [ '韩国', 'KR' ], [ '德国', 'DE' ] ];
const TYPES = [ 'Shadowsocks', 'Vmess', 'Trojan', 'Hysteria2', 'Vless' ];
const SUBS = { 甲: 36, 乙: 14, Kitty: 6 };

function makeNode(name, i) {
	const dead = i % 11 === 7;
	const base = 40 + (i * 37) % 260;
	const history = dead ? [ { time: iso(now() - 60000), delay: 0 } ]
		: [ 0, 1, 2 ].map(k => ({ time: iso(now() - (3 - k) * 300000), delay: Math.round(base + rnd(-15, 25)) }));
	return { name, type: TYPES[i % TYPES.length], alive: !dead, udp: i % 3 !== 0, xudp: false, tfo: false, history, extra: {} };
}

function buildWorld() {
	const providers = {}, proxies = {};
	let n = 0;
	for (const [ sub, count ] of Object.entries(SUBS)) {
		const list = [];
		for (let i = 0; i < count; i++) {
			const [ zh, code ] = REGIONS[i % REGIONS.length];
			const node = makeNode(`[${sub}] ${zh} ${code}-${String(Math.floor(i / REGIONS.length) + 1).padStart(2, '0')}`, n++);
			list.push(node);
			proxies[node.name] = node;
		}
		providers[sub] = { name: sub, type: 'Proxy', vehicleType: 'HTTP', proxies: list, testUrl: 'https://cp.cloudflare.com',
			updatedAt: iso(now() - { 甲: 1800e3, 乙: 7200e3, Kitty: 26 * 3600e3 }[sub]) };
	}
	const GB = 1024 ** 3;
	providers.甲.subscriptionInfo = { Upload: 12 * GB, Download: 168 * GB, Total: 500 * GB, Expire: Math.floor(now() / 1000) + 40 * 86400 };
	providers.乙.subscriptionInfo = { Upload: 4 * GB, Download: 180 * GB, Total: 200 * GB, Expire: Math.floor(now() / 1000) + 5 * 86400 };
	const all = Object.values(providers).flatMap(p => p.proxies.map(x => x.name));
	const hk = all.filter(x => /港|HK/i.test(x));
	const grp = (name, type, list, extra) => (proxies[name] = Object.assign({ name, type, all: list, now: list[0], history: [], alive: true, udp: true, testUrl: 'https://cp.cloudflare.com' }, extra || {}));
	proxies.DIRECT = { name: 'DIRECT', type: 'Direct', alive: true, udp: true, history: [] };
	proxies.REJECT = { name: 'REJECT', type: 'Reject', alive: true, udp: true, history: [] };
	proxies.DNS_Hijack = { name: 'DNS_Hijack', type: 'Dns', alive: true, udp: true, history: [] };
	proxies['TS-Server'] = { name: 'TS-Server', type: 'Tailscale', alive: true, udp: true, history: [] };
	grp('节点选择', 'Selector', [ '香港', '全部节点', '自动选择', '单独', 'DIRECT' ]);
	grp('dns', 'Selector', [ '节点选择', '香港', '全部节点', '自动选择', 'DIRECT' ]);
	grp('香港', 'Smart', hk, { now: hk[2] });
	grp('全部节点', 'Smart', all, { now: all[5] });
	grp('自动选择', 'URLTest', all, { now: all[9] });
	grp('单独', 'Selector', providers.Kitty.proxies.map(x => x.name).concat('DIRECT'));
	grp('GLOBAL', 'Selector', [ '节点选择', 'dns', '香港', '全部节点', '自动选择', '单独', 'DIRECT', 'REJECT' ], { hidden: false });
	providers.default = { name: 'default', type: 'Proxy', vehicleType: 'Compatible', proxies: [] };
	return { providers, proxies };
}

/* ---------- 规则 ---------- */

const RULE_TYPES = { 'IP-CIDR': 'IPCIDR', 'DST-PORT': 'DstPort', 'DOMAIN-SUFFIX': 'DomainSuffix', 'RULE-SET': 'RuleSet', AND: 'AND', OR: 'OR', MATCH: 'Match', DOMAIN: 'Domain' };

function buildRules(list) {
	return (list || []).map((s, i) => {
		const t = s.split(',')[0].trim();
		let payload, proxy;
		if (t === 'AND' || t === 'OR') {
			const close = s.lastIndexOf(')');
			payload = s.slice(t.length + 1, close + 1);
			proxy = s.slice(close + 2).split(',')[0];
		} else {
			const parts = s.split(',').map(x => x.trim());
			payload = t === 'MATCH' ? '' : parts[1];
			proxy = t === 'MATCH' ? parts[1] : parts[2];
		}
		const hits = [ 812, 20431, 96, 3310, 1288, 655, 48210, 9120 ][i % 8];
		return { index: i, type: RULE_TYPES[t] || t, payload, proxy, size: t === 'RULE-SET' ? 12000 : -1,
			extra: { disabled: false, hitCount: hits, hitAt: iso(now() - i * 47000), missCount: 0, missAt: iso(0) } };
	});
}

function buildRuleSets(list) {
	const out = {};
	(list || []).forEach((r, i) => {
		out[r.name] = { name: r.name, type: 'Rule', vehicleType: r.type === 'inline' ? 'Inline' : 'HTTP',
			behavior: { domain: 'Domain', ipcidr: 'IPCIDR', classical: 'Classical' }[r.behavior] || r.behavior,
			format: r.format === 'mrs' ? 'MrsRule' : 'YamlRule', ruleCount: [ 1820, 162340, 8902, 3, 12 ][i % 5],
			updatedAt: iso(now() - (i + 1) * 3600e3) };
	});
	return out;
}

/* ---------- 连接与日志 ---------- */

const DEVICES = [
	{ name: 'MacBook-Pro', mac: '3c:22:fb:10:20:31', ip4: '192.168.77.23', ip6: [] },
	{ name: 'iPhone', mac: '6e:7a:11:42:9c:02', ip4: '192.168.77.41', ip6: [] },
	{ name: 'Xiaomi-TV', mac: '50:ec:50:aa:01:9f', ip4: '192.168.77.88', ip6: [] },
	{ name: 'NAS', mac: '00:11:32:5b:6c:7d', ip4: '192.168.77.10', ip6: [] }
];
const HOSTS = [ [ 'www.google.com', 443, '节点选择' ], [ 'api.github.com', 443, '节点选择' ], [ 'i.ytimg.com', 443, '香港' ],
	[ 'www.baidu.com', 443, 'DIRECT' ], [ 'mirrors.tuna.tsinghua.edu.cn', 443, 'DIRECT' ], [ 'gateway.icloud.com', 443, 'DIRECT' ],
	[ 'example.org', 443, '香港' ], [ 'open.spotify.com', 443, '全部节点' ], [ 'time.apple.com', 123, 'DIRECT' ], [ 'chat.openai.com', 443, '全部节点' ] ];

function makeConn(i, world) {
	const h = HOSTS[i % HOSTS.length];
	const dev = DEVICES[i % DEVICES.length];
	const inner = i % 9 === 8;
	const g = world.proxies[h[2]];
	const chains = h[2] === 'DIRECT' ? [ 'DIRECT' ] : [ (g && g.now) || 'DIRECT', h[2] ];
	if (h[2] === '香港' || h[2] === '全部节点') chains.splice(1, 0);
	return {
		id: crypto.randomUUID(),
		metadata: { network: h[1] === 123 ? 'udp' : 'tcp', type: inner ? 'Inner' : 'Ebpf', sourceIP: inner ? '' : dev.ip4, sourcePort: String(40000 + i * 7),
			destinationIP: h[2] === 'DIRECT' ? '110.242.68.' + (i + 3) : '', destinationPort: String(h[1]), host: h[0], process: '', dnsMode: 'normal' },
		upload: Math.round(rnd(2e3, 4e5)), download: Math.round(rnd(1e4, 5e7)),
		start: iso(now() - rnd(2, 900) * 1000), chains,
		rule: h[2] === 'DIRECT' ? 'RuleSet' : (h[0] === 'example.org' ? 'DomainSuffix' : 'Match'),
		rulePayload: h[2] === 'DIRECT' ? 'CN-IP' : (h[0] === 'example.org' ? 'example.org' : '')
	};
}

const LOG_SAMPLES = [
	[ 'info', c => `[TCP] ${c.metadata.sourceIP || '127.0.0.1'}:${c.metadata.sourcePort} --> ${c.metadata.host}:${c.metadata.destinationPort} match ${c.rule}(${c.rulePayload}) using ${c.chains.slice().reverse().join('[') + (c.chains.length > 1 ? ']' : '')}` ],
	[ 'warning', () => '[Provider] 乙 pull error: 503 Service Unavailable' ],
	[ 'debug', () => '[DNS] resolve www.google.com A from https://1.1.1.1/dns-query#节点选择' ],
	[ 'error', () => `dial [甲] 日本 JP-02 (match Match/) to chat.openai.com:443 error: i/o timeout` ]
];

/* ---------- 控制器服务 ---------- */

function wsAccept(key) {
	return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function wsFrame(text) {
	const data = Buffer.from(text);
	const n = data.length;
	const head = n < 126 ? Buffer.from([ 0x81, n ]) : (n < 65536 ? Buffer.from([ 0x81, 126, n >> 8, n & 255 ]) : Buffer.concat([ Buffer.from([ 0x81, 127 ]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })() ]));
	return Buffer.concat([ head, data ]);
}

function startController(port, secret) {
	const snap = snapshot();
	const world = buildWorld();
	const rules = buildRules(snap.sections && snap.sections.rules && snap.sections.rules.list);
	const ruleSets = buildRuleSets(snap.sections && snap.sections.rule_providers && snap.sections.rule_providers.list);
	const configs = { port: 0, 'socks-port': 0, 'mixed-port': 17891, mode: 'rule', 'log-level': 'warning', ipv6: true, 'allow-lan': true, 'bind-address': '*' };
	let conns = Array.from({ length: 26 }, (_, i) => makeConn(i, world));
	let totals = { up: 1.8 * 1024 ** 3, down: 23.6 * 1024 ** 3 };
	const ebpf = {
		inbounds: [ {
			name: 'ebpf-in', mode: 'hybrid', local_data_plane: 'cgroup', shared_data_plane: 'packet_rewrite',
			resources: {
				programs: [ 'cgroup_connect4', 'cgroup_connect6', 'cgroup_sendmsg4', 'cgroup_recvmsg4', 'tc_ingress', 'tc_egress' ].map(n => ({ name: n })),
				maps: { status: 'pass', maps: [
					{ name: 'conntrack', category: 'runtime', supported: true, max_entries: 65536, entries: 9120, pressure: 'healthy' },
					{ name: 'nat_origin', category: 'runtime', supported: true, max_entries: 32768, entries: 2140, pressure: 'healthy' },
					{ name: 'bypass_cidr4', category: 'policy', supported: true, max_entries: 16384, entries: 8902, pressure: 'configured' },
					{ name: 'bypass_cidr6', category: 'policy', supported: true, max_entries: 16384, entries: 1902, pressure: 'configured' },
					{ name: 'dns_hijack', category: 'runtime', supported: true, max_entries: 4096, entries: 61, pressure: 'healthy' }
				] }
			},
			maintenance: [ { name: 'conntrack-gc', failures: 0 } ]
		} ]
	};

	const send = (res, code, body) => {
		res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
		res.end(body === undefined ? '' : JSON.stringify(body));
	};
	const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { try { r(b ? JSON.parse(b) : null); } catch (e) { r(null); } }); });
	const delayOf = name => { const p = world.proxies[name]; const h = p && p.history; return h && h.length ? h[h.length - 1].delay : 0; };
	const retest = name => {
		const p = world.proxies[name];
		if (!p || p.all) return 0;
		const d = p.alive ? Math.round(rnd(35, 380)) : 0;
		p.history = p.history.concat({ time: iso(now()), delay: d }).slice(-10);
		return d;
	};

	const server = http.createServer(async (req, res) => {
		if (req.method === 'OPTIONS') {
			res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
				'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE' });
			return res.end();
		}
		if (secret && req.headers.authorization !== 'Bearer ' + secret) return send(res, 401, { message: 'Unauthorized' });
		const u = new URL(req.url, 'http://x');
		const p = decodeURIComponent(u.pathname);
		const m = req.method;
		let mm;
		if (m === 'GET' && p === '/configs') return send(res, 200, configs);
		if (m === 'PATCH' && p === '/configs') { Object.assign(configs, await readBody(req)); return send(res, 204); }
		if (m === 'GET' && p === '/connections/summary') return send(res, 200, {
			connectionCount: conns.length, uploadTotal: Math.round(totals.up), downloadTotal: Math.round(totals.down), memory: 58e6
		});
		if (m === 'GET' && p === '/overview') {
			const target = configs.mode === 'direct' ? 'DIRECT' : configs.mode === 'global' ? 'GLOBAL' : (rules.filter(rule => rule.type === 'Match').pop() || {}).proxy || 'GLOBAL';
			const chain = [];
			let current = target, smart = false;
			while (current && world.proxies[current] && chain.length < 32 && !chain.includes(current)) {
				chain.push(current);
				const proxy = world.proxies[current];
				if (proxy.type === 'Smart') { smart = true; break; }
				if (proxy.type === 'LoadBalance') break;
				current = proxy.now;
			}
			const providers = Object.fromEntries(Object.entries(world.providers).map(([name, provider]) => [name, {
				name, vehicleType: provider.vehicleType, count: provider.proxies.length, updatedAt: provider.updatedAt, subscriptionInfo: provider.subscriptionInfo
			}]));
			return send(res, 200, { exit: { chain, smart }, providers });
		}
		if (m === 'GET' && p === '/proxies') return send(res, 200, { proxies: world.proxies });
		if ((mm = p.match(/^\/proxies\/(.+)\/delay$/)) && m === 'GET') return send(res, 200, { delay: retest(mm[1]) });
		if ((mm = p.match(/^\/proxies\/(.+)$/))) {
			const g = world.proxies[mm[1]];
			if (!g || !g.all) return send(res, 404, { message: 'not found' });
			if (m === 'PUT') { const b = await readBody(req); if (g.type === 'Selector') g.now = b.name; else g.fixed = b.name; return send(res, 204); }
			if (m === 'DELETE') { delete g.fixed; return send(res, 204); }
		}
		if ((mm = p.match(/^\/group\/(.+)\/delay$/)) && m === 'GET') {
			const g = world.proxies[mm[1]];
			if (!g) return send(res, 404, { message: 'not found' });
			const out = {};
			g.all.forEach(n => { const d = world.proxies[n] && world.proxies[n].all ? delayOf(world.proxies[n].now) : retest(n); if (d) out[n] = d; });
			return setTimeout(() => send(res, 200, out), 600);
		}
		if (m === 'GET' && p === '/providers/proxies') return send(res, 200, { providers: world.providers });
		if ((mm = p.match(/^\/providers\/proxies\/([^/]+)(\/healthcheck)?$/))) {
			const pv = world.providers[mm[1]];
			if (!pv) return send(res, 404, { message: 'not found' });
			if (m === 'PUT') { pv.updatedAt = iso(now()); return setTimeout(() => send(res, 204), 500); }
			if (mm[2]) { pv.proxies.forEach(x => retest(x.name)); return setTimeout(() => send(res, 204), 600); }
			return send(res, 200, pv);
		}
		if (m === 'GET' && p === '/providers/rules') return send(res, 200, { providers: ruleSets });
		if ((mm = p.match(/^\/providers\/rules\/(.+)$/)) && m === 'PUT') { if (ruleSets[mm[1]]) ruleSets[mm[1]].updatedAt = iso(now()); return send(res, 204); }
		if (m === 'GET' && p === '/rules') return send(res, 200, { rules });
		if (m === 'PATCH' && p === '/rules/disable') { const b = (await readBody(req)) || {}; for (const k in b) if (rules[k]) rules[k].extra.disabled = !!b[k]; return send(res, 204); }
		if (m === 'GET' && p === '/ebpf') return send(res, 200, ebpf);
		if (m === 'GET' && p === '/ebpf/summary') return send(res, 200, {
			inbounds: ebpf.inbounds.map(({ resources, ...inbound }) => inbound)
		});
		if (m === 'DELETE' && p === '/connections') { conns = []; return send(res, 204); }
		if ((mm = p.match(/^\/connections\/(.+)$/)) && m === 'DELETE') { conns = conns.filter(c => c.id !== mm[1]); return send(res, 204); }
		if (m === 'POST' && /^\/cache\/(dns|smart)\/flush$/.test(p)) return send(res, 204);
		if (m === 'GET' && p === '/version') return send(res, 200, { meta: true, version: 'alpha-smart-e272b9d-ebpf' });
		send(res, 404, { message: 'mock: ' + m + ' ' + p });
	});

	server.on('upgrade', (req, socket) => {
		const u = new URL(req.url, 'http://x');
		if (secret && u.searchParams.get('token') !== secret) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
		socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n');
		const push = o => { if (!socket.destroyed) socket.write(wsFrame(JSON.stringify(o))); };
		let tick, iv = 1000;
		let up = 120e3, down = 2.4e6, mem = 58e6;
		if (u.pathname === '/traffic') tick = () => {
			up = Math.max(5e3, up + rnd(-60e3, 60e3)); down = Math.max(2e4, down + rnd(-1.2e6, 1.2e6));
			totals.up += up; totals.down += down;
			push({ up: Math.round(up), down: Math.round(down) });
		};
		else if (u.pathname === '/memory') { push({ inuse: 0, oslimit: 0 }); tick = () => { mem = Math.min(90e6, Math.max(40e6, mem + rnd(-2e6, 2e6))); push({ inuse: Math.round(mem), oslimit: 0 }); }; }
		else if (u.pathname === '/connections') {
			iv = +u.searchParams.get('interval') || 1000;
			tick = () => {
				conns.forEach(c => { c.download += Math.round(rnd(0, 4e5)); c.upload += Math.round(rnd(0, 2e4)); });
				if (Math.random() < 0.3 && conns.length > 12) conns.splice(Math.floor(rnd(0, conns.length)), 1);
				if (Math.random() < 0.4) conns.push(makeConn(Math.floor(rnd(0, 40)), world));
				push({ downloadTotal: Math.round(totals.down), uploadTotal: Math.round(totals.up), connections: conns, memory: Math.round(mem) });
			};
		} else if (u.pathname === '/logs') {
			iv = 1400;
			tick = () => { const s = pick(LOG_SAMPLES); push({ type: s[0], payload: s[1](pick(conns.length ? conns : [ makeConn(0, world) ])) }); };
		} else { socket.end(); return; }
		tick();
		const t = setInterval(tick, iv);
		const stop = () => clearInterval(t);
		socket.on('close', stop);
		socket.on('error', stop);
		socket.on('data', buf => { if ((buf[0] & 0x0f) === 8) { stop(); socket.end(); } });
	});

	server.listen(port, '127.0.0.1');
	return server;
}

/* ---------- rpc ---------- */

const CORE_VERSION = 'alpha-smart-e272b9d-ebpf';

function syslog() {
	const t0 = now() - 3600e3;
	const lines = [];
	for (let i = 0; i < 60; i++) {
		const d = new Date(t0 + i * 61e3).toString().split(' ').slice(0, 5).join(' ');
		const s = pick(LOG_SAMPLES);
		lines.push(`${d} daemon.${s[0] === 'warning' ? 'warn' : s[0] === 'error' ? 'err' : 'info'} mihomo-ebpf[5189]: time="${iso(t0 + i * 61e3)}" level=${s[0]} msg="${s[1](makeConn(i, { proxies: {} })).replace(/"/g, '\\"')}"`);
	}
	return lines.join('\n') + '\n';
}

function rpc(method, args, opts) {
	const snap = snapshot();
	const fresh = !!(opts && opts.fresh);
	const rev = snap.sections && snap.sections.rev;
	const job = { ok: true, job: 'mock-' + Date.now() };
	switch (method) {
	case 'status':
		return fresh ? { ok: true, running: false, pid: null, uptime: null, rss_kb: null, version: null, autostart: false, config_rev: null, config_present: false, yq_present: true }
			: { ok: true, running: true, pid: 5189, uptime: 3 * 86400 + 5 * 3600 + 12 * 60, rss_kb: 61840, version: CORE_VERSION, autostart: true, config_rev: rev, config_present: true, yq_present: true };
	case 'controller':
		if (fresh) return { ok: false, error: '无法读取配置文件' };
		return { ok: true, listen: '0.0.0.0:9090', secret: opts.secret, host: '127.0.0.1', port: opts.ctrlPort, reachable: true, reason: null, ui: './dashboard', ui_name: 'zashboard' };
	case 'config_read':
		return fresh ? { ok: false, error: '配置文件不存在：/etc/mihomo/config.yaml' } : snap.config_read;
	case 'backups':
		return fresh ? { ok: true, list: [] } : snap.backups;
	case 'backup_read':
		return { ok: true, content: snap.config_read.content };
	case 'sections': {
		if (fresh) return { ok: true, rev: null, parse_error: '配置文件有语法错误，或缺少 yq，请在配置文件页修复' };
		const names = (args && args.names && args.names.length) ? args.names : Object.keys(snap.sections).filter(k => k !== 'ok' && k !== 'rev');
		const out = { ok: true, rev };
		names.forEach(n => { out[n] = snap.sections[n]; });
		return out;
	}
	case 'logs':
		return { ok: true, text: syslog() };
	case 'devices':
		return { ok: true, list: DEVICES };
	case 'interfaces':
		return { ok: true, list: [
			{ name: 'br-lan', type: 'ether', up: true, master: null, kind: 'bridge', addrs: [ '192.168.77.1/24', 'fd00:77::1/64' ], is_default_upstream: false },
			{ name: 'sipa_eth8', type: 'none', up: true, master: null, kind: null, addrs: [ '10.141.22.9/30' ], is_default_upstream: true },
			{ name: 'tailscale0', type: 'none', up: true, master: null, kind: 'tun', addrs: [ '100.64.0.1/32' ], is_default_upstream: false },
			{ name: 'usb0', type: 'ether', up: true, master: 'br-lan', kind: null, addrs: [], is_default_upstream: false },
			{ name: 'wlan0', type: 'ether', up: true, master: 'br-lan', kind: null, addrs: [], is_default_upstream: false },
			{ name: 'sipa_dummy0', type: 'ether', up: true, master: null, kind: 'dummy', addrs: [], is_default_upstream: false },
			{ name: 'sipa_eth0', type: 'none', up: false, master: null, kind: null, addrs: [], is_default_upstream: false }
		] };
	case 'tailscale':
		return { ok: true, list: [ { name: 'TS-Server', state_dir: '/etc/mihomo/tailscale', logged_in: true, login: 'someone@example.com', tailnet: 'example.ts.net', magic_dns: 'tail0000.ts.net' } ] };
	case 'apply_status':
		return { ok: true, state: 'done', step: 'done', kind: 'patch', started: Math.floor(now() / 1000) - 3, finished: Math.floor(now() / 1000), restarted: true, backup: 'config-20261104-093011.yaml' };
	case 'validate':
		return { ok: true, valid: true, error: null, detail: 'configuration file /tmp/x.yaml test is successful' };
	case 'save_raw': case 'patch': case 'provider_toggle': case 'migrate_include_all': case 'backup_restore':
	case 'core_update': case 'core_rollback': case 'setup_apply':
		return job;
	case 'backup_delete': case 'service': case 'core_settings':
		return { ok: true };
	case 'rule_test':
		return { ok: true, host: String((args && args.target) || 'www.baidu.com').split(':')[0], port: 443, elapsed_ms: 412, rule: 'RuleSet', payload: 'CN-IP', chains: [ 'DIRECT' ], ip: '110.242.68.66', via: 'connections' };
	case 'core_info':
		return fresh ? Object.assign({}, snap.core_info, { arch: 'aarch64', asset: 'linux-arm64', installed: false, version: null, prev_version: null, running: false, free_kb: 5.1 * 1024 * 1024 })
			: Object.assign({}, snap.core_info, { arch: 'aarch64', asset: 'linux-arm64', installed: true, version: CORE_VERSION, prev_version: 'alpha-smart-d1c0a77-ebpf', latest: null, running: true, free_kb: 5.1 * 1024 * 1024 });
	case 'core_check':
		return { ok: true, latest: 'alpha-smart-f3b19c0-ebpf', current: fresh ? null : CORE_VERSION, update_available: true, route: '本机代理' };
	case 'setup_status':
		return fresh ? { ok: true, core: false, config: false, autostart: false, running: false, arch_ok: true, lan_default: [ 'br-lan' ], rev: null }
			: Object.assign({}, snap.setup_status, { autostart: true, running: true, lan_default: [ 'br-lan' ] });
	case 'setup_render':
		return { ok: true, content: snap.config_read.content };
	case 'setup_fetch':
		if (/sub|token/i.test(String((args && args.url) || '')))
			return { ok: true, kind: 'subscription', message: '这是 base64 编码的节点订阅，不是 mihomo 配置' };
		return { ok: true, kind: 'config', summary: { proxies: 24, providers: 0, groups: 9, rules: 312 }, content: snap.config_read.content };
	case 'setup_adapt':
		return { ok: true, content: snap.config_read.content, changes: [
			{ id: 'ebpf', title: 'eBPF 透明代理（下联 br-lan）', detail: '新增 ebpf-in 入站：本机 cgroup + 局域网 packet_rewrite，国内 IP 绕过', optional: false, applied: true },
			{ id: 'dns', title: 'DNS', detail: '开启 DNS 并监听 0.0.0.0:1053，redir-host 模式', optional: false, applied: true },
			{ id: 'listeners', title: '移除冲突的入站', detail: 'tproxy-in（tproxy）', optional: true, applied: !(args && (args.skip || []).includes('listeners')) },
			{ id: 'ports', title: '移除透明代理端口', detail: 'tproxy-port、redir-port', optional: true, applied: !(args && (args.skip || []).includes('ports')) },
			{ id: 'secret', title: '面板密钥', detail: '随机生成', optional: true, applied: !(args && (args.skip || []).includes('secret')) }
		] };
	}
	return null;
}

module.exports = { rpc, startController };
