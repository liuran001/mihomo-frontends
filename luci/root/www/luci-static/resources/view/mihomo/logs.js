'use strict';
'require view';
'require ui';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';

/* 日志：实时日志（控制器 /logs WebSocket）与系统日志（logread）。 */

const MAX_LINES = 1000;
const LEVELS = [ ['debug', '调试'], ['info', '信息'], ['warning', '警告'], ['error', '错误'] ];

function matches(entry, q) {
	if (!q) return true;
	q = q.toLowerCase();
	return entry.payload.toLowerCase().indexOf(q) >= 0 || entry.type.toLowerCase().indexOf(q) >= 0;
}

// 复制给别人看之前打码：节点链接、密钥类字段、UUID、tskey、长 token、公网 IPv4 后两段与公网 IPv6 后缀
function redact(text) {
	return String(text)
		.replace(/\b(https?|wss?|ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic|anytls|socks5?):\/\/[^\s'"]+/gi, (m, scheme) => scheme + '://***')
		.replace(/((?:secret|password|passwd|auth-key|authkey|token|private-key|pre-shared-key|psk|uuid|sid|short-id|public-key|key)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '***-uuid')
		.replace(/\btskey-[A-Za-z0-9-]+/g, 'tskey-***')
		.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '***')
		.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, a, b) => {
			const x = Number(a), y = Number(b);
			const local = x === 10 || x === 127 || x === 0 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y < 32)
				|| (x === 100 && y >= 64 && y < 128) || (x === 169 && y === 254) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
			return local ? m : a + '.' + b + '.x.x';
		})
		.replace(/\b(?:2[0-9a-f]{3}|3[0-9a-f]{3}):[0-9a-f:]{4,}/gi, m => m.split(':').slice(0, 2).join(':') + ':…');
}

// http 访问的 LuCI 不是安全上下文，没有 navigator.clipboard，退回到选中文本框再 execCommand
function copyText(area) {
	if (navigator.clipboard && window.isSecureContext)
		return navigator.clipboard.writeText(area.value).then(() => true, () => false);
	area.focus();
	area.select();
	let ok = false;
	try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
	return Promise.resolve(ok);
}

function clock() {
	const d = new Date();
	return [ d.getHours(), d.getMinutes(), d.getSeconds() ].map(n => (n < 10 ? '0' : '') + n).join(':');
}

return view.extend({
	matches, redact, MAX_LINES,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.resolve();
	},

	render() {
		mui.loadCss();
		this.paused = false;
		this.pending = [];
		this.query = '';
		this.level = localStorage.getItem('mihomo.logs.level') || 'info';

		this.box = E('div', { 'class': 'mh-logbox' });
		this.sysBox = E('pre', { 'class': 'mh-logbox' });
		this.sysBox.hidden = true;

		const levelSel = E('select', { 'class': 'cbi-input-select', 'change': ev => this.setLevel(ev.target.value) },
			LEVELS.map(l => E('option', { value: l[0] }, l[1])));
		levelSel.value = this.level;
		const search = E('input', { 'class': 'cbi-input-text mh-search', type: 'search', placeholder: '搜索日志', 'input': ev => this.setQuery(ev.target.value) });
		this.pauseBtn = mui.btn('暂停', () => this.togglePause(), 'mh-btn-sm');
		this.liveTools = E('span', { 'class': 'mh-tools' }, [ levelSel, search, this.pauseBtn, mui.btn('清空', () => this.box.replaceChildren(), 'mh-btn-sm') ]);
		this.sysTools = E('span', { 'class': 'mh-tools' }, [ mui.btn('刷新', () => this.loadSystem(), 'mh-btn-sm') ]);
		this.sysTools.hidden = true;

		this.diagBtn = mui.btn('复制诊断信息', () => this.diagnostics(), 'mh-btn-sm cbi-button-action');
		const tabLive = E('button', { 'class': 'mh-seg-btn active', 'click': () => this.switchTab(true) }, '实时日志');
		const tabSys = E('button', { 'class': 'mh-seg-btn', 'click': () => this.switchTab(false) }, '系统日志');
		this.tabs = [ tabLive, tabSys ];

		this.root = E('div', { 'class': 'mh' }, [
			header.render(),
			mui.card(null, [
				E('div', { 'class': 'mh-toolbar' }, [ E('div', { 'class': 'mh-tabs' }, this.tabs), E('span', { 'class': 'mh-grow' }), this.liveTools, this.sysTools, this.diagBtn ]),
				this.box,
				this.sysBox
			])
		]);
		this.connect();
		return this.root;
	},

	connect() {
		if (this.stream) this.stream.close();
		this.stream = api.stream('/logs?level=' + this.level, d => this.add({ type: d.type || 'info', payload: String(d.payload || ''), time: clock() }), this.root);
	},

	setLevel(level) {
		this.level = level;
		localStorage.setItem('mihomo.logs.level', level);
		this.connect();
	},

	setQuery(q) {
		this.query = q;
		Array.prototype.forEach.call(this.box.children, el => { el.hidden = !matches(el._entry, q); });
	},

	togglePause() {
		this.paused = !this.paused;
		this.pauseBtn.textContent = this.paused ? '继续（' + this.pending.length + '）' : '暂停';
		if (!this.paused) {
			const list = this.pending;
			this.pending = [];
			list.forEach(e => this.add(e));
		}
	},

	add(entry) {
		if (this.paused) {
			this.pending.push(entry);
			if (this.pending.length > MAX_LINES) this.pending.shift();
			this.pauseBtn.textContent = '继续（' + this.pending.length + '）';
			return;
		}
		const box = this.box;
		const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
		const el = E('div', { 'class': 'mh-log-row lv-' + entry.type }, [
			E('time', {}, entry.time),
			E('span', { 'class': 'mh-log-lv' }, entry.type),
			E('span', {}, entry.payload)
		]);
		el._entry = entry;
		el.hidden = !matches(entry, this.query);
		box.appendChild(el);
		while (box.children.length > MAX_LINES) box.firstChild.remove();
		if (atBottom) box.scrollTop = box.scrollHeight;
	},

	switchTab(live) {
		this.tabs[0].classList.toggle('active', live);
		this.tabs[1].classList.toggle('active', !live);
		this.box.hidden = !live;
		this.liveTools.hidden = !live;
		this.sysBox.hidden = live;
		this.sysTools.hidden = live;
		if (live) this.connect();
		else {
			if (this.stream) this.stream.close();
			this.loadSystem();
		}
	},

	// 诊断信息 = 系统/插件/内核/网络概况 + 最近系统日志 + 页面上的实时日志，打码后可直接复制
	diagnostics() {
		this.diagBtn.disabled = true;
		return api.rpc.diagnostics().then(r => {
			if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
			const live = Array.prototype.map.call(this.box.children, el => el._entry ? el._entry.time + ' ' + el._entry.type + ' ' + el._entry.payload : '')
				.filter(Boolean).slice(-200);
			const text = redact([ '# mihomo-ebpf 诊断信息（LuCI）', '时间: ' + new Date().toISOString(), '页面: ' + navigator.userAgent, r.text,
				live.length ? '\n== 实时日志（本页最近 ' + live.length + ' 条）==\n' + live.join('\n') : '' ].join('\n'));
			const area = E('textarea', { 'class': 'cbi-input-textarea', readonly: '', rows: 20, style: 'width:100%;font-family:monospace;font-size:12px' }, text);
			ui.showModal('诊断信息', [
				E('p', { 'class': 'mh-note' }, '节点链接、密钥、UUID 与公网 IP 已打码；配置文件内容不会包含在内。发给别人前请再看一遍。'),
				area,
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '关闭'), ' ',
					E('button', { 'class': 'btn cbi-button-action', 'click': () => copyText(area).then(ok =>
						mui.notify(ok ? '已复制' : '复制失败，请在文本框里全选后手动复制', ok ? undefined : 'error')) }, '复制全部')
				])
			]);
		}).catch(e => mui.notify('读取诊断信息失败：' + e.message, 'error')).then(() => { this.diagBtn.disabled = false; });
	},

	loadSystem() {
		this.sysBox.textContent = '读取中…';
		api.rpc.logs(500).then(r => {
			this.sysBox.textContent = r.ok ? (r.text || '（没有日志）') : r.error;
			this.sysBox.scrollTop = this.sysBox.scrollHeight;
		}, e => { this.sysBox.textContent = '读取失败：' + e.message; });
	}
});
