'use strict';
'require view';
'require ui';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';
'require mihomo.nodes as nodes';

/* 订阅与节点：配置中的 http 订阅（链接、更新间隔、前缀、UA、健康检查）与运行时信息（节点数、流量、到期）。
 * 编辑、新增、停用、删除经 patch 写回配置文件；更新与测速直接调用控制器。 */

// subscriptionInfo：Upload/Download/Total 为字节，Expire 为秒级时间戳（0 表示长期）
function usage(info) {
	if (!info || typeof info !== 'object') return null;
	const used = (Number(info.Upload) || 0) + (Number(info.Download) || 0);
	const total = Number(info.Total) || 0;
	if (!total && !info.Expire) return null;
	return { used: used, total: total, ratio: total ? Math.min(1, used / total) : null, expire: Number(info.Expire) || 0 };
}

// list：sections 中的订阅；runtime：/providers/proxies 的 providers
function mergeRuntime(list, runtime) {
	runtime = runtime || {};
	return (list || []).map(p => {
		const r = p.enabled ? runtime[p.name] : null;
		const nodes = (r && r.proxies) || [];
		return Object.assign({}, p, {
			loaded: !!r,
			count: nodes.length,
			alive: nodes.filter(n => n.alive).length,
			updatedAt: r ? r.updatedAt : null,
			usage: r ? usage(r.subscriptionInfo) : null
		});
	});
}

function numOrEmpty(s) {
	s = String(s == null ? '' : s).trim();
	return s === '' ? '' : Number(s);
}

// 表单（字符串值）转成 provider.set / provider.add 的 data
function formToData(f) {
	const data = {
		url: String(f.url || '').trim(),
		interval: numOrEmpty(f.interval),
		prefix: String(f.prefix || '').trim(),
		user_agent: String(f.user_agent || '').trim(),
		health_check: {
			enable: !!f.hc_enable,
			url: String(f.hc_url || '').trim(),
			interval: numOrEmpty(f.hc_interval),
			timeout: numOrEmpty(f.hc_timeout)
		}
	};
	if (f.join_groups != null) data.join_groups = !!f.join_groups;
	return data;
}

// 订阅链接通常带着令牌：只显示协议与主机
function maskUrl(url) {
	const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(String(url || ''));
	if (!m) return url ? '…' : '';
	return m[1] + m[2] + (m[3] ? '/…' : '');
}

// 与后端 check.uc 的 name() 一致
function validName(s) {
	return typeof s === 'string' && s !== '' && s === s.trim() && s.length <= 64 &&
		!/[\/,\\\u0000-\u001f\u007f]/.test(s) && s[0] !== '.';
}

const FIELD_LABELS = { url: '订阅链接', interval: '更新间隔', prefix: '节点名前缀', user_agent: 'User-Agent', health_check: '健康检查' };

return view.extend({
	usage, mergeRuntime, formToData, maskUrl, validName,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.resolve();
	},

	render() {
		mui.loadCss();
		this.revealed = {};
		this.banner = E('div', {});
		this.countEl = E('span', { 'class': 'mh-count' });
		this.updateAllBtn = mui.btn('全部更新', () => this.updateAll(), 'mh-btn-sm');
		this.grid = E('div', { 'class': 'mh-grid wide mh-provs' }, mui.empty('读取中…'));
		this.other = E('div', {});
		this.nodesBox = E('div', {});
		const toolbar = E('div', { 'class': 'mh-card mh-px-toolbar mh-toolbar' }, [
			this.countEl,
			E('span', { 'class': 'mh-grow' }),
			mui.btn('刷新', () => this.refresh(), 'mh-btn-sm'),
			this.updateAllBtn,
			mui.btn('新增订阅', () => this.edit(null), 'cbi-button-add mh-btn-sm')
		]);
		const root = E('div', { 'class': 'mh' }, [ header.render(), this.banner, toolbar, this.grid, this.other, this.nodesBox ]);
		this.refresh();
		if (this.poller) this.poller.close();
		this.poller = api.poll(root, 30000, () => this.refreshRuntime(), false);
		return root;
	},

	refresh() {
		return api.rpc.sections([ 'providers', 'proxies' ]).then(s => {
			if (!s || !s.ok) throw new Error((s && s.error) || '读取失败');
			if (s.parse_error) throw new Error(s.parse_error);
			if (s.providers.unsupported) throw new Error(s.providers.reason);
			this.rev = s.rev;
			this.sec = s.providers;
			this.nodeSec = s.proxies;
			return this.refreshRuntime();
		}).catch(e => {
			this.sec = null;
			this.grid.replaceChildren(mui.empty('无法读取订阅：' + e.message));
			this.banner.replaceChildren();
			this.countEl.textContent = '';
		});
	},

	refreshRuntime() {
		if (!this.sec) return Promise.resolve();
		return api.get('/providers/proxies').then(d => d.providers || {}, () => null).then(rt => {
			this.runtime = rt;
			this.renderAll();
		});
	},

	renderAll() {
		const sec = this.sec;
		const list = mergeRuntime(sec.list, this.runtime || {});
		const on = list.filter(p => p.enabled).length;
		this.countEl.textContent = on + ' 个启用' + (list.length > on ? '，' + (list.length - on) + ' 个停用' : '');
		this.renderBanner();
		if (!list.length) {
			this.grid.replaceChildren(E('div', { 'class': 'mh-card mh-span-all' }, mui.empty('还没有 http 订阅', mui.btn('新增订阅', () => this.edit(null), 'cbi-button-add'))));
		} else {
			this.grid.replaceChildren(...list.map(p => this.renderCard(p)));
		}
		this.other.replaceChildren(sec.other && sec.other.length
			? mui.card('其他订阅', [
				E('p', { 'class': 'mh-note' }, '以下订阅不是 http 类型，只能在配置文件页编辑：'),
				E('div', { 'class': 'mh-chips' }, sec.other.map(o => E('span', { 'class': 'mh-chip' }, [ E('b', {}, o.name), ' ' + (o.type || '?') ])))
			])
			: '');
		// 单个节点（proxies）：与订阅同为节点来源，放在同一页
		const ns = this.nodeSec;
		this.nodesBox.replaceChildren(!ns ? '' : ns.unsupported ? mui.card('单个节点', mui.empty('无法编辑节点：' + ns.reason))
			: nodes.card({ sec: ns, rev: this.rev, apply: ops => this.apply(api.rpc.patch(ops, this.rev)) }));
	},

	renderBanner() {
		const groups = this.sec.migratable || [];
		if (!groups.length) return this.banner.replaceChildren();
		this.banner.replaceChildren(E('div', { 'class': 'mh-banner mh-prov-banner' }, [
			E('span', {}, groups.length + ' 个策略组用 use 列出了全部订阅（' + groups.slice(0, 4).join('、') + (groups.length > 4 ? ' 等' : '') +
				'）。改为 include-all-providers: true 后，新增、停用订阅时不用再维护这些列表。'),
			mui.btn('改为自动包含', () => this.migrate(), 'mh-btn-sm cbi-button-action')
		]));
	},

	renderCard(p) {
		const tags = [];
		if (!p.enabled) tags.push(E('span', { 'class': 'mh-tag warn' }, '已停用'));
		else if (!p.loaded) tags.push(E('span', { 'class': 'mh-tag warn', title: '控制器中没有这个订阅：服务未运行，或配置尚未生效' }, '未加载'));
		if (p.anchor) tags.push(E('span', { 'class': 'mh-tag', title: '继承字段：' + p.inherited.map(f => FIELD_LABELS[f] || f).join('、') }, '锚点 ' + p.anchor));

		const u = p.usage;
		const cls = !u || u.ratio == null ? '' : (u.ratio > 0.9 ? 'bad' : (u.ratio > 0.7 ? 'mid' : ''));
		const left = u && u.expire ? u.expire * 1000 - Date.now() : null;
		const expire = !u || !u.expire ? '长期' : mui.fmtDate(u.expire).slice(0, 10);
		const urlEl = E('span', { 'class': 'mh-prov-url', title: '点击显示完整链接' }, this.revealed[p.name] ? p.url : maskUrl(p.url));
		urlEl.addEventListener('click', () => {
			this.revealed[p.name] = !this.revealed[p.name];
			urlEl.textContent = this.revealed[p.name] ? p.url : maskUrl(p.url);
		});
		const hc = p.health_check || {};
		const groups = p.groups || [];

		const body = [
			p.enabled ? E('div', { 'class': 'mh-prov-stat' }, [
				E('span', { 'class': 'mh-big' }, p.loaded ? String(p.alive) : '-'),
				E('span', { 'class': 'mh-sub' }, p.loaded ? ' / ' + p.count + ' 个节点可用' : ' 未加载')
			]) : '',
			u && u.ratio != null ? mui.meter(u.ratio, cls) : '',
			u ? E('div', { 'class': 'mh-sub-meta' }, [
				E('span', {}, u.total ? '已用 ' + mui.fmtBytes(u.used) + ' / ' + mui.fmtBytes(u.total) : '无流量信息'),
				E('span', { 'class': left == null ? '' : (left <= 0 ? 'mh-err' : (left < 7 * 86400000 ? 'mh-warn' : '')) }, '到期 ' + expire)
			]) : '',
			E('div', { 'class': 'mh-prov-rows' }, [
				mui.row('链接', urlEl),
				mui.row('更新间隔', p.interval ? mui.fmtDuration(p.interval) : '不自动更新'),
				p.enabled ? mui.row('上次更新', p.updatedAt ? mui.fmtAgo(p.updatedAt) : '-') : '',
				p.prefix ? mui.row('节点名前缀', p.prefix) : '',
				p.user_agent ? mui.row('User-Agent', p.user_agent) : '',
				mui.row('健康检查', hc.enable ? (mui.fmtDuration(hc.interval || 0) + ' 一次') : '关闭'),
				p.enabled ? mui.row('策略组', E('span', { title: groups.join('、') }, groups.length ? groups.length + ' 个' : E('span', { 'class': 'mh-warn' }, '没有策略组使用'))) : ''
			])
		];

		const actions = p.enabled ? [
			mui.btn('更新', ev => this.update(p.name, ev.currentTarget), 'mh-btn-sm'),
			mui.btn('测速', ev => this.healthcheck(p.name, ev.currentTarget), 'mh-btn-sm'),
			mui.btn('编辑', () => this.edit(p), 'mh-btn-sm'),
			mui.btn('停用', () => this.toggle(p, false), 'mh-btn-sm'),
			mui.btn('删除', () => this.remove(p), 'mh-btn-sm cbi-button-negative')
		] : [
			mui.btn('启用', () => this.toggle(p, true), 'mh-btn-sm cbi-button-action'),
			mui.btn('删除', () => this.remove(p), 'mh-btn-sm cbi-button-negative')
		];

		return E('div', { 'class': 'mh-card mh-prov' + (p.enabled ? '' : ' off') }, [
			E('div', { 'class': 'mh-prov-head' }, [ E('b', { title: p.name }, p.name), E('span', { 'class': 'mh-prov-tags' }, tags) ]),
			E('div', { 'class': 'mh-prov-body' }, body),
			E('div', { 'class': 'mh-prov-actions' }, actions)
		]);
	},

	/* ---------- 运行时操作 ---------- */

	busy(btn, text) {
		const old = btn.textContent;
		btn.disabled = true;
		btn.textContent = text;
		return () => { btn.disabled = false; btn.textContent = old; };
	},

	update(name, btn) {
		const done = this.busy(btn, '更新中…');
		api.put('/providers/proxies/' + encodeURIComponent(name)).then(() => mui.notify('订阅「' + name + '」已更新'),
			e => mui.notify('更新失败：' + e.message, 'error')).then(() => { done(); this.refreshRuntime(); });
	},

	healthcheck(name, btn) {
		const done = this.busy(btn, '测速中…');
		api.get('/providers/proxies/' + encodeURIComponent(name) + '/healthcheck', { timeout: 60000 }).then(() => mui.notify('订阅「' + name + '」测速完成'),
			e => mui.notify('测速失败：' + e.message, 'error')).then(() => { done(); this.refreshRuntime(); });
	},

	updateAll() {
		const names = (this.sec ? this.sec.list : []).filter(p => p.enabled).map(p => p.name);
		const done = this.busy(this.updateAllBtn, '更新中…');
		Promise.all(names.map(n => api.put('/providers/proxies/' + encodeURIComponent(n)).then(() => null, e => n + '：' + e.message))).then(errs => {
			errs = errs.filter(Boolean);
			mui.notify(errs.length ? '部分订阅更新失败：' + errs.join('；') : '订阅已全部更新', errs.length ? 'warning' : 'info');
		}).then(() => { done(); this.refreshRuntime(); });
	},

	/* ---------- 修改配置 ---------- */

	apply(start) {
		return mui.runJob(start).then(s => {
			this.refresh();
			return s;
		});
	},

	migrate() {
		const groups = this.sec.migratable;
		mui.confirm('改为自动包含全部订阅', '将这些策略组的 use 列表换成 include-all-providers: true：' + groups.join('、') +
			'。节点与现在相同；之后新增或停用订阅时，这些组自动跟随。', '修改并应用').then(ok => {
			if (ok) this.apply(api.rpc.migrateIncludeAll(this.rev));
		});
	},

	toggle(p, enabled) {
		if (enabled) return this.apply(api.rpc.providerToggle(p.name, true, this.rev));
		const n = (p.groups || []).length;
		mui.confirm('停用订阅', '停用后「' + p.name + '」从配置中移除' + (n ? '，并从 ' + n + ' 个策略组的 use 列表中去掉' : '') +
			'。定义保存在 /etc/mihomo/.luci/disabled.json，重新启用时恢复原来的设置与策略组。', '停用并应用', true).then(ok => {
			if (ok) this.apply(api.rpc.providerToggle(p.name, false, this.rev));
		});
	},

	remove(p) {
		mui.confirm('删除订阅', '确定删除「' + p.name + '」？' + (p.enabled ? '会同时从所有策略组的 use 列表中去掉，' : '') +
			'应用成功后删除缓存文件 ' + (p.path || '') + '。此操作不可撤销（保存前会自动备份配置）。', '删除并应用', true).then(ok => {
			if (ok) this.apply(api.rpc.patch([ { op: 'provider.delete', name: p.name } ], this.rev));
		});
	},

	// p 为 null 时新增
	edit(p) {
		const adding = !p;
		const dft = (this.sec && this.sec.defaults) || { interval: 3600, health_check: { enable: true, url: 'https://cp.cloudflare.com', interval: 300, timeout: 5000 } };
		const src = p || { name: '', url: '', interval: dft.interval, prefix: '', user_agent: '', health_check: dft.health_check, inherited: [] };
		const hc = src.health_check || {};
		const inh = f => (p && p.anchor && p.inherited.indexOf(f) >= 0) ? E('span', { 'class': 'mh-tag', title: '当前值继承自锚点，修改后只写入这个订阅' }, '来自锚点 ' + p.anchor) : '';
		const input = (value, attrs) => E('input', Object.assign({ type: 'text', 'class': 'cbi-input-text', value: value == null ? '' : String(value) }, attrs || {}));
		const f = {
			name: input(src.name, adding ? { placeholder: '例如 机场A' } : { disabled: true }),
			url: input(src.url, { placeholder: 'https://…', autocomplete: 'off' }),
			interval: input(src.interval, { inputmode: 'numeric', placeholder: '秒，0 表示不自动更新' }),
			prefix: input(src.prefix, { placeholder: '例如 [机场A]' }),
			user_agent: input(src.user_agent, { placeholder: '留空使用 mihomo 默认值' }),
			hc_enable: E('input', { type: 'checkbox' }),
			hc_url: input(hc.url, { placeholder: 'https://cp.cloudflare.com' }),
			hc_interval: input(hc.interval, { inputmode: 'numeric', placeholder: '秒' }),
			hc_timeout: input(hc.timeout, { inputmode: 'numeric', placeholder: '毫秒' }),
			join_groups: E('input', { type: 'checkbox' })
		};
		f.hc_enable.checked = !!hc.enable;
		f.join_groups.checked = true;
		const field = (label, el, extra, hint) => E('div', { 'class': 'mh-field' }, [
			E('label', {}, [ label, extra || '' ]), E('div', {}, [ el, hint ? E('div', { 'class': 'mh-note' }, hint) : '' ])
		]);
		const err = E('p', { 'class': 'mh-err' });
		const groupsHint = adding && (this.sec.list || []).length
			? field('加入策略组', E('label', { 'class': 'mh-switch' }, [ f.join_groups, ' 加入当前列出了全部订阅的 use 列表' ]))
			: '';
		ui.showModal(adding ? '新增订阅' : '编辑订阅「' + p.name + '」', [
			E('div', { 'class': 'mh mh-form' }, [
				field('名称', f.name, '', adding ? '保存后不能修改；缓存文件为 ./proxy_provider/<名称>.yaml' : ''),
				field('订阅链接', f.url, inh('url')),
				field('更新间隔（秒）', f.interval, inh('interval')),
				field('节点名前缀', f.prefix, inh('prefix')),
				field('User-Agent', f.user_agent, inh('user_agent'), '部分机场按 UA 返回不同格式，例如 clash-verge/v2.5.2'),
				field('健康检查', E('label', { 'class': 'mh-switch' }, [ f.hc_enable, ' 定期测试节点延迟' ]), inh('health_check')),
				field('测速地址', f.hc_url),
				field('测速间隔（秒）', f.hc_interval),
				field('超时（毫秒）', f.hc_timeout),
				groupsHint,
				err
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '取消'), ' ',
				E('button', { 'class': 'btn cbi-button-positive', 'click': () => {
					const vals = {};
					for (const k in f) vals[k] = f[k].type === 'checkbox' ? f[k].checked : f[k].value;
					if (!adding) delete vals.join_groups;
					else if (!groupsHint) vals.join_groups = false;
					const data = formToData(vals);
					const name = adding ? String(vals.name).trim() : p.name;
					const problem = (adding && !validName(name)) ? '名称不能为空，不能包含 / , \\，不能以 . 开头，最长 64 个字符'
						: (!/^https?:\/\/[^\s/?#]+/.test(data.url) ? '订阅链接需要 http:// 或 https:// 开头'
						: ([ data.interval, data.health_check.interval, data.health_check.timeout ].some(n => n !== '' && !(Number.isInteger(n) && n >= 0)) ? '间隔与超时需要填写非负整数'
						: (data.health_check.enable && !data.health_check.url ? '开启健康检查时需要填写测速地址' : null)));
					if (problem) {
						err.textContent = problem;
						return;
					}
					this.apply(api.rpc.patch([ { op: adding ? 'provider.add' : 'provider.set', name: name, data: data } ], this.rev));
				} }, adding ? '新增并应用' : '保存并应用')
			])
		]);
	}
});
