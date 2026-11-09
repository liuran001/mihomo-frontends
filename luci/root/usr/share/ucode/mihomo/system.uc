'use strict';

import * as fs from 'fs';
import * as uci from 'uci';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import * as Y from 'mihomo.yaml';

function logs(lines) {
	lines = int(lines ?? 300);
	if (!(lines >= 1 && lines <= 2000))
		lines = 300;
	let r = U.run('logread -e ' + U.shq(P.LOG_TAG));
	return { ok: true, text: U.tail_lines(r.out, lines) };
}

// 诊断信息：系统、插件、内核与网络概况加最近日志，供用户复制后反馈问题。
// 不含配置文件内容；浏览器端会再把链接、密钥与公网地址打码。
function diagnostics() {
	let out = [];
	let section = (title) => push(out, '', '== ' + title + ' ==');
	let cmd = (c, n) => {
		let r = U.run(c);
		let text = rtrim(r.out ?? '', '\n');
		if (text != '')
			push(out, U.tail_lines(text, n ?? 40));
	};
	section('系统');
	let rel = fs.readfile('/etc/openwrt_release') ?? '';
	let m = match(rel, /DISTRIB_DESCRIPTION='([^']*)'/);
	push(out, '系统: ' + (m ? m[1] : '未知'));
	cmd('uname -srm');
	let model = trim(split(fs.readfile('/tmp/sysinfo/model') ?? '', '\n')[0] ?? '');
	if (model != '')
		push(out, '型号: ' + model);
	cmd('cat /proc/meminfo | head -n 3');
	section('软件包');
	if (fs.access('/usr/bin/apk', 'x'))
		cmd("apk list -I 2>/dev/null | grep -E 'mihomo|kmod-sched|kmod-veth|yq|curl'");
	else
		cmd("opkg list-installed 2>/dev/null | grep -E 'mihomo|kmod-sched|kmod-veth|yq|curl'");
	section('内核');
	if (fs.access(P.BIN, 'x'))
		cmd(U.shq(P.BIN) + ' -v | head -n 2');
	else
		push(out, '未安装');
	cmd(U.shq(P.INIT) + ' status');
	push(out, '开机自启: ' + (length(fs.glob('/etc/rc.d/S??' + P.SERVICE) ?? []) > 0 ? '是' : '否'));
	let st = fs.stat(P.CONFIG);
	push(out, '配置文件: ' + (st ? st.size + ' 字节' : '不存在'));
	section('网络');
	cmd("ip -o addr show | awk '{print $2, $3, $4}'");
	push(out, '-- ip rule');
	cmd('ip rule show');
	push(out, '-- 默认路由');
	cmd("ip route show table all | grep -E '^default'", 10);
	push(out, '-- tc 过滤器（eBPF）');
	cmd("for d in $(ls /sys/class/net); do tc filter show dev $d ingress 2>/dev/null | grep -q bpf && echo \"$d: ingress bpf\"; done");
	section('最近日志');
	cmd('logread -e ' + U.shq(P.LOG_TAG), 150);
	return { ok: true, text: join('\n', out) };
}

/* ---------- 局域网设备 ---------- */

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

function norm_mac(s) {
	s = lc(trim('' + (s ?? '')));
	return match(s, MAC_RE) ? s : null;
}

// leases_text：dnsmasq 租约（expiry mac ip name clientid）；static_hosts：[{mac, name, ip}]；neigh：ip -j neigh 的数组
function merge_devices(leases_text, static_hosts, neigh) {
	let by = {};
	let get = (mac) => (by[mac] ??= { mac: mac, name: null, ip4: null, ip6: [], dev: null, online: false });

	for (let line in split(leases_text ?? '', '\n')) {
		let f = split(trim(line), /[ \t]+/);
		let mac = norm_mac(f[1]);
		if (length(f) < 4 || !mac)
			continue;
		let d = get(mac);
		d.ip4 ??= f[2];
		if (f[3] != '*' && f[3] != '')
			d.name ??= f[3];
	}
	for (let h in static_hosts ?? []) {
		let mac = norm_mac(h.mac);
		if (!mac)
			continue;
		let d = get(mac);
		if (h.name)
			d.name = h.name;
		if (h.ip)
			d.ip4 = h.ip;
	}
	for (let n in neigh ?? []) {
		let mac = norm_mac(n?.lladdr);
		let st = n?.state ?? [];
		if (!mac || type(n.dst) != 'string' || index(st, 'FAILED') >= 0 || index(st, 'INCOMPLETE') >= 0)
			continue;
		let d = get(mac);
		d.dev ??= n.dev;
		if (index(n.dst, ':') >= 0) {
			if (index(d.ip6, n.dst) < 0)
				push(d.ip6, n.dst);
		} else
			d.ip4 ??= n.dst;
		if (length(filter(st, (s) => s == 'REACHABLE' || s == 'DELAY' || s == 'PROBE' || s == 'PERMANENT')))
			d.online = true;
	}

	let list = values(by);
	return sort(list, (a, b) => {
		if ((a.name == null) != (b.name == null))
			return a.name == null ? 1 : -1;
		let an = lc(a.name ?? ''), bn = lc(b.name ?? '');
		if (an != bn)
			return an < bn ? -1 : 1;
		let ai = a.ip4 ?? '', bi = b.ip4 ?? '';
		return ai < bi ? -1 : (ai > bi ? 1 : 0);
	});
}

// /etc/config/dhcp 中的静态分配；mac 可以是空格分隔的多个地址或列表
function static_hosts() {
	let res = [];
	let c = uci.cursor();
	c.foreach('dhcp', 'host', (s) => {
		let macs = type(s.mac) == 'array' ? s.mac : split(s.mac ?? '', /[ \t]+/);
		for (let m in macs)
			push(res, { mac: m, name: s.name, ip: s.ip });
	});
	return res;
}

function devices() {
	let neigh = [];
	let r = U.run('ip -j neigh show', { stderr: false });
	try {
		neigh = json(r.out);
	} catch (e) {
		neigh = [];
	}
	return { ok: true, list: merge_devices(fs.readfile(P.LEASES), static_hosts(), type(neigh) == 'array' ? neigh : []) };
}

/* ---------- 网络接口 ---------- */

function run_json(cmd) {
	let r = U.run(cmd, { stderr: false });
	try {
		let v = json(r.out);
		return type(v) == 'array' ? v : [];
	} catch (e) {
		return [];
	}
}

// addr：ip -j -d addr show 的数组；route4、route6：ip -j route show default 的数组
function merge_interfaces(addr, route4, route6) {
	let upstream = {};
	for (let r in [...(route4 ?? []), ...(route6 ?? [])])
		if (type(r?.dev) == 'string')
			upstream[r.dev] = true;
	let list = [];
	for (let a in addr ?? []) {
		let name = a?.ifname;
		if (type(name) != 'string' || name == 'lo')
			continue;
		let flags = type(a.flags) == 'array' ? a.flags : [];
		// 虚拟接口（tun、ppp 等）的 operstate 常为 UNKNOWN，此时看 UP 与 LOWER_UP
		let up = a.operstate == 'UP' ||
			(a.operstate == 'UNKNOWN' && index(flags, 'UP') >= 0 && index(flags, 'LOWER_UP') >= 0);
		let addrs = [];
		for (let x in a.addr_info ?? [])
			if (type(x?.local) == 'string' && x.scope != 'link')
				push(addrs, x.local + '/' + x.prefixlen);
		push(list, {
			name: name,
			type: a.link_type ?? null,
			up: up,
			master: a.master ?? null,
			kind: a.linkinfo?.info_kind ?? null,
			addrs: addrs,
			is_default_upstream: !!upstream[name]
		});
	}
	return sort(list, (x, y) => {
		if (x.up != y.up)
			return x.up ? -1 : 1;
		return x.name < y.name ? -1 : (x.name > y.name ? 1 : 0);
	});
}

function interfaces() {
	return { ok: true, list: merge_interfaces(run_json('ip -j -d addr show'),
		run_json('ip -j route show default'), run_json('ip -j -6 route show default')) };
}

/* ---------- Tailscale 登录状态 ---------- */

const TS_EXPR = '[explode(.) | .proxies[]? | select(.type == "tailscale") | {"name": .name, "dir": .["state-dir"]}]';

function b64json(v) {
	if (type(v) != 'string')
		return null;
	try {
		return json(b64dec(v));
	} catch (e) {
		return null;
	}
}

// state：tailscaled.state 解析后的对象。只解码 _current-profile 与 _profiles，不碰 _machinekey 与 profile-*。
function ts_profile(state) {
	let s = (type(state) == 'object') ? state : {};
	let cur = (type(s['_current-profile']) == 'string') ? b64dec(s['_current-profile']) : null;
	let profiles = b64json(s._profiles);
	let p = null;
	if (cur && type(profiles) == 'object')
		for (let id in profiles) {
			let x = profiles[id];
			if (type(x) == 'object' && (x.Key == cur || 'profile-' + id == cur))
				p = x;
		}
	if (!p)
		return { logged_in: false, login: null, tailnet: null, magic_dns: null };
	return {
		logged_in: type(p.NodeID) == 'string' && p.NodeID != '',
		login: p.UserProfile?.LoginName ?? null,
		tailnet: p.NetworkProfile?.DomainName ?? null,
		magic_dns: p.NetworkProfile?.MagicDNSName ?? null
	};
}

// 退出登录会整个删除状态目录，这些配置目录下的子目录绝不能当作状态目录
const TS_PROTECTED = ['backup', '.luci', 'substore', 'proxy_provider', 'rule_provider', 'ui'];

// 与 mihomo 一致：缺省为 tailscale，相对路径相对于配置目录。
// 按段规范化（去掉 . 与重复的 /，拒绝 ..），只接受配置目录之内、且不是配置目录本身或上面这些目录的路径；
// 否则 state-dir 写成「.」「./」时，退出登录会删掉整个配置目录。
function ts_dir(dir) {
	if (dir == null || dir == '')
		dir = 'tailscale';
	if (type(dir) != 'string')
		return null;
	let parts = [];
	for (let s in split((substr(dir, 0, 1) == '/') ? dir : P.HOME + '/' + dir, '/')) {
		if (s == '' || s == '.')
			continue;
		if (s == '..')
			return null;
		push(parts, s);
	}
	let p = '/' + join('/', parts);
	if (substr(p, 0, length(P.HOME) + 1) != P.HOME + '/')
		return null;
	let first = split(substr(p, length(P.HOME) + 1), '/')[0];
	return (index(TS_PROTECTED, first) >= 0) ? null : p;
}

function tailscale_status() {
	let list = [];
	for (let t in Y.query(P.CONFIG, TS_EXPR) ?? []) {
		let dir = ts_dir(t.dir);
		let state = null;
		if (dir) {
			try {
				state = json(fs.readfile(dir + '/tailscaled.state') ?? 'null');
			} catch (e) {
				state = null;
			}
		}
		push(list, { name: t.name, state_dir: dir, ...ts_profile(state) });
	}
	return { ok: true, list: list };
}

// 退出登录：删除状态目录。服务运行时先停止（否则 tsnet 退出时会把登录状态写回），删除后再启动。
function tailscale_logout(name) {
	if (type(name) != 'string' || name == '')
		return { ok: false, error: '名称无效' };
	let t = filter(Y.query(P.CONFIG, TS_EXPR) ?? [], (t) => t.name == name)[0];
	if (!t)
		return { ok: false, error: 'Tailscale 代理不存在：' + name };
	let dir = ts_dir(t.dir);
	if (!dir)
		return { ok: false, error: 'state-dir 必须在配置目录之内' };
	let was = system(U.shq(P.INIT) + ' running >/dev/null 2>&1') == 0;
	if (was) {
		let r = U.run(U.shq(P.INIT) + ' stop');
		if (r.code != 0)
			return { ok: false, error: '停止服务失败', detail: U.tail_lines(r.out, 20) };
	}
	let removed = U.rm_tree(dir);
	if (was) {
		let r = U.run(U.shq(P.INIT) + ' start');
		if (r.code != 0)
			return { ok: false, error: '已删除登录状态，但启动服务失败', detail: U.tail_lines(r.out, 20) };
	}
	return removed ? { ok: true, restarted: was } : { ok: false, error: '删除状态目录失败：' + dir };
}

export { logs, diagnostics, merge_devices, devices, merge_interfaces, interfaces, ts_profile, ts_dir, tailscale_status, tailscale_logout };
