'use strict';
'require baseclass';
'require ui';
'require mihomo.ui as mui';
'require mihomo.proxylink as PL';

/* 单个节点（配置里的 proxies）：列表、粘贴分享链接导入、按协议分组的表单。
 * 字段与说明来自 shared/proxylink.js（LuCI 与 Magisk 共用）；写入经 patch 的 proxy.add / proxy.set / proxy.delete。 */

// 策略组勾选项：auto 组自动包含全部节点（勾选且禁用），继承自锚点的组不能在这里改
function groupChoices(groups, selected) {
	return (groups || []).map(g => ({
		name: g.name, type: g.type || '',
		checked: g.auto || (selected || []).indexOf(g.name) >= 0,
		disabled: g.auto || !g.editable,
		note: g.auto ? '自动包含全部节点' : (!g.editable ? '成员继承自锚点，请在配置文件页修改' : '')
	}));
}

// 勾选结果 → patch 的 groups（只含可编辑、非自动的组）
function pickedGroups(choices, checked) {
	return choices.filter(c => !c.disabled && checked[c.name]).map(c => c.name);
}

// 节点所在的策略组说明
function groupText(node, groups) {
	const auto = (groups || []).filter(g => g.auto).map(g => g.name);
	const own = node.groups || [];
	if (own.length) return own.join('、') + (auto.length ? '（另自动包含于 ' + auto.length + ' 个组）' : '');
	return auto.length ? '自动包含于 ' + auto.join('、') : '';
}

function check(label, checked, disabled, title) {
	const box = E('input', { type: 'checkbox' });
	box.checked = !!checked;
	box.disabled = !!disabled;
	return { box: box, el: E('label', { 'class': 'mh-check', title: title || '' }, [ box, ' ', label ]) };
}

// 策略组勾选区：返回 { el, value() }
function groupPicker(groups, selected) {
	const choices = groupChoices(groups, selected);
	if (!choices.length) return { el: E('span', { 'class': 'mh-sub' }, '配置里还没有策略组'), value: () => [] };
	const boxes = {};
	const el = E('div', { 'class': 'mh-group-pick' }, choices.map(c => {
		const k = check(c.name, c.checked, c.disabled, c.note);
		boxes[c.name] = k.box;
		return k.el;
	}));
	return { el: el, value: () => {
		const checked = {};
		for (const n in boxes) checked[n] = boxes[n].checked;
		return pickedGroups(choices, checked);
	} };
}

function input(field, value, policies, self) {
	const ph = field.placeholder || '';
	if (field.kind === 'bool') {
		const box = E('input', { type: 'checkbox' });
		box.checked = value === true;
		return box;
	}
	if (field.kind === 'enum' || field.kind === 'policy') {
		let opts = field.kind === 'policy' ? [ '' ].concat((policies || []).filter(p => p !== self)) : field.options;
		opts = opts.map(o => Array.isArray(o) ? o : [ o, o === '' ? '（默认）' : o ]);
		if (value !== '' && !opts.some(o => o[0] === value)) opts.push([ value, value ]);
		const sel = E('select', { 'class': 'cbi-input-select' }, opts.map(o => E('option', { value: o[0] }, o[1])));
		sel.value = value;
		return sel;
	}
	return E('input', {
		'class': 'cbi-input-text', type: field.kind === 'secret' ? 'password' : 'text', value: value, placeholder: ph,
		spellcheck: 'false', autocomplete: 'off', inputmode: field.kind === 'int' ? 'numeric' : null
	});
}

function readInput(el) {
	return el.type === 'checkbox' ? el.checked : el.value;
}

return baseclass.extend({
	groupChoices, pickedGroups, groupText,

	/* ctx：{ sec（sections.proxies）, rev, apply(promise) } */
	card(ctx) {
		const sec = ctx.sec;
		const list = sec.list.filter(n => n.type !== 'dns');
		const head = E('p', { 'class': 'mh-note' }, '不来自订阅、单独添加的节点。可以粘贴分享链接（ss:// vmess:// vless:// trojan:// hysteria2:// tuic:// 等）批量导入，或手动填写。');
		const rows = list.length ? E('div', { 'class': 'mh-pnode-list' }, list.map(n => this.row(ctx, n))) : mui.empty('还没有单独添加的节点');
		return mui.card('单个节点', [ head, rows ], { cls: 'mh-span-all', tools: [
			mui.btn('粘贴链接', () => this.paste(ctx), 'mh-btn-sm cbi-button-add'),
			mui.btn('手动添加', () => this.edit(ctx, null), 'mh-btn-sm')
		] });
	},

	row(ctx, n) {
		const g = groupText(n, ctx.sec.groups);
		const meta = [ E('span', {}, n.data ? PL.summary(n.data) : (n.type || '?') + (n.server ? ' · ' + n.server + ':' + n.port : '')) ];
		if (n.lock) meta.push(E('span', { 'class': 'mh-sub' }, n.lock));
		else meta.push(g ? E('span', { 'class': 'mh-sub', title: g }, '策略组：' + g) : E('span', { 'class': 'mh-warn' }, '没有加入策略组，规则引用它之前不会被使用'));
		const actions = [];
		if (!n.lock) actions.push(mui.btn('编辑', () => this.edit(ctx, n), 'mh-btn-sm'));
		if (n.type !== 'tailscale') actions.push(mui.btn('删除', () => this.remove(ctx, n), 'mh-btn-sm cbi-button-negative'));
		return E('div', { 'class': 'mh-pnode' }, [
			E('div', { 'class': 'mh-pnode-main' }, [ E('b', { title: n.name }, n.name), E('div', { 'class': 'mh-pnode-meta' }, meta) ]),
			E('div', { 'class': 'mh-pnode-actions' }, actions)
		]);
	},

	remove(ctx, n) {
		mui.confirm('删除节点', '确定删除「' + n.name + '」？会同时从策略组中移除。仍被规则、前置代理或规则集使用时不能删除，需要先改成别的出站。', '删除并应用', true).then(ok => {
			if (ok) ctx.apply([ { op: 'proxy.delete', name: n.name } ]);
		});
	},

	taken(ctx) {
		return (ctx.sec.policies || []).concat(ctx.sec.list.map(n => n.name));
	},

	paste(ctx) {
		const text = E('textarea', { 'class': 'mh-textarea', rows: 8, spellcheck: 'false', placeholder: '每行一条分享链接，也可以粘贴 base64 编码的订阅内容' });
		const preview = E('div', { 'class': 'mh-pnode-preview' });
		const picker = groupPicker(ctx.sec.groups, []);
		const err = E('p', { 'class': 'mh-err' });
		const submit = E('button', { 'class': 'btn cbi-button-positive', disabled: true }, '添加并应用');
		let parsed = { nodes: [], errors: [] };
		const update = () => {
			err.textContent = '';
			try {
				parsed = text.value.trim() ? PL.parseText(text.value, this.taken(ctx)) : { nodes: [], errors: [] };
			} catch (e) {
				parsed = { nodes: [], errors: [] };
				err.textContent = e.message;
			}
			submit.disabled = !parsed.nodes.length;
			submit.textContent = parsed.nodes.length ? '添加 ' + parsed.nodes.length + ' 个节点并应用' : '添加并应用';
			preview.replaceChildren(
				...parsed.nodes.map(n => E('div', { 'class': 'mh-pnode' }, [ E('div', { 'class': 'mh-pnode-main' }, [ E('b', {}, n.name), E('div', { 'class': 'mh-pnode-meta' }, PL.summary(n)) ]) ])),
				...parsed.errors.map(e => E('div', { 'class': 'mh-pnode bad' }, [ E('div', { 'class': 'mh-pnode-main' }, [ E('b', {}, '第 ' + e.line + ' 行：' + e.error), E('div', { 'class': 'mh-pnode-meta' }, e.text) ]) ]))
			);
		};
		text.addEventListener('input', update);
		submit.addEventListener('click', () => {
			ctx.apply([ { op: 'proxy.add', nodes: parsed.nodes, groups: picker.value() } ]);
		});
		ui.showModal('粘贴分享链接', [
			E('div', { 'class': 'mh mh-form' }, [
				text,
				preview,
				mui.field('加入策略组', picker.el, '勾选的策略组里可以选到这些节点；也可以之后在规则里直接写节点名称'),
				E('p', { 'class': 'mh-note' }, '无法解析的行会被跳过。链接里的名称重复时自动加编号。'),
				err
			]),
			E('div', { 'class': 'right' }, [ E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '取消'), ' ', submit ])
		]);
	},

	// n 为 null 时新增
	edit(ctx, n) {
		const adding = !n;
		const base = adding ? { udp: true } : n.data;
		let type = adding ? 'vless' : n.data.type;
		const typeSel = E('select', { 'class': 'cbi-input-select' }, PL.PROTOCOLS.map(p => E('option', { value: p.type }, p.label)));
		typeSel.value = type;
		const box = E('div', {});
		const err = E('p', { 'class': 'mh-err' });
		const picker = groupPicker(ctx.sec.groups, adding ? [] : n.groups);
		let inputs = {}, rows = {};
		const values = () => {
			const v = {};
			for (const k in inputs) v[k] = readInput(inputs[k]);
			return v;
		};
		// 按当前填写的值决定哪些字段显示（例如传输方式为 WebSocket 时才显示路径）
		const refresh = () => {
			const cur = PL.applyForm(base, type, (() => {
				const out = {};
				for (const f of PL.fields(type)) if (f.key in inputs) { try { out[f.key] = PL.fromInput(f, readInput(inputs[f.key])); } catch (e) {} }
				return out;
			})());
			for (const f of PL.fields(type)) if (rows[f.key]) rows[f.key].hidden = !PL.visible(f, cur);
		};
		const draw = (start) => {
			const vals = PL.formValues(start, type);
			inputs = {}; rows = {};
			const mk = f => {
				const el = input(f, vals[f.key], ctx.sec.policies, adding ? null : n.name);
				el.addEventListener('change', refresh);
				inputs[f.key] = el;
				const label = f.required ? [ f.label, E('span', { 'class': 'mh-req' }, ' *') ] : f.label;
				rows[f.key] = mui.field(label, el, f.help ? f.help + '（' + f.key + '）' : f.key);
				return rows[f.key];
			};
			const all = PL.fields(type);
			const main = all.filter(f => !f.adv), adv = all.filter(f => f.adv);
			box.replaceChildren(
				...main.map(mk),
				adv.length ? E('details', { 'class': 'mh-adv' }, [ E('summary', {}, '高级选项（' + adv.length + '）'), ...adv.map(mk) ]) : ''
			);
			refresh();
		};
		// 换协议：保留名称、服务器与端口，其余字段按新协议重新填写
		typeSel.addEventListener('change', () => {
			const keep = values();
			type = typeSel.value;
			draw(type === base.type ? base : { name: keep.name, server: keep.server, port: keep.port, udp: true });
		});
		draw(base);
		const others = adding ? [] : Object.keys(n.data).filter(k => !PL.fields(n.data.type).some(f => f.key === k || f.key.split('.')[0] === k) && k !== 'type');
		ui.showModal(adding ? '添加节点' : '编辑节点「' + n.name + '」', [
			E('div', { 'class': 'mh mh-form' }, [
				mui.field('协议', typeSel, '与机场或服务端提供的协议一致'),
				box,
				mui.field('加入策略组', picker.el, '勾选的策略组里可以选到这个节点'),
				others.length ? E('p', { 'class': 'mh-note' }, '另有 ' + others.length + ' 个表单中没有的字段会原样保留：' + others.join('、')) : '',
				err
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '取消'), ' ',
				E('button', { 'class': 'btn cbi-button-positive', 'click': () => {
					const r = PL.buildNode(base, type, values());
					if (r.error) { err.textContent = r.error; return; }
					const taken = this.taken(ctx).filter(x => adding || x !== n.name);
					if (taken.indexOf(r.node.name) >= 0) { err.textContent = '名称已被占用：' + r.node.name; return; }
					ctx.apply([ adding ? { op: 'proxy.add', nodes: [ r.node ], groups: picker.value() }
						: { op: 'proxy.set', name: n.name, data: r.node, groups: picker.value() } ]);
				} }, adding ? '添加并应用' : '保存并应用')
			])
		]);
	}
});
