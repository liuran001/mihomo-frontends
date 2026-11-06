'use strict';
'require view';
'require ui';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';

/* 规则：匹配测试（后端经 mixed-port 发起一次真实连接）；配置文件中的规则表（编辑、排序、增删后保存并应用），
 * 按下标对应运行中的规则（命中次数、临时停用）；规则集管理。 */

// 与后端 probe.uc 的 parse_target 规则一致
function parseTarget(s) {
	if (typeof s !== 'string') return null;
	s = s.trim();
	let host = null, port = '443', m;
	if ((m = s.match(/^\[([0-9A-Fa-f:.]+)\]:([0-9]+)$/))) {
		host = m[1];
		port = m[2];
	} else if (/^[0-9A-Fa-f:.]+$/.test(s) && s.split(':').length > 2)
		host = s;
	else if ((m = s.match(/^([A-Za-z0-9._-]+):([0-9]+)$/))) {
		host = m[1];
		port = m[2];
	} else if (/^[A-Za-z0-9._-]+$/.test(s))
		host = s;
	if (host == null || host.length > 253 || port.length > 5) return null;
	const n = +port;
	return (n >= 1 && n <= 65535) ? { host: host, port: n } : null;
}

function validTime(t) {
	const ms = Date.parse(t);
	return (!t || isNaN(ms) || new Date(ms).getFullYear() < 2000) ? null : t;
}

// 运行中的规则（/rules）转成显示用的行；读不到配置文件时直接显示这张表
function ruleView(rules, q) {
	q = String(q || '').toLowerCase();
	return (rules || []).map(r => {
		const x = r.extra || {};
		return {
			index: r.index, type: r.type, payload: r.payload || '', proxy: r.proxy,
			disabled: !!x.disabled, hits: x.hitCount || 0, hitAt: validTime(x.hitAt), toggleable: !!r.extra
		};
	}).filter(r => !q || [ r.type, r.payload, r.proxy ].join('\n').toLowerCase().indexOf(q) >= 0);
}

function chainText(chains) {
	return (chains && chains.length) ? chains.slice().reverse().join(' → ') : '-';
}

function ruleText(r) {
	if (!r.rule) return '未命中规则（全局或直连模式）';
	return r.payload ? r.rule + '(' + r.payload + ')' : r.rule;
}

/* ---------- 规则文本 ---------- */

const LOGIC = [ 'AND', 'OR', 'NOT', 'SUB-RULE' ];
const TYPES = [
	'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-WILDCARD', 'DOMAIN-REGEX', 'GEOSITE',
	'IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'IP-ASN', 'GEOIP',
	'SRC-IP-CIDR', 'SRC-IP-SUFFIX', 'SRC-IP-ASN', 'SRC-GEOIP',
	'DST-PORT', 'SRC-PORT', 'IN-PORT', 'IN-TYPE', 'IN-USER', 'IN-NAME',
	'PROCESS-NAME', 'PROCESS-PATH', 'PROCESS-NAME-REGEX', 'PROCESS-PATH-REGEX', 'UID',
	'NETWORK', 'DSCP', 'RULE-SET', 'MATCH'
];
const OPTS = [ 'no-resolve', 'src' ];
const IP_TYPES = [ 'IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'IP-ASN', 'GEOIP', 'RULE-SET' ];

// 按最外层的逗号切分（逻辑规则的括号里也有逗号）
function splitTop(s) {
	const out = [];
	let depth = 0, cur = '';
	for (const c of String(s)) {
		if (c === '(') depth++;
		else if (c === ')') depth = Math.max(0, depth - 1);
		if (c === ',' && depth === 0) {
			out.push(cur.trim());
			cur = '';
		} else cur += c;
	}
	out.push(cur.trim());
	return out;
}

function parseRule(s) {
	const raw = String(s == null ? '' : s);
	const p = splitTop(raw);
	const type = (p[0] || '').toUpperCase();
	if (type === 'MATCH')
		return { type: type, value: '', policy: p[1] || '', opts: p.slice(2), raw: raw, logic: false };
	return { type: type, value: p[1] || '', policy: p[2] || '', opts: p.slice(3), raw: raw, logic: LOGIC.indexOf(type) >= 0 };
}

function buildRule(r) {
	if (r.type === 'MATCH') return [ 'MATCH', r.policy ].concat(r.opts || []).join(',');
	return [ r.type, r.value, r.policy ].concat(r.opts || []).join(',');
}

// rows：[{ k: 原下标或 null, v: 规则文本 }]，orig：配置中的规则；转成 rules.set 的 items
function toItems(rows, orig) {
	return rows.map(r => {
		if (r.k == null) return { v: r.v };
		return (orig && orig[r.k] === r.v) ? { k: r.k } : { k: r.k, v: r.v };
	});
}

function isDirty(rows, orig) {
	if (rows.length !== orig.length) return true;
	return rows.some((r, i) => r.k !== i || r.v !== orig[i]);
}

// 规则行与运行中的规则按原下标对应；数量不一致时不对应（配置尚未生效等）
function mergeRows(rows, runtime, origCount) {
	const rt = (runtime && runtime.length === origCount) ? runtime : null;
	return rows.map((r, i) => {
		const x = (rt && r.k != null && rt[r.k]) ? (rt[r.k].extra || null) : null;
		return Object.assign({ pos: i, rule: parseRule(r.v), hits: x ? (x.hitCount || 0) : null, hitAt: x ? validTime(x.hitAt) : null,
			disabled: !!(x && x.disabled), toggleable: !!x }, r);
	});
}

function refsText(refs) {
	return (refs && refs.length) ? '正在被使用：' + refs.join('、') : '未被引用';
}

function rowMatches(row, q) {
	if (!q) return true;
	return [ row.v ].join('\n').toLowerCase().indexOf(q.toLowerCase()) >= 0;
}

const BEHAVIORS = { domain: '域名', ipcidr: 'IP 段', classical: '经典' };

return view.extend({
	parseTarget, ruleView, chainText, ruleText, splitTop, parseRule, buildRule, toItems, isDirty, mergeRows, refsText,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.resolve();
	},

	render() {
		mui.loadCss();
		this.orig = null;
		this.rows = [];
		this.runtime = null;
		this.q = '';

		this.input = E('input', { type: 'text', 'class': 'cbi-input-text', placeholder: '例如 www.google.com、1.1.1.1:443、[2001:db8::1]:443' });
		this.input.addEventListener('keydown', ev => { if (ev.key === 'Enter') this.runTest(); });
		this.testBtn = mui.btn('测试', () => this.runTest(), 'cbi-button-action');
		this.result = E('div', { 'class': 'mh-probe-result' });
		const probe = mui.card('匹配测试', [
			E('div', { 'class': 'mh-probe' }, [ this.input, this.testBtn ]),
			this.result,
			E('p', { 'class': 'mh-note' }, '测试从路由器本机经 mixed-port 对目标发起一次真实的 TCP 连接，查到命中的规则后立即断开。按来源 IP、MAC 或入站匹配的规则，结果可能与局域网设备不同。')
		]);

		const search = E('input', { type: 'search', 'class': 'cbi-input-text mh-search', placeholder: '搜索规则' });
		search.addEventListener('input', () => { this.q = search.value.trim(); this.renderRules(); });
		this.modeNote = E('div', { 'class': 'mh-banner warn' });
		this.modeNote.hidden = true;
		this.dirtyBar = E('div', { 'class': 'mh-banner mh-dirty' }, [
			E('span', { 'class': 'mh-grow' }, '规则有未保存的修改。'),
			mui.btn('放弃修改', () => this.discard(), 'mh-btn-sm'),
			mui.btn('保存并应用', () => this.saveRules(), 'mh-btn-sm cbi-button-apply')
		]);
		this.dirtyBar.hidden = true;
		this.tbody = E('tbody', {});
		this.tbody.addEventListener('change', ev => {
			const cb = ev.target.closest('input[data-index]');
			if (cb) this.setEnabled(+cb.getAttribute('data-index'), cb.checked, cb);
		});
		this.tbody.addEventListener('click', ev => {
			const b = ev.target.closest('button[data-act]');
			if (b) this.rowAction(b.getAttribute('data-act'), +b.getAttribute('data-pos'));
		});
		this.countEl = E('span', { 'class': 'mh-count' });
		this.noteEl = E('p', { 'class': 'mh-note' });
		this.addBtn = mui.btn('新增规则', () => this.editRule(null), 'mh-btn-sm cbi-button-add');
		const list = mui.card('规则', [
			this.modeNote,
			this.dirtyBar,
			E('div', { 'class': 'mh-toolbar' }, [ search, E('span', { 'class': 'mh-grow' }), this.countEl, mui.btn('刷新', () => this.reload(), 'mh-btn-sm') ]),
			E('div', { 'class': 'mh-scroll-x' }, E('table', { 'class': 'mh-table mh-cards mh-rule-table' }, [
				E('thead', {}, E('tr', {}, [ '#', '类型', '内容', '策略', '参数', '命中', '最近命中', '启用', '' ].map((c, i) => E('th', { 'class': (i === 5) ? 'mh-num' : '' }, c)))),
				this.tbody
			])),
			this.noteEl
		], { tools: [ this.addBtn ] });

		this.rpBody = E('div', {}, mui.empty('读取中…'));
		this.rpUpdateAll = mui.btn('全部更新', () => this.updateAllSets(), 'mh-btn-sm');
		const sets = mui.card('规则集', this.rpBody, { tools: [ this.rpUpdateAll, mui.btn('新增规则集', () => this.editSet(null), 'mh-btn-sm cbi-button-add') ] });

		const root = E('div', { 'class': 'mh' }, [ header.render(), probe, list, sets ]);
		this.reload();
		if (this.poller) this.poller.close();
		this.poller = api.poll(root, 15000, () => this.loadRuntime(), false);
		return root;
	},

	/* ---------- 读取 ---------- */

	reload() {
		return api.rpc.sections([ 'rules', 'rule_providers' ]).then(s => {
			if (!s || !s.ok) throw new Error((s && s.error) || '读取失败');
			this.rev = s.rev;
			this.cfgError = s.parse_error || (s.rules && s.rules.unsupported && s.rules.reason) || null;
			if (this.cfgError) {
				this.orig = null;
				this.sec = null;
			} else {
				this.sec = s;
				this.orig = s.rules.list.slice();
				this.rows = this.orig.map((v, k) => ({ k: k, v: v }));
			}
		}).catch(e => {
			this.cfgError = '无法读取配置：' + e.message;
			this.orig = null;
			this.sec = null;
		}).then(() => this.loadRuntime());
	},

	loadRuntime() {
		return Promise.all([
			api.get('/rules').then(d => (d && d.rules) || [], () => null),
			api.get('/configs').catch(() => null),
			api.get('/providers/rules').then(d => (d && d.providers) || {}, () => null)
		]).then(([ rules, cfg, sets ]) => {
			this.runtime = rules;
			this.runtimeSets = sets;
			const mode = String((cfg && cfg.mode) || 'rule').toLowerCase();
			this.modeNote.hidden = mode === 'rule';
			this.modeNote.textContent = '当前为' + (mode === 'global' ? '全局' : '直连') + '模式，规则不参与分流。';
			this.renderRules();
			this.renderSets();
		});
	},

	/* ---------- 规则表 ---------- */

	renderRules() {
		const editable = this.orig != null;
		this.addBtn.disabled = !editable;
		this.dirtyBar.hidden = !(editable && isDirty(this.rows, this.orig));
		if (!editable) return this.renderRuntimeOnly();

		const all = mergeRows(this.rows, this.runtime, this.orig.length);
		const shown = all.filter(r => rowMatches(r, this.q));
		const filtering = !!this.q;
		this.countEl.textContent = (filtering ? shown.length + ' / ' : '') + all.length + ' 条';
		const linked = this.runtime && this.runtime.length === this.orig.length;
		this.noteEl.textContent = (linked ? '命中与「启用」开关对应运行中的规则；开关只对本次运行有效，服务重启后恢复。' :
			'运行中的规则与配置文件数量不一致（服务未运行或配置尚未生效），暂不显示命中次数。') +
			' 修改规则后点「保存并应用」写入配置文件，原有注释随规则一起保留。';
		if (!shown.length) {
			this.tbody.replaceChildren(E('tr', {}, E('td', { colspan: 9 }, mui.empty(all.length ? '没有符合搜索条件的规则' : '没有规则'))));
			return;
		}
		const last = all.length - 1;
		this.tbody.replaceChildren(...shown.map(r => {
			const p = r.rule;
			const cb = E('input', { type: 'checkbox', 'data-index': r.k == null ? '' : r.k });
			cb.checked = !r.disabled;
			cb.disabled = !r.toggleable;
			cb.title = r.toggleable ? '' : (r.k == null ? '新规则保存后才能停用' : '运行中的规则暂不可用');
			if (!r.toggleable) cb.removeAttribute('data-index');
			const changed = r.k == null ? 'new' : (r.v !== this.orig[r.k] ? 'changed' : (r.k !== r.pos ? 'moved' : ''));
			const act = (a, label, title, disabled) => E('button', { 'class': 'mh-x', 'data-act': a, 'data-pos': r.pos, title: title, disabled: disabled ? '' : null }, label);
			return E('tr', { 'class': [ r.disabled ? 'off' : '', changed ].join(' ').trim() }, [
				E('td', { 'class': 'mh-dim c-no' }, String(r.pos + 1)),
				E('td', { 'class': 'c-type' }, p.type || '?'),
				E('td', { 'class': 'mh-trunc c-val', title: p.logic ? p.raw : p.value }, p.logic ? p.value : (p.value || '-')),
				E('td', { 'class': 'mh-trunc c-pol', title: p.policy, 'data-label': '→' }, p.policy),
				E('td', { 'class': 'mh-dim c-opts' }, p.opts.join(',')),
				E('td', { 'class': 'mh-num c-hits', 'data-label': '命中' }, r.hits == null ? '-' : String(r.hits)),
				E('td', { 'class': 'mh-dim c-when', 'data-label': '最近' }, r.hitAt ? mui.fmtAgo(r.hitAt) : '-'),
				E('td', { 'class': 'c-sw' }, cb),
				E('td', { 'class': 'mh-actions c-act' }, [
					act('edit', '✎', '编辑'),
					act('up', '↑', filtering ? '搜索时不能移动' : '上移', filtering || r.pos === 0),
					act('down', '↓', filtering ? '搜索时不能移动' : '下移', filtering || r.pos === last),
					act('del', '✕', '删除')
				])
			]);
		}));
	},

	renderRuntimeOnly() {
		const list = ruleView(this.runtime, this.q);
		this.countEl.textContent = (this.runtime || []).length + ' 条（只读）';
		this.noteEl.textContent = (this.cfgError || '') + ' 当前只显示运行中的规则，不能编辑。';
		if (!list.length) {
			this.tbody.replaceChildren(E('tr', {}, E('td', { colspan: 9 }, mui.empty(this.runtime ? '没有规则' : '无法读取规则'))));
			return;
		}
		this.tbody.replaceChildren(...list.map(r => {
			const cb = E('input', { type: 'checkbox', 'data-index': r.index });
			cb.checked = !r.disabled;
			cb.disabled = !r.toggleable;
			return E('tr', { 'class': r.disabled ? 'off' : '' }, [
				E('td', { 'class': 'mh-dim c-no' }, String(r.index + 1)), E('td', { 'class': 'c-type' }, r.type),
				E('td', { 'class': 'mh-trunc c-val', title: r.payload }, r.payload || '-'), E('td', { 'class': 'mh-trunc c-pol', 'data-label': '→' }, r.proxy), E('td', { 'class': 'c-opts' }, ''),
				E('td', { 'class': 'mh-num c-hits', 'data-label': '命中' }, String(r.hits)), E('td', { 'class': 'mh-dim c-when', 'data-label': '最近' }, r.hitAt ? mui.fmtAgo(r.hitAt) : '-'),
				E('td', { 'class': 'c-sw' }, cb), E('td', { 'class': 'c-act' }, '')
			]);
		}));
	},

	rowAction(act, pos) {
		const rows = this.rows;
		if (act === 'edit') return this.editRule(pos);
		if (act === 'del') rows.splice(pos, 1);
		else if (act === 'up' && pos > 0) rows.splice(pos - 1, 0, rows.splice(pos, 1)[0]);
		else if (act === 'down' && pos < rows.length - 1) rows.splice(pos + 1, 0, rows.splice(pos, 1)[0]);
		this.renderRules();
	},

	discard() {
		this.rows = this.orig.map((v, k) => ({ k: k, v: v }));
		this.renderRules();
	},

	saveRules() {
		mui.runJob(api.rpc.patch([ { op: 'rules.set', items: toItems(this.rows, this.orig) } ], this.rev)).then(s => {
			if (s.state === 'done' || s.state === 'rolled_back') this.reload();
		});
	},

	setEnabled(index, enabled, cb) {
		const body = {};
		body[index] = !enabled;
		api.patch('/rules/disable', body).then(() => {
			const r = (this.runtime || []).find(x => x.index === index);
			if (r && r.extra) r.extra.disabled = !enabled;
			this.renderRules();
			mui.notify((enabled ? '已启用' : '已临时停用') + '第 ' + (index + 1) + ' 条规则' + (enabled ? '' : '，重启后恢复'));
		}, e => {
			cb.checked = !enabled;
			mui.notify('操作失败：' + e.message, 'error');
		});
	},

	// pos 为 null 时新增
	editRule(pos) {
		const adding = pos == null;
		const cur = adding ? parseRule('DOMAIN-SUFFIX,,' + ((this.sec.rules.policies || [])[0] || 'DIRECT')) : parseRule(this.rows[pos].v);
		// 能拆成「类型、内容、策略、参数」并原样拼回的规则用下拉编辑，其余（逻辑规则、内容含逗号等）直接编辑文本
		const known = TYPES.indexOf(cur.type) >= 0 && !cur.opts.some(o => OPTS.indexOf(o) < 0) &&
			buildRule(cur) === splitTop(cur.raw).join(',');
		const policies = this.sec.rules.policies || [];
		const sets = this.sec.rules.rule_sets || [];

		const typeSel = E('select', { 'class': 'cbi-input-select' }, TYPES.map(t => E('option', { value: t }, t)).concat([ E('option', { value: '' }, '逻辑规则 / 其他（直接编辑文本）') ]));
		typeSel.value = known ? cur.type : '';
		const valueIn = E('input', { type: 'text', 'class': 'cbi-input-text', value: cur.value });
		const setSel = E('select', { 'class': 'cbi-input-select' }, sets.map(n => E('option', { value: n }, n)));
		if (cur.type === 'RULE-SET' && sets.indexOf(cur.value) >= 0) setSel.value = cur.value;
		const polSel = E('select', { 'class': 'cbi-input-select' }, policies.map(n => E('option', { value: n }, n)));
		if (cur.policy && policies.indexOf(cur.policy) < 0) polSel.appendChild(E('option', { value: cur.policy }, cur.policy + '（不存在）'));
		polSel.value = cur.policy || policies[0] || '';
		const optBoxes = OPTS.map(o => {
			const cb = E('input', { type: 'checkbox' });
			cb.checked = cur.opts.indexOf(o) >= 0;
			return { name: o, cb: cb, label: E('label', { 'class': 'mh-switch' }, [ cb, ' ' + o ]) };
		});
		const rawIn = E('textarea', { 'class': 'cbi-input-textarea', rows: 3, style: 'width:100%' }, cur.raw);
		const posSel = E('select', { 'class': 'cbi-input-select' }, [ E('option', { value: 'top' }, '最前'), E('option', { value: 'end' }, '最后（MATCH 之前）') ]);
		const preview = E('code', { 'class': 'mh-rule-preview' });
		const err = E('p', { 'class': 'mh-err' });

		const field = (label, el) => E('div', { 'class': 'mh-field' }, [ E('label', {}, label), E('div', {}, el) ]);
		const fValue = field('内容', valueIn), fSet = field('规则集', setSel), fPol = field('策略', polSel);
		const fOpts = field('参数', E('div', { 'class': 'mh-chips' }, optBoxes.map(o => o.label)));
		const fRaw = field('规则文本', rawIn);

		const build = () => {
			const t = typeSel.value;
			if (!t) return rawIn.value.trim();
			const r = { type: t, value: t === 'RULE-SET' ? setSel.value : valueIn.value.trim(), policy: polSel.value,
				opts: optBoxes.filter(o => o.cb.checked && IP_TYPES.indexOf(t) >= 0).map(o => o.name) };
			return buildRule(r);
		};
		const sync = () => {
			const t = typeSel.value;
			fValue.hidden = !t || t === 'MATCH' || t === 'RULE-SET';
			fSet.hidden = t !== 'RULE-SET';
			fPol.hidden = !t;
			fOpts.hidden = IP_TYPES.indexOf(t) < 0;
			fRaw.hidden = !!t;
			if (t) rawIn.value = build();
			preview.textContent = build();
		};
		[ typeSel, valueIn, setSel, polSel, rawIn ].concat(optBoxes.map(o => o.cb)).forEach(el => {
			el.addEventListener('input', sync);
			el.addEventListener('change', sync);
		});
		sync();

		ui.showModal(adding ? '新增规则' : '编辑第 ' + (pos + 1) + ' 条规则', [
			E('div', { 'class': 'mh mh-form' }, [
				field('类型', typeSel), fValue, fSet, fPol, fOpts, fRaw,
				adding ? field('位置', posSel) : '',
				field('预览', preview),
				E('p', { 'class': 'mh-note' }, '修改先保存在本页，点规则表上方的「保存并应用」后才写入配置文件。'),
				err
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '取消'), ' ',
				E('button', { 'class': 'btn cbi-button-positive', 'click': () => {
					const text = build();
					const p = parseRule(text);
					const problem = !text || text.indexOf(',') < 0 ? '规则至少需要「类型,策略」两段'
						: (/[\r\n]/.test(text) ? '规则不能换行'
						: (typeSel.value && typeSel.value !== 'MATCH' && !p.value ? '请填写内容'
						: (!p.policy ? '请选择策略' : null)));
					if (problem) {
						err.textContent = problem;
						return;
					}
					if (adding) {
						let at = 0;
						if (posSel.value === 'end') {
							at = this.rows.length;
							if (at && parseRule(this.rows[at - 1].v).type === 'MATCH') at--;
						}
						this.rows.splice(at, 0, { k: null, v: text });
					} else this.rows[pos] = { k: this.rows[pos].k, v: text };
					ui.hideModal();
					this.renderRules();
				} }, '确定')
			])
		]);
	},

	/* ---------- 规则集 ---------- */

	renderSets() {
		if (!this.sec || !this.sec.rule_providers || this.sec.rule_providers.unsupported) {
			this.rpBody.replaceChildren(mui.empty(this.cfgError || (this.sec && this.sec.rule_providers && this.sec.rule_providers.reason) || '无法读取规则集'));
			return;
		}
		const list = this.sec.rule_providers.list;
		if (!list.length) {
			this.rpBody.replaceChildren(mui.empty('没有规则集'));
			return;
		}
		const rt = this.runtimeSets || {};
		this.rpBody.replaceChildren(E('div', { 'class': 'mh-scroll-x' }, E('table', { 'class': 'mh-table mh-cards mh-set-table' }, [
			E('thead', {}, E('tr', {}, [ '名称', '类型', '条目', '更新于', '更新间隔', '经由', '引用', '' ].map((c, i) => E('th', { 'class': i === 2 ? 'mh-num' : '' }, c)))),
			E('tbody', {}, list.map(r => {
				const x = rt[r.name];
				const http = r.type === 'http';
				const refs = r.refs || [];
				const na = http ? '' : ' mh-na';	// 非 http 规则集没有更新信息，卡片排版时隐藏
				return E('tr', {}, [
					E('td', { 'class': 'c-name' }, E('b', {}, r.name)),
					E('td', { 'class': 'mh-dim c-kind' }, (BEHAVIORS[r.behavior] || r.behavior || '-') + ' · ' + (r.type === 'inline' ? '内联' : (r.format || r.type))),
					E('td', { 'class': 'mh-num c-count', 'data-label': '条目' }, x ? String(x.ruleCount) : (r.size != null ? String(r.size) : '-')),
					E('td', { 'class': 'mh-dim c-upd' + na, 'data-label': '更新于' }, x && http ? mui.fmtAgo(x.updatedAt) : '-'),
					E('td', { 'class': 'mh-dim c-ivl' + na, 'data-label': '间隔' }, http && r.interval ? mui.fmtDuration(r.interval) : '-'),
					E('td', { 'class': 'mh-dim c-via' + na, 'data-label': '经由' }, http ? (r.proxy || 'DIRECT') : '-'),
					E('td', { 'class': 'mh-trunc c-refs', title: refs.join('\n'), 'data-label': refs.length ? '引用' : null }, refs.length ? refs.length + ' 处' : E('span', { 'class': 'mh-dim' }, '未被引用')),
					E('td', { 'class': 'mh-actions c-act' }, [
						http ? mui.btn('更新', ev => this.updateSet(r.name, ev.currentTarget), 'mh-btn-sm') : '',
						http ? mui.btn('编辑', () => this.editSet(r), 'mh-btn-sm') : '',
						E('button', { 'class': 'btn cbi-button mh-btn-sm cbi-button-negative', disabled: refs.length ? '' : null,
							title: refs.length ? refsText(refs) + '，先去掉这些引用才能删除' : '', 'click': () => this.removeSet(r) }, '删除')
					])
				]);
			}))
		])));
	},

	updateSet(name, btn) {
		btn.disabled = true;
		return api.put('/providers/rules/' + encodeURIComponent(name)).then(() => mui.notify('规则集「' + name + '」已更新'),
			e => mui.notify('更新失败：' + e.message, 'error')).then(() => { btn.disabled = false; this.loadRuntime(); });
	},

	updateAllSets() {
		const names = ((this.sec && this.sec.rule_providers.list) || []).filter(r => r.type === 'http').map(r => r.name);
		this.rpUpdateAll.disabled = true;
		Promise.all(names.map(n => api.put('/providers/rules/' + encodeURIComponent(n)).then(() => null, e => n + '：' + e.message))).then(errs => {
			errs = errs.filter(Boolean);
			mui.notify(errs.length ? '部分规则集更新失败：' + errs.join('；') : '规则集已全部更新', errs.length ? 'warning' : 'info');
		}).then(() => { this.rpUpdateAll.disabled = false; this.loadRuntime(); });
	},

	removeSet(r) {
		mui.confirm('删除规则集', '确定删除规则集「' + r.name + '」？应用成功后删除缓存文件 ' + (r.path || '') + '。', '删除并应用', true).then(ok => {
			if (ok) mui.runJob(api.rpc.patch([ { op: 'rule_provider.delete', name: r.name } ], this.rev)).then(() => this.reload());
		});
	},

	editSet(r) {
		if (!this.sec || !this.sec.rule_providers || this.sec.rule_providers.unsupported) return;
		const adding = !r;
		const policies = this.sec.rule_providers.policies || [ 'DIRECT' ];
		const input = (v, attrs) => E('input', Object.assign({ type: 'text', 'class': 'cbi-input-text', value: v == null ? '' : String(v) }, attrs || {}));
		const sel = (opts, v) => {
			const s = E('select', { 'class': 'cbi-input-select' }, opts.map(o => E('option', { value: o[0] }, o[1])));
			s.value = v;
			return s;
		};
		const f = {
			name: input(adding ? '' : r.name, adding ? { placeholder: '例如 CN-IP' } : { disabled: true }),
			behavior: sel([ [ 'domain', 'domain（域名）' ], [ 'ipcidr', 'ipcidr（IP 段）' ], [ 'classical', 'classical（经典）' ] ], adding ? 'domain' : r.behavior),
			format: sel([ [ 'mrs', 'mrs' ], [ 'yaml', 'yaml' ], [ 'text', 'text' ] ], adding ? 'mrs' : r.format),
			url: input(adding ? '' : r.url, { placeholder: 'https://…' }),
			interval: input(adding ? 86400 : r.interval, { inputmode: 'numeric' }),
			proxy: sel(policies.map(p => [ p, p ]), adding ? 'DIRECT' : (r.proxy || 'DIRECT'))
		};
		if (!adding) {
			f.behavior.disabled = true;
			f.format.disabled = true;
		}
		const err = E('p', { 'class': 'mh-err' });
		const field = (label, el, hint) => E('div', { 'class': 'mh-field' }, [ E('label', {}, label), E('div', {}, [ el, hint ? E('div', { 'class': 'mh-note' }, hint) : '' ]) ]);
		ui.showModal(adding ? '新增规则集' : '编辑规则集「' + r.name + '」', [
			E('div', { 'class': 'mh mh-form' }, [
				field('名称', f.name, adding ? '缓存文件为 ./rule_provider/<名称>.<格式>' : ''),
				field('类型', f.behavior), field('格式', f.format, adding ? 'mrs 只支持 domain 与 ipcidr' : ''),
				field('链接', f.url), field('更新间隔（秒）', f.interval), field('下载经由', f.proxy),
				err
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '取消'), ' ',
				E('button', { 'class': 'btn cbi-button-positive', 'click': () => {
					const name = String(f.name.value).trim();
					const interval = String(f.interval.value).trim();
					const data = { url: f.url.value.trim(), interval: interval === '' ? '' : Number(interval), proxy: f.proxy.value };
					const problem = (adding && (!name || /[\/,\\]/.test(name) || name[0] === '.')) ? '名称不能为空，不能包含 / , \\，不能以 . 开头'
						: (!/^https?:\/\/[^\s/?#]+/.test(data.url) ? '链接需要 http:// 或 https:// 开头'
						: (data.interval !== '' && !(Number.isInteger(data.interval) && data.interval >= 0) ? '更新间隔需要填写非负整数'
						: (adding && f.format.value === 'mrs' && f.behavior.value === 'classical' ? 'mrs 格式只支持 domain 与 ipcidr' : null)));
					if (problem) {
						err.textContent = problem;
						return;
					}
					if (adding) {
						data.behavior = f.behavior.value;
						data.format = f.format.value;
					}
					mui.runJob(api.rpc.patch([ { op: adding ? 'rule_provider.add' : 'rule_provider.set', name: adding ? name : r.name, data: data } ], this.rev))
						.then(() => this.reload());
				} }, adding ? '新增并应用' : '保存并应用')
			])
		]);
	},

	/* ---------- 匹配测试 ---------- */

	runTest() {
		const t = parseTarget(this.input.value);
		if (!t) {
			this.result.replaceChildren(E('p', { 'class': 'mh-err' }, '目标格式不对，应为 host 或 host:port'));
			return;
		}
		const target = (t.host.indexOf(':') >= 0 ? '[' + t.host + ']' : t.host) + ':' + t.port;
		this.testBtn.disabled = true;
		this.testBtn.textContent = '测试中…';
		this.result.replaceChildren(E('div', { 'class': 'mh-job' }, [ E('span', { 'class': 'mh-spinner' }), '正在连接 ' + target ]));
		api.rpc.ruleTest(target).then(r => {
			if (!r || !r.ok) {
				this.result.replaceChildren(E('p', { 'class': 'mh-err' }, (r && r.error) || '测试失败'));
				return;
			}
			const rows = [
				mui.row('目标', target),
				mui.row('命中规则', E('b', {}, ruleText(r))),
				mui.row('策略链路', chainText(r.chains)),
				mui.row('目标 IP', r.ip || '由节点解析'),
				mui.row('用时', r.elapsed_ms + ' ms')
			];
			if (r.via === 'log')
				rows.push(mui.row('拨号结果', E('span', { 'class': 'mh-err' }, '失败：' + (r.error || '未知错误'))));
			this.result.replaceChildren(E('div', { 'class': 'mh-probe-box' }, rows));
			this.loadRuntime();
		}, e => {
			this.result.replaceChildren(E('p', { 'class': 'mh-err' }, '测试失败：' + e.message));
		}).then(() => {
			this.testBtn.disabled = false;
			this.testBtn.textContent = '测试';
		});
	}
});
