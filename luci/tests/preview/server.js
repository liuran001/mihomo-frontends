'use strict';
// 本地预览：在电脑上用路由器的 LuCI 前端运行时渲染本插件的页面，不需要在浏览器里登录 LuCI。
// - 本插件的前端文件直接读仓库（改完刷新即可，不用部署），其他 /luci-static 文件转发到路由器；
// - rpc 经一条常驻 ssh 连接转发到路由器上的 ubus，只放行 ACL 文件里 luci.mihomo 的方法；
//   写方法默认关闭（校验除外），设置 MIHOMO_PREVIEW_WRITE=1 才放行。
// 用法：SSH=ssh ROUTER=root@192.168.77.1 node tests/preview/server.js，然后打开 http://localhost:8377/
// 离线：MIHOMO_PREVIEW_MOCK=1 node tests/preview/server.js——LuCI 前端读 .cache/www（从固件包解出），
// rpc 与控制器用 mock.js 的样例数据（先在 WSL 里运行 sh tests/preview/snapshot.sh），不连接路由器；页面地址加 ?fresh=1 模拟全新安装。
const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const PORT = +process.env.PORT || 8377;
const ROUTER = process.env.ROUTER || 'root@192.168.77.1';
const ROUTER_HOST = ROUTER.replace(/^.*@/, '');
const SSH = process.env.SSH || 'ssh';
const SH = process.env.SH || 'sh';
const MOCK = process.env.MIHOMO_PREVIEW_MOCK === '1';
const WRITE = MOCK || process.env.MIHOMO_PREVIEW_WRITE === '1';
const MOCK_CTRL_PORT = +process.env.MOCK_CTRL_PORT || 8379;
const MOCK_SECRET = 'preview';
const CACHE_WWW = path.join(__dirname, '.cache/www');
const mock = MOCK ? require('./mock') : null;
const ROOT = path.join(__dirname, '../../root');
const VIEWS = ['overview', 'proxies', 'connections', 'providers', 'groups', 'rules', 'settings', 'config', 'core', 'setup', 'logs'];
const TITLES = { overview: '概览', proxies: '代理', connections: '连接', providers: '订阅与节点', groups: '策略组', rules: '规则', settings: '设置', config: '配置文件', core: '内核', setup: '设置向导', logs: '日志' };
const LOCAL_PREFIXES = ['/luci-static/resources/mihomo/', '/luci-static/resources/view/mihomo/'];
const SAFE_WRITES = ['validate'];
// LuCI 运行时自身在启动时调用的只读方法，原样转发
const LUCI_READS = ['uci.get', 'uci.changes', 'luci.getFeatures', 'file.list'];

function aclMethods() {
	const acl = JSON.parse(fs.readFileSync(path.join(ROOT, 'usr/share/rpcd/acl.d/luci-app-mihomo.json'), 'utf8'))['luci-app-mihomo'];
	const read = acl.read.ubus['luci.mihomo'] || [];
	const write = acl.write.ubus['luci.mihomo'] || [];
	return { read, write, allowed: new Set(read.concat(WRITE ? write : write.filter(m => SAFE_WRITES.includes(m)))) };
}

/* ---------- ubus 桥 ---------- */

let bridge = null, nextId = 1;
const pending = new Map();

function sh(cmd, input) {
	return new Promise((resolve, reject) => {
		const p = spawn(SH, ['-c', cmd], { stdio: ['pipe', 'pipe', 'inherit'] });
		p.on('error', reject);
		let out = '';
		p.stdout.on('data', d => { out += d; });
		p.on('close', code => code === 0 ? resolve(out) : reject(new Error(cmd + ' exited ' + code)));
		p.stdin.end(input || '');
	});
}

function startBridge() {
	if (bridge) return bridge;
	bridge = sh(`${SSH} ${ROUTER} 'cat > /tmp/mlt-bridge.uc'`, fs.readFileSync(path.join(__dirname, 'bridge.uc'))).then(() => {
		const p = spawn(SH, ['-c', `${SSH} ${ROUTER} ucode /tmp/mlt-bridge.uc`], { stdio: ['pipe', 'pipe', 'inherit'] });
		p.on('error', () => { bridge = null; });
		readline.createInterface({ input: p.stdout }).on('line', line => {
			let r;
			try { r = JSON.parse(line); } catch (e) { return; }
			const cb = pending.get(r.id);
			if (cb) { pending.delete(r.id); cb(r); }
		});
		p.on('close', () => {
			bridge = null;
			for (const cb of pending.values()) cb({ code: 4, data: null });
			pending.clear();
		});
		return p;
	});
	return bridge;
}

// 单次调用超时后重建 ssh 连接（例如 rpcd 重启或网络抖动导致连接卡住）
const CALL_TIMEOUT = 40000;

function ubusCall(object, method, args) {
	return startBridge().then(p => new Promise(resolve => {
		const id = nextId++;
		const timer = setTimeout(() => {
			if (!pending.has(id)) return;
			console.log(`timeout ${object}.${method}，重建 ubus 桥`);
			pending.delete(id);
			resolve({ code: 7, data: null });
			p.kill();
		}, CALL_TIMEOUT);
		pending.set(id, r => { clearTimeout(timer); resolve(r); });
		p.stdin.write(JSON.stringify({ id, object, method, args: args || {} }) + '\n');
	}));
}

/* ---------- JSON-RPC ---------- */

// 离线模式下 LuCI 运行时自身的调用给空结果
const MOCK_LUCI = { 'uci.get': {}, 'uci.changes': { changes: {} }, 'luci.getFeatures': {}, 'file.list': { entries: [] } };

function handleCall(req, acl, ctx) {
	const reply = result => ({ jsonrpc: '2.0', id: req.id, result });
	if (req.method === 'list') return Promise.resolve(reply({}));
	const [, object, method, args] = req.params || [];
	if (object === 'session' && method === 'access') return Promise.resolve(reply([0, { access: true }]));
	const passthrough = LUCI_READS.includes(object + '.' + method);
	if (!passthrough && (object !== 'luci.mihomo' || !acl.allowed.has(method))) {
		console.log(`deny  ${object}.${method}`);
		return Promise.resolve(reply([6]));
	}
	if (MOCK) {
		const data = object === 'luci.mihomo'
			? mock.rpc(method, args, { fresh: ctx.fresh, ctrlPort: MOCK_CTRL_PORT, secret: MOCK_SECRET })
			: MOCK_LUCI[object + '.' + method];
		console.log(`mock  ${object}.${method}${ctx.fresh ? ' (fresh)' : ''}`);
		return Promise.resolve(reply(data == null ? [0] : [0, data]));
	}
	const t0 = Date.now();
	return ubusCall(object, method, args).then(r => {
		console.log(`call  ${object}.${method} -> ${r.code} (${Date.now() - t0} ms)`);
		// 页面在 localhost 上，控制器的通配地址需要换成路由器地址
		if (method === 'controller' && r.data && r.data.reachable && !r.data.host) r.data.host = ROUTER_HOST;
		return reply(r.code === 0 ? (r.data == null ? [0] : [0, r.data]) : [r.code]);
	});
}

function handleUbus(body, res, headers) {
	let req;
	try { req = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end(); }
	const acl = aclMethods();
	const list = Array.isArray(req) ? req : [req];
	const ctx = { fresh: /[?&]fresh=1/.test(headers.referer || '') };
	Promise.all(list.map(r => handleCall(r, acl, ctx))).then(out => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(Array.isArray(req) ? out : out[0]));
	});
}

/* ---------- 页面与静态文件 ---------- */

function page(view) {
	const p = ['admin', 'services', 'mihomo', view];
	const env = {
		media: '/luci-static/aurora', resource: '/luci-static/resources', scriptname: '/cgi-bin/luci',
		pathinfo: '/' + p.join('/'), documentroot: '/www', requestpath: p, dispatchpath: p, pollinterval: 5,
		ubuspath: '/ubus/', sessionid: '00000000000000000000000000000000', token: 'preview',
		nodespec: { title: TITLES[view], action: { type: 'view', path: 'mihomo/' + view } },
		apply_rollback: 90, apply_holdoff: 4, apply_timeout: 5, apply_display: 1.5, rollback_token: null
	};
	const tabs = VIEWS.filter(v => fs.existsSync(path.join(ROOT, 'www/luci-static/resources/view/mihomo', v + '.js')))
		.map(v => `<a href="/${v}"${v === view ? ' style="font-weight:700"' : ''}>${TITLES[v]}</a>`).join(' · ');
	return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLES[view]} - Mihomo 预览</title>
<script>document.documentElement.setAttribute('data-darkmode', String(localStorage.getItem('aurora.theme') === 'dark'));</script>
<link rel="stylesheet" href="/luci-static/aurora/main.css?v=1.4.0">
<script src="/luci-static/resources/cbi.js?v=1.4.0"></script>
</head>
<body class="lang_zh_Hans" data-page="${p.join('-')}">
<div style="padding:8px 16px;font-size:13px;background:#fffbe6;border-bottom:1px solid #eee">
本地预览（${MOCK ? '<b>离线样例数据</b>' : (WRITE ? '<b>写操作已放行</b>' : '只读')}） · ${tabs} ·
<a href="#" onclick="localStorage.setItem('aurora.theme', localStorage.getItem('aurora.theme') === 'dark' ? 'light' : 'dark'); location.reload(); return false">切换深浅色</a>
</div>
<div id="maincontent" class="container" style="padding:16px">
<div id="view"><div class="spinning">加载中…</div></div>
</div>
<script src="/luci-static/resources/luci.js?v=preview"></script>
<script>
L = new LuCI(${JSON.stringify(env)});
L.require('ui').then(function(ui) { ui.instantiateView('mihomo/${view}'); });
</script>
</body>
</html>`;
}

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serveLocal(url, res) {
	const file = path.join(ROOT, 'www', path.normalize(url).replace(/^([/\\])+/, ''));
	if (!file.startsWith(path.join(ROOT, 'www'))) { res.writeHead(403); return res.end(); }
	fs.readFile(file, (err, data) => {
		if (err) { res.writeHead(404); return res.end(); }
		res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
		res.end(data);
	});
}

function serveCache(url, res) {
	const file = path.join(CACHE_WWW, path.normalize(url).replace(/^([/\\])+/, ''));
	if (!file.startsWith(CACHE_WWW)) { res.writeHead(403); return res.end(); }
	fs.readFile(file, (err, data) => {
		if (err) { res.writeHead(404); return res.end(); }
		res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
		res.end(data);
	});
}

function proxy(url, res) {
	if (MOCK) return serveCache(url.split('?')[0], res);
	http.get({ host: ROUTER_HOST, port: 80, path: url }, up => {
		res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'application/octet-stream' });
		up.pipe(res);
	}).on('error', e => { res.writeHead(502); res.end(String(e)); });
}

http.createServer((req, res) => {
	const url = req.url.split('?')[0];
	if (req.method === 'POST' && url.startsWith('/ubus')) {
		let body = '';
		req.on('data', d => { body += d; });
		req.on('end', () => handleUbus(body, res, req.headers));
		return;
	}
	if (url === '/') { res.writeHead(302, { Location: '/overview' }); return res.end(); }
	const view = url.slice(1);
	if (VIEWS.includes(view)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page(view)); }
	if (LOCAL_PREFIXES.some(p => url.startsWith(p))) return serveLocal(url, res);
	if (url.startsWith('/luci-static/')) return proxy(req.url, res);
	if (url.startsWith('/cgi-bin/luci/admin/translations')) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(''); }
	res.writeHead(404);
	res.end();
}).listen(PORT, '127.0.0.1', () => {
	const acl = aclMethods();
	if (MOCK) {
		mock.startController(MOCK_CTRL_PORT, MOCK_SECRET);
		return console.log(`离线预览：http://localhost:${PORT}/  样例控制器 127.0.0.1:${MOCK_CTRL_PORT}`);
	}
	console.log(`预览：http://localhost:${PORT}/  路由器 ${ROUTER}  放行方法：${[...acl.allowed].join(', ')}`);
});
