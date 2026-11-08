'use strict';

const assert = require('assert');
const { load, baseclass } = require('./harness');

if (require.main !== module) {
	require('child_process').execFileSync(process.execPath, [ __filename ], { stdio: 'inherit' });
	return;
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function environment() {
	const timers = new Map(), observers = new Set(), sockets = [], listeners = new Map();
	let nextTimer = 0;
	const events = {
		addEventListener(name, callback) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name).add(callback);
		},
		removeEventListener(name, callback) { if (listeners.has(name)) listeners.get(name).delete(callback); }
	};
	const document = { ...events, hidden: false, body: { contains: root => root.connected } };
	const options = {
		baseclass, document, window: events, location: { protocol: 'http:', hostname: 'router.invalid' }, AbortController,
		rpc: { declare: () => async () => ({ ok: true, reachable: true, port: 9090 }) },
		setTimeout(callback, interval) { const timer = ++nextTimer; timers.set(timer, { callback, interval }); return timer; },
		clearTimeout(timer) { timers.delete(timer); },
		MutationObserver: class {
			constructor(callback) { this.callback = callback; }
			observe() { observers.add(this.callback); }
			disconnect() { observers.delete(this.callback); }
		},
		WebSocket: class {
			constructor(url) { this.url = url; this.closed = false; sockets.push(this); }
			close() { this.closed = true; if (this.onclose) this.onclose(); }
		}
	};
	return {
		options, timers, observers, sockets, document, listeners,
		visibility(hidden) { document.hidden = hidden; for (const callback of listeners.get('visibilitychange') || []) callback(); },
		mutate() { for (const callback of Array.from(observers)) callback(); },
		async tick() {
			const waiting = Array.from(timers.entries());
			for (const [timer, task] of waiting) { timers.delete(timer); task.callback(); }
			await settle();
		}
	};
}

async function checkPolling() {
	const mock = environment(), api = load('mihomo/api.js', mock.options), root = { connected: false };
	let requests = 0, release;
	const poller = api.poll(root, 2000, () => {
		requests++;
		return new Promise(resolve => { release = resolve; });
	});
	await settle();
	assert.strictEqual(requests, 0, 'unmounted views do not poll');
	root.connected = true;
	mock.mutate();
	await settle();
	assert.strictEqual(requests, 1);
	assert.strictEqual(mock.timers.size, 0, 'pending reads cannot overlap');
	mock.visibility(true);
	release();
	await settle();
	assert.strictEqual(mock.timers.size, 0, 'hidden completion cannot restart polling');
	mock.visibility(false);
	await settle();
	assert.strictEqual(requests, 2);
	release();
	await settle();
	assert.strictEqual(mock.timers.size, 1);
	await mock.tick();
	assert.strictEqual(requests, 3);
	mock.visibility(true);
	mock.visibility(false);
	await settle();
	assert.strictEqual(requests, 3, 'visibility changes cannot duplicate an outstanding read');
	root.connected = false;
	mock.mutate();
	release();
	await settle();
	assert.strictEqual(mock.timers.size, 0);
	assert.strictEqual(mock.observers.size, 0, 'unmount removes observation');
	assert.strictEqual(mock.listeners.get('visibilitychange').size, 0);
	poller.close();
	root.connected = true;
	const delayed = api.poll(root, 2000, () => requests++, false);
	await settle();
	assert.strictEqual(requests, 3, 'views with an initial load do not read it twice');
	await mock.tick();
	assert.strictEqual(requests, 4);
	for (const callback of mock.listeners.get('pagehide')) callback();
	assert.strictEqual(mock.timers.size, 0);
	for (const callback of mock.listeners.get('pageshow')) callback();
	await mock.tick();
	assert.strictEqual(requests, 5, 'back-forward cache restoration resumes polling');
	delayed.close();
}

async function checkStreams() {
	const mock = environment(), api = load('mihomo/api.js', mock.options), root = { connected: true };
	let frames = 0;
	const stream = api.stream('/connections?interval=1000', () => frames++, root);
	await settle();
	assert.strictEqual(mock.sockets.length, 1);
	mock.sockets[0].onmessage({ data: '{}' });
	assert.strictEqual(frames, 1);
	mock.visibility(true);
	assert.strictEqual(mock.sockets[0].closed, true);
	assert.strictEqual(mock.timers.size, 0, 'hidden streams do not reconnect');
	mock.visibility(false);
	await settle();
	assert.strictEqual(mock.sockets.length, 2);
	mock.sockets[1].close();
	assert.strictEqual(mock.timers.size, 1);
	await mock.tick();
	assert.strictEqual(mock.sockets.length, 3);
	root.connected = false;
	mock.mutate();
	assert.strictEqual(mock.sockets[2].closed, true);
	assert.strictEqual(mock.timers.size, 0);
	assert.strictEqual(mock.observers.size, 0);
	stream.close();

	const pending = environment();
	let resolveController;
	pending.options.rpc = { declare: () => () => new Promise(resolve => { resolveController = resolve; }) };
	const delayed = load('mihomo/api.js', pending.options).stream('/logs', () => {}, { connected: true });
	pending.visibility(true);
	pending.visibility(false);
	resolveController({ ok: true, reachable: true, port: 9090 });
	await settle();
	assert.strictEqual(pending.sockets.length, 1, 'stale controller lookups cannot open duplicate streams');
	delayed.close();
}

async function checkBodyTimeout() {
	const mock = environment();
	let bodyStarted = false;
	mock.options.fetch = async (url, options) => ({
		ok: true, status: 200,
		text: () => new Promise((resolve, reject) => {
			bodyStarted = true;
			options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
		})
	});
	const api = load('mihomo/api.js', mock.options);
	const result = api.get('/overview').then(() => null, error => error);
	await settle();
	assert.strictEqual(bodyStarted, true);
	assert.strictEqual(mock.timers.size, 1, 'deadline remains active after response headers');
	await mock.tick();
	assert.match((await result).message, /请求超时/);
	assert.strictEqual(mock.timers.size, 0);
}

async function checkOverview() {
	const reads = [], streams = [], polls = [];
	let legacy = false;
	const api = {
		get: async endpoint => {
			reads.push(endpoint);
			if (legacy) throw Object.assign(new Error('HTTP 404'), { status: 404 });
			if (endpoint === '/connections/sources') return { sources: [{ source: '192.168.1.20', upload: 10, download: 20 }] };
			return { connectionCount: 10000, memory: 5000, uploadTotal: 1, downloadTotal: 2, exit: { chain: ['DIRECT'] }, providers: {} };
		},
		rpc: { devices: async () => ({ ok: true, list: [{ mac: 'aa:bb:cc:00:11:22', ip4: '192.168.1.20', name: 'phone' }] }) },
		stream: (endpoint, callback, root) => { streams.push({ endpoint, root }); return { close() {} }; },
		poll: (root, interval, callback) => { polls.push({ root, interval, callback }); return { close() {} }; }
	};
	const dl = load('mihomo/devices.js', { baseclass });
	const view = load('view/mihomo/overview.js', {
		view: baseclass, api, mui: { fmtBytes: String, fmtRate: String, empty: String }, chart: { sparkline: () => null }, header: {}, dl
	});
	view.els = Object.fromEntries(['conns', 'dlTotal', 'ulTotal', 'connSpark', 'mem', 'memSpark', 'exit', 'exitChain', 'subs'].map(name => [name, { replaceChildren() {} }]));
	view.connHist = [];
	view.memHist = [];
	view.renderSubs = () => {};
	view.renderEbpf = () => {};
	view.devSampler = dl.sampler();
	view.devList = [];
	view.devCard = { hidden: true };
	view.els.devs = { replaceChildren() {} };
	global.E = () => ({});
	const root = {};
	view.startStreams(root);
	assert.deepStrictEqual(streams, [{ endpoint: '/traffic', root }]);
	assert.strictEqual(polls[0].interval, 2000);
	assert.strictEqual(polls[1].interval, 2000);
	await polls[0].callback();
	await Promise.all([view.refreshSlow(), view.refreshSlow()]);
	await polls[1].callback();
	assert.deepStrictEqual(reads, ['/connections/summary', '/overview', '/ebpf/summary', '/connections/sources'],
		'per-device traffic reads the per-source counters, not the connection table');
	assert.strictEqual(view.devCard.hidden, false, 'devices with traffic are shown');
	assert.strictEqual(view.els.conns.textContent, '10000');
	const summary = view.subSummary({ count: 2000, subscriptionInfo: { Upload: 2, Download: 3, Total: 10 } });
	assert.deepStrictEqual([summary.alive, summary.total, summary.used], [null, 2000, 5]);
	await view.inspectEbpf();
	assert.strictEqual(reads.at(-1), '/ebpf', 'map scans are manual only');
	reads.length = 0;
	legacy = true;
	await polls[0].callback();
	await view.refreshSlow();
	await polls[1].callback();
	await polls[1].callback();
	assert.deepStrictEqual(reads, ['/connections/summary', '/overview', '/ebpf/summary', '/connections/sources'], '404 never falls back to full tables');
	assert.strictEqual(view.els.conns.textContent, '请升级内核');
}

(async () => {
	await checkPolling();
	await checkStreams();
	await checkBodyTimeout();
	await checkOverview();
	console.log('performance: summaries, hidden/unmounted lifecycle, single-flight and body timeout passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
