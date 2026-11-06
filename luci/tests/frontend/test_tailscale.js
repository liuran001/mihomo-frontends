'use strict';
// Tailscale 网页登录：订阅日志 → 测速唤醒 → 显示链接 → 轮询登录状态；以及拿不到链接时的重试提示
const assert = require('assert');
const { load } = require('./harness');

// 会替换全局的 setTimeout 与 E：由 run.js 加载时在子进程里运行，不影响其它测试
if (require.main !== module) {
	require('child_process').execFileSync(process.execPath, [ __filename ], { stdio: 'inherit' });
	return;
}

// 最小 DOM：E(tag, attrs, children)，只记录文本与子节点
function E(tag, attrs, children) {
	if (!(attrs && typeof attrs === 'object' && !Array.isArray(attrs) && !attrs.tag)) { children = attrs; attrs = {}; }
	const node = { tag, attrs, children: [].concat(children == null ? [] : children), textContent: typeof children === 'string' ? children : '',
		replaceChildren(...c) { this.children = c; } };
	return node;
}
function text(node) {
	if (node == null || typeof node !== 'object') return node == null ? '' : String(node);
	return (node.textContent || '') + node.children.map(text).join('');
}
global.E = E;

// 手动推进的定时器
let queue = [];
global.setTimeout = (fn, ms) => { const t = { fn, ms }; queue.push(t); return t; };
global.clearTimeout = t => { queue = queue.filter(x => x !== t); };
async function tick() {
	const now = queue;
	queue = [];
	for (const t of now) await t.fn();
	await new Promise(r => setImmediate(r));
}

function setup(opts) {
	const calls = { gets: [], service: [], modal: [] };
	let onLog = null, logged = false;
	const api = {
		poll: (root, interval, callback) => {
			let closed = false, timer;
			const run = async () => {
				await callback();
				if (!closed) timer = setTimeout(run, interval);
			};
			timer = setTimeout(run, interval);
			return { close() { closed = true; clearTimeout(timer); } };
		},
		rpc: {
			status: async () => ({ ok: true, running: opts.running !== false }),
			service: async a => { calls.service.push(a); return { ok: true }; },
			tailscale: async () => ({ ok: true, list: [ { name: 'TS B', logged_in: logged, login: logged ? 'u@example.com' : null } ] })
		},
		controller: async () => ({ base: 'http://192.168.77.1:9090' }),
		stream: (path, cb) => { calls.stream = path; onLog = cb; return { close() { calls.closed = true; } }; },
		get: async p => {
			if (p.startsWith('/tailscale')) {
				if (!opts.kernel) throw Object.assign(new Error('HTTP 404'), { status: 404 });
				calls.status = (calls.status || 0) + 1;
				return { name: 'TS B', state: logged ? 'Running' : 'NeedsLogin', login: logged ? 'k@example.com' : undefined };
			}
			calls.gets.push(p);
			return { delay: 0 };
		},
		request: async (method, p) => {
			calls.requests = (calls.requests || []).concat(method + ' ' + p);
			if (!opts.kernel) throw Object.assign(new Error('HTTP 404'), { status: 404 });
			return { name: 'TS B', state: 'NeedsLogin', authURL: 'https://login.tailscale.com/a/kernel1' };
		}
	};
	const ui = { showModal: (title, body) => calls.modal.push({ title, body }), hideModal: () => { calls.hidden = true; } };
	const notes = [];
	const mui = { btn: (label, fn) => Object.assign(E('button', {}, label), { click: fn }), notify: m => notes.push(m) };
	const st = load('view/mihomo/settings.js', { view: { extend: o => o }, ui, form: {}, api, mui, header: {} });
	st.reload = async () => { calls.reloaded = true; };
	return { st, calls, notes, log: p => onLog({ type: 'info', payload: p }), login: () => { logged = true; } };
}

(async () => {
	// 拿到链接并在登录后关闭
	let t = setup({});
	t.st.tsLogin('TS B');
	await tick();
	assert.strictEqual(t.calls.stream, '/logs?level=info', '先订阅 info 日志');
	assert.deepStrictEqual(t.calls.gets, [], '订阅建立后才测速');
	await tick();
	assert.deepStrictEqual(t.calls.gets, [ '/proxies/TS%20B/delay?url=http%3A%2F%2F100.100.100.100&timeout=8000' ], '对出站测速唤醒 tsnet');
	t.log('[Tailscale](Other) To start this tsnet server, restart with TS_AUTHKEY set, or go to: https://login.tailscale.com/a/other');
	t.log('[Tailscale](TS B) To start this tsnet server, restart with TS_AUTHKEY set, or go to: https://login.tailscale.com/a/abc123');
	const body = t.calls.modal[0].body;
	assert.ok(text(body[1]).includes('https://login.tailscale.com/a/abc123'), '显示本出站的登录链接');
	assert.ok(!text(body[1]).includes('/a/other'), '忽略其它出站的链接');
	t.login();
	await tick(); // 轮询
	await tick();
	assert.ok(t.calls.hidden && t.calls.closed && t.calls.reloaded, '登录后关闭弹窗、断开日志并刷新');
	assert.ok(t.notes.some(n => n.includes('u@example.com')));

	// 服务未运行时先启动；20 秒内没有链接时提示重启后重试
	t = setup({ running: false });
	t.st.tsLogin('TS B');
	await tick();
	assert.deepStrictEqual(t.calls.service, [ 'start' ], '服务未运行时先启动');
	await tick(); // 测速
	await tick(); // 超时
	const modal = t.calls.modal[0].body;
	assert.ok(text(modal[0]).includes('没有拿到登录链接'), text(modal[0]));
	assert.ok(text(modal[2]).includes('重启服务后重新获取'));
	modal[2].children[0].click();
	await tick();
	assert.deepStrictEqual(t.calls.service, [ 'start', 'restart' ], '重试时重启服务');
	// 新内核：登录接口直接返回链接，不订阅日志；轮询内核状态直到 Running
	t = setup({ kernel: true });
	t.st.tsLogin('TS B');
	await tick();
	assert.deepStrictEqual(t.calls.requests, [ 'POST /tailscale/TS%20B/login?wait=20' ]);
	assert.strictEqual(t.calls.stream, undefined, '不再订阅日志');
	assert.ok(text(t.calls.modal[0].body[1]).includes('https://login.tailscale.com/a/kernel1'), '显示内核返回的链接');
	await tick();
	assert.ok(t.calls.status >= 1 && !t.calls.hidden, '未登录时继续轮询');
	t.login();
	await tick();
	await tick();
	assert.ok(t.calls.hidden && t.calls.reloaded, '内核状态 Running 后关闭弹窗');
	assert.ok(t.notes.some(n => n.includes('k@example.com')));
	console.log('test_tailscale ok');
})().catch(e => { console.error(e); process.exit(1); });
