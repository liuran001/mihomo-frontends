'use strict';
'require baseclass';

/* 下联设备：名单（eBPF 入站 shared.include-* / exclude-*）的解析与生成，以及按来源 IP 的流量采样。
 * 名单判断在内核的 eBPF 程序里完成：不走代理的设备直接放行、不进 mihomo（所以也统计不到它们的流量）。
 * 黑名单（exclude）MAC 或来源地址任一命中即排除且优先；白名单（include）MAC 或来源地址任一命中即走代理
 * （需要新内核，旧内核要求两者同时满足）。 */

const KEYS = [ 'include-mac-address', 'include-source-cidr', 'exclude-mac-address', 'exclude-source-cidr' ];

// 一条名单：MAC（aa:bb:cc:dd:ee:ff，也接受 - 分隔或不分隔）或 IP / 网段；无效返回 null
function entry(text) {
	const v = String(text || '').trim().toLowerCase();
	if (/^[0-9a-f]{2}([-:])[0-9a-f]{2}(\1[0-9a-f]{2}){4}$/.test(v) || /^[0-9a-f]{12}$/.test(v) || /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(v))
		return { kind: 'mac', value: v.replace(/[-:.]/g, '').match(/../g).join(':') };
	const m = /^([0-9a-f:.]+)(\/(\d{1,3}))?$/.exec(v);
	if (!m) return null;
	const ip4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(m[1]);
	if (ip4) {
		if (ip4.slice(1).some(n => +n > 255) || (m[3] != null && +m[3] > 32)) return null;
		return { kind: 'ip', value: m[1] + '/' + (m[3] != null ? m[3] : '32') };
	}
	// IPv6：8 段，或含一个 :: 时不超过 7 段；每段 1–4 位十六进制（不支持内嵌 IPv4 写法）
	const parts = m[1].split(':'), compressed = m[1].split('::').length - 1;
	const groups = m[1].split('::').join(':').split(':').filter(g => g !== '');
	if (compressed > 1 || (compressed === 0 && parts.length !== 8) || (compressed === 1 && groups.length > 7) ||
		!groups.every(g => /^[0-9a-f]{1,4}$/.test(g)) || (m[3] != null && +m[3] > 128)) return null;
	return { kind: 'ip', value: m[1] + '/' + (m[3] != null ? m[3] : '128') };
}

// 配置里的四个列表 → { mode: exclude | include, entries, mixed }。
// 两种名单都空时为黑名单（空黑名单 = 全部走代理）；同时有 include 与 exclude 时按白名单显示，mixed 为真
function policy(shared) {
	const list = k => ((shared && shared[k]) || []).map(String);
	const inc = list('include-mac-address').concat(list('include-source-cidr'));
	const exc = list('exclude-mac-address').concat(list('exclude-source-cidr'));
	if (inc.length) return { mode: 'include', entries: inc, mixed: exc.length > 0 };
	return { mode: 'exclude', entries: exc, mixed: false };
}

// 模式与名单 → 四个列表（空列表表示删除）；白名单为空时抛出说明
function data(mode, entries) {
	const out = {};
	KEYS.forEach(k => { out[k] = []; });
	if (mode === 'all') return out;
	const uniq = (v, i, a) => a.indexOf(v) === i;
	const items = entries.map(e => entry(e)).filter(Boolean);
	const macs = items.filter(e => e.kind === 'mac').map(e => e.value).filter(uniq);
	const ips = items.filter(e => e.kind === 'ip').map(e => e.value).filter(uniq);
	if (mode === 'include') {
		if (!macs.length && !ips.length) throw new Error('设备名单：白名单至少选一台走代理的设备；不想代理任何下联设备请在「设置 › 透明代理」里关闭「下联设备」');
		out['include-mac-address'] = macs;
		out['include-source-cidr'] = ips;
	} else {
		out['exclude-mac-address'] = macs;
		out['exclude-source-cidr'] = ips;
	}
	return out;
}

// IPv4 地址 → 32 位整数；不是 IPv4 时返回 null
function ip4(text) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
	return m && m.slice(1).every(n => +n <= 255) ? ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0 : null;
}

// 网段是否包含地址：IPv4 按前缀比较；IPv6 只认整条地址（/128）
function contains(cidr, addr) {
	const [ net, bits ] = String(cidr).split('/');
	const a = ip4(String(addr)), n = ip4(net);
	if (a != null && n != null) {
		const len = bits == null ? 32 : +bits;
		const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
		return ((a & mask) >>> 0) === ((n & mask) >>> 0);
	}
	return a == null && n == null && net.toLowerCase() === String(addr).toLowerCase() && (bits == null || +bits === 128);
}

// 设备是否走代理（与内核的判断一致）：黑名单任一命中即不走；白名单任一命中才走
function proxied(mode, entries, dev) {
	const addrs = [ dev.ip4 ].concat(dev.ip6 || []).filter(Boolean);
	const hit = entries.some(e => e === dev.mac || addrs.some(a => contains(e, a)));
	return mode === 'include' ? hit : !hit;
}

/* 流量采样：内核 /connections/sources 给出每个来源 IP 的累计流量（含已关闭连接），
 * 相邻两次采样相减得出速率。push 返回 { ip: { up, down, upRate, downRate } }。 */
function sampler() {
	let last = null;
	return {
		push(list, now) {
			const totals = {};
			(list || []).forEach(s => {
				const key = String(s.source || '').toLowerCase();
				if (key) totals[key] = { up: +s.upload || 0, down: +s.download || 0 };
			});
			const prev = last;
			last = { at: now, totals };
			const sec = prev ? (now - prev.at) / 1000 : 0;
			const out = {};
			Object.keys(totals).forEach(k => {
				const t = totals[k], p = prev && prev.totals[k];
				out[k] = { up: t.up, down: t.down,
					upRate: p && sec > 0.2 ? Math.max(0, (t.up - p.up) / sec) : 0,
					downRate: p && sec > 0.2 ? Math.max(0, (t.down - p.down) / sec) : 0 };
			});
			return out;
		}
	};
}

// 一组地址（或一条网段名单）的流量合计；没有任何记录时返回 null
function traffic(stats, addrs) {
	let hit = null;
	Object.keys(stats || {}).forEach(k => {
		if (!addrs.some(a => a && (a.toLowerCase() === k || (a.indexOf('/') > 0 && contains(a, k))))) return;
		const s = stats[k];
		hit = hit || { up: 0, down: 0, upRate: 0, downRate: 0 };
		hit.up += s.up; hit.down += s.down; hit.upRate += s.upRate; hit.downRate += s.downRate;
	});
	return hit;
}

return baseclass.extend({ KEYS, entry, policy, data, contains, proxied, sampler, traffic });
