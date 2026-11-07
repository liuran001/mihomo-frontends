'use strict';
'require view';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';
'require mihomo.corecard as corecard';

/* 内核：版本与更新、回滚；下载设置（发布仓库、标签、镜像前缀）。 */

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
