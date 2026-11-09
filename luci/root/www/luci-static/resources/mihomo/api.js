'use strict';
'require baseclass';
'require rpc';

/* 两条数据通道：
 * - rpc：LuCI 会话 → rpcd 对象 luci.mihomo（读写配置、校验、服务启停等需要 root 的操作）
 * - 控制器：浏览器直连 mihomo REST/WebSocket（实时数据与运行时操作），方式与 zashboard 相同 */

const OBJECT = 'luci.mihomo';

function declare(method, params) {
	return rpc.declare({ object: OBJECT, method: method, params: params || [] });
}

const SETUP_APPLY = ['source', 'subs', 'lan', 'secret', 'content', 'url', 'ua', 'adapt', 'skip', 'start', 'rev'];
const SETUP_ADAPT = ['content', 'lan', 'secret', 'skip'];
const SETUP_RENDER = ['subs', 'lan', 'secret'];
const CORE_SETTINGS = ['repo', 'tag', 'mirror'];

const rpcs = {
	status: declare('status'),
	controller: declare('controller'),
	configRead: declare('config_read'),
	backups: declare('backups'),
	backupRead: declare('backup_read', ['name']),
	logs: declare('logs', ['lines']),
	diagnostics: declare('diagnostics'),
	substoreStatus: declare('substore_status'),
	substoreList: declare('substore_list'),
	substoreSet: declare('substore_set', ['mode', 'port', 'lan', 'url']),
	substoreInstall: declare('substore_install', ['what']),
	substoreService: declare('substore_service', ['action']),
	devices: declare('devices'),
	sections: declare('sections', ['names']),
	interfaces: declare('interfaces'),
	tailscale: declare('tailscale'),
	tailscaleLogout: declare('tailscale_logout', ['name']),
	applyStatus: declare('apply_status', ['job']),
	validate: declare('validate', ['content']),
	yamlCheck: declare('yaml_check', ['content']),
	saveRaw: declare('save_raw', ['content', 'rev']),
	patch: declare('patch', ['ops', 'rev']),
	providerToggle: declare('provider_toggle', ['name', 'enabled', 'rev']),
	migrateIncludeAll: declare('migrate_include_all', ['rev']),
	backupRestore: declare('backup_restore', ['name']),
	backupDelete: declare('backup_delete', ['name']),
	service: declare('service', ['action']),
	ruleTest: declare('rule_test', ['target']),
	coreInfo: declare('core_info'),
	coreCheck: declare('core_check'),
	coreUpdate: declare('core_update', ['force']),
	coreRollback: declare('core_rollback'),
	coreSettings: declare('core_settings', CORE_SETTINGS),
	pluginStatus: declare('plugin_status'),
	pluginCheck: declare('plugin_check'),
	pluginUpgrade: declare('plugin_upgrade', ['force']),
	setupStatus: declare('setup_status'),
	setupRender: declare('setup_render', SETUP_RENDER),
	setupFetch: declare('setup_fetch', ['url', 'ua']),
	setupAdapt: declare('setup_adapt', SETUP_ADAPT),
	setupApply: declare('setup_apply', SETUP_APPLY)
};

// 参数较多的方法按对象传参：按声明顺序展开，缺省的键为 undefined，序列化时省略，由插件取默认值
function named(method, params) {
	return a => rpcs[method].apply(null, params.map(k => (a || {})[k]));
}
const setupApply = named('setupApply', SETUP_APPLY);
const setupRender = named('setupRender', SETUP_RENDER);
const setupAdapt = named('setupAdapt', SETUP_ADAPT);
const coreSettings = named('coreSettings', CORE_SETTINGS);

const HTTPS_REASON = '当前以 https 打开 LuCI，浏览器会拦截到控制器的 http 连接；实时功能请改用 http 访问 LuCI，或在配置里启用 external-controller-tls（并在 tls 中配置证书），页面会自动改用 TLS 控制器';
const TLS_HINT = '若控制器使用自签证书，请先让浏览器信任该证书';

function hostPort(endpoint, hostname) {
	let host = endpoint.host || hostname;
	if (host.indexOf(':') >= 0 && host[0] !== '[') host = '[' + host + ']';
	return host + ':' + endpoint.port;
}

function baseUrl(endpoint, hostname) {
	return endpoint.scheme + '://' + hostPort(endpoint, hostname);
}

function endpointOf(scheme, c) {
	if (!c)
		return null;
	return { scheme: scheme, listen: c.listen, host: c.host, port: c.port, reachable: !!c.reachable, reason: c.reason };
}

// 按页面协议选择控制器：http 页面优先明文，https 页面只能用 TLS（明文会被混合内容拦截）。
// 首选监听不可用时退到另一个；https 页面不能退到 http。
function chooseEndpoint(c, protocol) {
	if (!c || !c.ok)
		return { endpoint: null, reason: (c && c.error) || '无法读取控制器设置' };
	const plain = endpointOf('http', c);
	const tls = endpointOf('https', c.tls);
	if (protocol === 'https:') {
		if (tls && tls.reachable) return { endpoint: tls, reason: null };
		if (plain.reachable) return { endpoint: null, reason: HTTPS_REASON };
		return { endpoint: null, reason: (tls && tls.reason) || plain.reason };
	}
	if (plain.reachable) return { endpoint: plain, reason: null };
	if (tls && tls.reachable) return { endpoint: tls, reason: null };
	return { endpoint: null, reason: plain.reason || (tls && tls.reason) };
}

// zashboard 的地址，带上自动连接后端的参数（secret 在 # 之后，不会发给服务器）。
// 面板与控制器的协议保持一致：https 控制器给出 https 链接，面板的 WebSocket 随之走 wss。
function dashboardUrl(c, hostname, protocol) {
	if (!c || !c.ok) return { url: null, reason: (c && c.error) || '无法读取控制器设置' };
	if (!c.ui) return { url: null, reason: '配置中没有面板目录（external-ui），可在 设置 → 基础 → 控制器与面板 填写，例如 ./dashboard' };
	const picked = chooseEndpoint(c, protocol || 'http:');
	if (!picked.endpoint) return { url: null, reason: picked.reason };
	const endpoint = picked.endpoint;
	const host = endpoint.host || hostname.replace(/^\[(.*)\]$/, '$1');
	const path = '/ui/' + (c.ui_name ? encodeURIComponent(c.ui_name) + '/' : '');
	let q = 'hostname=' + encodeURIComponent(host) + '&port=' + endpoint.port + '&protocol=' + endpoint.scheme;
	if (c.secret) q += '&secret=' + encodeURIComponent(c.secret);
	return { url: baseUrl(endpoint, hostname) + path + '#/setup?' + q, reason: null };
}

function withToken(path, secret) {
	if (!secret) return path;
	return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(secret);
}

let ctl = null;          // Promise<{ base, secret, reason }>
let current = { base: null, secret: '', reason: null };
let online = null;
const stateListeners = [];

function setOnline(v) {
	if (online === v) return;
	online = v;
	stateListeners.forEach(f => f(v));
}

function onState(f) {
	stateListeners.push(f);
	if (online !== null) f(online);
	return () => {
		const index = stateListeners.indexOf(f);
		if (index >= 0) stateListeners.splice(index, 1);
	};
}

function controller(force) {
	if (ctl && !force) return ctl;
	ctl = rpcs.controller().then(c => {
		const picked = chooseEndpoint(c, location.protocol);
		const base = picked.endpoint ? baseUrl(picked.endpoint, location.hostname) : null;
		current = { base: base, secret: (c && c.secret) || '', reason: picked.reason, raw: c, endpoint: picked.endpoint };
		return current;
	}, e => {
		// rpc 失败不缓存，下次调用时重试
		ctl = null;
		current = { base: null, secret: '', reason: '无法读取控制器设置：' + e.message };
		return current;
	});
	return ctl;
}

function request(method, path, body, opts) {
	opts = opts || {};
	return controller().then(c => {
		if (!c.base) throw new Error(c.reason);
		const init = { method: method, headers: {} };
		if (c.secret) init.headers.Authorization = 'Bearer ' + c.secret;
		if (body !== undefined) {
			init.headers['Content-Type'] = 'application/json';
			init.body = JSON.stringify(body);
		}
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), opts.timeout || 10000);
		init.signal = abort.signal;
		return fetch(c.base + path, init).then(r => {
			setOnline(true);
			if (r.status === 204) return null;
			return r.text().then(txt => {
				let data = txt;
				try { data = txt ? JSON.parse(txt) : null; } catch (e) { /* 非 JSON 响应原样返回 */ }
				if (!r.ok) {
					const err = new Error((data && data.message) || ('HTTP ' + r.status));
					err.status = r.status;
					throw err;
				}
				return data;
			});
		}).catch(e => {
			if (e.name === 'AbortError') throw new Error('请求超时');
			if (e.status) throw e;
			setOnline(false);
			throw new Error('无法连接 mihomo 控制器' + (c.base.indexOf('https:') === 0 ? '；' + TLS_HINT : ''));
		}).finally(() => clearTimeout(timer));
	});
}

function observeView(root, activate, deactivate) {
	let active = false, attached = false, closed = false;
	const observer = root ? new MutationObserver(refresh) : null;
	function close() {
		if (closed) return;
		closed = true;
		if (observer) observer.disconnect();
		document.removeEventListener('visibilitychange', refresh);
		window.removeEventListener('pagehide', suspend);
		window.removeEventListener('pageshow', refresh);
		if (active) { active = false; deactivate(); }
	}
	function suspend() {
		if (active) { active = false; deactivate(); }
	}
	function refresh() {
		if (closed) return;
		const connected = !root || document.body.contains(root);
		if (attached && !connected) return close();
		attached = attached || connected;
		const visible = connected && !document.hidden;
		if (visible === active) return;
		active = visible;
		if (active) activate(); else deactivate();
	}
	if (observer) observer.observe(document.body, { childList: true, subtree: true });
	document.addEventListener('visibilitychange', refresh);
	window.addEventListener('pagehide', suspend);
	window.addEventListener('pageshow', refresh);
	refresh();
	return close;
}

function poll(root, interval, callback, immediate = true) {
	let active = false, pending = null, timer = null;
	function run() {
		timer = null;
		if (!active || pending) return;
		pending = Promise.resolve().then(() => active ? callback() : null).catch(() => null).finally(() => {
			pending = null;
			if (active) timer = setTimeout(run, interval);
		});
	}
	const close = observeView(root, () => {
		active = true;
		if (immediate) run(); else if (!pending) timer = setTimeout(run, interval);
	}, () => {
		active = false;
		clearTimeout(timer);
		timer = null;
	});
	return { close };
}

function stream(path, onMessage, root) {
	let socket = null, active = false, opening = false, timer = null, generation = 0;
	const retry = () => {
		clearTimeout(timer);
		if (active) timer = setTimeout(open, 3000);
	};
	function suspend() {
		active = false;
		generation++;
		clearTimeout(timer);
		timer = null;
		if (socket) {
			socket.onopen = socket.onmessage = socket.onclose = null;
			socket.close();
			socket = null;
		}
	}
	function open() {
		if (!active || socket || opening) return;
		opening = true;
		const current = generation;
		controller().then(c => {
			if (!active || current !== generation) return;
			if (!c.base) return retry();
			const client = new WebSocket(c.base.replace(/^http/, 'ws') + withToken(path, c.secret));
			socket = client;
			client.onopen = () => setOnline(true);
			client.onmessage = ev => {
				if (document.hidden || (root && !document.body.contains(root))) return;
				let d;
				try { d = JSON.parse(ev.data); } catch (e) { return; }
				onMessage(d);
			};
			client.onclose = () => {
				if (socket !== client) return;
				socket = null;
				if (!active) return;
				setOnline(false);
				retry();
			};
		}).catch(() => { if (current === generation) retry(); }).finally(() => {
			opening = false;
			if (active && current !== generation) open();
		});
	}
	const close = observeView(root, () => { active = true; open(); }, suspend);
	return { close };
}

return baseclass.extend({
	rpc: rpcs,
	baseUrl, chooseEndpoint, withToken, dashboardUrl, controller, request, stream, poll, onState,
	setupApply, setupRender, setupAdapt, coreSettings,
	// 面板链接 { url, reason }
	dashboard: () => controller().then(c => dashboardUrl(c.raw, location.hostname, location.protocol)),
	reason: () => current.reason,
	isOnline: () => online,
	get: (p, opts) => request('GET', p, undefined, opts),
	put: (p, b) => request('PUT', p, b),
	post: (p, b) => request('POST', p, b),
	patch: (p, b) => request('PATCH', p, b),
	del: p => request('DELETE', p)
});
