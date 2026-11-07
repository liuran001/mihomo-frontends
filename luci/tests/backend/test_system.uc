'use strict';

import * as fs from 'fs';
import * as SY from 'mihomo.system';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import { ok, eq, done } from 'lib';

let leases = join('\n', [
	'1793765867 AA:BB:CC:DD:EE:01 192.168.77.138 W10-PC 01:aa:bb:cc:dd:ee:01',
	'1793764455 AA:BB:CC:DD:EE:02 192.168.77.200 * 01:AA:BB:CC:DD:EE:02',
	''
]);
let statics = [
	{ mac: 'AA:BB:CC:DD:EE:02', name: 'usb-host', ip: '192.168.77.200' },
	{ mac: 'aa:aa:aa:aa:aa:aa', name: 'printer', ip: '192.168.77.50' }
];
let neigh = [
	{ dst: '192.168.77.138', dev: 'br-lan', lladdr: 'aa:bb:cc:dd:ee:01', state: ['REACHABLE'] },
	{ dst: '2409:8d50::1', dev: 'br-lan', lladdr: 'aa:bb:cc:dd:ee:01', state: ['STALE'] },
	{ dst: 'fe80::1', dev: 'br-lan', lladdr: 'aa:bb:cc:dd:ee:01', state: ['STALE'] },
	{ dst: '192.168.77.190', dev: 'br-lan', lladdr: 'aa:bb:cc:dd:ee:03', state: ['REACHABLE'] },
	{ dst: '192.168.77.99', dev: 'br-lan', state: ['FAILED'] },
	{ dst: '192.168.77.98', dev: 'br-lan', lladdr: '11:11:11:11:11:11', state: ['INCOMPLETE'] }
];

let list = SY.merge_devices(leases, statics, neigh);
eq(map(list, (d) => d.mac), ['aa:aa:aa:aa:aa:aa', 'aa:bb:cc:dd:ee:02', 'aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:03'],
	'按名称排序，无名称的排最后；FAILED、INCOMPLETE 与无 MAC 的邻居被忽略');
let pc = filter(list, (d) => d.mac == 'aa:bb:cc:dd:ee:01')[0];
eq([pc.name, pc.ip4, pc.ip6, pc.dev, pc.online], ['W10-PC', '192.168.77.138', ['2409:8d50::1', 'fe80::1'], 'br-lan', true],
	'租约与邻居按 MAC 合并（MAC 转小写）');
let usb = filter(list, (d) => d.mac == 'aa:bb:cc:dd:ee:02')[0];
eq([usb.name, usb.ip4, usb.online], ['usb-host', '192.168.77.200', false], '静态分配的名称优先，租约名 * 视为无名称');
let anon = filter(list, (d) => d.mac == 'aa:bb:cc:dd:ee:03')[0];
eq([anon.name, anon.ip4, anon.online], [null, '192.168.77.190', true], '只在邻居表中的设备');
eq(SY.merge_devices(null, [], []), [], '没有任何来源时返回空数组');
eq(length(SY.merge_devices('garbage line\n', [], [{ dst: 'x' }])), 0, '忽略格式不对的行');

let r = SY.devices();
ok(r.ok && type(r.list) == 'array', 'devices() 在路由器上返回数组', r);
ok(length(filter(r.list, (d) => match(d.mac, /^[0-9a-f:]{17}$/) == null)) == 0, 'MAC 格式统一');

/* ---------- 网络接口 ---------- */

let addr = [
	{ ifname: 'lo', link_type: 'loopback', operstate: 'UNKNOWN', flags: ['LOOPBACK', 'UP', 'LOWER_UP'], addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8, scope: 'host' }] },
	{ ifname: 'wan0', link_type: 'none', operstate: 'UP', flags: ['NOARP', 'UP', 'LOWER_UP'],
		addr_info: [{ family: 'inet', local: '10.1.2.3', prefixlen: 30, scope: 'global' }, { family: 'inet6', local: 'fe80::1', prefixlen: 64, scope: 'link' }] },
	{ ifname: 'usb0', link_type: 'ether', operstate: 'DOWN', flags: ['NO-CARRIER', 'UP'], master: 'br-lan', linkinfo: { info_slave_kind: 'bridge' }, addr_info: [] },
	{ ifname: 'br-lan', link_type: 'ether', operstate: 'UP', flags: ['UP', 'LOWER_UP'], linkinfo: { info_kind: 'bridge' },
		addr_info: [{ family: 'inet', local: '192.168.77.1', prefixlen: 24, scope: 'global' }] },
	{ ifname: 'tun0', link_type: 'none', operstate: 'UNKNOWN', flags: ['POINTOPOINT', 'UP', 'LOWER_UP'], linkinfo: { info_kind: 'tun' } },
	{ link_type: 'ether' }
];
let ifs = SY.merge_interfaces(addr, [{ dst: 'default', dev: 'wan0' }], [{ dst: 'default', gateway: 'fe80::1', dev: 'wan0' }]);
eq(map(ifs, (i) => i.name), ['br-lan', 'tun0', 'wan0', 'usb0'], '去掉 lo 与无名称项；启用的排前，再按名称');
eq(ifs[0], { name: 'br-lan', type: 'ether', up: true, master: null, kind: 'bridge', addrs: ['192.168.77.1/24'], is_default_upstream: false }, '网桥');
eq([ifs[1].up, ifs[1].kind], [true, 'tun'], 'UNKNOWN 但 UP|LOWER_UP 视为启用');
eq([ifs[2].is_default_upstream, ifs[2].addrs], [true, ['10.1.2.3/30']], '默认路由出口；不列出链路本地地址');
eq([ifs[3].up, ifs[3].master], [false, 'br-lan'], '桥接成员与未连接');
eq(SY.merge_interfaces(null, null, null), [], '没有数据时返回空数组');
r = SY.interfaces();
// 本机（WSL）没有 br-lan，只检查能列出网卡
if (getenv('MIHOMO_TEST_LOCAL'))
	ok(r.ok && length(r.list) > 0, 'interfaces() 能列出本机网卡', r);
else
	ok(r.ok && length(filter(r.list, (i) => i.name == 'br-lan')) == 1, 'interfaces() 在路由器上能列出 br-lan', r);

/* ---------- Tailscale 登录状态 ---------- */

const SECRET = 'privkey:0123456789abcdef-should-not-leak';
let profiles = {
	dea8: { ID: 'dea8', Name: 'u@example.com', Key: 'profile-dea8', NodeID: 'nX1', ControlURL: 'https://controlplane.tailscale.com',
		UserProfile: { LoginName: 'u@example.com', DisplayName: 'U' },
		NetworkProfile: { MagicDNSName: 'tail1234.ts.net', DomainName: 'u@example.com' } },
	beef: { ID: 'beef', Key: 'profile-beef', NodeID: 'nX2', UserProfile: { LoginName: 'other@example.com' } }
};
let state = {
	'_current-profile': b64enc('profile-dea8'),
	'_machinekey': b64enc(SECRET),
	'_profiles': b64enc(sprintf('%J', profiles)),
	'profile-dea8': b64enc(sprintf('%J', { PrivateNodeKey: SECRET }))
};
let st = SY.ts_profile(state);
eq(st, { logged_in: true, login: 'u@example.com', tailnet: 'u@example.com', magic_dns: 'tail1234.ts.net' }, '解码当前账号');
ok(index(sprintf('%J', st), 'privkey') < 0, '结果不含密钥');
eq(SY.ts_profile({ ...state, '_current-profile': b64enc('profile-none') }).logged_in, false, '当前 profile 不存在时未登录');
eq(SY.ts_profile(null).logged_in, false, '没有 state 文件时未登录');
eq(SY.ts_profile({ _profiles: 'not base64 json!' }).logged_in, false, '格式不对时未登录');

eq(SY.ts_dir(null), P.HOME + '/tailscale', 'state-dir 缺省为 tailscale');
eq(SY.ts_dir('ts-a'), P.HOME + '/ts-a', '相对路径相对配置目录');
eq(SY.ts_dir('../x'), null, '拒绝配置目录之外');
eq(SY.ts_dir('/tmp/x'), null, '拒绝配置目录之外的绝对路径');
eq(SY.ts_dir('.'), null, '拒绝配置目录本身（退出登录会删掉整个配置目录）');
eq(SY.ts_dir('./'), null, '拒绝 ./');
eq(SY.ts_dir(P.HOME + '/.'), null, '拒绝绝对路径写法的配置目录本身');
eq(SY.ts_dir('backup'), null, '拒绝备份目录');
eq(SY.ts_dir('./ts-a//x/'), P.HOME + '/ts-a/x', '规范化多余的 . 与 /');

U.write_file(P.CONFIG, 'proxies:\n  - name: TS-A\n    type: tailscale\n    state-dir: ts-a\n  - {name: S, type: socks5, server: 127.0.0.1, port: 1}\n  - {name: TS-B, type: tailscale}\n');
U.mkdir_p(P.HOME + '/ts-a');
U.write_file(P.HOME + '/ts-a/tailscaled.state', sprintf('%J', state));
r = SY.tailscale_status();
eq(r, { ok: true, list: [
	{ name: 'TS-A', state_dir: P.HOME + '/ts-a', logged_in: true, login: 'u@example.com', tailnet: 'u@example.com', magic_dns: 'tail1234.ts.net' },
	{ name: 'TS-B', state_dir: P.HOME + '/tailscale', logged_in: false, login: null, tailnet: null, magic_dns: null }
] }, 'tailscale_status 列出每个 tailscale 代理');
ok(index(sprintf('%J', r), 'privkey') < 0, 'tailscale_status 不含密钥');

// 退出登录：只删配置目录之内的状态目录；本机测试没有 init 脚本（服务视为未运行），路由器上不重启真实服务，只测失败分支
eq(SY.tailscale_logout('').ok, false, '退出登录：名称不能为空');
eq(SY.tailscale_logout('Nope').ok, false, '退出登录：出站必须存在');
U.write_file(P.CONFIG, 'proxies:\n  - {name: TS-A, type: tailscale, state-dir: ts-a}\n  - {name: TS-X, type: tailscale, state-dir: /tmp/ts-x}\n');
r = SY.tailscale_logout('TS-X');
ok(!r.ok && index(r.error, '配置目录') >= 0, '退出登录：拒绝配置目录之外的 state-dir', r);
if (getenv('MIHOMO_TEST_LOCAL')) {
	r = SY.tailscale_logout('TS-A');
	eq([r, fs.stat(P.HOME + '/ts-a')], [{ ok: true, restarted: false }, null], '退出登录：删除状态目录');
}


// 诊断信息：各区段都在，命令失败时不报错
let d = SY.diagnostics();
ok(d.ok && index(d.text, '== 系统 ==') >= 0 && index(d.text, '== 内核 ==') >= 0 && index(d.text, '== 最近日志 ==') >= 0, 'diagnostics 区段齐全');

done();
