'use strict';
'require view';
'require ui';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';

/* 连接：/connections WebSocket 每秒一帧。每条连接的速率由相邻两帧的累计流量差得到；表格行按 id 复用，
 * 避免每秒整表重建导致点击落空。 */

const SORT_KEY = 'mihomo.connections.sort';
const SORTS = [ [ 'start', '最新' ], [ 'dlRate', '下载速率' ], [ 'ulRate', '上传速率' ], [ 'down', '下载量' ], [ 'up', '上传量' ] ];
const COLS = [ '来源', '目标', '网络', '规则', '链路', '↓ 速率', '↑ 速率', '流量', '时长', '' ];

function deviceIndex(list) {
	const idx = {};
	(list || []).forEach(d => {
		if (!d.name) return;
		if (d.ip4) idx[d.ip4] = d.name;
		(d.ip6 || []).forEach(ip => { idx[ip] = d.name; });
	});
	return idx;
}

function hostPort(h, port) {
	return (h.indexOf(':') >= 0 ? '[' + h + ']' : h) + (port ? ':' + port : '');
}

function toRows(snap, prev, now, devices) {
	prev = prev || {};
	devices = devices || {};
	const next = {};
	const rows = ((snap && snap.connections) || []).map(c => {
		const md = c.metadata || {};
		const p = prev[c.id];
		const d = c.download || 0, u = c.upload || 0;
		const dt = p ? (now - p.t) / 1000 : 0;
		const rate = (cur, old) => (p && dt > 0 && cur >= old) ? (cur - old) / dt : 0;
		next[c.id] = { d: d, u: u, t: now };
		const inner = md.type === 'Inner' || !md.sourceIP;
		const start = Date.parse(c.start);
		return {
			id: c.id,
			source: inner ? 'mihomo 内部' : (devices[md.sourceIP] || md.sourceIP),
			sourceIp: md.sourceIP || '',
			target: hostPort(md.host || md.sniffHost || md.destinationIP || md.remoteDestination || '-', md.destinationPort),
			network: String(md.network || '').toUpperCase() + (md.type ? ' · ' + md.type : ''),
			rule: c.rulePayload ? c.rule + '(' + c.rulePayload + ')' : (c.rule || ''),
			chain: (c.chains || []).slice().reverse().join(' → '),
			down: d,
			up: u,
			dlRate: rate(d, p ? p.d : 0),
			ulRate: rate(u, p ? p.u : 0),
			start: isNaN(start) ? 0 : start,
			duration: isNaN(start) ? 0 : Math.max(0, Math.floor((now - start) / 1000)),
			raw: c
		};
	});
	return { rows: rows, prev: next };
}

function matchRow(row, q) {
	if (!q) return true;
	q = String(q).toLowerCase();
	return [ row.source, row.sourceIp, row.target, row.rule, row.chain ].join('\n').toLowerCase().indexOf(q) >= 0;
}

function sortRows(rows, key) {
	return rows.sort((a, b) => (b[key] || 0) - (a[key] || 0));
}

function shortDuration(sec) {
	if (sec < 60) return sec + ' 秒';
	if (sec < 3600) return Math.floor(sec / 60) + ' 分';
	if (sec < 86400) return Math.floor(sec / 3600) + ' 时 ' + Math.floor(sec % 3600 / 60) + ' 分';
	return Math.floor(sec / 86400) + ' 天';
}

function setText(el, text, title) {
	if (el.textContent !== text) el.textContent = text;
	if (title !== undefined && el.title !== title) el.title = title;
}

return view.extend({
	deviceIndex, toRows, matchRow, sortRows,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.resolve();
	},

	render() {
		mui.loadCss();
		this.prev = {};
		this.devices = {};
		this.rows = [];
		this.totals = null;
		this.paused = false;
		this.q = '';
		this.sortKey = localStorage.getItem(SORT_KEY) || 'start';
		this.rowEls = new Map();

		const search = E('input', { type: 'search', 'class': 'cbi-input-text mh-search', placeholder: '搜索来源、目标、规则、链路' });
		search.addEventListener('input', () => { this.q = search.value.trim(); this.renderRows(); });
		const sort = E('select', { 'class': 'cbi-input-select', 'change': ev => {
			this.sortKey = ev.target.value;
			localStorage.setItem(SORT_KEY, this.sortKey);
			this.renderRows();
		} }, SORTS.map(s => E('option', { value: s[0] }, '排序：' + s[1])));
		sort.value = this.sortKey;
		this.pauseBtn = mui.btn('暂停', () => this.togglePause(), 'mh-btn-sm');
		this.countEl = E('span', { 'class': 'mh-count' }, '连接中…');

		this.tbody = E('tbody', {});
		this.tbody.addEventListener('click', ev => {
			const tr = ev.target.closest('tr[data-id]');
			if (!tr) return;
			const id = tr.getAttribute('data-id');
			if (ev.target.closest('[data-close]')) this.closeOne(id);
			else this.showDetail(id);
		});
		this.emptyEl = E('div', {}, mui.empty('没有活动连接'));
		this.emptyEl.hidden = true;

		const card = mui.card('活动连接', [
			E('div', { 'class': 'mh-toolbar' }, [
				search, sort, this.pauseBtn, E('span', { 'class': 'mh-grow' }), this.countEl,
				mui.btn('断开全部', () => this.closeAll(), 'mh-btn-sm cbi-button-negative')
			]),
			E('div', { 'class': 'mh-scroll-x' }, E('table', { 'class': 'mh-table mh-cards mh-conn-table' }, [
				E('thead', {}, E('tr', {}, COLS.map((c, i) => E('th', { 'class': (i >= 5 && i <= 8) ? 'mh-num' : '' }, c)))),
				this.tbody
			])),
			this.emptyEl
		]);

		const root = E('div', { 'class': 'mh' }, [ header.render(), card ]);
		if (this.stream) this.stream.close();
		if (this.poller) this.poller.close();
		this.stream = api.stream('/connections?interval=1000', d => this.onFrame(d), root);
		this.poller = api.poll(root, 60000, () => this.loadDevices());
		return root;
	},

	loadDevices() {
		return api.rpc.devices().then(r => { if (r && r.ok) this.devices = deviceIndex(r.list); }, () => {});
	},

	onFrame(d) {
		const r = toRows(d, this.prev, Date.now(), this.devices);
		this.prev = r.prev;
		this.rows = r.rows;
		this.totals = { down: d.downloadTotal || 0, up: d.uploadTotal || 0 };
		if (!this.paused) this.renderRows();
	},

	togglePause() {
		this.paused = !this.paused;
		this.pauseBtn.textContent = this.paused ? '继续' : '暂停';
		this.pauseBtn.classList.toggle('cbi-button-action', this.paused);
		this.renderRows();
	},

	renderRows() {
		const rows = sortRows(this.rows.filter(x => matchRow(x, this.q)), this.sortKey);
		const total = this.rows.length;
		let text = this.q ? rows.length + ' / ' + total + ' 条' : total + ' 条';
		if (this.totals) text += ' · 本次运行 ↓ ' + mui.fmtBytes(this.totals.down) + ' ↑ ' + mui.fmtBytes(this.totals.up);
		if (this.paused) text += ' · 已暂停';
		this.countEl.textContent = text;

		const seen = new Set();
		rows.forEach((row, i) => {
			let r = this.rowEls.get(row.id);
			if (!r) {
				r = this.makeRow(row.id);
				this.rowEls.set(row.id, r);
			}
			this.fillRow(r, row);
			seen.add(row.id);
			if (this.tbody.children[i] !== r.tr) this.tbody.insertBefore(r.tr, this.tbody.children[i] || null);
		});
		this.rowEls.forEach((r, id) => {
			if (seen.has(id)) return;
			r.tr.remove();
			this.rowEls.delete(id);
		});
		this.emptyEl.hidden = rows.length > 0;
		this.emptyEl.firstChild.firstChild.textContent = total ? '没有符合搜索条件的连接' : '没有活动连接';
	},

	makeRow(id) {
		// c-* 与 data-label 用于窄屏的卡片排版
		const td = (cls, label) => E('td', { 'class': cls, 'data-label': label || null });
		const r = {
			src: E('div', {}), srcIp: E('div', { 'class': 'mh-sub' }),
			target: td('mh-trunc c-tgt'), network: td('mh-dim c-net'), rule: td('mh-trunc c-rule'), chain: td('mh-trunc c-chain'),
			dl: td('mh-num c-dl', '↓'), ul: td('mh-num c-ul', '↑'), traffic: td('mh-num c-traffic'), dur: td('mh-num mh-dim c-dur')
		};
		r.tr = E('tr', { 'data-id': id }, [
			E('td', { 'class': 'mh-trunc c-src' }, [ r.src, r.srcIp ]),
			r.target, r.network, r.rule, r.chain, r.dl, r.ul, r.traffic, r.dur,
			E('td', { 'class': 'mh-actions c-act' }, E('button', { 'class': 'mh-x', 'data-close': '1', title: '断开' }, '×'))
		]);
		return r;
	},

	fillRow(r, row) {
		setText(r.src, row.source, row.source);
		setText(r.srcIp, row.source !== row.sourceIp ? row.sourceIp : '');
		setText(r.target, row.target, row.target);
		setText(r.network, row.network);
		setText(r.rule, row.rule, row.rule);
		setText(r.chain, row.chain, row.chain);
		setText(r.dl, row.dlRate ? mui.fmtRate(row.dlRate) : '-');
		setText(r.ul, row.ulRate ? mui.fmtRate(row.ulRate) : '-');
		setText(r.traffic, '↓ ' + mui.fmtBytes(row.down) + ' ↑ ' + mui.fmtBytes(row.up));
		setText(r.dur, shortDuration(row.duration));
		r.dl.classList.toggle('mh-dim', !row.dlRate);
		r.ul.classList.toggle('mh-dim', !row.ulRate);
	},

	closeOne(id) {
		api.del('/connections/' + encodeURIComponent(id)).then(() => {
			const r = this.rowEls.get(id);
			if (r) r.tr.classList.add('mh-closing');
		}, e => mui.notify('断开失败：' + e.message, 'error'));
	},

	closeAll() {
		mui.confirm('断开全部连接', '将断开当前全部 ' + this.rows.length + ' 条连接，正在进行的下载、通话等会中断（客户端通常会自动重连）。确定继续？', '断开全部', true).then(yes => {
			if (!yes) return;
			api.del('/connections').then(() => mui.notify('已断开全部连接'), e => mui.notify('断开失败：' + e.message, 'error'));
		});
	},

	showDetail(id) {
		const row = this.rows.find(x => x.id === id);
		if (!row) return;
		const c = row.raw, md = c.metadata || {};
		const providers = (c.providerChains || []).filter(Boolean);
		const kv = [
			[ '来源', (row.source !== row.sourceIp ? row.source + ' · ' : '') + hostPort(md.sourceIP || '-', md.sourcePort) ],
			[ '入站', [ md.type, md.inboundName ].filter(Boolean).join(' · ') || '-' ],
			[ '目标', row.target ],
			[ '域名', md.host || '-' ],
			[ '嗅探域名', md.sniffHost || '-' ],
			[ '目标 IP', md.destinationIP || '-' ],
			[ '实际连接地址', md.remoteDestination || '-' ],
			[ '规则', row.rule || '-' ],
			[ '链路', row.chain || '-' ],
			[ '订阅', providers.length ? providers.join('、') : '-' ],
			[ '出口地区', md.exitGeoIP || '-' ],
			[ 'DNS 模式', md.dnsMode || '-' ],
			[ '开始时间', mui.fmtDate(c.start) + '（' + shortDuration(row.duration) + '）' ],
			[ '流量', '↓ ' + mui.fmtBytes(row.down) + ' ↑ ' + mui.fmtBytes(row.up) ]
		];
		ui.showModal('连接详情', [
			E('div', { 'class': 'mh-detail' }, kv.map(x => mui.row(x[0], x[1]))),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '关闭'), ' ',
				E('button', { 'class': 'btn cbi-button-negative', 'click': () => { ui.hideModal(); this.closeOne(id); } }, '断开')
			])
		]);
	}
});
