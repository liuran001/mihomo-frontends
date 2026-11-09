'use strict';

// 首次设置：内置模板渲染、「补全路由器所需设置」（adapt）、setup 任务的准备与后台前置步骤。
// 任务的校验、备份、替换、启动沿用 apply.uc 的配置流程。
import * as fs from 'fs';
import * as uci from 'uci';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import * as Y from 'mihomo.yaml';
import * as C from 'mihomo.check';
import * as F from 'mihomo.forms';
import * as S from 'mihomo.service';
import * as CORE from 'mihomo.core';

const UI_URL = 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip';
const FIP_URL = 'https://github.com/DustinWin/ruleset_geodata/raw/refs/heads/mihomo-ruleset/fakeip-filter.mrs';
const DEFAULT_UA = 'clash.meta';
const DNS_LISTEN = '0.0.0.0:1053';
const DNS_UPSTREAM = ['223.5.5.5', '119.29.29.29'];
const SOURCES = ['template', 'import', 'url'];
const MAX_SUBS = 32;
const MAX_LAN = 8;

function fail(msg) {
	return { ok: false, error: msg };
}

function obj(v) {
	return (type(v) == 'object') ? v : {};
}

function empty(v) {
	return v == null || v === '';
}

// 占位符的值写成 JSON：JSON 字符串、数组就是合法的 YAML 双引号标量与流式序列
function J(v) {
	return sprintf('%J', v);
}

/* ---------- 参数校验 ---------- */

function check_subs(subs) {
	if (type(subs) != 'array' || !length(subs))
		return fail('至少需要一个订阅');
	if (length(subs) > MAX_SUBS)
		return fail('订阅过多（最多 ' + MAX_SUBS + ' 个）');
	let out = [], seen = {};
	for (let i = 0; i < length(subs); i++) {
		let s = obj(subs[i]);
		let name = C.name(s.name);
		if (name == null)
			return fail(sprintf('第 %d 个订阅的名称无效：%s（不能为空，不能包含 / , \\，不能以 . 开头，最长 64 个字符）',
				i + 1, '' + (s.name ?? '')));
		if (seen[name])
			return fail('订阅名称重复：' + name);
		seen[name] = true;
		if (C.url(s.url) == null)
			return fail('订阅「' + name + '」的地址无效（需要 http:// 或 https:// 开头）');
		let ua = null;
		if (!empty(s.ua)) {
			ua = C.text(s.ua, 256);
			if (!ua)
				return fail('订阅「' + name + '」的 User-Agent 无效');
		}
		push(out, { name: name, url: C.url(s.url), ua: ua });
	}
	return { ok: true, list: out };
}

function check_lan(lan) {
	let l = C.list(lan, C.ifname, MAX_LAN);
	if (l == null)
		return fail('下联接口名无效');
	if (!length(l))
		return fail('请至少选择一个下联接口');
	return { ok: true, list: l };
}

// 未填写时随机生成
function check_secret(s) {
	if (empty(s))
		return { ok: true, value: U.rand_hex(16) };
	let v = C.text(s, 128);
	if (!v || index(v, ' ') >= 0)
		return fail('面板密钥不能含空格或控制字符，最长 128 个字符');
	return { ok: true, value: v };
}

// args.mirror 给出时校验并补全末尾斜杠，否则取内核下载设置里的镜像前缀
function mirror_of(args) {
	if (args.mirror == null)
		return { ok: true, value: CORE.settings().mirror };
	let m = CORE.norm_mirror(args.mirror);
	return (m == null) ? fail('镜像前缀应以 http:// 或 https:// 开头，且不含空格') : { ok: true, value: m };
}

/* ---------- 模板渲染 ---------- */

// args：subs[{ name, url, ua }]、lan[]、secret（可空）、mirror（可省略）。返回 { ok, content } 或 { ok:false, error }
function render(args) {
	args = obj(args);
	let subs = check_subs(args.subs);
	if (!subs.ok)
		return subs;
	let lan = check_lan(args.lan);
	if (!lan.ok)
		return lan;
	let secret = check_secret(args.secret);
	if (!secret.ok)
		return secret;
	let mirror = mirror_of(args);
	if (!mirror.ok)
		return mirror;
	let text = fs.readfile(P.TEMPLATE);
	if (text == null)
		return fail('缺少内置模板：' + P.TEMPLATE);
	let m = mirror.value;

	// 每个占位符生成若干行，缩进相对占位符所在列
	let blocks = {
		providers: () => {
			let lines = [];
			for (let s in subs.list) {
				push(lines, J(s.name) + ':', '  <<: *p', '  path: ' + J('./proxy_provider/' + s.name + '.yaml'),
					'  url: ' + J(s.url), '  override:', '    additional-prefix: ' + J('[' + s.name + ']'));
				if (s.ua)
					push(lines, '  header:', '    User-Agent: [' + J(s.ua) + ']');
			}
			return lines;
		},
		use: () => map(subs.list, (s) => '- ' + J(s.name)),
		secret: () => ['secret: ' + J(secret.value)],
		'ui-url': () => ['external-ui-url: ' + J(m + UI_URL)],
		// 走镜像时直连即可；直连 GitHub 不稳定，没有镜像时走代理
		'fake-ip-filter-url': () => ['url: ' + J(m + FIP_URL), 'proxy: ' + J(m ? 'DIRECT' : '节点选择')],
		lan: () => ['interface: ' + J(lan.list)]
	};
	let out = [], used = {};
	for (let line in split(text, '\n')) {
		let ph = match(line, /^( *)#@([a-z-]+)[ \t]*$/);
		if (!ph) {
			push(out, line);
			continue;
		}
		if (!blocks[ph[2]])
			return fail('模板中有未知的占位符：' + ph[2]);
		used[ph[2]] = true;
		for (let l in blocks[ph[2]]())
			push(out, ph[1] + l);
	}
	for (let k in keys(blocks))
		if (!used[k])
			return fail('模板缺少占位符：' + k);
	return { ok: true, content: join('\n', out) };
}

/* ---------- 补全 ---------- */

const TAILNET = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];
// 与 eBPF 抢同一批流量的透明代理入站
const CONFLICT_LISTENERS = ['tproxy', 'redir', 'tun'];
const REDIR_KEYS = ['tproxy-port', 'redir-port'];
const LEGACY_EBPF = ['dns-mode', 'bypass-private-address', 'tcp-splice'];
const SKIP_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_CONTENT = 4 * 1024 * 1024;
// 与模板一致的 GEO 数据下载地址（jsDelivr 国内可直连）与嗅探设置
const GEOX = {
	geoip: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat',
	geosite: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat',
	mmdb: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb'
};
const SNIFFER = {
	enable: true, 'parse-pure-ip': true,
	sniff: { HTTP: { ports: [80, '8080-8880'], 'override-destination': true }, TLS: { ports: [443, 8443] }, QUIC: { ports: [443, 8443] } }
};
// 内存低于这个值（MB）时 GEO 数据用省内存方式加载
const LOW_MEM_MB = 1024;

function has_type(list, t) {
	return type(list) == 'array' && length(filter(list, (e) => obj(e).type == t)) > 0;
}

// 可选项的 id 列表；无效时返回 null
function check_skip(skip) {
	if (skip == null)
		return [];
	if (type(skip) != 'array' || length(skip) > 32)
		return null;
	for (let s in skip)
		if (type(s) != 'string' || !match(s, SKIP_RE))
			return null;
	return skip;
}

function rule_target(rule) {
	let parts = map(split('' + rule, ','), (s) => trim(s));
	while (length(parts) > 2 && match(lc(parts[length(parts) - 1]), /^(no-resolve|src)$/))
		pop(parts);
	return parts[length(parts) - 1];
}

// 指向 mihomo 目录以外的路径（绝对路径或含 ..）：内核会拒绝加载
function outside_home(v) {
	if (type(v) != 'string' || v == '')
		return false;
	if (index(split(v, '/'), '..') >= 0)
		return true;
	return substr(v, 0, 1) == '/' && substr(v, 0, length(P.HOME) + 1) != P.HOME + '/';
}

// 本机是否有 IPv6 默认路由、内存大小（MB）；读不到时为 null
function host_info() {
	let r = U.run('ip -6 route show default', { stderr: false });
	let m = match(fs.readfile('/proc/meminfo') ?? '', /MemTotal:[ \t]*([0-9]+) kB/);
	return { ipv6: (r.code == 0) ? trim(r.out) != '' : null, mem_mb: m ? int(+m[1] / 1024) : null };
}

function arr_of(v) {
	return (type(v) == 'array') ? v : [];
}

// 规则（含 AND/OR/NOT、SUB-RULE 里嵌套的）中是否用到某类匹配
function rules_use(x, re) {
	for (let r in arr_of(x.rules))
		if (type(r) == 'string' && match(r, re))
			return true;
	for (let k, list in (type(x['sub-rules']) == 'object') ? x['sub-rules'] : {})
		for (let r in arr_of(list))
			if (type(r) == 'string' && match(r, re))
				return true;
	return false;
}

function base_name(v) {
	let parts = filter(split(v, '/'), (s) => s != '' && s != '..' && s != '.');
	return length(parts) ? parts[length(parts) - 1] : 'file';
}

// 在 file 上补齐路由器运行所需的设置。args：lan[]、secret（可空）、mirror（可省略）、skip[]（跳过的可选项 id）。
// 返回 { ok, adapted: [已应用项的标题…], changes: [{ id, title, detail, optional, applied }] }；没有改动时不碰文件
function adapt(file, args) {
	args = obj(args);
	let skip = check_skip(args.skip);
	if (skip == null)
		return fail('跳过项无效');
	let ctx = F.context(file);
	if (!ctx)
		return fail('配置文件有语法错误，无法补全');
	let x = ctx.x;
	let mirror = mirror_of(args);
	if (!mirror.ok)
		return mirror;
	for (let k in ['listeners', 'proxies', 'rules'])
		if (x[k] != null && type(x[k]) != 'array')
			return fail(k + ' 不是列表，请在配置文件页编辑');
	if (x.dns != null && type(x.dns) != 'object')
		return fail('dns 不是映射，请在配置文件页编辑');

	let changes = [], ops = [], edits = [], basic = {}, err = null;
	// 记录一项改动；必需项总会应用，可选项在 skip 中时只列出不应用
	let step = (id, title, detail, optional, run) => {
		let applied = !optional || index(skip, id) < 0;
		push(changes, { id: id, title: title, detail: detail, optional: optional, applied: applied });
		if (applied && err == null)
			err = run();
	};

	// 1. eBPF 透明代理入站
	let ls = x.listeners ?? [];
	let ebpf = filter(ls, (l) => obj(l).type == 'ebpf');
	let tailnet = has_type(x.proxies, 'tailscale');
	if (!length(ebpf)) {
		let lan = check_lan(args.lan);
		if (!lan.ok)
			return fail('需要添加 eBPF 入站，但' + lan.error);
		step('ebpf', '添加 eBPF 透明代理入站', '本机流量与下联接口 ' + join('、', lan.list) + ' 的设备流量交给 mihomo', false,
			() => { push(ops, { op: 'ebpf.create', interface: lan.list }); });
	} else {
		let l = obj(ebpf[0]);
		let legacy = filter(LEGACY_EBPF, (k) => l[k] != null);
		for (let r in ['local', 'shared'])
			if (obj(l[r])['ipv6-mode'] != null)
				push(legacy, r + '.ipv6-mode');
		let roles = filter(['local', 'shared'], (r) => type(l[r]) == 'object');
		let miss = tailnet ? filter(roles, (r) => length(filter(TAILNET, (c) => index(obj(l[r])['bypass-exclude'] ?? [], c) < 0)) > 0) : [];
		if (length(legacy) || length(miss)) {
			let what = [];
			if (length(legacy))
				push(what, '旧写法 ' + join('、', legacy) + ' 展开到 local/shared');
			if (length(miss))
				push(what, 'Tailnet 地址段加入 bypass-exclude，不再当作私网直连');
			step('ebpf', '规范 eBPF 入站', join('；', what), false, () => {
				let data = {};
				for (let r in miss)
					data[r] = { 'bypass-exclude': uniq([...(obj(l[r])['bypass-exclude'] ?? []), ...TAILNET]) };
				push(ops, { op: 'ebpf.set', data: data });
			});
		}
	}

	// 2. 与 eBPF 冲突的透明代理入站，以及只为它们开的端口
	let conflict = [];
	for (let i = 0; i < length(ls); i++)
		if (index(CONFLICT_LISTENERS, obj(ls[i]).type) >= 0)
			push(conflict, i);
	if (length(conflict)) {
		let names = map(conflict, (i) => (obj(ls[i]).name ?? ('#' + (i + 1))) + '（' + ls[i].type + '）');
		step('listeners', '移除冲突的透明代理入站', join('、', names) + ' 与 eBPF 抢同一批流量', true, () => {
			let kept = [];
			for (let i = 0; i < length(ls); i++)
				if (index(conflict, i) < 0)
					push(kept, { k: i });
			push(edits, { t: 'list', p: ['listeners'], v: kept });
		});
	}
	let ports = filter(REDIR_KEYS, (k) => x[k] != null);
	if (length(ports))
		step('ports', '移除透明代理端口', join('、', ports) + ' 由 eBPF 接管后不再需要', true, () => {
			for (let k in ports)
				push(edits, { t: 'del', p: [k] });
		});

	// 3. 出站绑定的网卡在本机不存在时，所有连接都会失败
	let ifn = x['interface-name'];
	if (type(ifn) == 'string' && ifn != '' && !fs.stat('/sys/class/net/' + ifn))
		step('iface', '移除出站网卡绑定', '本机没有网卡 ' + ifn + '，保留会让所有出站失败', false,
			() => { push(edits, { t: 'del', p: ['interface-name'] }); });

	// 4. 外部控制、密钥与面板：LuCI 与 zashboard 都要从局域网连接控制器
	let ec = x['external-controller'];
	let addr = Y.parse_listen(ec != null ? '' + ec : '');
	// 已有对外监听的 TLS 控制器时，明文保持只绑本机即可（external-controller 仍须填写）
	let tls_ec = x['external-controller-tls'];
	let tls_addr = Y.parse_listen(tls_ec != null ? '' + tls_ec : '');
	let tls_open = tls_addr && !tls_addr.loopback;
	if (!addr || (addr.loopback && !tls_open)) {
		let to = '0.0.0.0:' + (addr ? addr.port : 9090);
		step('controller', '外部控制监听局域网', (addr ? ec + ' 只能本机访问' : '未开启外部控制') + '，改为 ' + to + '，LuCI 与面板通过它管理内核', false,
			() => { basic['external-controller'] = to; });
	}
	if (empty(x.secret)) {
		let s = check_secret(args.secret);
		if (!s.ok)
			return s;
		step('secret', '生成面板密钥', '控制器监听局域网时，没有密钥任何设备都能管理内核', true, () => { basic.secret = s.value; });
	}
	if (empty(x['external-ui']))
		step('dashboard', '配置 zashboard 面板', '面板放在 ./dashboard，首次打开时自动下载', true, () => {
			basic['external-ui'] = './dashboard';
			if (empty(x['external-ui-url']))
				basic['external-ui-url'] = mirror.value + UI_URL;
		});

	// 5. 指向 mihomo 目录以外的文件路径
	let pathfix = [];
	for (let sec, dir in { 'proxy-providers': 'proxy_provider', 'rule-providers': 'rule_provider' })
		for (let n, it in obj(x[sec]))
			if (outside_home(obj(it).path))
				push(pathfix, { p: [sec, n, 'path'], v: './' + dir + '/' + base_name(it.path) });
	if (outside_home(x['external-ui']))
		push(pathfix, { p: ['external-ui'], v: './dashboard' });
	for (let k, v in obj(x['geox-path']))
		if (outside_home(v))
			push(pathfix, { p: ['geox-path', k], v: './' + base_name(v) });
	if (length(pathfix)) {
		let shown = map(slice(pathfix, 0, 4), (f) => join('.', f.p));
		step('paths', '改写配置目录以外的路径',
			join('、', shown) + (length(pathfix) > 4 ? ' 等 ' + length(pathfix) + ' 项' : '') + ' 不在 ' + P.HOME + ' 下，内核会拒绝加载，改为相对路径', false,
			() => { for (let f in pathfix) push(edits, { t: 'set', p: f.p, v: f.v }); });
	}

	// 6. Tun：路由器上由 eBPF 接管
	if (type(x.tun) == 'object' && x.tun.enable === true)
		step('tun', '关闭 Tun', 'eBPF 已接管透明代理，Tun 会与它争抢路由', false,
			() => { push(edits, { t: 'set', p: ['tun', 'enable'], v: false }); });

	// 7. DNS
	let d = x.dns;
	if (d == null)
		step('dns', '添加 DNS 设置', 'redir-host 模式，监听 ' + DNS_LISTEN + '，上游 ' + join('、', DNS_UPSTREAM), false, () => {
			push(ops, { op: 'dns.set', data: { enable: true, listen: DNS_LISTEN, 'enhanced-mode': 'redir-host', nameserver: DNS_UPSTREAM } });
		});
	else if (d.enable !== true)
		step('dns', '启用 DNS', '原配置的 DNS 未启用' + (d.listen == null ? '，监听 ' + DNS_LISTEN : ''), false, () => {
			let data = { enable: true };
			if (d.listen == null)
				data.listen = DNS_LISTEN;
			push(ops, { op: 'dns.set', data: data });
		});

	// 8. DNS 出站与首条规则：下联设备的 53 端口请求交给 dns 模块
	let px = x.proxies, rules = x.rules;
	let dnsp = filter(px ?? [], (e) => obj(e).type == 'dns')[0];
	let name = dnsp ? '' + dnsp.name : null;
	let ruled = name != null && length(filter(rules ?? [], (r) => type(r) == 'string' &&
		match(trim(r), /^DST-PORT\s*,\s*53\s*,/) && rule_target(r) == name)) > 0;
	if (!dnsp || !ruled) {
		if (!dnsp) {
			let taken = {};
			for (let e in [...(px ?? []), ...((type(x['proxy-groups']) == 'array') ? x['proxy-groups'] : [])])
				taken[obj(e).name] = true;
			name = 'DNS_Hijack';
			for (let n = 2; taken[name]; n++)
				name = 'DNS_Hijack-' + n;
		}
		let rule = 'DST-PORT,53,' + name;
		step('dns-hijack', '接管 53 端口 DNS', (dnsp ? '' : '添加 DNS 出站 ' + name + '，') + '在规则最前面加入 ' + rule, false, () => {
			if (!dnsp) {
				let def = { name: name, type: 'dns' };
				push(edits, (px != null) ? { t: 'append', p: ['proxies'], v: def } : { t: 'set', p: ['proxies'], v: [def] });
			}
			if (rules != null) {
				let items = [{ v: rule }];
				for (let i = 0; i < length(rules); i++)
					push(items, { k: i });
				push(edits, { t: 'list', p: ['rules'], v: items });
			} else
				push(edits, { t: 'set', p: ['rules'], v: [rule] });
		});
	}

	// 9. 与模块向导一致的优化（都是可选项）
	let host = (type(args.host) == 'object') ? args.host : host_info();
	if (host.ipv6 === false && x.ipv6 !== false)
		step('ipv6', '关闭 IPv6', '路由器没有 IPv6 默认路由，避免 AAAA 解析导致连接先走 IPv6 超时', true, () => {
			basic.ipv6 = false;
			if (type(x.dns) == 'object' && x.dns.ipv6 === true)
				push(edits, { t: 'set', p: ['dns', 'ipv6'], v: false });
		});
	let geo = rules_use(x, /(^|[(, ])(GEOSITE|GEOIP|SRC-GEOIP)[ \t]*,/) || index(sprintf('%J', x.dns ?? {}), 'geosite:') >= 0;
	if (geo && type(x['geox-url']) != 'object')
		step('geox', '设置 GEO 数据下载地址', '规则用到 GEOSITE/GEOIP，改用 jsDelivr 镜像，GitHub 直连不稳定时也能下载', true, () => {
			for (let k, v in GEOX)
				basic['geox-url.' + k] = v;
		});
	if (geo && host.mem_mb > 0 && host.mem_mb < LOW_MEM_MB && x['geodata-loader'] == null)
		step('geodata', 'GEO 数据省内存加载', '路由器内存 ' + host.mem_mb + ' MB，减少常驻内存', true, () => { basic['geodata-loader'] = 'memconservative'; });
	// 路由器上只能识别本机进程，下联设备的连接查不到进程，规则也很少用到
	if (x['find-process-mode'] == null && !rules_use(x, /(PROCESS-NAME|PROCESS-PATH|UID)/))
		step('process', '关闭进程查找', '规则没有按进程分流，关闭可降低 CPU 占用', true, () => { basic['find-process-mode'] = 'off'; });
	if (x['log-level'] == null || x['log-level'] == 'info' || x['log-level'] == 'debug')
		step('log', '降低日志级别', '改为 warning，减少日志占用的内存', true, () => { basic['log-level'] = 'warning'; });
	if (x['tcp-concurrent'] == null)
		step('tcp', '开启 TCP 并发', '同时连接域名解析出的多个 IP，用最快的那个', true, () => { basic['tcp-concurrent'] = true; });
	if (type(x.profile) != 'object' || x.profile['store-selected'] == null)
		step('profile', '记住手动选择的节点', '重启内核后保留在代理页手动选择的节点', true, () => { basic['profile.store-selected'] = true; });
	if (type(x.sniffer) != 'object')
		step('sniffer', '开启域名嗅探', '从 TLS/HTTP 握手里读出域名，按 IP 进来的连接也能按域名规则分流', true,
			() => { push(edits, { t: 'set', p: ['sniffer'], v: SNIFFER }); });

	if (err)
		return fail(err);
	if (length(keys(basic)))
		push(ops, { op: 'basic.set', data: basic });
	if (length(edits)) {
		U.mkdir_p(P.RUN_DIR);
		let work = P.RUN_DIR + '/adapt-' + U.rand_hex(4) + '.yaml';
		let e = U.write_file(work, fs.readfile(file)) ? (Y.edit(work, edits) ?? Y.commit(file, work)) : '无法写入临时文件';
		fs.unlink(work);
		if (e)
			return fail(e);
	}
	if (length(ops)) {
		let r = F.apply_ops(file, ops);
		if (r.error)
			return fail(r.error);
	}
	return { ok: true, changes: changes, adapted: map(filter(changes, (c) => c.applied), (c) => c.title) };
}

// 在临时副本上试运行补全，返回补全后的内容与改动清单，不改动任何配置。args：content、lan[]、secret、skip[]
function adapt_preview(args) {
	args = obj(args);
	if (type(args.content) != 'string' || trim(args.content) == '')
		return fail('配置内容为空');
	if (length(args.content) > MAX_CONTENT)
		return fail('配置内容过大（超过 4 MB）');
	U.mkdir_p(P.RUN_DIR);
	let work = P.RUN_DIR + '/preview-' + U.rand_hex(4) + '.yaml';
	if (!U.write_file(work, args.content))
		return fail('无法写入临时文件');
	let r = adapt(work, { lan: args.lan, secret: args.secret, skip: args.skip });
	let content = fs.readfile(work);
	fs.unlink(work);
	return r.ok ? { ok: true, changes: r.changes, content: content } : r;
}

/* ---------- 识别下载内容 ---------- */

const URI_RE = /^(ss|ssr|vmess|vless|trojan|hysteria|hysteria2|hy2|tuic|anytls|wireguard|wg|socks|socks5|snell|mieru|juicity):\/\//i;

function uri_list(text) {
	let lines = filter(map(split(text, '\n'), (l) => trim(l)), (l) => l != '');
	let hits = length(filter(lines, (l) => match(l, URI_RE)));
	return hits > 0 && hits * 2 >= length(lines);
}

// 判断内容是完整配置、节点订阅（分享链接或其 base64）还是别的。返回 { kind, summary?, message? }，kind 为 config / partial / subscription / invalid
function classify(text) {
	let t = trim(text ?? '');
	if (t == '')
		return { kind: 'invalid', message: '内容为空' };
	if (uri_list(t))
		return { kind: 'subscription', message: '这是节点分享链接列表，不是 mihomo 配置' };
	let compact = join('', map(split(t, '\n'), (l) => trim(l)));
	if (match(compact, /^[-A-Za-z0-9+=_\/]+$/)) {
		let b = replace(replace(compact, '-', '+'), '_', '/');
		while (length(b) % 4)
			b += '=';
		let dec = b64dec(b);
		if (type(dec) == 'string' && uri_list(dec))
			return { kind: 'subscription', message: '这是 base64 编码的节点订阅，不是 mihomo 配置' };
	}
	U.mkdir_p(P.RUN_DIR);
	let work = P.RUN_DIR + '/classify-' + U.rand_hex(4) + '.yaml';
	if (!U.write_file(work, text))
		return { kind: 'invalid', message: '无法写入临时文件' };
	let x = Y.query(work, 'explode(.)');
	fs.unlink(work);
	if (type(x) != 'object')
		return { kind: 'invalid', message: '不是 YAML 格式的 mihomo 配置' };
	let summary = {
		proxies: length(filter(x.proxies ?? [], (p) => obj(p).type != 'dns')),
		providers: length(keys(obj(x['proxy-providers']))),
		groups: (type(x['proxy-groups']) == 'array') ? length(x['proxy-groups']) : 0,
		rules: (type(x.rules) == 'array') ? length(x.rules) : 0
	};
	if (summary.proxies + summary.providers > 0 || summary.groups > 0 || summary.rules > 0)
		return { kind: 'config', summary: summary };
	return { kind: 'partial', summary: summary, message: '没有找到节点、订阅、策略组或规则，导入后可能无法上网' };
}

// 下载链接内容并识别。args：url、ua。完整配置时带回 content，供预览补全并以导入方式写入
function fetch_config(args) {
	args = obj(args);
	let url = C.url(args.url);
	if (url == null)
		return fail('配置地址无效（需要 http:// 或 https:// 开头）');
	let ua = DEFAULT_UA;
	if (!empty(args.ua)) {
		ua = C.text(args.ua, 256);
		if (!ua)
			return fail('User-Agent 无效');
	}
	U.mkdir_p(P.RUN_DIR);
	let out = P.RUN_DIR + '/fetch-' + U.rand_hex(4);
	// 订阅转换类地址不走 GitHub 镜像：服务运行时先经本机代理，再直连；每条线路限时，整体不超过 RPC 超时
	let r = CORE.fetch(url, out, { routes: CORE.routes({ mirror: '' }, CORE.proxy_port()), args: ['-A', ua, '--max-filesize', '' + (MAX_CONTENT + 1)], max_time: 9 });
	if (!r.ok)
		return fail(index(r.error, 'Maximum file size') >= 0 ? '下载的内容过大（超过 4 MB）' : '下载失败：' + r.error);
	let size = fs.stat(out)?.size ?? 0;
	let text = (size > 0 && size <= MAX_CONTENT) ? fs.readfile(out) : null;
	fs.unlink(out);
	if (size == 0)
		return fail('下载的内容为空');
	if (text == null)
		return fail('下载的内容过大（超过 4 MB）');
	let c = classify(text);
	let res = { ok: true, ...c };
	if (c.kind == 'config' || c.kind == 'partial')
		res.content = text;
	return res;
}

/* ---------- 状态 ---------- */

// network.lan 的设备（通常是 br-lan），取不到时为空
function lan_default() {
	let c = uci.cursor();
	let dev = c?.get('network', 'lan', 'device');
	if (type(dev) == 'array')
		dev = dev[0];
	if (dev == null && c?.get('network', 'lan', 'type') == 'bridge')
		dev = 'br-lan';
	return C.ifname(dev) ? [dev] : [];
}

function status() {
	return {
		ok: true,
		core: fs.access(P.BIN, 'x') == true,
		config: fs.stat(P.CONFIG) != null,
		autostart: length(fs.glob('/etc/rc.d/S??' + P.SERVICE) ?? []) > 0,
		running: S.running(),
		arch_ok: CORE.asset() != null,
		lan_default: lan_default(),
		rev: U.file_rev(P.CONFIG)
	};
}

/* ---------- setup 任务 ---------- */

// 在 apply.begin 中执行（持有锁）：模板与导入来源写好候选文件，下载来源留给后台任务。
// 返回 { error } 或 { opts }；opts 只给任务进程用，job_status 不会返回
function prepare(args) {
	args = obj(args);
	if (index(SOURCES, args.source) < 0)
		return { error: '未知的配置来源' };
	let start = !!args.start;
	if (args.source == 'template') {
		let r = render(args);
		if (!r.ok)
			return { error: r.error };
		return U.write_file(P.CANDIDATE, r.content) ? { opts: { start: start } } : { error: '无法写入候选配置' };
	}
	let opts = { start: start, adapt: !!args.adapt };
	if (opts.adapt) {
		let skip = check_skip(args.skip);
		if (skip == null)
			return { error: '跳过项无效' };
		if (length(skip))
			opts.skip = skip;
	}
	if (opts.adapt && args.lan != null) {
		let lan = check_lan(args.lan);
		if (!lan.ok)
			return { error: lan.error };
		opts.lan = lan.list;
	}
	if (args.source == 'import') {
		if (type(args.content) != 'string' || trim(args.content) == '')
			return { error: '导入的配置内容为空' };
		return U.write_file(P.CANDIDATE, args.content) ? { opts: opts } : { error: '无法写入候选配置' };
	}
	let url = C.url(args.url);
	if (url == null)
		return { error: '配置地址无效（需要 http:// 或 https:// 开头）' };
	let ua = DEFAULT_UA;
	if (!empty(args.ua)) {
		ua = C.text(args.ua, 256);
		if (!ua)
			return { error: 'User-Agent 无效' };
	}
	opts.url = url;
	opts.ua = ua;
	fs.unlink(P.CANDIDATE);
	return { opts: opts };
}

// 后台任务里、配置流程之前的步骤：下载（url 来源）与补全。返回 { adapted } 或 { error }
function job_pre(ctx, opts) {
	opts = obj(opts);
	if (opts.url) {
		ctx.step('download');
		// 订阅转换类地址不走 GitHub 镜像：服务运行时先经本机代理，再直连
		let r = CORE.fetch(opts.url, P.CANDIDATE, { routes: CORE.routes({ mirror: '' }, CORE.proxy_port()),
			args: ['-A', opts.ua ?? DEFAULT_UA] });
		if (!r.ok)
			return { error: '下载配置失败：' + r.error };
		if (!(fs.stat(P.CANDIDATE)?.size > 0)) {
			fs.unlink(P.CANDIDATE);
			return { error: '下载的配置为空' };
		}
	}
	if (!opts.adapt)
		return {};
	ctx.step('adapt');
	let r = adapt(P.CANDIDATE, { lan: opts.lan, skip: opts.skip });
	return r.ok ? { adapted: r.adapted } : { error: '补全失败：' + r.error };
}

export { UI_URL, FIP_URL, render, adapt, adapt_preview, classify, fetch_config, status, prepare, job_pre };
