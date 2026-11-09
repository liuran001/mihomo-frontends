'use strict';

import * as fs from 'fs';
import * as ubus from 'ubus';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import * as Y from 'mihomo.yaml';

const ACTIONS = ['start', 'stop', 'restart', 'enable', 'disable'];

let version_cache = { key: null, value: null };

function version() {
	let st = fs.stat(P.BIN);
	if (!st)
		return null;
	let key = sprintf('%d-%d', st.mtime, st.size);
	if (version_cache.key != key) {
		let r = U.run(U.shq(P.BIN) + ' -v');
		let m = match(r.out, /Mihomo Meta ([^ \n]+)/);
		version_cache = { key: key, value: m ? m[1] : trim(split(r.out, '\n')[0]) };
	}
	return version_cache.value;
}

function running() {
	return system(U.shq(P.INIT) + ' running >/dev/null 2>&1') == 0;
}

// procd 中该服务的第一个实例
function instance() {
	let c = ubus.connect();
	if (!c)
		return null;
	let r = c.call('service', 'list', { name: P.SERVICE });
	c.disconnect();
	for (let k, inst in (r?.[P.SERVICE]?.instances ?? {}))
		return inst;
	return null;
}

function proc_info(pid) {
	let stat = fs.readfile('/proc/' + pid + '/stat');
	let up = fs.readfile('/proc/uptime');
	if (!stat || !up)
		return {};
	// 第 2 个字段 comm 可能含空格，从最后一个 ')' 之后开始数；starttime 是第 22 个字段
	let rest = split(substr(stat, rindex(stat, ')') + 2), ' ');
	let start_s = +rest[19] / 100;
	let m = match(fs.readfile('/proc/' + pid + '/status') ?? '', /VmRSS:[ \t]*([0-9]+)/);
	return { uptime: int(+split(up, ' ')[0] - start_s), rss_kb: m ? +m[1] : null };
}

function status() {
	let inst = instance();
	let res = {
		running: !!inst?.running,
		pid: inst?.pid ?? null,
		uptime: null,
		rss_kb: null,
		version: version(),
		autostart: length(fs.glob('/etc/rc.d/S??' + P.SERVICE) ?? []) > 0,
		config_rev: U.file_rev(P.CONFIG),
		config_present: fs.stat(P.CONFIG) != null,
		yq_present: Y.available()
	};
	if (res.running && res.pid) {
		let pi = proc_info(res.pid);
		res.uptime = pi.uptime;
		res.rss_kb = pi.rss_kb;
	}
	return res;
}

function action(name) {
	if (index(ACTIONS, name) < 0)
		return { ok: false, error: '不支持的操作：' + name };
	let r = U.run(U.shq(P.INIT) + ' ' + name);
	if (r.code != 0)
		return { ok: false, error: '执行失败', detail: U.tail_lines(r.out, 20) };
	return { ok: true };
}

// 浏览器直连控制器所需的信息；secret 只返回给已登录的 LuCI 会话（ACL 只读组）
// 明文与 TLS 监听分别上报，页面按自己的协议选择；external-controller-tls 需同时配置 external-controller
function endpoint(listen, addr, name) {
	if (!addr)
		return { listen: listen, host: null, port: null, reachable: false,
			reason: listen ? '无法识别 ' + name + ' 的写法：' + listen : null };
	if (addr.loopback)
		return { listen: listen, host: null, port: null, reachable: false,
			reason: (name == 'external-controller' ? '控制器' : 'TLS 控制器') +
				'只监听本机地址，浏览器无法直连；请把 ' + name + ' 改为 0.0.0.0:' + addr.port };
	return { listen: listen, host: addr.host, port: addr.port, reachable: true, reason: null };
}

function controller() {
	let c = Y.controller_of(P.CONFIG);
	if (!c)
		return { ok: false, error: '无法读取配置文件' };
	let plain = endpoint(c.listen, c.addr, 'external-controller');
	if (!c.listen)
		plain.reason = '配置中没有 external-controller，页面无法连接 mihomo';
	let res = { ok: true, listen: plain.listen, secret: c.secret, host: plain.host, port: plain.port,
		reachable: plain.reachable, reason: plain.reason, tls: null, ui: c.ui, ui_name: c.ui_name };
	if (c.tls_listen)
		res.tls = endpoint(c.tls_listen, c.tls_addr, 'external-controller-tls');
	return res;
}

export { version, running, instance, proc_info, status, action, controller };
