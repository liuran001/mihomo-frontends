'use strict';

// 表单区段：读取（sections）与写入（patch 操作 → 低层编辑）。
// 读取时取两份 JSON：x 是展开锚点后的有效值；raw 是未展开时各映射的显式键，用来判断字段是否继承自 <<: *锚点。
// 写入时只为值有变化的字段生成编辑；带合并键的映射一律在条目这一层 merge，避免 yq 改到锚点（见 yaml.uc）。

import * as fs from 'fs';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import * as Y from 'mihomo.yaml';
import * as C from 'mihomo.check';

const NAMES = ['providers', 'proxies', 'groups', 'ebpf', 'rules', 'rule_providers', 'basic', 'dns', 'tailscale'];
const BUILTIN_POLICIES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'];
const DEFAULT_HC = { enable: true, url: 'https://cp.cloudflare.com', interval: 300, timeout: 5000 };
const MAX_RULES = 5000;

const KEYS = 'if tag == "!!map" then keys else [] end';
const MERGE = 'if tag == "!!map" then (.["<<"] | alias) else "" end';
const RAW_EXPR = '{' +
	'"top": [keys[] as $k | {"k": $k, "anchor": (.[$k] | anchor), "keys": (.[$k] | ' + KEYS + ')}], ' +
	'"pp": ((.["proxy-providers"] // {}) | map_values({"keys": (' + KEYS + '), "merge": (' + MERGE + ')})), ' +
	'"groups": [(.["proxy-groups"] // [])[] | {"keys": (' + KEYS + '), "merge": (' + MERGE + '), "anchor": anchor}], ' +
	'"listeners": [(.listeners // [])[] | {"keys": (' + KEYS + '), "local": (.local | ' + KEYS + '), "shared": (.shared | ' + KEYS + ')}], ' +
	'"rp": ((.["rule-providers"] // {}) | map_values(' + KEYS + ')), ' +
	'"proxies": [(.proxies // [])[] | {"keys": (' + KEYS + ')}]' +
	'}';

/* ---------- 通用 ---------- */

// 键顺序无关的比较
function canon(v) {
	if (type(v) == 'object') {
		let o = {};
		for (let k in sort(keys(v)))
			o[k] = canon(v[k]);
		return o;
	}
	if (type(v) == 'array')
		return map(v, canon);
	return v;
}

function same(a, b) {
	return sprintf('%J', canon(a)) == sprintf('%J', canon(b));
}

function clone(v) {
	return (v == null) ? null : json(sprintf('%J', v));
}

function has(list, k) {
	return type(list) == 'array' && index(list, k) >= 0;
}

function is_empty(v) {
	return v == null || v === '' || (type(v) == 'array' && !length(v)) || (type(v) == 'object' && !length(keys(v)));
}

function fail(msg) {
	return { error: msg };
}

function obj(v) {
	return (type(v) == 'object') ? v : {};
}

function arr(v) {
	return (type(v) == 'array') ? v : [];
}

function context(file) {
	let x = Y.query(file, 'explode(.)');
	if (type(x) != 'object')
		return null;
	let raw = Y.query(file, RAW_EXPR);
	if (type(raw) != 'object')
		return null;
	return { x: x, raw: raw };
}

function top_keys(ctx, k) {
	for (let t in arr(ctx.raw.top))
		if (t.k == k)
			return t.keys;
	return null;
}

// 写入一个映射下的若干字段：path 指向映射，vals 中值为 null 的表示删除。
// 映射本身带合并键时整体 merge；否则逐键 set。只为与当前值不同的字段生成编辑。
function map_edits(path, cur, keys_, vals) {
	cur = obj(cur);
	let edits = [], merged = {}, merging = has(keys_, '<<');
	for (let k, v in vals) {
		if (v == null) {
			if (cur[k] == null)
				continue;
			if (merging && !has(keys_, k))
				return fail('字段「' + k + '」继承自锚点，不能删除，只能修改');
			push(edits, { t: 'del', p: [...path, k] });
		} else if (!same(cur[k], v)) {
			if (merging)
				merged[k] = v;
			else
				push(edits, { t: 'set', p: [...path, k], v: v });
		}
	}
	if (length(keys(merged)))
		unshift(edits, { t: 'merge', p: path, v: merged });
	return { edits: edits };
}

// 解析配置里的相对路径（相对 /etc/mihomo）；不在 HOME 内时返回 null
function home_path(p) {
	if (type(p) != 'string' || p == '')
		return null;
	let full = (substr(p, 0, 1) == '/') ? p : P.HOME + '/' + p;
	let parts = [];
	for (let s in split(full, '/')) {
		if (s == '' || s == '.')
			continue;
		if (s == '..')
			return null;
		push(parts, s);
	}
	full = '/' + join('/', parts);
	return (substr(full, 0, length(P.HOME) + 1) == P.HOME + '/') ? full : null;
}

function policies(x) {
	let out = [...BUILTIN_POLICIES];
	for (let g in arr(x['proxy-groups']))
		if (type(g?.name) == 'string')
			push(out, g.name);
	for (let p in arr(x.proxies))
		if (type(p?.name) == 'string')
			push(out, p.name);
	return uniq(out);
}

/* ---------- 停用的订阅 ---------- */

function disabled_read() {
	let d = U.read_json(P.DISABLED);
	return (type(d?.providers) == 'object') ? d.providers : {};
}

function disabled_write(map_) {
	U.mkdir_p(P.STATE_DIR);
	return U.write_json(P.DISABLED, { providers: map_ });
}

function disabled_put(name, entry) {
	let d = disabled_read();
	d[name] = entry;
	return disabled_write(d);
}

function disabled_remove(name) {
	let d = disabled_read();
	if (!(name in d))
		return true;
	delete d[name];
	return disabled_write(d);
}

/* ---------- 策略组与 use 列表 ---------- */

// 锚点名 → 定义位置（顶层键或策略组）
function anchor_index(ctx) {
	let idx = {};
	for (let t in arr(ctx.raw.top))
		if (t.anchor && t.anchor != '')
			idx[t.anchor] = { path: [t.k], keys: t.keys, node: ctx.x[t.k], owner: { anchor: t.anchor } };
	let groups = arr(ctx.x['proxy-groups']);
	for (let i, g in arr(ctx.raw.groups))
		if (g.anchor && g.anchor != '')
			idx[g.anchor] = { path: ['proxy-groups', i], keys: g.keys, node: groups[i], owner: { anchor: g.anchor } };
	return idx;
}

// 每个策略组的 use 来自哪里：显式写在组里，或经合并键继承自某个锚点
function group_info(ctx) {
	let groups = arr(ctx.x['proxy-groups']), raws = arr(ctx.raw.groups), out = [];
	let anchors = anchor_index(ctx);
	for (let i, g in groups) {
		let r = raws[i] ?? { keys: [] };
		let from = null, list_path = null;
		if (has(r.keys, 'use')) {
			from = 'explicit';
			list_path = ['proxy-groups', i, 'use'];
		} else if (has(r.keys, '<<') && r.merge && anchors[r.merge] && has(anchors[r.merge].keys, 'use')) {
			from = 'anchor:' + r.merge;
			list_path = [...anchors[r.merge].path, 'use'];
		}
		push(out, {
			index: i, name: g?.name, type: g?.type, use: arr(g?.use),
			include_all_providers: obj(g)['include-all-providers'] === true,
			include_all: obj(g)['include-all'] === true,
			use_from: from, list_path: list_path, keys: r.keys
		});
	}
	return out;
}

// 去重后的显式 use 列表：{ path, names, owner, groups }
function use_lists(ctx) {
	let out = [], by = {};
	for (let g in group_info(ctx)) {
		if (!g.list_path)
			continue;
		let key = sprintf('%J', g.list_path);
		if (!by[key]) {
			let owner = (g.use_from == 'explicit') ? { group: g.name } : { anchor: substr(g.use_from, 7) };
			by[key] = { path: g.list_path, names: g.use, owner: owner, groups: [] };
			push(out, by[key]);
		}
		push(by[key].groups, g.name);
	}
	return out;
}

function all_providers(ctx) {
	return keys(obj(ctx.x['proxy-providers']));
}

function same_set(a, b) {
	return same(sort([...uniq(a)]), sort([...uniq(b)]));
}

// 去掉 use 列表中所有 name；同一列表按下标从大到小删除
function remove_from_lists(ctx, name) {
	let edits = [], refs = [];
	for (let l in use_lists(ctx)) {
		let hit = false;
		for (let i = length(l.names) - 1; i >= 0; i--)
			if (l.names[i] == name) {
				push(edits, { t: 'del', p: [...l.path, i] });
				hit = true;
			}
		if (hit)
			push(refs, l.owner);
	}
	return { edits: edits, refs: refs };
}

function find_list(ctx, owner) {
	for (let l in use_lists(ctx))
		if ((owner.group != null && l.owner.group == owner.group) || (owner.anchor != null && l.owner.anchor == owner.anchor))
			return l;
	return null;
}

/* ---------- 区段：providers / groups ---------- */

function ua_of(h) {
	let v = obj(h)['User-Agent'];
	return (type(v) == 'array') ? ('' + (v[0] ?? '')) : ((v != null) ? '' + v : '');
}

const PROVIDER_FIELDS = [['url', 'url'], ['interval', 'interval'], ['path', 'path'], ['prefix', 'override'],
	['user_agent', 'header'], ['health_check', 'health-check']];

function provider_view(name, e, raw, users, enabled) {
	e = obj(e);
	let hc = obj(e['health-check']);
	let v = {
		name: name, enabled: enabled, type: e.type ?? '',
		url: e.url ?? '', interval: e.interval, path: e.path ?? '',
		prefix: obj(e.override)['additional-prefix'] ?? '',
		user_agent: ua_of(e.header),
		health_check: { enable: hc.enable === true, url: hc.url ?? '', interval: hc.interval, timeout: hc.timeout },
		inherited: [], anchor: null, groups: users
	};
	if (raw && has(raw.keys, '<<')) {
		v.anchor = (raw.merge && raw.merge != 'null') ? raw.merge : null;
		for (let f in PROVIDER_FIELDS)
			if (e[f[1]] != null && !has(raw.keys, f[1]))
				push(v.inherited, f[0]);
	}
	return v;
}

function provider_defaults(ctx) {
	// 新订阅的默认值：取自现有订阅引用的锚点（例如 p），没有时用内置默认值
	let anchors = anchor_index(ctx);
	for (let n, r in obj(ctx.raw.pp)) {
		let a = (r.merge && r.merge != 'null') ? anchors[r.merge] : null;
		if (a && type(a.node) == 'object') {
			let hc = obj(a.node['health-check']);
			return {
				anchor: r.merge,
				interval: a.node.interval ?? 3600,
				health_check: {
					enable: hc.enable ?? DEFAULT_HC.enable, url: hc.url ?? DEFAULT_HC.url,
					interval: hc.interval ?? DEFAULT_HC.interval, timeout: hc.timeout ?? DEFAULT_HC.timeout
				}
			};
		}
	}
	return { anchor: null, interval: 3600, health_check: { ...DEFAULT_HC } };
}

function migratable(ctx) {
	let all = all_providers(ctx), out = [];
	if (!length(all))
		return out;
	for (let l in use_lists(ctx))
		if (same_set(l.names, all))
			for (let g in l.groups)
				push(out, g);
	return out;
}

function sec_providers(ctx) {
	let pp = ctx.x['proxy-providers'];
	if (pp != null && type(pp) != 'object')
		return { unsupported: true, reason: 'proxy-providers 不是映射' };
	pp = obj(pp);
	let groups = group_info(ctx);
	let users = (name) => map(filter(groups, (g) => g.include_all_providers || g.include_all || has(g.use, name)), (g) => g.name);
	let list = [], other = [];
	for (let name, e in pp) {
		if (obj(e).type == 'http')
			push(list, provider_view(name, e, obj(ctx.raw.pp)[name], users(name), true));
		else
			push(other, { name: name, type: obj(e).type ?? '' });
	}
	for (let name, d in disabled_read())
		if (!(name in pp))
			push(list, provider_view(name, d.def, null, [], false));
	let dft = provider_defaults(ctx);
	return { list: list, other: other, anchor: dft.anchor, defaults: { interval: dft.interval, health_check: dft.health_check },
		migratable: migratable(ctx) };
}

function sec_groups(ctx) {
	return map(group_info(ctx), (g) => ({
		name: g.name, type: g.type, use: g.use, include_all_providers: g.include_all_providers,
		include_all: g.include_all, use_from: g.use_from
	}));
}

/* ---------- 区段：ebpf ---------- */

const EBPF_TOP = ['network', 'udp-timeout', 'bypass-rule-set', 'tc-priority', 'fakeip-icmp', 'bypass-tun-direct'];
const EBPF_ROLE = {
	local: ['data-plane', 'dns-mode', 'ipv6', 'bypass-private-address', 'bypass-exclude', 'bypass-port'],
	shared: ['interface', 'data-plane', 'dns-mode', 'ipv6', 'bypass-private-address', 'allow-default-upstream',
		'bypass-exclude', 'bypass-port', 'include-mac-address', 'exclude-mac-address', 'include-source-cidr', 'exclude-source-cidr']
};
const LEGACY_TOP = ['dns-mode', 'bypass-private-address', 'tcp-splice'];

function ebpf_index(x) {
	for (let i, l in arr(x.listeners))
		if (obj(l).type == 'ebpf')
			return i;
	return -1;
}

function ipcidr_sets(x) {
	let out = [];
	for (let n, r in obj(x['rule-providers']))
		if (obj(r).behavior == 'ipcidr')
			push(out, n);
	return out;
}

function role_on(r) {
	r = obj(r);
	let v = r.enable ?? r.enabled;
	return (v == null) ? null : (v === true);
}

// 读取角色开关与写法：mode（local/shared/hybrid）或 local.enable/shared.enable
function ebpf_roles(l) {
	if (l.mode != null)
		return { style: 'mode', local: l.mode == 'local' || l.mode == 'hybrid', shared: l.mode == 'shared' || l.mode == 'hybrid' };
	let a = role_on(l.local), b = role_on(l.shared);
	if (a != null || b != null)
		return { style: 'enable', local: a === true, shared: b === true };
	return { style: 'mode', local: true, shared: false };
}

// 旧写法展开到各角色：顶层 dns-mode、bypass-private-address 作为角色的缺省值，ipv6-mode 换成 ipv6
function ebpf_normalize(l) {
	let n = clone(l);
	for (let r in ['local', 'shared']) {
		let role = obj(n[r]);
		for (let k in ['dns-mode', 'bypass-private-address'])
			if (role[k] == null && l[k] != null)
				role[k] = l[k];
		if (role['ipv6-mode'] != null) {
			if (role.ipv6 == null)
				role.ipv6 = role['ipv6-mode'] != 'off';
			delete role['ipv6-mode'];
		}
		if (n[r] != null || length(keys(role)))
			n[r] = role;
	}
	for (let k in LEGACY_TOP)
		delete n[k];
	return n;
}

function legacy_keys(l) {
	let out = filter(LEGACY_TOP, (k) => l[k] != null);
	for (let r in ['local', 'shared'])
		if (obj(l[r])['ipv6-mode'] != null)
			push(out, r + '.ipv6-mode');
	return out;
}

function sec_ebpf(ctx) {
	let x = ctx.x, i = ebpf_index(x);
	if (x.listeners != null && type(x.listeners) != 'array')
		return { unsupported: true, reason: 'listeners 不是列表' };
	if (i < 0)
		return { missing: true, ipcidr_sets: ipcidr_sets(x), rule_sets: keys(obj(x['rule-providers'])) };
	let l = x.listeners[i];
	if (l.local != null && type(l.local) != 'object' || l.shared != null && type(l.shared) != 'object')
		return { unsupported: true, reason: 'eBPF 入站的 local/shared 不是映射' };
	let roles = ebpf_roles(l), n = ebpf_normalize(l);
	let data = { local_enable: roles.local, shared_enable: roles.shared, local: {}, shared: {} };
	for (let k in EBPF_TOP)
		data[k] = n[k];
	for (let r, ks in EBPF_ROLE)
		for (let k in ks)
			data[r][k] = obj(n[r])[k];
	return { index: i, name: l.name, style: roles.style, legacy: legacy_keys(l), data: data,
		ipcidr_sets: ipcidr_sets(x), rule_sets: keys(obj(x['rule-providers'])) };
}

/* ---------- 区段：rules / rule_providers ---------- */

function sec_rules(ctx) {
	let r = ctx.x.rules;
	if (r != null && type(r) != 'array')
		return { unsupported: true, reason: 'rules 不是列表' };
	for (let s in arr(r))
		if (type(s) != 'string')
			return { unsupported: true, reason: 'rules 中有非字符串条目' };
	return { list: arr(r), policies: policies(ctx.x), rule_sets: keys(obj(ctx.x['rule-providers'])) };
}

function squash(s) {
	return replace('' + s, / /g, '');
}

// 规则字符串（含 AND/OR/NOT 内部）是否引用了规则集 name
function rule_uses(rule, name) {
	let s = squash(rule), needle = 'RULE-SET,' + name;
	let i = index(s, needle);
	while (i >= 0) {
		let before = (i == 0) ? '' : substr(s, i - 1, 1);
		let after = substr(s, i + length(needle), 1);
		if ((before == '' || before == '(' || before == ',') && (after == '' || after == ',' || after == ')'))
			return true;
		let rest = index(substr(s, i + 1), needle);
		i = (rest < 0) ? -1 : i + 1 + rest;
	}
	return false;
}

function set_names(v) {
	let s = squash(v);
	return (substr(s, 0, 9) == 'rule-set:') ? split(substr(s, 9), ',') : [];
}

// 规则集被引用的位置（中文说明）
function rule_set_refs(x, name) {
	let refs = [];
	for (let i, r in arr(x.rules))
		if (type(r) == 'string' && rule_uses(r, name))
			push(refs, '规则第 ' + (i + 1) + ' 条');
	for (let sub, list in obj(x['sub-rules']))
		for (let i, r in arr(list))
			if (type(r) == 'string' && rule_uses(r, name))
				push(refs, '子规则 ' + sub + ' 第 ' + (i + 1) + ' 条');
	for (let l in arr(x.listeners)) {
		let lname = obj(l).name ?? 'ebpf';
		if (has(obj(l)['bypass-rule-set'], name))
			push(refs, '入站 ' + lname + ' 的 bypass-rule-set');
		for (let r in ['local', 'shared'])
			if (has(obj(obj(l)[r])['bypass-rule-set'], name))
				push(refs, '入站 ' + lname + ' 的 ' + r + '.bypass-rule-set');
	}
	let dns = obj(x.dns);
	for (let k in keys(obj(dns['nameserver-policy'])))
		if (has(set_names(k), name))
			push(refs, 'DNS 策略 ' + k);
	for (let f in arr(dns['fake-ip-filter']))
		if (has(set_names(f), name))
			push(refs, 'DNS fake-ip-filter');
	for (let k in ['route-address-set', 'route-exclude-address-set'])
		if (has(obj(x.tun)[k], name))
			push(refs, 'tun.' + k);
	return refs;
}

function sec_rule_providers(ctx) {
	let rp = ctx.x['rule-providers'];
	if (rp != null && type(rp) != 'object')
		return { unsupported: true, reason: 'rule-providers 不是映射' };
	let list = [];
	for (let name, e in obj(rp)) {
		e = obj(e);
		push(list, {
			name: name, type: e.type ?? '', behavior: e.behavior ?? '', format: e.format ?? '',
			url: e.url ?? '', path: e.path ?? '', interval: e.interval, proxy: e.proxy ?? '',
			size: (type(e.payload) == 'array') ? length(e.payload) : null,
			refs: rule_set_refs(ctx.x, name)
		});
	}
	return { list: list, policies: policies(ctx.x) };
}

/* ---------- 区段：basic / dns / tailscale ---------- */

// [字段名, 路径, 校验]
const BASIC_FIELDS = [
	['mixed-port', ['mixed-port'], (v) => C.port0(v)],
	['allow-lan', ['allow-lan'], (v) => C.bool(v)],
	['bind-address', ['bind-address'], (v) => (v === '*') ? '*' : C.ip(v)],
	['ipv6', ['ipv6'], (v) => C.bool(v)],
	['mode', ['mode'], (v) => C.oneof(v, Y.MODES)],
	['log-level', ['log-level'], (v) => C.oneof(v, ['silent', 'error', 'warning', 'info', 'debug'])],
	['tcp-concurrent', ['tcp-concurrent'], (v) => C.bool(v)],
	['unified-delay', ['unified-delay'], (v) => C.bool(v)],
	['find-process-mode', ['find-process-mode'], (v) => C.oneof(v, ['always', 'strict', 'off'])],
	['external-controller', ['external-controller'], (v) => C.listen(v)],
	['secret', ['secret'], (v) => (C.text(v, 128) != null && index(v, ' ') < 0) ? C.text(v, 128) : null],
	['external-ui', ['external-ui'], (v) => (C.text(v, 256) != null && index(v, '..') < 0) ? C.text(v, 256) : null],
	['external-ui-url', ['external-ui-url'], (v) => C.url(v)],
	['sniffer.enable', ['sniffer', 'enable'], (v) => C.bool(v)],
	['geox-url.geoip', ['geox-url', 'geoip'], (v) => C.url(v)],
	['geox-url.geosite', ['geox-url', 'geosite'], (v) => C.url(v)],
	['geox-url.mmdb', ['geox-url', 'mmdb'], (v) => C.url(v)],
	['profile.store-selected', ['profile', 'store-selected'], (v) => C.bool(v)]
];
const REQUIRED_BASIC = ['external-controller'];

function getp(x, path) {
	let v = x;
	for (let k in path) {
		if (type(v) != 'object')
			return null;
		v = v[k];
	}
	return v;
}

function sec_basic(ctx) {
	let out = {};
	for (let f in BASIC_FIELDS)
		out[f[0]] = getp(ctx.x, f[1]);
	return out;
}

const DNS_LISTS = ['default-nameserver', 'nameserver', 'proxy-server-nameserver', 'direct-nameserver', 'fake-ip-filter'];

function policy_list(p) {
	let out = [];
	for (let k, v in obj(p))
		push(out, { key: k, servers: (type(v) == 'array') ? map(v, (s) => '' + s) : ['' + v] });
	return out;
}

function sec_dns(ctx) {
	let d = ctx.x.dns;
	if (d != null && type(d) != 'object')
		return { unsupported: true, reason: 'dns 不是映射' };
	d = obj(d);
	let out = {};
	for (let k in ['enable', 'listen', 'enhanced-mode', 'ipv6', 'fake-ip-range', 'fake-ip-range6'])
		out[k] = d[k];
	for (let k in DNS_LISTS)
		out[k] = (type(d[k]) == 'array') ? d[k] : null;
	out['nameserver-policy'] = policy_list(d['nameserver-policy']);
	return out;
}

const TS_FIELDS = ['hostname', 'auth-key', 'udp', 'accept-routes', 'advertise-routes', 'advertise-exit-node', 'listen-port', 'serve'];

function ts_index(x, name) {
	for (let i, p in arr(x.proxies))
		if (obj(p).type == 'tailscale' && p.name == name)
			return i;
	return -1;
}

function sec_tailscale(ctx) {
	let out = [];
	for (let p in arr(ctx.x.proxies)) {
		if (obj(p).type != 'tailscale')
			continue;
		let v = { name: p.name };
		for (let k in TS_FIELDS)
			v[k] = p[k];
		push(out, v);
	}
	return out;
}

/* ---------- 区段：proxies（单个节点） ---------- */

// 表单支持的类型（与 shared/proxylink.js 的 PROTOCOLS 一致）；其他类型只列出、可删除
const NODE_TYPES = ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'socks5', 'http', 'wireguard'];
const MAX_NODES = 256;

// 节点名称：可含空格、emoji 与 /，但不能含英文逗号（会破坏规则）与控制字符
function node_name(v) {
	if (type(v) != 'string' || v == '' || v != trim(v) || length(v) > 128 || index(v, ',') >= 0)
		return null;
	return (C.text(v, 128) == v) ? v : null;
}

// 节点不能编辑的原因；null 表示可以
function node_lock(p, raw) {
	p = obj(p);
	if (p.type == 'tailscale')
		return 'Tailscale 出站请在 Tailscale 页管理';
	if (p.type == 'dns')
		return '内置的 DNS 出站，用于接管 53 端口';
	if (has(obj(raw).keys, '<<'))
		return '使用了锚点合并（<<），请在配置文件页编辑';
	if (!has(NODE_TYPES, p.type))
		return '表单暂不支持 ' + (p.type ?? '?') + ' 类型，请在配置文件页编辑';
	return null;
}

// 策略组与节点成员：auto 为 include-all / include-all-proxies 自动包含全部节点；
// editable 为能否直接改它的 proxies 列表（经锚点合并继承的不能）
function node_groups(ctx) {
	let raws = arr(ctx.raw.groups), out = [];
	for (let i, g in arr(ctx.x['proxy-groups'])) {
		g = obj(g);
		let keys_ = obj(raws[i]).keys ?? [];
		push(out, {
			index: i, name: g.name, type: g.type,
			auto: g['include-all'] === true || g['include-all-proxies'] === true,
			editable: has(keys_, 'proxies') || !has(keys_, '<<'),
			explicit: has(keys_, 'proxies'),
			members: arr(g.proxies),
			others: length(arr(g.use)) > 0 || g['include-all'] === true || g['include-all-proxies'] === true || g['include-all-providers'] === true
		});
	}
	return out;
}

function sec_proxies(ctx) {
	let px = ctx.x.proxies;
	if (px != null && type(px) != 'array')
		return { unsupported: true, reason: 'proxies 不是列表' };
	let groups = node_groups(ctx), raws = arr(ctx.raw.proxies), list = [];
	for (let i, p in arr(px)) {
		p = obj(p);
		let lock = node_lock(p, raws[i]);
		let v = { name: p.name, type: p.type ?? '', server: p.server ?? '', port: p.port, lock: lock,
			groups: map(filter(groups, (g) => has(g.members, p.name)), (g) => g.name) };
		if (!lock)
			v.data = p;
		push(list, v);
	}
	return {
		list: list, types: NODE_TYPES, policies: policies(ctx.x),
		groups: map(groups, (g) => ({ name: g.name, type: g.type, auto: g.auto, editable: g.editable }))
	};
}

const SECTIONS = {
	providers: sec_providers, proxies: sec_proxies, groups: sec_groups, ebpf: sec_ebpf, rules: sec_rules,
	rule_providers: sec_rule_providers, basic: sec_basic, dns: sec_dns, tailscale: sec_tailscale
};

function sections(names) {
	if (type(names) != 'array' || !length(names))
		names = NAMES;
	for (let n in names)
		if (!SECTIONS[n])
			return { ok: false, error: '未知的区段：' + n };
	let rev = U.file_rev(P.CONFIG);
	let ctx = context(P.CONFIG);
	if (!ctx)
		return { ok: true, rev: rev, parse_error: '配置文件有语法错误，或缺少 yq，请在配置文件页修复' };
	let out = { ok: true, rev: rev };
	for (let n in names)
		out[n] = SECTIONS[n](ctx);
	return out;
}

/* ---------- patch 操作 ---------- */

// 逐个字段校验：spec 为 { 字段: 校验函数 }；data 中缺省的字段不处理，null 或空串表示删除
function pick_fields(data, spec, label) {
	let out = {};
	for (let k, fn in spec) {
		if (!(k in data))
			continue;
		let v = data[k];
		if (v == null || v === '') {
			out[k] = null;
			continue;
		}
		let c = fn(v);
		if (c == null)
			return fail((label ?? '') + '「' + k + '」的值无效');
		out[k] = c;
	}
	return { vals: out };
}

const HC_SPEC = {
	enable: (v) => C.bool(v), url: (v) => C.url(v),
	interval: (v) => C.int(v, 0, 86400), timeout: (v) => C.int(v, 1, 60000)
};

const PROVIDER_SPEC = {
	url: (v) => C.url(v), interval: (v) => C.int(v, 0, 31536000),
	prefix: (v) => C.text(v, 64), user_agent: (v) => C.text(v, 256)
};

// 由表单数据得到订阅条目新的顶层字段（null 表示删除）；e 为当前有效值
function provider_fields(e, data) {
	data = obj(data);
	let r = pick_fields(data, PROVIDER_SPEC, '订阅');
	if (r.error)
		return r;
	let v = r.vals, out = {};
	if ('url' in v) {
		if (v.url == null)
			return fail('订阅链接不能为空');
		out.url = v.url;
	}
	if ('interval' in v)
		out.interval = v.interval;
	if ('prefix' in v) {
		let o = clone(obj(e.override));
		if (v.prefix == null)
			delete o['additional-prefix'];
		else
			o['additional-prefix'] = v.prefix;
		out.override = length(keys(o)) ? o : null;
	}
	if ('user_agent' in v) {
		let h = clone(obj(e.header));
		if (v.user_agent == null)
			delete h['User-Agent'];
		else
			h['User-Agent'] = [v.user_agent];
		out.header = length(keys(h)) ? h : null;
	}
	if (type(data.health_check) == 'object') {
		let hr = pick_fields(data.health_check, HC_SPEC, '健康检查');
		if (hr.error)
			return hr;
		let hc = clone(obj(e['health-check']));
		for (let k, val in hr.vals) {
			if (val == null)
				delete hc[k];
			else
				hc[k] = val;
		}
		if (hc.enable && !hc.url)
			return fail('开启健康检查时需要填写测速地址');
		out['health-check'] = length(keys(hc)) ? hc : null;
	}
	return { fields: out };
}

function op_provider_set(op, ctx) {
	let pp = obj(ctx.x['proxy-providers']), e = pp[op.name];
	if (type(op.name) != 'string' || type(e) != 'object')
		return fail('订阅不存在：' + (op.name ?? ''));
	if (e.type != 'http')
		return fail('只能编辑 http 类型的订阅');
	let r = provider_fields(e, op.data);
	if (r.error)
		return r;
	return map_edits(['proxy-providers', op.name], e, obj(obj(ctx.raw.pp)[op.name]).keys ?? [], r.fields);
}

function op_provider_add(op, ctx) {
	let name = C.name(op.name);
	if (name == null)
		return fail('订阅名称无效：不能为空，不能包含 / , \\，不能以 . 开头，最长 64 个字符');
	let pp = ctx.x['proxy-providers'];
	if (pp != null && type(pp) != 'object')
		return fail('proxy-providers 不是映射，请在配置文件页编辑');
	if (name in obj(pp) || name in disabled_read())
		return fail('已有同名订阅：' + name);
	let data = obj(op.data);
	if (C.url(data.url) == null)
		return fail('订阅链接无效（需要 http:// 或 https:// 开头）');
	let dft = provider_defaults(ctx);
	let base = { type: 'http', url: '', path: './proxy_provider/' + name + '.yaml', interval: dft.interval,
		'health-check': dft.health_check };
	let r = provider_fields(base, data);
	if (r.error)
		return r;
	let def = { ...base };
	for (let k, v in r.fields) {
		if (v == null)
			delete def[k];
		else
			def[k] = v;
	}
	let edits = [{ t: 'set', p: ['proxy-providers', name], v: def }];
	if (data.join_groups !== false) {
		let all = all_providers(ctx);
		for (let l in use_lists(ctx))
			if (length(all) && same_set(l.names, all))
				push(edits, { t: 'append', p: l.path, v: name });
	}
	return { edits: edits };
}

function cache_unlink(e) {
	let p = (obj(e).type == 'http') ? home_path(obj(e).path) : null;
	return p ? [{ t: 'unlink', path: p }] : [];
}

function op_provider_delete(op, ctx) {
	let pp = obj(ctx.x['proxy-providers']);
	if (type(op.name) != 'string')
		return fail('订阅名称无效');
	if (op.name in pp) {
		let rm = remove_from_lists(ctx, op.name);
		return { edits: [{ t: 'del', p: ['proxy-providers', op.name] }, ...rm.edits], post: cache_unlink(pp[op.name]) };
	}
	let d = disabled_read()[op.name];
	if (!d)
		return fail('订阅不存在：' + op.name);
	return { edits: [], post: [{ t: 'disabled_remove', name: op.name }, ...cache_unlink(d.def)] };
}

function op_provider_toggle(op, ctx) {
	let pp = obj(ctx.x['proxy-providers']), name = op.name;
	if (type(name) != 'string')
		return fail('订阅名称无效');
	if (op.enabled === false) {
		if (!(name in pp))
			return fail('订阅不存在或已停用：' + name);
		let rm = remove_from_lists(ctx, name);
		// 先写入停用列表再进入应用流程：应用失败时配置里仍有这个订阅，读取时以配置为准
		let entry = { def: pp[name], refs: rm.refs, time: time() };
		return { edits: [{ t: 'del', p: ['proxy-providers', name] }, ...rm.edits], pre: [{ t: 'disabled_put', name: name, entry: entry }] };
	}
	if (op.enabled !== true)
		return fail('enabled 只能是 true 或 false');
	if (name in pp)
		return fail('订阅已经启用：' + name);
	let d = disabled_read()[name];
	if (!d || type(d.def) != 'object')
		return fail('停用列表中没有这个订阅：' + name);
	let edits = [{ t: 'set', p: ['proxy-providers', name], v: d.def }];
	for (let owner in arr(d.refs)) {
		let l = find_list(ctx, obj(owner));
		if (l && !has(l.names, name))
			push(edits, { t: 'append', p: l.path, v: name });
	}
	return { edits: edits, post: [{ t: 'disabled_remove', name: name }] };
}

// 把与「全部订阅」等价的 use 列表换成 include-all-providers: true（规格 6.2）
function op_groups_include_all(op, ctx) {
	let all = all_providers(ctx), edits = [];
	let anchors = anchor_index(ctx);
	for (let l in use_lists(ctx)) {
		if (!length(all) || !same_set(l.names, all))
			continue;
		let owner_path = slice(l.path, 0, length(l.path) - 1);
		let owner_keys = null;
		if (l.owner.anchor != null)
			owner_keys = anchors[l.owner.anchor]?.keys;
		else
			owner_keys = arr(ctx.raw.groups)[owner_path[1]]?.keys;
		push(edits, { t: 'del', p: l.path });
		if (has(owner_keys, '<<'))
			push(edits, { t: 'merge', p: owner_path, v: { 'include-all-providers': true } });
		else
			push(edits, { t: 'set', p: [...owner_path, 'include-all-providers'], v: true });
	}
	if (!length(edits))
		return fail('没有可以迁移的策略组');
	return { edits: edits };
}

function op_mode_set(op, ctx) {
	if (C.oneof(op.mode, Y.MODES) == null)
		return fail('模式只能是 rule、global 或 direct');
	return { edits: same(ctx.x.mode, op.mode) ? [] : [{ t: 'set', p: ['mode'], v: op.mode }] };
}

/* eBPF */

const EBPF_TOP_SPEC = {
	network: (v) => {
		let l = C.list(v, (s) => C.oneof(s, ['tcp', 'udp']), 2);
		return (l && length(l)) ? l : null;
	},
	'udp-timeout': (v) => C.int(v, 5, 86400),
	'tc-priority': (v) => C.int(v, 0, 65535),
	'fakeip-icmp': (v) => C.oneof(v, ['off', 'reply']),
	'bypass-tun-direct': (v) => C.bool(v)
};
const DNS_MODES = ['hijack', 'respect_policy', 'respect_bypass', 'off'];
const cidrs = (v) => C.list(v, C.cidr, 256);
const ROLE_SPEC = {
	local: {
		'data-plane': (v) => C.oneof(v, ['cgroup', 'tc']), 'dns-mode': (v) => C.oneof(v, DNS_MODES),
		ipv6: (v) => C.bool(v), 'bypass-private-address': (v) => C.bool(v),
		'bypass-exclude': cidrs, 'bypass-port': (v) => C.list(v, C.port, 256)
	},
	shared: {
		interface: (v) => C.list(v, C.ifname, 16),
		'data-plane': (v) => C.oneof(v, ['packet_rewrite', 'socket_assign']), 'dns-mode': (v) => C.oneof(v, DNS_MODES),
		ipv6: (v) => C.bool(v), 'bypass-private-address': (v) => C.bool(v), 'allow-default-upstream': (v) => C.bool(v),
		'bypass-exclude': cidrs, 'bypass-port': (v) => C.list(v, C.port, 256),
		'include-mac-address': (v) => C.list(v, C.mac, 256), 'exclude-mac-address': (v) => C.list(v, C.mac, 256),
		'include-source-cidr': cidrs, 'exclude-source-cidr': cidrs
	}
};

// 把校验后的值写进 target；空列表视为删除（使用默认值）
function put_vals(target, vals) {
	for (let k, v in vals) {
		if (v == null || (type(v) == 'array' && !length(v)))
			delete target[k];
		else
			target[k] = v;
	}
}

function op_ebpf_set(op, ctx) {
	let x = ctx.x, i = ebpf_index(x);
	if (i < 0)
		return fail('没有 eBPF 入站，请先创建');
	let data = obj(op.data), l = x.listeners[i];
	let roles = ebpf_roles(l);
	let want = ebpf_normalize(l);
	let lo = ('local_enable' in data) ? C.bool(data.local_enable) : roles.local;
	let sh = ('shared_enable' in data) ? C.bool(data.shared_enable) : roles.shared;
	if (lo == null || sh == null)
		return fail('角色开关的值无效');
	if (!lo && !sh)
		return fail('「本机流量」与「下联设备」至少开启一个');

	let top = pick_fields(data, EBPF_TOP_SPEC, 'eBPF ');
	if (top.error)
		return top;
	put_vals(want, top.vals);
	if ('bypass-rule-set' in data) {
		let sets = keys(obj(x['rule-providers']));
		let l2 = C.list(data['bypass-rule-set'] ?? [], (s) => has(sets, s) ? s : null, 64);
		if (l2 == null)
			return fail('bypass-rule-set 中有不存在的规则集');
		put_vals(want, { 'bypass-rule-set': l2 });
	}
	for (let r, spec in ROLE_SPEC) {
		if (type(data[r]) != 'object')
			continue;
		let rv = pick_fields(data[r], spec, r + '.');
		if (rv.error)
			return rv;
		want[r] = obj(want[r]);
		put_vals(want[r], rv.vals);
	}

	for (let r in ['local', 'shared']) {
		want[r] = obj(want[r]);
		delete want[r].enabled;
	}
	if (roles.style == 'enable') {
		delete want.mode;
		want.local.enable = lo;
		want.shared.enable = sh;
	} else {
		want.mode = (lo && sh) ? 'hybrid' : (lo ? 'local' : 'shared');
		delete want.local.enable;
		delete want.shared.enable;
	}
	if (sh && !length(arr(want.shared.interface)))
		return fail('开启「下联设备」时至少选择一个网卡');
	for (let r in ['local', 'shared'])
		if (!length(keys(want[r])) && l[r] == null)
			delete want[r];

	let rl = arr(ctx.raw.listeners)[i] ?? {};
	let path = ['listeners', i];
	if (has(rl.keys, '<<') || has(rl.local, '<<') || has(rl.shared, '<<')) {
		let vals = {};
		for (let k in uniq([...keys(l), ...keys(want)]))
			vals[k] = want[k];
		return map_edits(path, l, rl.keys, vals);
	}
	let edits = [];
	for (let k in uniq([...keys(l), ...keys(want)])) {
		if (k == 'local' || k == 'shared')
			continue;
		if (want[k] == null)
			push(edits, { t: 'del', p: [...path, k] });
		else if (!same(l[k], want[k]))
			push(edits, { t: 'set', p: [...path, k], v: want[k] });
	}
	for (let r in ['local', 'shared']) {
		if (want[r] == null)
			continue;
		if (type(l[r]) != 'object') {
			push(edits, { t: 'set', p: [...path, r], v: want[r] });
			continue;
		}
		let vals = {};
		for (let k in uniq([...keys(l[r]), ...keys(want[r])]))
			vals[k] = want[r][k];
		let me = map_edits([...path, r], l[r], rl[r], vals);
		if (me.error)
			return me;
		push(edits, ...me.edits);
	}
	return { edits: edits };
}

function op_ebpf_create(op, ctx) {
	let x = ctx.x;
	if (x.listeners != null && type(x.listeners) != 'array')
		return fail('listeners 不是列表，请在配置文件页编辑');
	if (ebpf_index(x) >= 0)
		return fail('已经有 eBPF 入站');
	// 下联接口：默认 br-lan，向导传入所选接口
	let ifs = ['br-lan'];
	if (op.interface != null) {
		ifs = C.list(op.interface, C.ifname, 8);
		if (!ifs || !length(ifs))
			return fail('下联接口无效');
	}
	let names = map(arr(x.listeners), (l) => obj(l).name);
	let name = 'ebpf-in';
	for (let n = 2; has(names, name); n++)
		name = 'ebpf-in-' + n;
	// Tailnet 地址落在私网放行范围（100.64.0.0/10）内：配置里有 Tailscale 代理时才强制它们进核心
	let tailnet = length(filter(arr(x.proxies), (p) => obj(p).type == 'tailscale')) > 0;
	let role = (extra) => {
		let r = { ...extra, 'dns-mode': 'hijack', ipv6: true, 'bypass-private-address': true };
		if (tailnet)
			r['bypass-exclude'] = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];
		return r;
	};
	let l = { name: name, type: 'ebpf', mode: 'hybrid', network: ['tcp', 'udp'], 'udp-timeout': 300 };
	if (has(ipcidr_sets(x), 'CN-IP'))
		l['bypass-rule-set'] = ['CN-IP'];
	l.local = role({ 'data-plane': 'cgroup' });
	l.shared = role({ interface: ifs, 'data-plane': 'packet_rewrite' });
	return { edits: [(type(x.listeners) == 'array') ? { t: 'append', p: ['listeners'], v: l } : { t: 'set', p: ['listeners'], v: [l] }] };
}

/* 规则与规则集 */

function op_rules_set(op, ctx) {
	let cur = ctx.x.rules;
	if (cur != null && type(cur) != 'array')
		return fail('rules 不是列表，请在配置文件页编辑');
	cur = arr(cur);
	let items = op.items;
	if (type(items) != 'array' || length(items) > MAX_RULES)
		return fail('规则列表无效');
	let out = [], vals = [];
	for (let it in items) {
		if (type(it) != 'object')
			return fail('规则列表无效');
		let k = it.k, v = it.v;
		if (k != null && !(type(k) == 'int' && k >= 0 && k < length(cur)))
			return fail('规则列表与当前配置不一致，请刷新后重试');
		if (v != null) {
			v = C.text(v, 4096);
			if (!v || index(v, ',') < 0)
				return fail('规则格式无效：' + (it.v ?? ''));
		}
		if (k == null && v == null)
			return fail('规则列表无效');
		let item = {};
		if (k != null)
			item.k = k;
		if (v != null && !(k != null && cur[k] == v))
			item.v = v;
		push(out, item);
		push(vals, item.v ?? cur[k]);
	}
	if (same(vals, cur))
		return { edits: [] };
	if (ctx.x.rules == null)
		return { edits: [{ t: 'set', p: ['rules'], v: vals }] };
	return { edits: [{ t: 'list', p: ['rules'], v: out }] };
}

const RP_SPEC = {
	url: (v) => C.url(v), interval: (v) => C.int(v, 0, 31536000), proxy: (v) => C.text(v, 128)
};

function check_proxy(ctx, v) {
	return (v == null || has(policies(ctx.x), v)) ? null : fail('策略不存在：' + v);
}

function op_rule_provider_set(op, ctx) {
	let rp = obj(ctx.x['rule-providers']), e = rp[op.name];
	if (type(op.name) != 'string' || type(e) != 'object')
		return fail('规则集不存在：' + (op.name ?? ''));
	if (e.type != 'http')
		return fail('只能编辑 http 类型的规则集');
	let r = pick_fields(obj(op.data), RP_SPEC, '规则集');
	if (r.error)
		return r;
	if ('url' in r.vals && r.vals.url == null)
		return fail('规则集链接不能为空');
	let bad = check_proxy(ctx, r.vals.proxy);
	if (bad)
		return bad;
	return map_edits(['rule-providers', op.name], e, obj(ctx.raw.rp)[op.name] ?? [], r.vals);
}

const RP_EXT = { mrs: '.mrs', yaml: '.yaml', text: '.list' };

function op_rule_provider_add(op, ctx) {
	let name = C.name(op.name);
	if (name == null)
		return fail('规则集名称无效：不能为空，不能包含 / , \\，不能以 . 开头，最长 64 个字符');
	let rp = ctx.x['rule-providers'];
	if (rp != null && type(rp) != 'object')
		return fail('rule-providers 不是映射，请在配置文件页编辑');
	if (name in obj(rp))
		return fail('已有同名规则集：' + name);
	let data = obj(op.data);
	let behavior = C.oneof(data.behavior, ['domain', 'ipcidr', 'classical']);
	let format = C.oneof(data.format, ['mrs', 'yaml', 'text']);
	if (!behavior || !format)
		return fail('请选择规则集的类型与格式');
	if (format == 'mrs' && behavior == 'classical')
		return fail('mrs 格式只支持 domain 与 ipcidr');
	let r = pick_fields(data, RP_SPEC, '规则集');
	if (r.error)
		return r;
	if (r.vals.url == null)
		return fail('规则集链接无效（需要 http:// 或 https:// 开头）');
	let bad = check_proxy(ctx, r.vals.proxy);
	if (bad)
		return bad;
	let def = { type: 'http', behavior: behavior, format: format, url: r.vals.url,
		path: './rule_provider/' + name + RP_EXT[format], interval: r.vals.interval ?? 86400 };
	if (r.vals.proxy != null)
		def.proxy = r.vals.proxy;
	return { edits: [{ t: 'set', p: ['rule-providers', name], v: def }] };
}

function op_rule_provider_delete(op, ctx) {
	let rp = obj(ctx.x['rule-providers']), e = rp[op.name];
	if (type(op.name) != 'string' || e == null)
		return fail('规则集不存在：' + (op.name ?? ''));
	let refs = rule_set_refs(ctx.x, op.name);
	if (length(refs))
		return fail('规则集「' + op.name + '」正在被使用：' + join('、', refs));
	return { edits: [{ t: 'del', p: ['rule-providers', op.name] }], post: cache_unlink(e) };
}

/* 基础、DNS、Tailscale */

function nested_edits(ctx, fields, data) {
	// fields: [字段名, 路径, 校验]；路径长度 1 或 2
	let groups = {}, order = [];
	for (let f in fields) {
		let name = f[0];
		if (!(name in data))
			continue;
		let v = data[name], c = null;
		if (v != null && v !== '') {
			c = f[2](v);
			if (c == null)
				return fail('「' + name + '」的值无效');
		} else if (has(REQUIRED_BASIC, name))
			return fail('「' + name + '」不能为空');
		let parent = (length(f[1]) == 1) ? '' : f[1][0];
		if (!groups[parent]) {
			groups[parent] = {};
			push(order, parent);
		}
		groups[parent][f[1][length(f[1]) - 1]] = c;
	}
	let edits = [];
	for (let parent in order) {
		let r;
		if (parent == '') {
			r = { edits: [] };
			for (let k, v in groups[''])
				if (v == null && ctx.x[k] != null)
					push(r.edits, { t: 'del', p: [k] });
				else if (v != null && !same(ctx.x[k], v))
					push(r.edits, { t: 'set', p: [k], v: v });
		} else {
			let cur = ctx.x[parent];
			if (cur != null && type(cur) != 'object')
				return fail(parent + ' 不是映射，请在配置文件页编辑');
			r = map_edits([parent], cur, top_keys(ctx, parent) ?? [], groups[parent]);
		}
		if (r.error)
			return r;
		push(edits, ...r.edits);
	}
	return { edits: edits };
}

function op_basic_set(op, ctx) {
	return nested_edits(ctx, BASIC_FIELDS, obj(op.data));
}

const server = (v) => (C.text(v, 256) && index(v, ' ') < 0) ? C.text(v, 256) : null;
const servers = (v) => C.list(v, server, 32);
const DNS_SPEC = {
	enable: (v) => C.bool(v), listen: (v) => C.listen(v),
	'enhanced-mode': (v) => C.oneof(v, ['redir-host', 'fake-ip', 'normal']), ipv6: (v) => C.bool(v),
	'default-nameserver': servers, nameserver: servers, 'proxy-server-nameserver': servers, 'direct-nameserver': servers,
	'fake-ip-range': (v) => { let c = C.cidr(v); return (c && index(c, ':') < 0) ? c : null; },
	'fake-ip-range6': (v) => { let c = C.cidr(v); return (c && index(c, ':') >= 0) ? c : null; },
	'fake-ip-filter': (v) => C.list(v, (s) => C.text(s, 256) || null, 1024)
};

function op_dns_set(op, ctx) {
	let d = ctx.x.dns;
	if (d != null && type(d) != 'object')
		return fail('dns 不是映射，请在配置文件页编辑');
	let data = obj(op.data);
	let r = pick_fields(data, DNS_SPEC, 'DNS ');
	if (r.error)
		return r;
	let vals = r.vals;
	for (let k, v in vals)
		if (type(v) == 'array' && !length(v))
			vals[k] = null;
	if ('nameserver-policy' in data) {
		let list = data['nameserver-policy'] ?? [];
		if (type(list) != 'array' || length(list) > 256)
			return fail('DNS 策略无效');
		let pol = {};
		for (let it in list) {
			let k = C.text(obj(it).key, 256), s = servers(obj(it).servers);
			if (!k || s == null || !length(s))
				return fail('DNS 策略「' + (obj(it).key ?? '') + '」无效：需要匹配条件和至少一个服务器');
			if (k in pol)
				return fail('DNS 策略的匹配条件重复：' + k);
			pol[k] = (length(s) == 1) ? s[0] : s;
		}
		let cur = policy_list(obj(d)['nameserver-policy']);
		let next = policy_list(pol);
		if (!same(cur, next))
			vals['nameserver-policy'] = length(keys(pol)) ? pol : null;
	}
	return map_edits(['dns'], d, top_keys(ctx, 'dns') ?? [], vals);
}

// serve：Tailnet 端口 → 本机 HTTP 服务（http://IP:端口 或 unix:套接字），端口不能重复
const SERVE_HTTP = regexp('^http://([0-9]{1,3}(\\.[0-9]{1,3}){3}|\\[[0-9A-Fa-f:.]+\\]):([0-9]{1,5})/?$');
const SERVE_UNIX = regexp('^unix:(//)?[^ \t]+$');

function serve_list(v) {
	if (type(v) != 'array' || length(v) > 32)
		return null;
	let out = [], seen = {};
	for (let e in v) {
		let p = C.port(obj(e).port), t = C.text(obj(e).target, 512);
		if (p == null || t == null || seen[p])
			return null;
		let m = match(t, SERVE_HTTP);
		if (m) {
			if (C.port(m[3]) == null)
				return null;
			t = replace(t, /\/$/, '');
		} else if (!match(t, SERVE_UNIX))
			return null;
		seen[p] = true;
		push(out, { port: p, target: t });
	}
	return out;
}

const TS_SPEC = {
	hostname: (v) => (type(v) == 'string' && match(v, /^[A-Za-z0-9-]{1,63}$/)) ? v : null,
	'auth-key': (v) => (C.text(v, 256) && index(v, ' ') < 0) ? C.text(v, 256) : null,
	udp: (v) => C.bool(v), 'accept-routes': (v) => C.bool(v), 'advertise-exit-node': (v) => C.bool(v),
	'advertise-routes': (v) => C.list(v, C.cidr, 64), 'listen-port': (v) => C.port0(v),
	serve: serve_list
};

function op_tailscale_set(op, ctx) {
	let i = ts_index(ctx.x, op.name);
	if (i < 0)
		return fail('Tailscale 代理不存在：' + (op.name ?? ''));
	let r = pick_fields(obj(op.data), TS_SPEC, 'Tailscale ');
	if (r.error)
		return r;
	let vals = r.vals;
	for (let k, v in vals)
		if ((type(v) == 'array' && !length(v)) || (k == 'listen-port' && v === 0))
			vals[k] = null;
	return map_edits(['proxies', i], ctx.x.proxies[i], arr(ctx.raw.proxies)[i]?.keys ?? [], vals);
}

// 新增：追加出站（不填 auth-key 时由「网页登录」完成授权），在开头的 DST-PORT 规则（DNS 接管）之后插入 Tailnet 规则，
// 并让 eBPF 不把 Tailnet 地址当作私网放行。删除：同时删掉指向它的规则与策略组成员，最后一个时撤回 bypass-exclude。
const TAILNET = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];
const TS_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function rule_target(rule) {
	let parts = map(split(rule, ','), (s) => trim(s));
	while (length(parts) > 2 && match(lc(parts[length(parts) - 1]), /^(no-resolve|src)$/))
		pop(parts);
	return parts[length(parts) - 1];
}

// 每个策略组的 proxies 列表（显式或经合并键继承自锚点），按路径去重
function proxies_lists(ctx) {
	let groups = arr(ctx.x['proxy-groups']), raws = arr(ctx.raw.groups), anchors = anchor_index(ctx), out = [], seen = {};
	for (let i, g in groups) {
		let r = raws[i] ?? { keys: [] }, path = null;
		if (has(r.keys, 'proxies'))
			path = ['proxy-groups', i, 'proxies'];
		else if (has(r.keys, '<<') && r.merge && anchors[r.merge] && has(anchors[r.merge].keys, 'proxies'))
			path = [...anchors[r.merge].path, 'proxies'];
		let key = sprintf('%J', path);
		if (path && !seen[key]) {
			seen[key] = true;
			push(out, { path: path, names: arr(obj(g).proxies) });
		}
	}
	return out;
}

function tailnet_edits(ctx, present) {
	let li = ebpf_index(ctx.x), edits = [];
	if (li < 0)
		return edits;
	let l = ctx.x.listeners[li];
	for (let role in ['local', 'shared']) {
		if (type(l[role]) != 'object')
			continue;
		let cur = arr(l[role]['bypass-exclude']), next = [];
		if (present) {
			next = [...cur];
			for (let c in TAILNET)
				if (!has(next, c))
					push(next, c);
		} else
			next = filter(cur, (c) => !has(TAILNET, c));
		if (same(next, cur))
			continue;
		let p = ['listeners', li, role, 'bypass-exclude'];
		push(edits, length(next) ? { t: 'set', p: p, v: next } : { t: 'del', p: p });
	}
	return edits;
}

function op_tailscale_add(op, ctx) {
	let x = ctx.x, name = op.name;
	if (type(name) != 'string' || !match(name, TS_NAME))
		return fail('名称只能包含字母、数字、_ . -，最长 64 个字符');
	if (has(policies(x), name) || name in obj(x['proxy-providers']))
		return fail('名称已被占用：' + name);
	if (x.proxies != null && type(x.proxies) != 'array')
		return fail('proxies 不是列表，请在配置文件页编辑');
	if (x.rules != null && type(x.rules) != 'array')
		return fail('rules 不是列表，请在配置文件页编辑');
	let r = pick_fields(obj(op.data), TS_SPEC, 'Tailscale ');
	if (r.error)
		return r;
	if (!r.vals.hostname)
		return fail('主机名不能为空：只能包含字母、数字与 -');
	let def = { name: name, type: 'tailscale', udp: true };
	for (let k, v in r.vals)
		if (v != null && !(type(v) == 'array' && !length(v)) && !(k == 'listen-port' && v === 0))
			def[k] = v;
	let edits = [(type(x.proxies) == 'array') ? { t: 'append', p: ['proxies'], v: def } : { t: 'set', p: ['proxies'], v: [def] }];
	let rules = arr(x.rules), pos = 0;
	while (pos < length(rules) && type(rules[pos]) == 'string' && match(rules[pos], /^[ \t]*DST-PORT[ \t]*,/))
		pos++;
	let add = [{ v: 'IP-CIDR,100.64.0.0/10,' + name + ',no-resolve' }, { v: 'IP-CIDR6,fd7a:115c:a1e0::/48,' + name + ',no-resolve' }];
	if (x.rules == null)
		push(edits, { t: 'set', p: ['rules'], v: map(add, (it) => it.v) });
	else {
		let items = [];
		for (let i = 0; i < length(rules); i++) {
			if (i == pos)
				push(items, ...add);
			push(items, { k: i });
		}
		if (pos >= length(rules))
			push(items, ...add);
		push(edits, { t: 'list', p: ['rules'], v: items });
	}
	push(edits, ...tailnet_edits(ctx, true));
	return { edits: edits };
}

// DNS 中以 ts://名称 引用该出站的服务器（nameserver、nameserver-policy 等任意位置）
function dns_uses(v, name) {
	if (type(v) == 'string')
		return v == 'ts://' + name || substr(v, 0, length(name) + 6) == 'ts://' + name + '#';
	if (type(v) == 'array')
		return length(filter(v, (e) => dns_uses(e, name))) > 0;
	if (type(v) == 'object') {
		for (let k, e in v)
			if (dns_uses(e, name))
				return true;
	}
	return false;
}

function op_tailscale_delete(op, ctx) {
	let x = ctx.x, i = ts_index(x, op.name);
	if (i < 0)
		return fail('Tailscale 代理不存在：' + (op.name ?? ''));
	if (dns_uses(x.dns, op.name))
		return fail('DNS 仍在使用 ts://' + op.name + '，请先在 DNS 标签页删除');
	let edits = [{ t: 'del', p: ['proxies', i] }];
	let rules = arr(x.rules), keep = [];
	for (let k, rule in rules)
		if (!(type(rule) == 'string' && rule_target(rule) == op.name))
			push(keep, { k: k });
	if (length(keep) != length(rules))
		push(edits, { t: 'list', p: ['rules'], v: keep });
	for (let l in proxies_lists(ctx)) {
		let hits = [];
		for (let j = length(l.names) - 1; j >= 0; j--)
			if (l.names[j] == op.name)
				push(hits, j);
		if (length(hits) && length(hits) == length(l.names))
			return fail('有策略组只包含 ' + op.name + '，请先在策略组页给它换一个出站');
		for (let j in hits)
			push(edits, { t: 'del', p: [...l.path, j] });
	}
	let left = filter(arr(x.proxies), (p) => obj(p).type == 'tailscale');
	if (length(left) == 1)
		push(edits, ...tailnet_edits(ctx, false));
	return { edits: edits };
}

/* 单个节点 */

const NODE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

// 节点字段的通用校验：键名、字符串长度、列表与嵌套深度有上限；协议细节由保存前的 mihomo -t 校验
function node_value(v, depth) {
	let t = type(v);
	if (t == 'string')
		return (C.text(v, 4096) != null) ? v : null;
	if (t == 'int' || t == 'double' || t == 'bool')
		return v;
	if (depth >= 4)
		return null;
	if (t == 'array') {
		if (length(v) > 64)
			return null;
		let out = [];
		for (let e in v) {
			let c = node_value(e, depth + 1);
			if (c == null)
				return null;
			push(out, c);
		}
		return out;
	}
	if (t == 'object') {
		if (length(keys(v)) > 64)
			return null;
		let out = {};
		for (let k, e in v) {
			if (!match(k, NODE_KEY) || k == '<<')
				return null;
			let c = node_value(e, depth + 1);
			if (c == null)
				return null;
			out[k] = c;
		}
		return out;
	}
	return null;
}

function check_node(n) {
	if (type(n) != 'object')
		return fail('节点无效');
	let name = node_name(n.name);
	if (name == null)
		return fail('节点名称无效：不能为空、首尾不能有空格、不能包含英文逗号，最长 128 个字符');
	if (!has(NODE_TYPES, n.type))
		return fail('节点「' + name + '」的类型不支持：' + (n.type ?? ''));
	let server = C.text(n.server, 255);
	if (server == null || match(server, /[ \t]/))
		return fail('节点「' + name + '」的服务器地址无效');
	if (C.port(n.port) == null)
		return fail('节点「' + name + '」的端口无效');
	let v = node_value(n, 0);
	if (v == null)
		return fail('节点「' + name + '」包含无效的字段');
	v.port = C.port(n.port);
	// 名称与类型放在最前面，便于阅读
	let out = { name: name, type: n.type };
	for (let k, e in v)
		if (k != 'name' && k != 'type')
			out[k] = e;
	return { node: out };
}

function node_index(x, name) {
	for (let i, p in arr(x.proxies))
		if (obj(p).name == name)
			return i;
	return -1;
}

// 被占用的名称：节点、策略组、内置策略与订阅
function taken_names(x) {
	return [...policies(x), ...keys(obj(x['proxy-providers']))];
}

// DNS 服务器以 地址#出站名 指定经哪个出站查询
function dns_hit(v, name) {
	if (type(v) == 'string')
		return substr(v, -length(name) - 1) == '#' + name;
	if (type(v) == 'array')
		return length(filter(v, (e) => dns_hit(e, name))) > 0;
	if (type(v) == 'object')
		return length(filter(values(v), (e) => dns_hit(e, name))) > 0;
	return false;
}

// 指向 name 的引用（中文说明）：规则出站、前置代理、规则集/订阅的 proxy、DNS 服务器的 #name
function policy_refs(x, name) {
	let refs = [];
	for (let i, r in arr(x.rules))
		if (type(r) == 'string' && rule_target(r) == name)
			push(refs, '规则第 ' + (i + 1) + ' 条');
	for (let p in arr(x.proxies))
		if (obj(p)['dialer-proxy'] == name)
			push(refs, '节点 ' + p.name + ' 的前置代理');
	for (let g in arr(x['proxy-groups']))
		if (obj(g)['dialer-proxy'] == name)
			push(refs, '策略组 ' + g.name + ' 的前置代理');
	for (let n, e in obj(x['rule-providers']))
		if (obj(e).proxy == name)
			push(refs, '规则集 ' + n + ' 的下载方式');
	for (let n, e in obj(x['proxy-providers']))
		if (obj(e).proxy == name || obj(obj(e).override)['dialer-proxy'] == name)
			push(refs, '订阅 ' + n);
	if (dns_hit(x.dns, name))
		push(refs, 'DNS 服务器');
	return refs;
}

// 规则字符串的出站改名（AND/OR 等逻辑规则的出站同样是最后一段）
function rule_retarget(rule, nw) {
	let parts = map(split(rule, ','), (s) => trim(s)), i = length(parts) - 1;
	while (i > 1 && match(lc(parts[i]), /^(no-resolve|src)$/))
		i--;
	parts[i] = nw;
	return join(',', parts);
}

// 改名：同步策略组成员、规则出站、前置代理、规则集与订阅的 proxy
function rename_edits(ctx, old, nw) {
	let x = ctx.x, edits = [];
	for (let l in proxies_lists(ctx))
		for (let j, n in l.names)
			if (n == old)
				push(edits, { t: 'set', p: [...l.path, j], v: nw });
	let rules = arr(x.rules), items = [], changed = false;
	for (let i, r in rules) {
		if (type(r) == 'string' && rule_target(r) == old) {
			push(items, { v: rule_retarget(r, nw) });
			changed = true;
		} else
			push(items, { k: i });
	}
	if (changed)
		push(edits, { t: 'list', p: ['rules'], v: items });
	let raws = arr(ctx.raw.proxies);
	for (let i, p in arr(x.proxies))
		if (obj(p)['dialer-proxy'] == old) {
			let r = map_edits(['proxies', i], p, obj(raws[i]).keys ?? [], { 'dialer-proxy': nw });
			if (r.error)
				return r;
			push(edits, ...r.edits);
		}
	for (let i, g in arr(x['proxy-groups']))
		if (obj(g)['dialer-proxy'] == old) {
			let r = map_edits(['proxy-groups', i], g, obj(arr(ctx.raw.groups)[i]).keys ?? [], { 'dialer-proxy': nw });
			if (r.error)
				return r;
			push(edits, ...r.edits);
		}
	for (let n, e in obj(x['rule-providers']))
		if (obj(e).proxy == old) {
			let r = map_edits(['rule-providers', n], e, obj(ctx.raw.rp)[n] ?? [], { proxy: nw });
			if (r.error)
				return r;
			push(edits, ...r.edits);
		}
	for (let n, e in obj(x['proxy-providers']))
		if (obj(e).proxy == old) {
			let r = map_edits(['proxy-providers', n], e, obj(obj(ctx.raw.pp)[n]).keys ?? [], { proxy: nw });
			if (r.error)
				return r;
			push(edits, ...r.edits);
		}
	return { edits: edits };
}

// 按勾选的策略组调整成员：groups 为希望包含 name 的策略组名；自动包含全部节点的组不改。
// 加入时追加到 proxies 末尾（组里还没有 proxies 时新建）；移出时组里不能因此没有任何出站
function membership_edits(ctx, name, groups, current_name) {
	if (type(groups) != 'array')
		return { edits: [] };
	let all = node_groups(ctx), edits = [];
	for (let g in groups)
		if (type(g) != 'string' || !length(filter(all, (e) => e.name == g)))
			return fail('策略组不存在：' + g);
	for (let g in all) {
		if (g.auto)
			continue;
		let want = has(groups, g.name), cur = current_name != null && has(g.members, current_name);
		if (want == cur)
			continue;
		if (!g.editable)
			return fail('策略组「' + g.name + '」的成员继承自锚点，请在配置文件页编辑');
		if (want) {
			push(edits, g.explicit ? { t: 'append', p: ['proxy-groups', g.index, 'proxies'], v: name }
				: { t: 'set', p: ['proxy-groups', g.index, 'proxies'], v: [name] });
			g.explicit = true;
		} else {
			let left = filter(g.members, (n) => n != current_name);
			if (!length(left) && !g.others)
				return fail('策略组「' + g.name + '」只剩这个节点，移出后没有可用出站');
			if (!length(left))
				push(edits, { t: 'del', p: ['proxy-groups', g.index, 'proxies'] });
			else
				for (let j = length(g.members) - 1; j >= 0; j--)
					if (g.members[j] == current_name)
						push(edits, { t: 'del', p: ['proxy-groups', g.index, 'proxies', j] });
		}
	}
	return { edits: edits };
}

function op_proxy_add(op, ctx) {
	let x = ctx.x;
	if (x.proxies != null && type(x.proxies) != 'array')
		return fail('proxies 不是列表，请在配置文件页编辑');
	let nodes = op.nodes;
	if (type(nodes) != 'array' || !length(nodes) || length(nodes) > MAX_NODES)
		return fail('一次添加 1–' + MAX_NODES + ' 个节点');
	if (length(arr(x.proxies)) + length(nodes) > 4096)
		return fail('节点过多');
	let taken = taken_names(x), add = [];
	for (let n in nodes) {
		let r = check_node(n);
		if (r.error)
			return r;
		if (has(taken, r.node.name))
			return fail('名称已被占用：' + r.node.name);
		push(taken, r.node.name);
		push(add, r.node);
	}
	let edits = (type(x.proxies) == 'array') ? map(add, (n) => ({ t: 'append', p: ['proxies'], v: n }))
		: [{ t: 'set', p: ['proxies'], v: add }];
	if (op.groups != null) {
		if (type(op.groups) != 'array')
			return fail('策略组列表无效');
		let m = membership_edits(ctx, add[0].name, op.groups, null);
		if (m.error)
			return m;
		for (let e in m.edits) {
			if (e.t == 'set')
				push(edits, { t: 'set', p: e.p, v: map(add, (n) => n.name) });
			else
				for (let n in add)
					push(edits, { t: 'append', p: e.p, v: n.name });
		}
	}
	return { edits: edits };
}

function op_proxy_set(op, ctx) {
	let x = ctx.x, i = node_index(x, op.name);
	if (type(op.name) != 'string' || i < 0)
		return fail('节点不存在：' + (op.name ?? ''));
	let lock = node_lock(x.proxies[i], arr(ctx.raw.proxies)[i]);
	if (lock)
		return fail(lock);
	let r = check_node(op.data);
	if (r.error)
		return r;
	let node = r.node, edits = [];
	if (node.name != op.name) {
		if (has(taken_names(x), node.name))
			return fail('名称已被占用：' + node.name);
		let rn = rename_edits(ctx, op.name, node.name);
		if (rn.error)
			return rn;
		push(edits, ...rn.edits);
	}
	if (!same(x.proxies[i], node))
		unshift(edits, { t: 'set', p: ['proxies', i], v: node });
	let m = membership_edits(ctx, node.name, op.groups, op.name);
	if (m.error)
		return m;
	push(edits, ...m.edits);
	return { edits: edits };
}

function op_proxy_delete(op, ctx) {
	let x = ctx.x, i = node_index(x, op.name);
	if (type(op.name) != 'string' || i < 0)
		return fail('节点不存在：' + (op.name ?? ''));
	let p = obj(x.proxies[i]);
	if (p.type == 'tailscale' || p.type == 'dns')
		return fail(node_lock(p, null));
	let refs = policy_refs(x, op.name);
	if (length(refs))
		return fail('节点「' + op.name + '」正在被使用：' + join('、', refs) + '。请先改成别的出站');
	let edits = [{ t: 'del', p: ['proxies', i] }];
	let groups = node_groups(ctx);
	for (let l in proxies_lists(ctx)) {
		let hits = [];
		for (let j = length(l.names) - 1; j >= 0; j--)
			if (l.names[j] == op.name)
				push(hits, j);
		if (!length(hits))
			continue;
		if (length(hits) == length(l.names)) {
			let g = filter(groups, (e) => same(['proxy-groups', e.index, 'proxies'], l.path) && e.others);
			if (!length(g))
				return fail('有策略组只包含「' + op.name + '」，请先给它换一个出站');
			push(edits, { t: 'del', p: l.path });
			continue;
		}
		for (let j in hits)
			push(edits, { t: 'del', p: [...l.path, j] });
	}
	return { edits: edits };
}

const OPS = {
	'mode.set': op_mode_set,
	'provider.set': op_provider_set,
	'provider.add': op_provider_add,
	'provider.delete': op_provider_delete,
	'provider.toggle': op_provider_toggle,
	'groups.include_all': op_groups_include_all,
	'ebpf.set': op_ebpf_set,
	'ebpf.create': op_ebpf_create,
	'rules.set': op_rules_set,
	'rule_provider.set': op_rule_provider_set,
	'rule_provider.add': op_rule_provider_add,
	'rule_provider.delete': op_rule_provider_delete,
	'basic.set': op_basic_set,
	'dns.set': op_dns_set,
	'tailscale.set': op_tailscale_set,
	'tailscale.add': op_tailscale_add,
	'tailscale.delete': op_tailscale_delete,
	'proxy.add': op_proxy_add,
	'proxy.set': op_proxy_set,
	'proxy.delete': op_proxy_delete
};

function run_pre(list) {
	for (let a in list)
		if (a.t == 'disabled_put' && !disabled_put(a.name, a.entry))
			return '无法写入停用订阅列表';
	return null;
}

// 在 file（候选配置）上执行一组白名单操作；返回 { error } 或 { post }
function apply_ops(file, ops) {
	if (!Y.available())
		return fail('缺少 yq，无法修改配置');
	if (type(ops) != 'array' || !length(ops))
		return fail('没有要执行的操作');
	if (length(ops) > 16)
		return fail('一次提交的操作过多');
	for (let op in ops)
		if (type(op) != 'object' || !OPS[op.op])
			return fail('不支持的操作：' + (op?.op ?? '?'));
	U.mkdir_p(P.RUN_DIR);
	let work = P.RUN_DIR + '/forms-' + U.rand_hex(4) + '.yaml';
	let src = fs.readfile(file);
	if (src == null || !U.write_file(work, src))
		return fail('无法写入临时文件');
	let pre = [], post = [], err = null;
	for (let op in ops) {
		let ctx = context(work);
		if (!ctx) {
			err = '配置文件有语法错误，请在配置文件页修复';
			break;
		}
		let r = OPS[op.op](op, ctx);
		if (r.error) {
			err = r.error;
			break;
		}
		err = Y.edit(work, r.edits);
		if (err)
			break;
		push(pre, ...(r.pre ?? []));
		push(post, ...(r.post ?? []));
	}
	if (!err)
		err = run_pre(pre) ?? Y.commit(file, work);
	fs.unlink(work);
	return err ? fail(err) : { post: post };
}

// mihomo -t 会真的启动 tsnet：用正式状态目录时，会与正在运行的实例同时以同一节点身份连接控制服务器。
// 校验前生成副本：每个 Tailscale 代理改用临时状态目录、去掉 auth-key、控制服务器指向不可达地址。
const TS_CHECK_DIR = '.luci/ts-check';

function validation_copy(src, dst) {
	let text = fs.readfile(src);
	if (text == null || !U.write_file(dst, text))
		return false;
	let ctx = context(dst);
	if (!ctx)
		return false;
	let edits = [];
	for (let i, p in arr(ctx.x.proxies)) {
		if (obj(p).type != 'tailscale')
			continue;
		let r = map_edits(['proxies', i], p, obj(arr(ctx.raw.proxies)[i]).keys ?? [],
			{ 'state-dir': TS_CHECK_DIR + '/' + i, 'auth-key': '', 'control-url': 'http://127.0.0.1:1' });
		if (r.error)
			return false;
		push(edits, ...r.edits);
	}
	return Y.edit(dst, edits) == null;
}

// 保存任务成功后执行（apply.uc 调用）；动作再次校验
function run_post(list) {
	for (let a in arr(list)) {
		if (a?.t == 'unlink' && home_path(a.path) == a.path && fs.stat(a.path)?.type == 'file')
			fs.unlink(a.path);
		else if (a?.t == 'disabled_remove' && type(a.name) == 'string')
			disabled_remove(a.name);
	}
}

export { NAMES, TS_CHECK_DIR, context, sections, apply_ops, run_post, validation_copy, disabled_read, home_path, rule_uses, same };
