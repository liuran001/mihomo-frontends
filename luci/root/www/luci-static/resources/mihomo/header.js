'use strict';
'require baseclass';
'require mihomo.api as api';
'require mihomo.ui as mui';

/* 各页面共用的顶部栏：服务状态、代理模式切换、常用操作，以及控制器连接提示。 */

const MODES = [ ['rule', '规则'], ['global', '全局'], ['direct', '直连'] ];

// 顶部提示，按优先级：缺内核 → 缺配置（kind 为 setup，带向导入口；向导页自身跳过）→ 服务未运行 → 控制器不可达 → 连接断开
function bannerFor(st, reason, online, onSetup) {
	if (st && !onSetup) {
		if (!st.version) return { text: '尚未安装 mihomo 内核。设置向导会下载适配本机的内核并生成配置。', kind: 'setup' };
		if (st.config_present === false) return { text: '还没有配置文件。可以在设置向导里用内置模板生成，或下载、导入已有配置。', kind: 'setup' };
	}
	if (st && !st.running) return { text: '服务未运行，实时数据不可用。可点击右上角「启动」。', kind: 'info' };
	if (reason) return { text: reason, kind: 'warn' };
	if (online === false) return { text: '与 mihomo 控制器的连接已断开，正在重连…', kind: 'info' };
	return null;
}

return baseclass.extend({
	bannerFor,

	// opts.onStatus(status)：每次刷新服务状态后回调，页面据此显示“服务未运行”等提示；opts.setup：当前是向导页
	render(opts) {
		if (this.poller) this.poller.close();
		if (this.unsubscribe) this.unsubscribe();
		this.opts = opts || {};
		const pill = E('span', { 'class': 'mh-pill' }, '读取中');
		const meta = E('span', { 'class': 'mh-meta' }, '');
		const modeBtns = MODES.map(m => E('button', { 'class': 'mh-seg-btn', 'data-mode': m[0], 'click': () => this.setMode(m[0]) }, m[1]));
		const seg = E('div', { 'class': 'mh-seg disabled', 'title': '代理模式' }, modeBtns);
		const toggle = mui.btn('停止', () => this.service(this.status && this.status.running ? 'stop' : 'start'), 'mh-btn-sm');
		// 链接里带 secret，只在新标签页打开，不写进 referrer
		const dash = E('a', { 'class': 'btn cbi-button mh-btn-sm mh-dash disabled', 'target': '_blank', 'rel': 'noopener noreferrer',
			'title': '读取中', 'click': ev => { if (!dash.href) ev.preventDefault(); } }, '面板 ↗');
		const banner = E('div', { 'class': 'mh-banner' });
		banner.hidden = true;

		this.els = { pill, meta, modeBtns, seg, toggle, dash, banner };
		this.root = E('div', { 'class': 'mh-header-wrap' }, [
			E('div', { 'class': 'mh-header' }, [
				E('div', { 'class': 'mh-head-left' }, [ E('span', { 'class': 'mh-title' }, 'Mihomo'), pill, meta ]),
				seg,
				E('div', { 'class': 'mh-head-actions' }, [
					dash,
					mui.btn('清空 DNS 缓存', () => this.flushDns(), 'mh-btn-sm'),
					mui.btn('重置 Smart', () => this.flushSmart(), 'mh-btn-sm'),
					mui.btn('重启', () => this.service('restart'), 'mh-btn-sm'),
					toggle
				])
			]),
			banner
		]);

		this.unsubscribe = api.onState(() => this.updateBanner());
		this.poller = api.poll(this.root, 5000, () => this.refresh());
		return this.root;
	},

	refresh() {
		if (this.refreshing) return this.refreshing;
		this.refreshing = api.rpc.status().then(st => {
			this.status = st;
			const { pill, meta, toggle } = this.els;
			pill.className = 'mh-pill ' + (st.running ? 'on' : 'off');
			pill.textContent = st.running ? '运行中' : '已停止';
			meta.textContent = [ st.version, st.running && st.uptime != null ? '已运行 ' + mui.fmtDuration(st.uptime) : null,
				st.running && st.rss_kb ? '内存 ' + mui.fmtBytes(st.rss_kb * 1024) : null ].filter(Boolean).join(' · ');
			toggle.textContent = st.running ? '停止' : '启动';
			const mode = st.running ? api.get('/configs').then(c => this.showMode(c && c.mode), () => this.showMode(null)) : Promise.resolve(this.showMode(null));
			const dashboard = api.dashboard().then(d => this.showDashboard(d));
			this.updateBanner();
			if (this.opts.onStatus) this.opts.onStatus(st);
			return Promise.all([mode, dashboard]);
		}, e => {
			this.els.pill.className = 'mh-pill off';
			this.els.pill.textContent = '状态未知';
			this.els.meta.textContent = e.message;
		}).finally(() => { this.refreshing = null; });
		return this.refreshing;
	},

	showDashboard(d) {
		const a = this.els.dash;
		if (d.url) a.href = d.url; else a.removeAttribute('href');
		a.classList.toggle('disabled', !d.url);
		a.title = d.url ? '在新标签页打开 zashboard' : d.reason;
	},

	showMode(mode) {
		mode = String(mode || '').toLowerCase();
		this.els.modeBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-mode') === mode));
		this.els.seg.classList.toggle('disabled', !mode);
	},

	setMode(mode) {
		const label = MODES.find(m => m[0] === mode)[1];
		api.patch('/configs', { mode: mode }).then(() => {
			this.showMode(mode);
			mui.notify('已切换到' + label + '模式');
			// 写回配置文件，重启后保持
			return mui.watchJob(api.rpc.patch([ { op: 'mode.set', mode: mode } ])).then(s => {
				if (s.state !== 'done') mui.notify('模式已在运行中切换，但写回配置文件失败：' + (s.error || ''), 'warning');
			});
		}, e => mui.notify('切换模式失败：' + e.message, 'error'));
	},

	flushDns() {
		api.post('/cache/dns/flush').then(() => mui.notify('DNS 缓存已清空'), e => mui.notify('清空失败：' + e.message, 'error'));
	},

	flushSmart() {
		mui.confirm('重置 Smart 数据', '将清空 smart 策略组积累的节点权重与统计，之后需要重新学习。确定继续？', '重置', true).then(yes => {
			if (!yes) return;
			api.post('/cache/smart/flush').then(() => mui.notify('Smart 数据已重置'), e => mui.notify('重置失败：' + e.message, 'error'));
		});
	},

	service(action) {
		const label = { restart: '重启', stop: '停止', start: '启动' }[action];
		const ask = action === 'stop'
			? mui.confirm('停止服务', '停止后流量不再经过代理：eBPF 程序随服务一起卸载，设备将直连上网。确定停止？', '停止', true)
			: Promise.resolve(true);
		ask.then(yes => {
			if (!yes) return;
			this.els.pill.className = 'mh-pill busy';
			this.els.pill.textContent = label + '中';
			return api.rpc.service(action).then(r => {
				if (!r.ok) throw new Error(r.error + (r.detail ? '：' + r.detail : ''));
				mui.notify('已' + label);
				api.controller(true);
				setTimeout(() => this.refresh(), 1500);
			});
		}).catch(e => {
			mui.notify(label + '失败：' + e.message, 'error');
			this.refresh();
		});
	},

	updateBanner() {
		const b = this.els.banner;
		const r = bannerFor(this.status, api.reason(), api.isOnline(), this.opts.setup);
		b.hidden = !r;
		b.className = 'mh-banner' + (r && r.kind !== 'info' ? ' ' + r.kind : '');
		if (!r) return b.replaceChildren();
		b.replaceChildren(E('span', {}, r.text), r.kind === 'setup'
			? E('a', { 'class': 'btn cbi-button cbi-button-action mh-btn-sm', href: L.url('admin/services/mihomo/setup') }, '打开设置向导 →') : '');
	}
});
