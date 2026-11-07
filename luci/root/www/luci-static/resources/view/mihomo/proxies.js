'use strict';
'require view';
'require ui';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';

/* 代理：每个策略组一张卡片，节点按延迟着色。select 组点击节点切换；url-test、fallback、smart 组点击节点固定，可取消固定。 */

const PREF_KEY = 'mihomo.proxies.prefs';
const DEFAULT_URL = 'https://www.gstatic.com/generate_204';
const TIMEOUT = 5000;
const TYPES = { Selector: '手动选择', URLTest: '自动测速', Fallback: '故障转移', LoadBalance: '负载均衡', Smart: 'Smart', Relay: '链式代理' };
const PICKABLE = [ 'Selector', 'URLTest', 'Fallback', 'Smart' ];
const RANKS = { MostUsed: '常用', OccasionalUsed: '偶尔', RarelyUsed: '很少' };
const SORTS = [ [ 'default', '默认顺序' ], [ 'delay', '按延迟' ], [ 'name', '按名称' ] ];

function typeLabel(t) {
	return TYPES[t] || t || '-';
}

// 订阅里的节点先放；/proxies 的条目只在是策略组或尚无同名节点时覆盖（/proxies 不含订阅节点的测速历史）
function buildIndex(proxies, providers) {
	const idx = {};
	Object.keys(providers || {}).forEach(k => ((providers[k] && providers[k].proxies) || []).forEach(p => { idx[p.name] = p; }));
	Object.keys(proxies || {}).forEach(k => {
		if (proxies[k].all || !idx[k]) idx[k] = proxies[k];
	});
	return idx;
}

// 节点所属的订阅（Compatible 是 mihomo 为策略组生成的虚拟订阅，不算）
function providerMap(providers) {
	const m = {};
	Object.keys(providers || {}).forEach(k => {
		const p = providers[k];
		if (!p || p.vehicleType === 'Compatible') return;
		(p.proxies || []).forEach(x => { if (!m[x.name]) m[x.name] = k; });
	});
	return m;
}

// 单节点测速：订阅里的节点不在 /proxies 中，要经订阅的 healthcheck 接口
function delayPath(name, proxies, prov) {
	const enc = encodeURIComponent;
	if (prov && prov[name]) return '/providers/proxies/' + enc(prov[name]) + '/' + enc(name) + '/healthcheck';
	if (proxies && proxies[name]) return '/proxies/' + enc(name) + '/delay';
	return null;
}

// 按 GLOBAL.all（即配置文件中的顺序）排列策略组，去掉隐藏组，GLOBAL 放最后
function groupList(proxies) {
	proxies = proxies || {};
	const isGroup = n => n !== 'GLOBAL' && proxies[n] && proxies[n].all && !proxies[n].hidden;
	const g = proxies.GLOBAL;
	const order = (g && g.all) ? g.all.filter(isGroup) : [];
	const rest = Object.keys(proxies).filter(n => isGroup(n) && order.indexOf(n) < 0).sort((a, b) => a.localeCompare(b, 'zh'));
	const list = order.concat(rest);
	if (g && g.all && !g.hidden) list.push('GLOBAL');
	return list;
}

// 最近一次延迟：本页测速结果 > 该组测速地址下的历史 > 默认历史；没有记录返回 null，0 表示超时
function latestDelay(node, url, tested) {
	if (!node) return null;
	const t = tested && tested[url || ''];
	if (t && t[node.name] !== undefined) return t[node.name];
	const ex = url && node.extra && node.extra[url];
	const hist = (ex && ex.history && ex.history.length) ? ex.history : node.history;
	return (hist && hist.length) ? hist[hist.length - 1].delay : null;
}

function currentOf(group) {
	return group.type === 'Smart' ? (group.fixed || null) : (group.fixed || group.now || null);
}

// 配置里的 icon：http(s) 或 data:image/ 链接，与模块网页一致
function iconUrl(v) {
	return (typeof v === 'string' && (/^https?:\/\//.test(v) || /^data:image\//.test(v))) ? v : '';
}

// 已成功加载过的图标：节点列表每次刷新都重建，这些直接显示图片，不再先闪一下首字
const loadedIcons = new Set();

// 图标；没有或加载失败时显示名称首字
function iconBox(cls) {
	const box = E('span', { 'class': 'mh-icon ' + cls });
	box.set = (url, name) => {
		url = iconUrl(url);
		if (box.url === url && box.label === name) return;
		box.url = url;
		box.label = name;
		// 先显示首字，图片加载成功后再替换：图标地址很慢或失效时不会留一块空白
		const img = E('img', { alt: '', referrerpolicy: 'no-referrer' });
		if (url && loadedIcons.has(url)) {
			img.src = url;
			return box.replaceChildren(img);
		}
		box.replaceChildren(E('b', {}, Array.from(name || '?')[0]));
		if (!url) return;
		img.addEventListener('load', () => {
			loadedIcons.add(url);
			if (box.url === url) box.replaceChildren(img);
		});
		img.src = url;
	};
	return box;
}

function nodeView(group, idx, opts) {
	opts = opts || {};
	const url = group.testUrl || '';
	const cur = currentOf(group);
	let list = (group.all || []).map(name => {
		const n = idx[name] || { name: name };
		return {
			name: name,
			type: n.type || '',
			delay: latestDelay(Object.assign({}, n, { name: name }), url, opts.tested),
			alive: n.alive !== false,
			current: name === cur,
			group: !!n.all
		};
	});
	if (opts.hideDead) list = list.filter(n => n.alive || n.current);
	if (opts.q) {
		const q = String(opts.q).toLowerCase();
		list = list.filter(n => n.name.toLowerCase().indexOf(q) >= 0);
	}
	if (opts.sort === 'delay') {
		const key = n => (n.delay > 0 ? n.delay : Infinity);
		list = list.map((n, i) => [ n, i ]).sort((a, b) => (key(a[0]) - key(b[0])) || (a[1] - b[1])).map(x => x[0]);
	} else if (opts.sort === 'name') {
		list.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
	}
	return list;
}

// 从组的 now 出发追到最终节点；遇到 smart 组（按连接自动选择）或循环就停
function nowChain(group, idx) {
	const chain = [];
	let name = group.now;
	while (name && idx[name] && chain.indexOf(name) < 0) {
		chain.push(name);
		const p = idx[name];
		if (!p.all || p.type === 'Smart') break;
		name = p.now;
	}
	return chain;
}

function delayText(d) {
	if (d == null) return '-';
	return d > 0 ? d + ' ms' : '超时';
}

function loadPrefs() {
	let p = {};
	try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { p = {}; }
	return { sort: p.sort || 'default', hideDead: !!p.hideDead, expanded: p.expanded || {} };
}

return view.extend({
	typeLabel, buildIndex, providerMap, delayPath, groupList, latestDelay, nodeView, nowChain,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.resolve();
	},

	render() {
		mui.loadCss();
		this.prefs = loadPrefs();
		this.tested = {};
		this.cards = {};
		this.q = '';
		this.busy = {};

		const search = E('input', { type: 'search', 'class': 'cbi-input-text mh-search', placeholder: '筛选节点名称' });
		let qt = null;
		search.addEventListener('input', () => {
			clearTimeout(qt);
			qt = setTimeout(() => { this.q = search.value.trim(); this.renderGroups(); }, 150);
		});
		const dead = E('input', { type: 'checkbox', 'change': ev => { this.prefs.hideDead = ev.target.checked; this.savePrefs(); this.renderGroups(); } });
		dead.checked = this.prefs.hideDead;
		const sort = E('select', { 'class': 'cbi-input-select', 'change': ev => { this.prefs.sort = ev.target.value; this.savePrefs(); this.renderGroups(); } },
			SORTS.map(s => E('option', { value: s[0] }, s[1])));
		sort.value = this.prefs.sort;

		const toolbar = E('div', { 'class': 'mh-card mh-toolbar mh-px-toolbar' }, [
			search,
			E('label', { 'class': 'mh-switch' }, [ dead, '隐藏不可用' ]),
			sort,
			E('span', { 'class': 'mh-grow' }),
			mui.btn('全部展开', () => this.expandAll(true), 'mh-btn-sm'),
			mui.btn('全部收起', () => this.expandAll(false), 'mh-btn-sm'),
			mui.btn('刷新', () => this.reload(), 'mh-btn-sm')
		]);

		this.body = E('div', { 'class': 'mh-groups' }, mui.empty('读取中…'));
		const root = E('div', { 'class': 'mh' }, [ header.render(), toolbar, this.body ]);
		if (this.poller) this.poller.close();
		this.poller = api.poll(root, 15000, () => this.reload());
		return root;
	},

	savePrefs() {
		localStorage.setItem(PREF_KEY, JSON.stringify(this.prefs));
	},

	reload() {
		return Promise.all([ api.get('/proxies'), api.get('/providers/proxies') ]).then(([ p, pv ]) => {
			this.proxies = (p && p.proxies) || {};
			this.idx = buildIndex(this.proxies, pv && pv.providers);
			this.provOf = providerMap(pv && pv.providers);
			this.renderGroups();
		}, e => {
			this.cards = {};
			this.body.replaceChildren(mui.empty('无法读取代理信息：' + e.message));
		});
	},

	renderGroups() {
		if (!this.proxies) return;
		const names = groupList(this.proxies);
		if (!names.length) {
			this.cards = {};
			this.body.replaceChildren(mui.empty('配置中没有策略组'));
			return;
		}
		const cards = {};
		names.forEach(n => {
			cards[n] = this.cards[n] || this.makeCard(n);
			this.fillCard(cards[n], this.proxies[n]);
		});
		this.cards = cards;
		this.body.replaceChildren(...names.map(n => cards[n].el));
	},

	makeCard(name) {
		const c = {};
		c.icon = iconBox('mh-group-icon');
		c.type = E('span', { 'class': 'mh-tag' });
		c.fixed = E('span', { 'class': 'mh-tag warn' });
		c.chain = E('div', { 'class': 'mh-sub mh-ellipsis' });
		c.count = E('span', { 'class': 'mh-sub' });
		c.weights = mui.btn('权重', ev => { ev.stopPropagation(); this.showWeights(name); }, 'mh-btn-sm');
		c.unfix = mui.btn('取消固定', ev => { ev.stopPropagation(); this.unfix(name); }, 'mh-btn-sm');
		c.test = mui.btn('测速', ev => { ev.stopPropagation(); this.testGroup(name); }, 'mh-btn-sm');
		c.arrow = E('span', { 'class': 'mh-arrow' }, '▾');
		c.dots = E('div', { 'class': 'mh-dots' });
		c.nodes = E('div', { 'class': 'mh-nodes' });
		c.nodes.addEventListener('click', ev => this.onNodeClick(name, ev));
		c.head = E('div', { 'class': 'mh-group-head', 'click': () => this.toggle(name) }, [
			c.icon,
			E('div', { 'class': 'mh-group-title' }, [
				E('div', { 'class': 'mh-group-name' }, [ E('b', {}, name), c.type, c.fixed, c.count ]),
				c.chain
			]),
			E('div', { 'class': 'mh-tools' }, [ c.weights, c.unfix, c.test, c.arrow ])
		]);
		c.el = E('div', { 'class': 'mh-card mh-group' }, [ c.head, c.dots, c.nodes ]);
		return c;
	},

	fillCard(c, g) {
		const name = g.name;
		const expanded = !!this.prefs.expanded[name];
		const nodes = nodeView(g, this.idx, { sort: this.prefs.sort, hideDead: this.prefs.hideDead, q: this.q, tested: this.tested });
		const pickable = PICKABLE.indexOf(g.type) >= 0;

		c.icon.set(g.icon, name);
		c.type.textContent = typeLabel(g.type);
		c.fixed.hidden = !(g.fixed && g.type !== 'Selector');
		c.fixed.textContent = '已固定';
		c.unfix.hidden = c.fixed.hidden;
		c.weights.hidden = g.type !== 'Smart';
		c.count.textContent = (this.q || this.prefs.hideDead) ? nodes.length + ' / ' + (g.all || []).length : String((g.all || []).length);

		let chainText;
		if (g.type === 'Smart')
			chainText = g.fixed ? '固定为 ' + g.fixed : '按连接自动选择节点';
		else {
			const chain = nowChain(g, this.idx);
			const last = this.idx[chain[chain.length - 1]];
			chainText = chain.length ? '当前：' + chain.join(' → ') + (last && last.type === 'Smart' ? '（自动选择）' : '') : '当前：-';
		}
		c.chain.textContent = chainText;
		c.chain.title = chainText;

		c.el.classList.toggle('expanded', expanded);
		c.arrow.textContent = expanded ? '▴' : '▾';
		c.test.disabled = !!this.busy[name];
		c.test.textContent = this.busy[name] ? '测速中…' : '测速';

		if (!expanded) {
			c.nodes.replaceChildren();
			c.dots.replaceChildren(...nodes.map(n => E('i', { 'class': 'mh-dot ' + mui.delayClass(n.delay) + (n.current ? ' cur' : ''), title: n.name + ' · ' + delayText(n.delay) })));
			return;
		}
		c.dots.replaceChildren();
		if (!nodes.length) {
			c.nodes.replaceChildren(E('div', { 'class': 'mh-sub' }, '没有符合条件的节点'));
			return;
		}
		c.nodes.replaceChildren(...nodes.map(n => {
			// 子策略组与配了图标的节点带图标，与模块网页一致
			const p = this.proxies[n.name];
			let icon = null;
			if (n.group || iconUrl(p && p.icon)) {
				icon = iconBox('mh-node-icon');
				icon.set(p && p.icon, n.name);
			}
			return E('div', {
			'class': 'mh-node' + (n.current ? ' current' : '') + (n.alive ? '' : ' dead') + (pickable ? ' pickable' : ''),
			'data-name': n.name,
			title: n.name
		}, [
			E('div', { 'class': 'mh-node-name' }, icon ? [ icon, E('span', {}, n.name) ] : n.name),
			E('div', { 'class': 'mh-node-meta' }, [
				E('span', { 'class': 'mh-node-type' }, n.group ? typeLabel(n.type) : n.type),
				E('span', { 'class': 'mh-delay ' + mui.delayClass(n.delay), 'data-test': '1', title: '点击测速' }, delayText(n.delay))
			])
		]);
		}));
	},

	toggle(name) {
		this.prefs.expanded[name] = !this.prefs.expanded[name];
		if (!this.prefs.expanded[name]) delete this.prefs.expanded[name];
		this.savePrefs();
		this.fillCard(this.cards[name], this.proxies[name]);
	},

	expandAll(on) {
		this.prefs.expanded = {};
		if (on) groupList(this.proxies || {}).forEach(n => { this.prefs.expanded[n] = true; });
		this.savePrefs();
		this.renderGroups();
	},

	onNodeClick(group, ev) {
		const tile = ev.target.closest('.mh-node');
		if (!tile) return;
		const node = tile.getAttribute('data-name');
		if (ev.target.closest('[data-test]')) return this.testNode(group, node);
		const g = this.proxies[group];
		if (PICKABLE.indexOf(g.type) < 0 || node === currentOf(g)) return;
		api.put('/proxies/' + encodeURIComponent(group), { name: node }).then(() => {
			if (g.type === 'Selector') g.now = node; else g.fixed = node;
			this.renderGroups();
			setTimeout(() => this.reload(), 600);
		}, e => mui.notify('切换失败：' + e.message, 'error'));
	},

	unfix(group) {
		api.del('/proxies/' + encodeURIComponent(group)).then(() => {
			this.proxies[group].fixed = '';
			this.renderGroups();
			setTimeout(() => this.reload(), 600);
		}, e => mui.notify('取消固定失败：' + e.message, 'error'));
	},

	testUrl(g) {
		return g.testUrl || DEFAULT_URL;
	},

	testGroup(name) {
		const g = this.proxies[name];
		if (!g || this.busy[name]) return;
		this.busy[name] = true;
		this.fillCard(this.cards[name], g);
		const url = this.testUrl(g);
		const q = '?url=' + encodeURIComponent(url) + '&timeout=' + TIMEOUT;
		api.get('/group/' + encodeURIComponent(name) + '/delay' + q, { timeout: TIMEOUT * 3 + 5000 }).then(res => {
			const t = this.tested[g.testUrl || ''] = this.tested[g.testUrl || ''] || {};
			// 测速失败的节点不在结果中，记为超时
			(g.all || []).forEach(n => { t[n] = (res && res[n] > 0) ? res[n] : 0; });
		}, e => {
			// 全部超时时 mihomo 返回 504
			if (e.status === 504) {
				const t = this.tested[g.testUrl || ''] = this.tested[g.testUrl || ''] || {};
				(g.all || []).forEach(n => { t[n] = 0; });
				mui.notify(name + '：全部节点超时', 'warning');
			} else
				mui.notify(name + ' 测速失败：' + e.message, 'error');
		}).then(() => {
			delete this.busy[name];
			return this.reload();
		});
	},

	testNode(group, node) {
		const g = this.proxies[group];
		const url = this.testUrl(g);
		const t = this.tested[g.testUrl || ''] = this.tested[g.testUrl || ''] || {};
		const p = delayPath(node, this.proxies, this.provOf);
		if (!p) return;
		api.get(p + '?url=' + encodeURIComponent(url) + '&timeout=' + TIMEOUT, { timeout: TIMEOUT + 3000 })
			.then(r => { t[node] = (r && r.delay > 0) ? r.delay : 0; }, e => {
				// 超时为 504/408；其他错误不当作测速结果
				if (e.status === 504 || e.status === 408 || e.status === 503) t[node] = 0;
				else mui.notify(node + ' 测速失败：' + e.message, 'error');
			})
			.then(() => this.renderGroups());
	},

	showWeights(name) {
		const box = E('div', {}, mui.empty('读取中…'));
		ui.showModal(name + ' · Smart 权重', [
			box,
			E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '关闭'))
		]);
		api.get('/group/' + encodeURIComponent(name) + '/weights').then(d => {
			const list = (d && d.weights) || [];
			if (!list.length) return box.replaceChildren(mui.empty((d && (d.message || d.error)) ? '暂无权重数据，Smart 组需要一段时间学习' : '暂无权重数据'));
			const max = Math.max.apply(null, list.map(w => w.Weight || 0)) || 1;
			box.replaceChildren(E('div', { 'class': 'mh-scroll-x mh-weights' }, E('table', { 'class': 'mh-table' }, [
				E('thead', {}, E('tr', {}, [ E('th', {}, '节点'), E('th', {}, '使用频率'), E('th', {}, '权重') ])),
				E('tbody', {}, list.map(w => E('tr', {}, [
					E('td', {}, w.Name),
					E('td', {}, RANKS[w.Rank] || w.Rank || '-'),
					E('td', { 'class': 'mh-weight' }, [ mui.meter((w.Weight || 0) / max), E('span', {}, String(Math.round((w.Weight || 0) * 10) / 10)) ])
				])))
			])));
		}, e => box.replaceChildren(mui.empty('无法读取权重：' + e.message)));
	}
});
