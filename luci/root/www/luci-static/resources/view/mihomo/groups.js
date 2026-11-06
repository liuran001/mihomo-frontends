'use strict';
'require view';
'require ui';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';
'require mihomo.nodes as nodes';
'require mihomo.proxylink as PL';

/* 策略组：列表、排序、新增 / 编辑 / 删除。规则把流量交给策略组，策略组再从成员里选出实际使用的节点。
 * 表单字段与说明来自 shared/proxylink.js（与 Magisk 共用，对齐 liuran001/mihomo 的 smart 分支）；
 * 写入经 patch 的 group.add / group.set / group.delete / group.move，改名时同步规则与其他组里的引用。 */

const BUILTIN = [ 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE' ];
const BUILTIN_LABELS = { DIRECT: 'DIRECT（直连）', REJECT: 'REJECT（拦截）', 'REJECT-DROP': 'REJECT-DROP（静默丢弃）', PASS: 'PASS（跳过本组）', COMPATIBLE: 'COMPATIBLE' };

// 成员可选项：内置策略、其他策略组、单个节点（DNS 出站除外）
function memberChoices(groups, nodeList, self) {
	return [
		{ label: '内置', items: BUILTIN.map(n => [ n, BUILTIN_LABELS[n] ]) },
		{ label: '策略组', items: (groups || []).map(g => g.name).filter(n => n !== self).map(n => [ n, n ]) },
		{ label: '单个节点', items: (nodeList || []).filter(n => n.type !== 'dns').map(n => [ n.name, n.name ]) }
	].filter(c => c.items.length);
}

// 哪些策略组把 name 列为成员
function memberOf(name, groups) {
	return (groups || []).filter(g => Array.isArray(g.data && g.data.proxies) && g.data.proxies.indexOf(name) >= 0).map(g => g.name);
}

// 列表里的「谁在用它」说明；没人用时提示
function usageText(g, groups) {
	const parts = [];
	const refs = g.refs || [];
	const rules = refs.filter(r => /^规则第/.test(r)).length;
	if (rules) parts.push(rules + ' 条规则');
	const others = refs.filter(r => !/^规则第/.test(r));
	if (others.length) parts.push(others.join('、'));
	const owners = memberOf(g.name, groups);
	// 被很多组引用时（如总开关）只给数量，免得摘要过长
	if (owners.length > 3) parts.push(owners.length + ' 个策略组的成员');
	else if (owners.length) parts.push('策略组 ' + owners.join('、') + ' 的成员');
	return parts.length ? '被 ' + parts.join('，') + ' 使用' : '';
}

// 不能删除的原因；可以删除时返回 null
function deleteBlock(g) {
	if ((g.anchored || []).length) return '策略组 ' + g.anchored.join('、') + ' 通过锚点继承它，请在配置文件页编辑';
	if ((g.refs || []).length) return '正在被 ' + g.refs.join('、') + ' 使用，请先改成别的出站';
	return null;
}

// 有序的成员编辑器：已选成员可上移、移除，下拉框追加。返回带 mhValue() 的元素
function membersInput(value, choices) {
	let list = (value || []).slice();
	const box = E('div', { 'class': 'mh-members' });
	const listEl = E('div', { 'class': 'mh-member-list' });
	const add = E('select', { 'class': 'cbi-input-select' });
	const draw = () => {
		listEl.replaceChildren(...(list.length ? list.map((n, i) => E('span', { 'class': 'mh-chip mh-member' }, [
			E('span', { 'class': 'mh-member-i' }, String(i + 1)), E('b', {}, n),
			i > 0 ? E('button', { 'class': 'mh-member-btn', type: 'button', title: '上移', 'click': () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); draw(); box.dispatchEvent(new Event('change')); } }, '↑') : '',
			E('button', { 'class': 'mh-member-btn', type: 'button', title: '移除', 'click': () => { list.splice(i, 1); draw(); box.dispatchEvent(new Event('change')); } }, '×')
		])) : [ E('span', { 'class': 'mh-sub' }, '还没有成员') ]));
		add.replaceChildren(E('option', { value: '' }, '添加成员…'), ...choices.map(c => E('optgroup', { label: c.label },
			c.items.filter(it => list.indexOf(it[0]) < 0).map(it => E('option', { value: it[0] }, it[1])))));
		add.value = '';
	};
	add.addEventListener('change', () => {
		if (add.value) list.push(add.value);
		draw();
		box.dispatchEvent(new Event('change'));
	});
	draw();
	box.append(listEl, add);
	box.mhValue = () => list.slice();
	return box;
}

// 订阅多选
function providersInput(value, names) {
	const boxes = {};
	const el = E('div', { 'class': 'mh-group-pick' }, names.length ? names.map(n => {
		const b = E('input', { type: 'checkbox' });
		b.checked = (value || []).indexOf(n) >= 0;
		boxes[n] = b;
		return E('label', { 'class': 'mh-check' }, [ b, ' ', n ]);
	}) : [ E('span', { 'class': 'mh-sub' }, '配置里还没有订阅') ]);
	// 配置里写了但已不存在的订阅也保留勾选，保存时由后端提示
	const missing = (value || []).filter(n => names.indexOf(n) < 0);
	el.mhValue = () => names.filter(n => boxes[n].checked).concat(missing);
	return el;
}

return view.extend({
	memberChoices, memberOf, usageText, deleteBlock,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.resolve();
	},

	render() {
		mui.loadCss();
		this.countEl = E('span', { 'class': 'mh-count' });
		this.listEl = E('div', { 'class': 'mh-pnode-list' }, mui.empty('读取中…'));
		const toolbar = E('div', { 'class': 'mh-card mh-px-toolbar mh-toolbar' }, [
			this.countEl,
			E('span', { 'class': 'mh-grow' }),
			mui.btn('刷新', () => this.refresh(), 'mh-btn-sm'),
			mui.btn('新增策略组', () => this.edit(null), 'cbi-button-add mh-btn-sm')
		]);
		const intro = E('p', { 'class': 'mh-note' }, [
			'规则把流量交给策略组，策略组再从成员里选出实际使用的节点。常见用法：「节点选择」用手动选择，地区组用 Smart 或自动测速，',
			'各应用组（如「学术」「Apple」）用手动选择并把地区组列为成员。列表的顺序就是面板里显示的顺序。'
		]);
		const root = E('div', { 'class': 'mh' }, [ header.render(), toolbar, mui.card('策略组', [ intro, this.listEl ], { cls: 'mh-span-all' }) ]);
		this.refresh();
		return root;
	},

	refresh() {
		return api.rpc.sections([ 'groups', 'proxies', 'providers' ]).then(s => {
			if (!s || !s.ok) throw new Error((s && s.error) || '读取失败');
			if (s.parse_error) throw new Error(s.parse_error);
			this.rev = s.rev;
			this.groups = Array.isArray(s.groups) ? s.groups : [];
			this.nodeList = (s.proxies && s.proxies.list) || [];
			const pv = s.providers || {};
			this.providerNames = ((pv.list || []).filter(p => p.enabled !== false).concat(pv.other || [])).map(p => p.name);
			this.renderList();
		}).catch(e => {
			this.groups = null;
			this.listEl.replaceChildren(mui.empty('无法读取策略组：' + e.message));
		});
	},

	renderList() {
		const groups = this.groups;
		this.countEl.textContent = groups.length + ' 个策略组';
		if (!groups.length) return this.listEl.replaceChildren(mui.empty('还没有策略组', mui.btn('新增策略组', () => this.edit(null), 'cbi-button-add')));
		this.listEl.replaceChildren(...groups.map((g, i) => this.row(g, i)));
	},

	row(g, i) {
		const t = PL.groupType(g.type);
		const used = usageText(g, this.groups);
		const block = deleteBlock(g);
		const meta = [ E('span', { title: t ? t.help : '' }, PL.groupSummary(g.data || {})) ];
		meta.push(used ? E('span', { 'class': 'mh-sub' }, used) : E('span', { 'class': 'mh-warn' }, '没有规则或其他策略组使用它'));
		const tags = [];
		if (!t) tags.push(E('span', { 'class': 'mh-tag warn', title: '表单不支持这个类型，只能修改其他字段' }, g.type || '?'));
		if ((g.inherited || []).length) tags.push(E('span', { 'class': 'mh-tag', title: '继承自锚点的字段：' + g.inherited.join('、') }, '锚点'));
		const del = mui.btn('删除', () => this.remove(g), 'mh-btn-sm cbi-button-negative');
		if (block) { del.disabled = true; del.title = block; }
		const up = mui.btn('↑', () => this.move(g, i - 1), 'mh-btn-sm');
		const down = mui.btn('↓', () => this.move(g, i + 1), 'mh-btn-sm');
		up.disabled = i === 0;
		down.disabled = i === this.groups.length - 1;
		up.title = '上移';
		down.title = '下移';
		return E('div', { 'class': 'mh-pnode' }, [
			E('div', { 'class': 'mh-pnode-main' }, [ E('b', { title: g.name }, [ g.name, ' ', ...tags ]), E('div', { 'class': 'mh-pnode-meta' }, meta) ]),
			E('div', { 'class': 'mh-pnode-actions' }, [ up, down, mui.btn('编辑', () => this.edit(g), 'mh-btn-sm'), del ])
		]);
	},

	apply(ops) {
		return mui.runJob(api.rpc.patch(ops, this.rev)).then(s => {
			this.refresh();
			return s;
		});
	},

	move(g, to) {
		this.apply([ { op: 'group.move', name: g.name, to: to } ]);
	},

	remove(g) {
		const owners = memberOf(g.name, this.groups);
		mui.confirm('删除策略组', '确定删除「' + g.name + '」？' + (owners.length ? '会同时从 ' + owners.join('、') + ' 的成员中移除。' : ''), '删除并应用', true).then(ok => {
			if (ok) this.apply([ { op: 'group.delete', name: g.name } ]);
		});
	},

	// g 为 null 时新增
	edit(g) {
		const adding = !g;
		const base = adding ? { type: 'select' } : g.data;
		const inherited = adding ? [] : (g.inherited || []);
		const vals = PL.groupValues(base);
		const choices = memberChoices(this.groups, this.nodeList, adding ? null : g.name);
		const fallback = BUILTIN.concat(this.nodeList.filter(n => n.type !== 'dns').map(n => n.name));
		const inputs = {}, rows = {};
		const err = E('p', { 'class': 'mh-err' });
		const typeHelp = E('div', { 'class': 'mh-note' });
		const values = () => {
			const v = {};
			for (const k in inputs) v[k] = nodes.readInput(inputs[k]);
			return v;
		};
		// 按类型等字段决定哪些项显示（例如 Smart 才有成员优先级）
		const refresh = () => {
			const cur = {};
			for (const f of PL.GROUP_FIELDS) { try { PL.setPath(cur, f.key, PL.fromInput(f, nodes.readInput(inputs[f.key]))); } catch (e) {} }
			for (const f of PL.GROUP_FIELDS) rows[f.key].hidden = !PL.visible(f, cur);
			const t = PL.groupType(cur.type);
			typeHelp.textContent = t ? t.help : '';
		};
		const mk = f => {
			let el;
			if (f.kind === 'members') el = membersInput(vals[f.key], choices);
			else if (f.kind === 'providers') el = providersInput(vals[f.key], this.providerNames);
			else el = nodes.input(f, vals[f.key], f.key === 'empty-fallback' ? fallback : [], null);
			el.addEventListener('change', refresh);
			inputs[f.key] = el;
			const label = [ f.label ];
			if (f.required) label.push(E('span', { 'class': 'mh-req' }, ' *'));
			if (inherited.indexOf(f.key) >= 0) label.push(' ', E('span', { 'class': 'mh-tag', title: '来自锚点，修改后只对这个组生效' }, '锚点'));
			const help = f.help ? f.help + '（' + f.key + '）' : f.key;
			rows[f.key] = mui.field(label, f.key === 'type' ? E('div', {}, [ el, typeHelp ]) : el, help);
			return rows[f.key];
		};
		const main = PL.GROUP_FIELDS.filter(f => !f.adv), adv = PL.GROUP_FIELDS.filter(f => f.adv);
		const form = [ ...main.map(mk), E('details', { 'class': 'mh-adv' }, [ E('summary', {}, '高级选项'), ...adv.map(mk) ]) ];
		refresh();
		const known = PL.GROUP_FIELDS.map(f => f.key);
		const others = adding ? [] : Object.keys(g.data).filter(k => known.indexOf(k) < 0);
		ui.showModal(adding ? '新增策略组' : '编辑策略组「' + g.name + '」', [
			E('div', { 'class': 'mh mh-form' }, [
				...form,
				others.length ? E('p', { 'class': 'mh-note' }, '另有表单中没有的字段会原样保留：' + others.join('、')) : '',
				adding ? E('p', { 'class': 'mh-note' }, '新的策略组要在「规则」页或其他策略组里引用后才会被使用。') : '',
				err
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '取消'), ' ',
				E('button', { 'class': 'btn cbi-button-positive', 'click': () => {
					const r = PL.buildGroup(base, values());
					if (r.error) { err.textContent = r.error; return; }
					const taken = BUILTIN.concat(this.groups.map(x => x.name), this.nodeList.map(n => n.name)).filter(n => adding || n !== g.name);
					if (taken.indexOf(r.group.name) >= 0) { err.textContent = '名称已被占用：' + r.group.name; return; }
					this.apply([ adding ? { op: 'group.add', data: r.group } : { op: 'group.set', name: g.name, data: r.group } ]);
				} }, adding ? '新增并应用' : '保存并应用')
			])
		]);
	}
});
