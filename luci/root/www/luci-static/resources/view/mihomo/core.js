'use strict';
'require view';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';
'require mihomo.corecard as corecard';

/* 更新：内核版本与更新、回滚，下载设置（发布仓库、标签、镜像前缀）；LuCI 插件升级；面板、GEO 数据、订阅与规则集的在线更新。 */

const DEFAULTS = { repo: 'liuran001/mihomo', tag: 'Prerelease-Alpha', mirror: 'https://ghfast.top/' };
// 常见的 GitHub 下载镜像，只作输入建议，可用性随时间变化
const MIRRORS = [ 'https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/' ];

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.resolve();
	},

	render() {
		mui.loadCss();
		this.card = corecard.create({ title: '内核', onChange: i => this.fill(i) });
		const root = E('div', { 'class': 'mh mh-core-page' }, [
			header.render(),
			E('div', { 'class': 'mh-grid mh-pair' }, [ this.card.el, this.settingsCard() ]),
			this.pluginCard(),
			this.dataCard(),
			mui.card('说明', E('ul', { 'class': 'mh-list' }, [
				E('li', {}, '更新流程：获取版本号 → 下载 → 按发布页的 checksums.txt 校验 sha256 → 试运行 → 用新内核校验当前配置 → 替换并重启服务。任一步失败都不会动到正在使用的内核。'),
				E('li', {}, '新内核启动失败时自动换回旧版本；空间足够时旧版本保留一份，可随时「回滚」。'),
				E('li', {}, '下载线路：服务运行时先经本机的 mixed-port 代理下载，失败再走镜像前缀；没有设置镜像时直连 GitHub。'),
				E('li', {}, '内核文件位于 /usr/bin/mihomo-ebpf，升级固件时保留。')
			]))
		]);
		this.card.refresh();
		this.pluginRefresh();
		return root;
	},

	/* ---------- 内核里可在线更新的数据：面板、GEO 数据、订阅与规则集（需要服务正在运行） ---------- */

	dataCard() {
		const item = (title, help, label, run) => {
			const b = mui.btn(label, () => this.runUpdate(b, label, run), 'mh-btn-sm');
			return E('div', { 'class': 'mh-row', style: 'align-items:center;padding:8px 0' }, [
				E('div', { style: 'min-width:0' }, [ E('div', {}, title), E('div', { 'class': 'mh-field-help' }, help) ]),
				b
			]);
		};
		const rows = [
			item('面板', '从「面板下载地址」重新下载（默认 zashboard），完成后刷新面板页面', '更新面板', () => this.updateDashboard()),
			item('GEO 数据', [ 'GeoIP、GeoSite、MMDB；下载地址在「', E('a', { href: L.url('admin/services/mihomo/settings') }, '设置 › 基础 › GEO 数据'), '」' ],
				'更新 GEO', () => api.request('POST', '/configs/geo', undefined, { timeout: 180000 }).then(() => 'GEO 数据已更新')),
			item('订阅', '所有在线订阅（HTTP 类型的代理集合）', '更新订阅', () => this.updateProviders('proxies', '订阅')),
			item('规则集', '所有在线规则集（HTTP 类型的规则集合）', '更新规则集', () => this.updateProviders('rules', '规则集'))
		];
		const all = mui.btn('全部更新', () => this.updateAllData(all), 'mh-btn-sm cbi-button-action');
		return mui.card('面板与数据', [ E('div', {}, rows), E('div', { 'class': 'mh-actions' }, [ all ]) ]);
	},

	runUpdate(btn, label, run) {
		btn.disabled = true;
		btn.textContent = '更新中…';
		return Promise.resolve().then(run).then(msg => mui.notify(msg, /失败/.test(msg) ? 'warning' : 'info'),
			e => mui.notify(label + '失败：' + e.message, 'error')).then(() => {
			btn.disabled = false;
			btn.textContent = label;
		});
	},

	updateDashboard() {
		return api.controller().then(c => {
			if (!c.raw || !c.raw.ui) throw new Error('配置里没有面板目录（external-ui），可在「设置 › 基础 › 控制器与面板」填写');
			return api.request('POST', '/upgrade/ui', undefined, { timeout: 120000 });
		}).then(() => '面板已更新，刷新面板页面即可看到新版本');
	},

	// 逐个更新 HTTP 类型的代理集合 / 规则集合，返回汇总消息；部分失败时列出名字
	updateProviders(kind, label) {
		return api.get('/providers/' + kind).then(d => {
			const names = Object.keys((d && d.providers) || {}).filter(k => d.providers[k].vehicleType === 'HTTP');
			if (!names.length) return '没有在线' + label;
			return Promise.all(names.map(n => api.put('/providers/' + kind + '/' + encodeURIComponent(n)).then(() => null, e => n + '（' + e.message + '）')))
				.then(errs => {
					errs = errs.filter(Boolean);
					return errs.length ? label + '部分更新失败：' + errs.join('、') : label + '已全部更新（' + names.length + ' 个）';
				});
		});
	},

	// 依次更新，避免同时下载占满带宽；面板没配置时跳过而不算失败
	updateAllData(btn) {
		const steps = [
			[ 'GEO', () => api.request('POST', '/configs/geo', undefined, { timeout: 180000 }).then(() => 'GEO 已更新') ],
			[ '订阅', () => this.updateProviders('proxies', '订阅') ],
			[ '规则集', () => this.updateProviders('rules', '规则集') ],
			[ '面板', () => this.updateDashboard().catch(e => /external-ui/.test(e.message) ? '未配置面板，已跳过' : Promise.reject(e)) ]
		];
		const out = [];
		return this.runUpdate(btn, '全部更新', () => steps.reduce((p, [ name, run ]) =>
			p.then(run).then(msg => { out.push(msg); }, e => { out.push(name + '失败：' + e.message); }), Promise.resolve())
			.then(() => out.join('；')));
	},

	/* ---------- 本插件（luci-app-mihomo-ebpf）的检查更新与一键升级 ---------- */

	pluginCard() {
		this.plugin = { current: null, latest: null };
		this.pluginBody = E('div', {}, mui.empty('读取中…'));
		this.pluginCheckBtn = mui.btn('检查更新', () => this.pluginCheck(), 'mh-btn-sm');
		this.pluginMainBtn = mui.btn('升级', () => this.pluginUpgrade(), 'mh-btn-sm cbi-button-action');
		this.pluginMainBtn.hidden = true;
		return mui.card('LuCI 插件', [ this.pluginBody, E('div', { 'class': 'mh-actions' }, [ this.pluginCheckBtn, this.pluginMainBtn ]) ]);
	},

	pluginDraw(note) {
		const p = this.plugin, l = p.latest;
		const badge = !l ? E('span', { 'class': 'mh-badge muted' }, '尚未检查更新')
			: l.update_available ? E('span', { 'class': 'mh-badge warn' }, '有新版本 ' + l.latest)
			: E('span', { 'class': 'mh-badge ok' }, '已是最新版本');
		this.pluginBody.replaceChildren(
			E('div', { 'class': 'mh-core-hero' }, [
				E('div', { 'class': 'mh-core-ver' }, [
					E('div', { 'class': 'mh-kpi-label' }, '当前版本'),
					E('div', { 'class': 'mh-big mh-ellipsis' }, p.current || '未知')
				]),
				badge
			]),
			l ? mui.row('最新版本', l.latest + (l.format ? ' · ' + l.format + ' 安装包' : '')) : '',
			note ? E('p', { 'class': 'mh-field-help' }, note) : ''
		);
		this.pluginMainBtn.hidden = !l;
		this.pluginMainBtn.textContent = l && l.update_available ? '升级到 ' + l.latest : '重新安装';
	},

	pluginRefresh() {
		return api.rpc.pluginStatus().then(r => { this.plugin.current = r && r.current; }, () => {}).then(() => this.pluginDraw());
	},

	pluginCheck() {
		this.pluginCheckBtn.disabled = true;
		api.rpc.pluginCheck().then(r => {
			if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
			this.plugin.latest = r;
			if (r.current) this.plugin.current = r.current;
			this.pluginDraw();
		}).catch(e => mui.notify('检查更新失败：' + e.message, 'error')).then(() => { this.pluginCheckBtn.disabled = false; });
	},

	pluginUpgrade() {
		const l = this.plugin.latest;
		const force = !(l && l.update_available);
		const text = '将下载 ' + (l ? l.latest : '最新版本') + ' 的安装包、校验 sha256 后安装。安装期间 LuCI 会短暂无响应，完成后页面自动刷新；mihomo 服务不受影响。继续？';
		mui.confirm(force ? '重新安装插件' : '升级插件', text, '继续').then(yes => {
			if (!yes) return;
			this.pluginCheckBtn.disabled = this.pluginMainBtn.disabled = true;
			return api.rpc.pluginUpgrade(force).then(r => {
				if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
				return this.pluginWait();
			}).catch(e => {
				mui.notify('升级失败：' + e.message, 'error');
				this.pluginCheckBtn.disabled = this.pluginMainBtn.disabled = false;
				this.pluginDraw();
			});
		});
	},

	// 安装时 rpcd 会重新加载，期间的调用失败属正常，继续等；最多等 5 分钟
	pluginWait() {
		const STEP = { check: '获取更新信息', download: '下载安装包', install: '安装中', start: '准备中' };
		const started = Date.now();
		const poll = () => api.rpc.pluginStatus().then(r => r, () => null).then(r => {
			const job = r && r.job;
			if (job && job.state === 'done') {
				mui.notify(job.unchanged ? '已是最新版本' : '插件已升级到 ' + (job.version || r.current) + '，正在刷新页面');
				if (!job.unchanged) window.setTimeout(() => location.reload(), 1500);
				this.pluginCheckBtn.disabled = this.pluginMainBtn.disabled = false;
				return;
			}
			if (job && job.state === 'failed')
				throw new Error(job.error + (job.detail ? '：' + job.detail : ''));
			if (Date.now() - started > 300000)
				throw new Error('等待超时，请稍后刷新页面查看版本');
			this.pluginDraw('正在升级：' + ((job && STEP[job.step]) || '安装中') + '…');
			return new Promise(res => window.setTimeout(res, 2000)).then(poll);
		});
		return poll();
	},

	settingsCard() {
		const input = (ph, list) => E('input', { 'class': 'cbi-input-text', type: 'text', placeholder: ph, spellcheck: 'false', autocomplete: 'off', list: list || null });
		this.inputs = { repo: input(DEFAULTS.repo), tag: input(DEFAULTS.tag), mirror: input('留空表示直连 GitHub', 'mh-mirrors') };
		this.saveBtn = mui.btn('保存', () => this.save(), 'cbi-button-positive');
		return mui.card('下载设置', [
			mui.field('发布仓库', this.inputs.repo, 'GitHub 上的 用户名/仓库名'),
			mui.field('发布标签', this.inputs.tag, '从这个 Release 下载 version.txt、checksums.txt 与本机架构的内核'),
			mui.field('镜像前缀', [ this.inputs.mirror, E('datalist', { id: 'mh-mirrors' }, MIRRORS.map(m => E('option', { value: m }))) ],
				'拼在 GitHub 地址前面，例如 https://ghfast.top/；向导模板生成配置时，zashboard 面板与 Fake-IP 过滤列表也经它下载'),
			E('div', { 'class': 'mh-actions' }, [ mui.btn('恢复默认', () => this.setValues(DEFAULTS), 'mh-btn-sm'), this.saveBtn ])
		], { cls: 'mh-core-settings' });
	},

	setValues(s) {
		Object.keys(this.inputs).forEach(k => { this.inputs[k].value = s[k] || ''; });
	},

	// 只在第一次读到时填入，之后刷新内核信息不覆盖正在编辑的值
	fill(info) {
		if (this.filled || !info || !info.ok) return;
		this.filled = true;
		this.setValues(info.settings || {});
	},

	save() {
		const v = {};
		Object.keys(this.inputs).forEach(k => { v[k] = this.inputs[k].value.trim(); });
		this.saveBtn.disabled = true;
		api.coreSettings(v).then(r => {
			if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
			mui.notify('下载设置已保存');
			this.filled = false;
			return this.card.refresh();
		}).catch(e => mui.notify('保存失败：' + e.message, 'error')).then(() => { this.saveBtn.disabled = false; });
	}
});
