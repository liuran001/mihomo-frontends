'use strict';
'require view';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.chart as chart';
'require mihomo.header as header';

/* 概览：实时网速、流量与连接、内存、当前出口、连通性、eBPF 状态、订阅摘要。 */

const SITES = [
	[ '百度', 'https://www.baidu.com/favicon.ico' ],
	[ 'Google', 'https://www.gstatic.com/generate_204' ],
	[ 'GitHub', 'https://github.githubassets.com/favicon.ico' ],
	[ 'YouTube', 'https://www.youtube.com/favicon.ico' ]
];
const IP_KEY = 'mihomo.overview.exitip';
const SPARK_N = 40;

// 从 MATCH 规则指向的策略组出发，沿 now 追到最终节点；遇到 smart 组（按连接自动选择）就停
function exitChain(proxies, start) {
	const chain = [];
	let name = start, smart = false;
	while (name && proxies[name] && chain.indexOf(name) < 0) {
		chain.push(name);
		const p = proxies[name];
		if (!p.all) break;
		if (p.type === 'Smart') { smart = true; break; }
		if (p.type === 'LoadBalance') break;
		name = p.now;
	}
	return { chain, smart };
}

// map 占用：fork 的 pressure 取值为 healthy / configured（策略表，不统计）/ not_applicable / unknown /
// warning（≥85%）/ degraded（≥95%）/ unavailable（读取失败）；status 为 pass / warning / degraded / unknown
const MAP_STATUS = { pass: ['正常', 'mh-ok'], warning: ['接近上限', 'mh-warn'], degraded: ['已满', 'mh-err'], unknown: ['部分无法读取', 'mh-warn'] };

function mapSummary(report) {
	const maps = (report && report.maps) || [];
	const pressured = maps.filter(m => m.pressure === 'warning' || m.pressure === 'degraded').map(m => m.name);
	let busiest = null;
	maps.forEach(m => {
		if (m.category !== 'runtime' || !m.supported || !m.max_entries) return;
		const ratio = (m.entries || 0) / m.max_entries;
		if (!busiest || ratio > busiest.ratio) busiest = { name: m.name, ratio: ratio };
	});
	const st = MAP_STATUS[report && report.status] || [ (report && report.status) || '未知', 'mh-warn' ];
	return {
		cls: st[1],
		text: st[0] + ' · ' + maps.length + ' 个' + (pressured.length ? ' · ' + pressured.length + ' 个接近上限' : ''),
		pressured: pressured,
		busiest: busiest
	};
}

function subSummary(p) {
	const list = p.proxies || [];
	const info = p.subscriptionInfo || {};
	const used = (info.Upload || 0) + (info.Download || 0);
	return {
		name: p.name,
		alive: p.proxies ? list.filter(x => x.alive).length : null,
		total: p.count == null ? list.length : p.count,
		used: used,
		quota: info.Total || 0,
		ratio: info.Total ? used / info.Total : null,
		expire: info.Expire || 0,
		updatedAt: p.updatedAt
	};
}

// 订阅到期提示：已过期红色，7 天内黄色；expire 为秒级时间戳，0 表示长期
function expireClass(expire, now) {
	if (!expire) return '';
	const left = expire * 1000 - (now || Date.now());
	return left <= 0 ? 'mh-err' : (left < 7 * 86400 * 1000 ? 'mh-warn' : '');
}

function timedFetch(url, ms) {
	const abort = new AbortController();
	const t = setTimeout(() => abort.abort(), ms);
	const start = performance.now();
	return fetch(url, { mode: 'no-cors', cache: 'no-store', signal: abort.signal })
		.then(() => Math.round(performance.now() - start), () => 0)
		.finally(() => clearTimeout(t));
}

function jsonFetch(url) {
	const abort = new AbortController();
	const t = setTimeout(() => abort.abort(), 6000);
	return fetch(url, { cache: 'no-store', signal: abort.signal }).then(r => r.json()).finally(() => clearTimeout(t));
}

return view.extend({
	exitChain, subSummary, mapSummary, expireClass,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.resolve();
	},

	render() {
		mui.loadCss();
		this.els = {};
		this.connHist = [];
		this.memHist = [];
		const v = (key, cls) => (this.els[key] = E('span', { 'class': cls || '' }, '-'));

		this.net = chart.lineChart({
			series: [ { label: '下载', cls: 'down' }, { label: '上传', cls: 'up' } ],
			format: mui.fmtRate,
			height: 190
		});

		const speed = mui.card('实时网速', [
			E('div', { 'class': 'mh-speed-now' }, [
				E('div', { 'class': 'mh-speed down' }, [ E('span', {}, '↓ 下载'), v('down', 'mh-big') ]),
				E('div', { 'class': 'mh-speed up' }, [ E('span', {}, '↑ 上传'), v('up', 'mh-big') ])
			]),
			this.net.el
		]);

		this.els.connSpark = E('div', { 'class': 'mh-spark-wrap' });
		this.els.memSpark = E('div', { 'class': 'mh-spark-wrap' });
		const kpis = E('div', { 'class': 'mh-grid mh-kpis' }, [
			mui.kpi('本次运行流量', [ E('div', { 'class': 'mh-big' }, [ '↓ ', v('dlTotal') ]), E('div', { 'class': 'mh-sub' }, [ '↑ ', v('ulTotal') ]) ]),
			mui.kpi('活动连接', [ v('conns', 'mh-big'), this.els.connSpark ]),
			mui.kpi('内存', [ v('mem', 'mh-big'), this.els.memSpark ]),
			mui.kpi('当前出口', [ v('exit', 'mh-big mh-ellipsis'), v('exitChain', 'mh-sub mh-ellipsis') ])
		]);

		this.siteEls = SITES.map(s => E('span', { 'class': 'mh-chip none' }, [ E('b', {}, s[0]), E('span', {}, '-') ]));
		const ipToggle = E('input', { type: 'checkbox', 'change': ev => { localStorage.setItem(IP_KEY, ev.target.checked ? '1' : '0'); this.checkIp(); } });
		ipToggle.checked = localStorage.getItem(IP_KEY) !== '0';
		this.ipToggle = ipToggle;
		this.els.ipBox = E('div', { 'class': 'mh-ipbox' });
		const conn = mui.card('连通性', [ E('div', { 'class': 'mh-chips' }, this.siteEls), this.els.ipBox ], {
			tools: [
				E('label', { 'class': 'mh-switch', title: '查询出口 IP 会访问外部 IP 服务（ipip.net、ipwho.is）' }, [ ipToggle, '出口 IP' ]),
				mui.btn('重测', () => { this.checkSites(); this.checkIp(); }, 'mh-btn-sm')
			]
		});

		this.els.ebpf = E('div', {}, mui.empty('读取中…'));
		const ebpf = mui.card('eBPF 透明代理', this.els.ebpf, {
			tools: [ mui.btn('详细诊断', () => this.inspectEbpf(), 'mh-btn-sm') ]
		});

		this.els.subs = E('div', { 'class': 'mh-sub-list' }, mui.empty('读取中…'));
		this.els.updateAll = mui.btn('全部更新', () => this.updateAll(), 'mh-btn-sm');
		const subs = mui.card('订阅', this.els.subs, { tools: [ this.els.updateAll ] });

		const root = E('div', { 'class': 'mh' }, [
			header.render(),
			speed,
			kpis,
			E('div', { 'class': 'mh-grid mh-pair' }, [ conn, ebpf ]),
			subs
		]);

		this.startStreams(root);
		if (this.slowPoll) this.slowPoll.close();
		this.slowPoll = api.poll(root, 30000, () => this.refreshSlow());
		this.checkSites();
		this.checkIp();
		return root;
	},

	startStreams(root) {
		if (this.trafficStream) this.trafficStream.close();
		if (this.summaryPoll) this.summaryPoll.close();
		this.trafficStream = api.stream('/traffic', d => {
			this.els.down.textContent = mui.fmtRate(d.down);
			this.els.up.textContent = mui.fmtRate(d.up);
			this.net.push([ d.down, d.up ]);
		}, root);
		this.summaryPoll = api.poll(root, 2000, () => api.get('/connections/summary').then(d => {
			this.els.conns.textContent = String(d.connectionCount);
			this.els.dlTotal.textContent = mui.fmtBytes(d.downloadTotal);
			this.els.ulTotal.textContent = mui.fmtBytes(d.uploadTotal);
			this.connHist.push(d.connectionCount);
			if (this.connHist.length > SPARK_N) this.connHist.shift();
			this.els.connSpark.replaceChildren(chart.sparkline(this.connHist, { points: SPARK_N }));
			this.els.mem.textContent = mui.fmtBytes(d.memory);
			this.memHist.push(d.memory);
			if (this.memHist.length > SPARK_N) this.memHist.shift();
			this.els.memSpark.replaceChildren(chart.sparkline(this.memHist, { points: SPARK_N }));
		}, error => {
			this.els.conns.textContent = error.status === 404 ? '请升级内核' : '读取失败';
		}));
	},

	refreshSlow() {
		if (this.slowPending) return this.slowPending;
		this.slowPending = Promise.all([
			api.get('/overview').then(data => {
				const exit = data.exit || {}, chain = exit.chain || [];
				const last = chain[chain.length - 1];
				this.els.exit.textContent = last ? last + (exit.smart ? '（Smart）' : '') : '-';
				this.els.exitChain.textContent = chain.join(' → ');
				this.els.exitChain.title = chain.join(' → ');
				this.renderSubs(data.providers || {});
			}, error => {
				this.els.exit.textContent = error.status === 404 ? '请升级内核' : '读取失败';
				this.els.subs.replaceChildren(mui.empty('无法读取订阅摘要：' + error.message));
			}),
			api.get('/ebpf/summary').then(data => this.renderEbpf(data), error => this.renderEbpf(null, error))
		]).finally(() => { this.slowPending = null; });
		return this.slowPending;
	},

	inspectEbpf() {
		if (this.inspection) return this.inspection;
		this.inspection = api.get('/ebpf').then(data => this.renderEbpf(data), error => this.renderEbpf(null, error))
			.finally(() => { this.inspection = null; });
		return this.inspection;
	},

	renderEbpf(d, err) {
		const box = this.els.ebpf;
		if (!d) {
			box.replaceChildren(mui.empty(err && err.status === 404 ? '请升级支持轻量 eBPF 摘要的内核' : '无法读取 eBPF 状态'));
			return;
		}
		const list = d.inbounds || [];
		if (!list.length) {
			box.replaceChildren(mui.empty('没有启用 eBPF 入站'));
			return;
		}
		const ib = list[0];
		const res = ib.resources || {};
		const m = mapSummary(res.maps);
		const maint = (ib.maintenance || []).reduce((a, x) => a + (x.failures || 0), 0);
		const modeText = { hybrid: '混合（本机 + 局域网）', local: '仅本机', shared: '仅局域网' }[ib.mode] || ib.mode;
		box.replaceChildren(
			mui.row('模式', modeText),
			mui.row('本机数据面', ib.local_data_plane || '-'),
			mui.row('局域网数据面', ib.shared_data_plane || '-'),
			ib.resources ? mui.row('eBPF 程序', String((res.programs || []).length) + ' 个') : '',
			ib.resources ? mui.row('Map', E('span', { 'class': m.cls, title: m.pressured.join('、') }, m.text)) : mui.row('Map 占用', '按「详细诊断」时读取'),
			m.busiest ? mui.row('最高占用', m.busiest.name + ' · ' + Math.round(m.busiest.ratio * 100) + '%') : '',
			mui.row('后台清理', maint ? E('span', { 'class': 'mh-err' }, maint + ' 次失败') : E('span', { 'class': 'mh-ok' }, '正常')),
			ib.resource_error ? mui.row('错误', E('span', { 'class': 'mh-err' }, ib.resource_error)) : ''
		);
	},

	renderSubs(providers) {
		const list = Object.keys(providers).map(k => providers[k]).filter(p => p.vehicleType === 'HTTP').map(subSummary)
			.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
		if (!list.length) {
			this.els.subs.replaceChildren(mui.empty('没有订阅'));
			return;
		}
		this.els.subs.replaceChildren(...list.map(s => {
			const cls = s.ratio == null ? '' : (s.ratio > 0.9 ? 'bad' : (s.ratio > 0.7 ? 'mid' : ''));
			const expire = s.expire ? mui.fmtDate(s.expire).slice(0, 10) : '长期';
			return E('div', { 'class': 'mh-sub-item' }, [
				E('div', { 'class': 'mh-sub-top' }, [
					E('b', { title: s.name }, s.name),
					E('span', { 'class': s.alive == null || s.alive ? '' : 'mh-err' }, s.alive == null ? s.total + ' 个节点' : s.alive + ' / ' + s.total + ' 可用')
				]),
				s.ratio != null ? mui.meter(s.ratio, cls) : '',
				E('div', { 'class': 'mh-sub-meta' }, [
					E('span', {}, s.quota ? '已用 ' + mui.fmtBytes(s.used) + ' / ' + mui.fmtBytes(s.quota) : '无流量信息'),
					E('span', {}, [ E('span', { 'class': expireClass(s.expire) }, '到期 ' + expire), ' · 更新于 ' + mui.fmtAgo(s.updatedAt) ])
				])
			]);
		}));
	},

	updateAll() {
		const btn = this.els.updateAll;
		btn.disabled = true;
		btn.textContent = '更新中…';
		api.get('/overview').then(d => {
			const names = Object.keys(d.providers || {}).filter(k => d.providers[k].vehicleType === 'HTTP');
			return Promise.all(names.map(n => api.put('/providers/proxies/' + encodeURIComponent(n)).then(() => null, e => n + '：' + e.message)));
		}).then(errs => {
			errs = errs.filter(Boolean);
			mui.notify(errs.length ? '部分订阅更新失败：' + errs.join('；') : '订阅已全部更新', errs.length ? 'warning' : 'info');
		}, e => mui.notify('更新失败：' + e.message, 'error')).then(() => {
			btn.disabled = false;
			btn.textContent = '全部更新';
			this.refreshSlow();
		});
	},

	checkSites() {
		SITES.forEach((s, i) => {
			const el = this.siteEls[i];
			el.className = 'mh-chip none';
			el.lastChild.textContent = '测试中';
			timedFetch(s[1] + (s[1].indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now(), 5000).then(ms => {
				el.className = 'mh-chip ' + mui.delayClass(ms);
				el.lastChild.textContent = ms ? ms + ' ms' : '超时';
			});
		});
	},

	checkIp() {
		const box = this.els.ipBox;
		if (!this.ipToggle.checked) {
			box.replaceChildren(E('div', { 'class': 'mh-sub' }, '出口 IP 查询已关闭'));
			return;
		}
		const cn = E('span', {}, '查询中…'), intl = E('span', {}, '查询中…');
		box.replaceChildren(mui.row('国内出口', cn), mui.row('海外出口', intl));
		jsonFetch('https://myip.ipip.net/json').then(d => {
			const loc = ((d.data && d.data.location) || []).filter(Boolean);
			cn.textContent = (d.data && d.data.ip || '-') + (loc.length ? ' · ' + loc.join(' ') : '');
		}, () => { cn.textContent = '查询失败'; });
		jsonFetch('https://ipwho.is/').then(d => {
			const isp = d.connection && (d.connection.isp || d.connection.org);
			intl.textContent = (d.ip || '-') + ' · ' + [ d.country, d.city, isp ].filter(Boolean).join(' ');
		}, () => { intl.textContent = '查询失败'; });
	}
});
