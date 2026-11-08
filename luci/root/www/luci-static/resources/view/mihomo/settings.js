'use strict';
'require view';
'require ui';
'require form';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';

/* 设置：透明代理（eBPF 入站）、基础、DNS、Tailscale。每个标签是一个 form.JSONMap；
 * 保存时只提交与打开页面时不同的字段，所有标签的修改合成一次 patch。 */

// [数据键（点号表示嵌套）, 类型]；表单选项名把点号换成 __（LuCI 用点号拼接元素 id）
const SPECS = {
	ebpf: [
		[ 'local_enable', 'bool' ], [ 'shared_enable', 'bool' ], [ 'network', 'list' ], [ 'udp-timeout', 'int' ],
		[ 'bypass-rule-set', 'list' ], [ 'fakeip-icmp', 'str' ], [ 'tc-priority', 'int' ], [ 'bypass-tun-direct', 'bool' ],
		[ 'local.data-plane', 'str' ], [ 'local.dns-mode', 'str' ], [ 'local.ipv6', 'bool' ], [ 'local.bypass-private-address', 'bool' ],
		[ 'local.bypass-exclude', 'list' ], [ 'local.bypass-port', 'list' ],
		[ 'shared.interface', 'list' ], [ 'shared.data-plane', 'str' ], [ 'shared.dns-mode', 'str' ], [ 'shared.ipv6', 'bool' ],
		[ 'shared.bypass-private-address', 'bool' ], [ 'shared.allow-default-upstream', 'bool' ], [ 'shared.bypass-exclude', 'list' ],
		[ 'shared.bypass-port', 'list' ]
	],
	basic: [
		[ 'mixed-port', 'int' ], [ 'allow-lan', 'bool' ], [ 'bind-address', 'str' ], [ 'ipv6', 'bool' ], [ 'log-level', 'str' ],
		[ 'find-process-mode', 'str' ], [ 'tcp-concurrent', 'bool' ], [ 'unified-delay', 'bool' ], [ 'sniffer.enable', 'bool' ],
		[ 'external-controller', 'str' ], [ 'secret', 'str' ], [ 'external-ui', 'str' ], [ 'external-ui-url', 'str' ],
		[ 'geox-url.geoip', 'str' ], [ 'geox-url.geosite', 'str' ], [ 'geox-url.mmdb', 'str' ], [ 'geo-auto-update', 'bool' ], [ 'geodata-loader', 'str' ],
		[ 'profile.store-selected', 'bool' ]
	],
	dns: [
		[ 'enable', 'bool' ], [ 'listen', 'str' ], [ 'enhanced-mode', 'str' ], [ 'ipv6', 'bool' ], [ 'fake-ip-range', 'str' ],
		[ 'fake-ip-range6', 'str' ], [ 'default-nameserver', 'list' ], [ 'nameserver', 'list' ], [ 'proxy-server-nameserver', 'list' ],
		[ 'direct-nameserver', 'list' ], [ 'fake-ip-filter', 'list' ]
	],
	tailscale: [
		[ 'hostname', 'str' ], [ 'auth-key', 'str' ], [ 'udp', 'bool' ], [ 'accept-routes', 'bool' ], [ 'exit-node', 'str' ], [ 'advertise-exit-node', 'bool' ],
		[ 'advertise-routes', 'list' ], [ 'listen-port', 'int' ]
	]
};

function optName(key) {
	return key.replace(/\./g, '__');
}

function getPath(obj, key) {
	return key.split('.').reduce((o, k) => (o != null && typeof o === 'object') ? o[k] : null, obj);
}

function setPath(obj, key, v) {
	const ks = key.split('.');
	let o = obj;
	for (let i = 0; i < ks.length - 1; i++) o = (o[ks[i]] = o[ks[i]] || {});
	o[ks[ks.length - 1]] = v;
}

// 区段数据 → JSONMap 的值：布尔为 '1'/'0'，数字为字符串，列表原样；没有值为 null（表单显示默认值）
function toForm(kind, data) {
	const out = {};
	SPECS[kind].forEach(([ key, t ]) => {
		const v = data ? getPath(data, key) : null;
		let f = null;
		if (v != null) {
			if (t === 'bool') f = v ? '1' : '0';
			else if (t === 'list') f = Array.isArray(v) ? v.map(String) : [ String(v) ];
			else f = String(v);
		}
		out[optName(key)] = f;
	});
	return out;
}

// 表单值 → patch 的 data（嵌套）；空字符串、空列表表示删除（使用默认值），由后端处理
function fromForm(kind, form, only) {
	const out = {};
	SPECS[kind].forEach(([ key, t ]) => {
		const name = optName(key);
		if (only && only.indexOf(name) < 0) return;
		let v = form[name];
		if (t === 'bool') v = (v == null || v === '') ? null : (v === '1' || v === true);
		else if (t === 'int') v = (v == null || String(v).trim() === '') ? '' : Number(String(v).trim());
		else if (t === 'list') v = Array.isArray(v) ? v.map(s => String(s).trim()).filter(s => s !== '') : ((v == null || v === '') ? [] : [ String(v).trim() ]);
		else v = (v == null) ? '' : String(v).trim();
		setPath(out, key, v);
	});
	return out;
}

function canon(v) {
	if (Array.isArray(v)) return v.map(canon);
	if (v && typeof v === 'object') {
		const o = {};
		Object.keys(v).sort().forEach(k => { o[k] = canon(v[k]); });
		return o;
	}
	return v;
}

// 两份数据是否不同（忽略键顺序；null 与 '' 视为相同）
function changed(a, b) {
	const norm = v => (v === '' || v === undefined) ? null : v;
	return JSON.stringify(canon(norm(a))) !== JSON.stringify(canon(norm(b)));
}

// 打开页面时与现在的表单值比较，返回有变化的选项名
function changedFields(before, now) {
	return Object.keys(now).filter(k => changed(before[k], now[k]));
}

// DNS 策略表：服务器用空格或逗号分隔
function policyRows(list) {
	return (list || []).map(p => ({ key: p.key, servers: (p.servers || []).join(' ') }));
}

function policyData(rows) {
	return rows.map(r => ({ key: String(r.key || '').trim(), servers: String(r.servers || '').split(/[\s,]+/).filter(Boolean) }))
		.filter(r => r.key !== '' || r.servers.length);
}

// serve 表格行 → 提交给 tailscale.set 的数组；空行忽略，格式错误时抛出说明
const SERVE_HTTP = /^http:\/\/(\d{1,3}(\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\]):(\d{1,5})\/?$/;
const SERVE_UNIX = /^unix:(\/\/)?\S+$/;
function serveData(rows, strict) {
	const out = [], seen = {};
	rows.forEach(r => {
		const p = String(r.port || '').trim(), t = String(r.target || '').trim();
		if (!p && !t) return;
		const n = Number(p), m = SERVE_HTTP.exec(t);
		if (strict) {
			if (!/^\d+$/.test(p) || n < 1 || n > 65535) throw new Error('端口转发：端口须为 1-65535：' + (p || '（空）'));
			if (seen[n]) throw new Error('端口转发：端口重复：' + n);
			if (!(m && Number(m[3]) >= 1 && Number(m[3]) <= 65535) && !SERVE_UNIX.test(t))
				throw new Error('端口转发：目标须为 http://IP:端口 或 unix:路径：' + (t || '（空）'));
		}
		seen[n] = true;
		out.push({ port: n, target: m ? t.replace(/\/$/, '') : t });
	});
	return out;
}

// 内核 /tailscale 接口：启动后端并等待登录结果（auth key 自动登录，或返回 authURL）
function tsKernelLogin(name, wait) {
	return api.request('POST', '/tailscale/' + encodeURIComponent(name) + '/login?wait=' + wait, undefined, { timeout: (wait + 10) * 1000 });
}

function tsIdentity(live, saved) {
	if (!live || live.state === 'NotStarted') return saved;
	return {
		logged_in: live.state === 'Running',
		login: live.login || null,
		tailnet: live.tailnet || null,
		magic_dns: (live.self && live.self.dnsName) || null,
		state_dir: saved.state_dir
	};
}

function tsStateLabel(live, st, t) {
	const tag = (cls, text) => E('span', { 'class': cls }, text);
	if (live) {
		switch (live.state) {
		case 'Running': return tag('mh-ok', '在线');
		case 'Starting': return tag('mh-warn', '连接中…');
		case 'NeedsMachineAuth': return tag('mh-warn', '等待管理员在 Tailscale 后台批准这台设备');
		case 'NeedsLogin': return tag('mh-warn', t['auth-key'] ? '需要登录（auth key 可能无效或已过期）' : '需要登录');
		case 'NotStarted':
			return st.logged_in ? tag('mh-warn', '已登录，未启动（有流量或点「立即连接」时启动）')
				: tag('mh-warn', t['auth-key'] ? '未登录（已填写 auth key，点「立即连接」或有流量时登录）' : '未登录');
		default: return tag('mh-warn', live.state || '未知');
		}
	}
	if (st.logged_in) return tag('mh-ok', '已登录');
	return tag('mh-warn', t['auth-key'] ? '未登录（已填写 auth key，服务启动并有流量时自动登录）' : '未登录');
}

const TABS = [ [ 'ebpf', '透明代理' ], [ 'basic', '基础' ], [ 'dns', 'DNS' ], [ 'tailscale', 'Tailscale' ] ];
const DNS_MODES = [ [ 'hijack', 'hijack：接管 DNS 查询' ], [ 'respect_policy', 'respect_policy：按规则决定是否接管' ], [ 'off', 'off：不处理 DNS' ] ];

return view.extend({
	SPECS, toForm, fromForm, changed, changedFields, policyRows, policyData, serveData, tsIdentity,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.resolve();
	},

	render() {
		mui.loadCss();
		this.tab = this.tab || 'ebpf';
		this.tabBtns = TABS.map(([ id, title ]) => E('button', { 'class': 'mh-seg-btn', 'data-tab': id, 'click': () => this.showTab(id) }, title));
		this.panels = {};
		TABS.forEach(([ id ]) => { this.panels[id] = E('div', { 'class': 'mh-set-panel' }); });
		this.saveBtn = mui.btn('保存并应用', () => this.save(), 'cbi-button-apply');
		this.resetBtn = mui.btn('放弃修改', () => this.reload(), '');
		this.body = E('div', {}, mui.card('', mui.empty('读取中…')));
		const root = E('div', { 'class': 'mh mh-settings' }, [
			header.render(),
			E('div', { 'class': 'mh-card mh-px-toolbar mh-toolbar' }, [ E('div', { 'class': 'mh-seg' }, this.tabBtns), E('span', { 'class': 'mh-grow' }) ]),
			this.body,
			E('div', { 'class': 'mh-set-foot' }, [ this.resetBtn, this.saveBtn ])
		]);
		this.reload();
		return root;
	},

	showTab(id) {
		this.tab = id;
		this.tabBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === id));
		Object.keys(this.panels).forEach(k => { this.panels[k].hidden = k !== id; });
	},

	reload() {
		this.saveBtn.disabled = true;
		return Promise.all([
			api.rpc.sections([ 'ebpf', 'basic', 'dns', 'tailscale' ]),
			api.rpc.interfaces().catch(() => null),
			api.rpc.tailscale().catch(() => null),
			// 内核运行时的实时状态（旧内核没有这个接口，或服务未运行时为 null）
			api.get('/tailscale', { timeout: 6000 }).catch(() => null)
		]).then(([ s, ifs, ts, live ]) => {
			if (!s || !s.ok) throw new Error((s && s.error) || '读取失败');
			if (s.parse_error) {
				this.body.replaceChildren(mui.card('', mui.empty(s.parse_error, E('a', { href: L.url('admin/services/mihomo/config') }, '打开配置文件页'))));
				return;
			}
			this.rev = s.rev;
			this.sec = s;
			this.ifs = (ifs && ifs.ok && ifs.list) || [];
			this.tsStatus = (ts && ts.ok && ts.list) || [];
			this.tsLive = (live && Array.isArray(live.tailscale)) ? live.tailscale : null;
			this.forms = {};
			return Promise.all([ this.buildEbpf(), this.buildBasic(), this.buildDns(), this.buildTailscale() ]).then(() => {
				this.body.replaceChildren(...TABS.map(([ id ]) => this.panels[id]));
				this.showTab(this.tab);
				this.saveBtn.disabled = false;
			});
		}).catch(e => {
			this.body.replaceChildren(mui.card('', mui.empty('无法读取设置：' + e.message)));
		});
	},

	// 渲染一个 JSONMap，记录打开时的表单值。sid 为区段名，kind 为 SPECS 的键
	mount(panel, key, kind, sid, data, build, extra) {
		const values = {};
		values[sid] = toForm(kind, data);
		const m = new form.JSONMap(values, null, null);
		const s = m.section(form.NamedSection, sid, sid);
		s.anonymous = true;
		build(s, data);
		return m.render().then(node => {
			const entry = { m: m, s: s, sid: sid, kind: kind, before: s.formvalue(sid), extra: extra || null };
			this.forms[key] = entry;
			panel.appendChild(node);
			return entry;
		});
	},

	unsupported(panel, reason) {
		panel.replaceChildren(mui.card('', mui.empty(reason, E('a', { href: L.url('admin/services/mihomo/config') }, '在配置文件页编辑'))));
	},

	/* ---------- 透明代理 ---------- */

	buildEbpf() {
		const sec = this.sec.ebpf, panel = this.panels.ebpf;
		panel.replaceChildren();
		if (sec.unsupported) return this.unsupported(panel, sec.reason);
		if (sec.missing) {
			panel.appendChild(mui.card('eBPF 透明入站', mui.empty('配置中没有 eBPF 入站。创建后默认同时代理本机与 br-lan 下联设备（hybrid），国内 IP 段在内核直连（需要有 CN-IP 规则集）。',
				mui.btn('创建 eBPF 入站', () => mui.runJob(api.rpc.patch([ { op: 'ebpf.create' } ], this.rev)).then(() => this.reload()), 'cbi-button-add'))));
			return;
		}
		const d = sec.data;
		const note = [];
		if (sec.legacy && sec.legacy.length)
			note.push(E('div', { 'class': 'mh-banner warn' }, '配置中有旧写法（' + sec.legacy.join('、') + '），这里已按 mihomo 的规则展开到各角色。保存本页时会改成新写法。'));
		note.push(E('p', { 'class': 'mh-note' }, '入站「' + (sec.name || 'ebpf') + '」，角色开关写作 ' + (sec.style === 'enable' ? 'local.enable / shared.enable' : 'mode') +
			'。关闭某个角色时它的其余设置保留，mihomo 会忽略。'));
		panel.appendChild(E('div', {}, note));
		const ifs = this.ifs, cur = getPath(d, 'shared.interface') || [];
		const sets = sec.ipcidr_sets || [];
		const curSets = d['bypass-rule-set'] || [];
		return this.mount(panel, 'ebpf', 'ebpf', 'ebpf', d, s => {
			s.tab('general', '通用');
			s.tab('local', '本机流量（local）');
			s.tab('shared', '下联设备（shared）');
			let o;
			o = s.taboption('general', form.Flag, 'local_enable', '本机流量', '代理路由器自身发出的连接');
			o = s.taboption('general', form.Flag, 'shared_enable', '下联设备', '代理局域网设备经本机转发的连接');
			o = s.taboption('general', form.MultiValue, 'network', '协议');
			o.value('tcp', 'TCP');
			o.value('udp', 'UDP');
			o.default = [ 'tcp', 'udp' ];
			o = s.taboption('general', form.Value, 'udp-timeout', 'UDP 会话超时（秒）');
			o.datatype = 'range(5,86400)';
			o.placeholder = '300';
			o = s.taboption('general', form.MultiValue, 'bypass-rule-set', '内核直连的规则集', '只能选 behavior 为 ipcidr 的规则集，命中的目标地址不进入 mihomo');
			sets.concat(curSets.filter(n => sets.indexOf(n) < 0)).forEach(n => o.value(n, n));
			o = s.taboption('general', form.ListValue, 'fakeip-icmp', 'FakeIP 的 ICMP');
			o.value('off', 'off：不处理（默认）');
			o.value('reply', 'reply：代答 ping');
			o.default = 'off';
			o = s.taboption('general', form.Flag, 'bypass-tun-direct', 'TUN 共存直连', '同时开启 TUN 时，被 eBPF 放行的目标直接连接，不再进 TUN（默认开启）');
			o.default = '1';
			o = s.taboption('general', form.Value, 'tc-priority', 'TC 优先级', '数字越小越先执行，留空使用默认值');
			o.datatype = 'range(0,65535)';

			const role = (tab, r, planes) => {
				o = s.taboption(tab, form.ListValue, r + '__data-plane', '数据面');
				planes.forEach(p => o.value(p[0], p[1]));
				o.default = planes[0][0];
				o = s.taboption(tab, form.ListValue, r + '__dns-mode', 'DNS');
				DNS_MODES.forEach(p => o.value(p[0], p[1]));
				o.default = 'hijack';
				o = s.taboption(tab, form.Flag, r + '__ipv6', '处理 IPv6');
				o.default = '1';
				o = s.taboption(tab, form.Flag, r + '__bypass-private-address', '私网地址直连', '目标为私网、链路本地等地址时不进入 mihomo（默认开启）');
				o.default = '1';
				o = s.taboption(tab, form.DynamicList, r + '__bypass-exclude', '强制进入 mihomo 的地址段', '即使属于私网也拦截，例如 Tailscale 的 100.64.0.0/10、fd7a:115c:a1e0::/48');
				o.datatype = 'ipaddr';
				o = s.taboption(tab, form.DynamicList, r + '__bypass-port', '直连的目标端口');
				o.datatype = 'port';
			};
			role('local', 'local', [ [ 'cgroup', 'cgroup（默认）' ], [ 'tc', 'tc' ] ]);

			o = s.taboption('shared', form.MultiValue, 'shared__interface', '下联网卡', '局域网设备所在的网卡；默认出口网卡会被自动跳过');
			o.create = true;
			ifs.filter(i => i.up || cur.indexOf(i.name) >= 0).forEach(i => o.value(i.name, mui.ifLabel(i)));
			cur.filter(n => !ifs.some(i => i.name === n)).forEach(n => o.value(n, n + '（不存在）'));
			role('shared', 'shared', [ [ 'packet_rewrite', 'packet_rewrite（默认）' ], [ 'socket_assign', 'socket_assign' ] ]);
			o = s.taboption('shared', form.Flag, 'shared__allow-default-upstream', '默认出口也作为下联', '单臂旁路由：唯一的网卡既是出口又是下联时开启');
		}).then(() => {
			panel.appendChild(mui.card('下联设备名单', E('p', { 'class': 'mh-note' }, [
				'逐台选择下联设备走不走代理（黑 / 白名单），以及每台设备的速率与流量，在 ',
				E('a', { href: L.url('admin/services/mihomo/devices') }, '「设备」页'), '。'
			])));
		});
	},

	/* ---------- 基础 ---------- */

	buildBasic() {
		const panel = this.panels.basic;
		panel.replaceChildren();
		return this.mount(panel, 'basic', 'basic', 'basic', this.sec.basic, s => {
			s.tab('net', '网络');
			s.tab('ctl', '控制器与面板');
			s.tab('geo', 'GEO 数据');
			let o;
			o = s.taboption('net', form.Value, 'mixed-port', '混合端口', 'HTTP 与 SOCKS5 代理端口，0 表示关闭');
			o.datatype = 'range(0,65535)';
			o = s.taboption('net', form.Flag, 'allow-lan', '允许局域网连接', '允许其他设备使用混合端口');
			o = s.taboption('net', form.Value, 'bind-address', '监听地址', '* 表示所有地址');
			o.placeholder = '*';
			o.validate = (sid, v) => (!v || v === '*' || /^[0-9a-fA-F:.]+$/.test(v)) ? true : '填写 * 或 IP 地址';
			o = s.taboption('net', form.Flag, 'ipv6', 'IPv6', '关闭后不使用 IPv6 连接');
			o.default = '1';
			o = s.taboption('net', form.Flag, 'tcp-concurrent', 'TCP 并发', '域名解析出多个地址时同时连接，使用最先连上的');
			o = s.taboption('net', form.Flag, 'unified-delay', '统一延迟', '测速时去掉握手等额外耗时');
			o = s.taboption('net', form.ListValue, 'find-process-mode', '查找进程');
			o.value('off', 'off：关闭（路由器推荐）');
			o.value('strict', 'strict：由 mihomo 判断');
			o.value('always', 'always：总是查找');
			o.default = 'strict';
			o = s.taboption('net', form.Flag, 'sniffer__enable', '域名嗅探', '从 TLS、HTTP 等流量中识别域名');
			o = s.taboption('net', form.ListValue, 'log-level', '日志级别');
			[ 'silent', 'error', 'warning', 'info', 'debug' ].forEach(l => o.value(l, l));
			o.default = 'info';
			o = s.taboption('net', form.Flag, 'profile__store-selected', '记住手动选择的节点');

			o = s.taboption('ctl', form.Value, 'external-controller', '控制器地址', '本插件的实时页面与 zashboard 都通过它访问 mihomo；改动后页面会重新连接');
			o.rmempty = false;
			o.validate = (sid, v) => /^(\[[0-9a-fA-F:.]+\]|[^\s:\[\]]*):[0-9]{1,5}$/.test(v || '') ? true : '格式为 地址:端口，例如 0.0.0.0:9090';
			o = s.taboption('ctl', form.Value, 'secret', '控制器密钥', '留空表示不需要密钥');
			o.password = true;
			o = s.taboption('ctl', form.Value, 'external-ui', '面板目录', '相对配置目录，例如 ./dashboard');
			o = s.taboption('ctl', form.Value, 'external-ui-url', '面板下载地址');
			o.datatype = 'string';

			o = s.taboption('geo', form.Value, 'geox-url__geoip', 'GeoIP');
			o = s.taboption('geo', form.Value, 'geox-url__geosite', 'GeoSite');
			o = s.taboption('geo', form.Value, 'geox-url__mmdb', 'MMDB');
			o = s.taboption('geo', form.Flag, 'geo-auto-update', '自动更新 GEO 数据', '按周期重新下载上面三个数据文件');
			o = s.taboption('geo', form.ListValue, 'geodata-loader', 'GEO 数据加载方式', '内存紧张的路由器选「省内存」');
			o.value('standard', '标准');
			o.value('memconservative', '省内存');
			o.default = 'standard';
		}).then(() => {
			panel.appendChild(E('p', { 'class': 'mh-note' }, [
				'更新面板、GEO 数据、订阅与规则集在「', E('a', { href: L.url('admin/services/mihomo/core') }, '更新'), '」页。'
			]));
		});
	},

	/* ---------- DNS ---------- */

	buildDns() {
		const sec = this.sec.dns, panel = this.panels.dns;
		panel.replaceChildren();
		if (sec.unsupported) return this.unsupported(panel, sec.reason);
		const rows = policyRows(sec['nameserver-policy']);
		const table = this.policyTable(rows);
		return this.mount(panel, 'dns', 'dns', 'dns', sec, s => {
			let o;
			o = s.option(form.Flag, 'enable', '启用 DNS');
			o = s.option(form.Value, 'listen', '监听地址', '例如 0.0.0.0:1053；留空不对外提供 DNS');
			o = s.option(form.ListValue, 'enhanced-mode', '模式');
			o.value('redir-host', 'redir-host');
			o.value('fake-ip', 'fake-ip');
			o.value('normal', 'normal');
			o.default = 'redir-host';
			o = s.option(form.Flag, 'ipv6', '返回 IPv6 地址（AAAA）');
			o = s.option(form.Value, 'fake-ip-range', 'FakeIP 地址段（IPv4）');
			o.datatype = 'cidr4';
			o.placeholder = '198.18.0.1/16';
			o = s.option(form.Value, 'fake-ip-range6', 'FakeIP 地址段（IPv6）');
			o.datatype = 'cidr6';
			o = s.option(form.DynamicList, 'default-nameserver', '引导服务器', '用于解析其他 DNS 服务器的域名，只能填 IP');
			o = s.option(form.DynamicList, 'nameserver', '默认服务器');
			o = s.option(form.DynamicList, 'proxy-server-nameserver', '代理节点域名的服务器');
			o = s.option(form.DynamicList, 'direct-nameserver', '直连域名的服务器');
			o = s.option(form.DynamicList, 'fake-ip-filter', '不使用 FakeIP 的域名', '例如 rule-set:Fake-IP-Filter、+.lan');
		}, { policy: rows.map(r => Object.assign({}, r)), table: table }).then(() => {
			panel.appendChild(mui.card('按域名指定服务器（nameserver-policy）', [
				table.root,
				E('p', { 'class': 'mh-note' }, '匹配条件如 +.example.com、geosite:cn、rule-set:名称；多个服务器用空格分隔。按顺序匹配。')
			]));
		});
	},

	policyTable(rows) {
		const tbody = E('tbody', {});
		const draw = () => {
			tbody.replaceChildren(...rows.map((r, i) => {
				const k = E('input', { type: 'text', 'class': 'cbi-input-text', value: r.key, placeholder: '+.example.com' });
				const v = E('input', { type: 'text', 'class': 'cbi-input-text', value: r.servers, placeholder: '223.5.5.5 https://dns.alidns.com/dns-query' });
				k.addEventListener('input', () => { r.key = k.value; });
				v.addEventListener('input', () => { r.servers = v.value; });
				const b = (label, title, fn, disabled) => E('button', { 'class': 'mh-x', title: title, disabled: disabled ? '' : null, 'click': fn }, label);
				return E('tr', {}, [
					E('td', { 'class': 'mh-pol-key' }, k), E('td', {}, v),
					E('td', { 'class': 'mh-actions' }, [
						b('↑', '上移', () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); draw(); }, i === 0),
						b('↓', '下移', () => { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); draw(); }, i === rows.length - 1),
						b('✕', '删除', () => { rows.splice(i, 1); draw(); })
					])
				]);
			}));
			if (!rows.length) tbody.appendChild(E('tr', {}, E('td', { colspan: 3 }, mui.empty('没有按域名指定的服务器'))));
		};
		draw();
		return {
			rows: rows,
			root: E('div', {}, [
				E('div', { 'class': 'mh-scroll-x' }, E('table', { 'class': 'mh-table mh-pol-table' }, [
					E('thead', {}, E('tr', {}, [ E('th', {}, '匹配条件'), E('th', {}, '服务器'), E('th', {}, '') ])), tbody
				])),
				E('div', { 'class': 'mh-toolbar', style: 'margin-top:8px' }, mui.btn('添加', () => { rows.push({ key: '', servers: '' }); draw(); }, 'mh-btn-sm cbi-button-add'))
			])
		};
	},

	/* ---------- Tailscale ---------- */

	buildTailscale() {
		const list = this.sec.tailscale, panel = this.panels.tailscale;
		panel.replaceChildren();
		if (!Array.isArray(list)) return this.unsupported(panel, (list && list.reason) || '无法读取');
		if (!list.length) {
			panel.appendChild(mui.card('', mui.empty('配置中没有 type: tailscale 的代理。添加后，访问 Tailnet 地址（100.64.0.0/10）的流量会走 Tailscale；不填 auth key 时用浏览器登录账号即可。',
				mui.btn('添加 Tailscale', () => this.tsAdd(), 'cbi-button-add'))));
			return;
		}
		return Promise.all(list.map((t, i) => {
			const saved = this.tsStatus.find(x => x.name === t.name) || {};
			const live = (this.tsLive || []).find(x => x.name === t.name) || null;
			const st = tsIdentity(live, saved);
			const self = (live && live.self) || {};
			const box = E('div', {});
			const running = live ? live.state === 'Running' : false;
			const loggedIn = running || !!st.logged_in;
			const actions = [];
			if (loggedIn) actions.push(mui.btn('退出登录', () => this.tsLogout(t.name), 'cbi-button-negative'));
			if (!running && live && t['auth-key']) actions.push(mui.btn('立即连接', () => this.tsConnect(t.name), 'cbi-button-action'), ' ');
			if (!loggedIn) actions.push(mui.btn('网页登录', () => this.tsLogin(t.name), 'cbi-button-action'));
			actions.push(' ', mui.btn('删除', () => this.tsDelete(t.name), 'cbi-button-remove'));
			const serve = this.serveTable(t.serve);
			panel.appendChild(mui.card('Tailscale：' + t.name, [
				E('div', { 'class': 'mh-ts-status' }, [
					mui.row('状态', tsStateLabel(live, st, t)),
					live && live.error ? mui.row('错误', E('span', { 'class': 'mh-warn', style: 'word-break:break-all' }, live.error)) : '',
					st.login ? mui.row('账号', st.login) : '',
					st.tailnet ? mui.row('Tailnet', st.tailnet) : '',
					self.dnsName ? mui.row('域名', self.dnsName.replace(/\.$/, '')) : (st.magic_dns ? mui.row('MagicDNS', st.magic_dns) : ''),
					Array.isArray(self.ips) && self.ips.length ? mui.row('Tailnet 地址', self.ips.join('  ')) : '',
					mui.row('状态目录', st.state_dir || '-')
				]),
				E('div', { 'class': 'mh-toolbar', style: 'margin:8px 0' }, actions),
				box,
				E('h4', { style: 'margin:12px 0 4px' }, '端口转发（serve）'),
				E('p', { 'class': 'mh-note' }, 'Tailnet 里的设备访问 ' + (self.dnsName ? self.dnsName.replace(/\.$/, '') : '这台设备的 Tailnet 地址') +
					':端口 时，转发到路由器上的 HTTP 服务，例如 LuCI（http://127.0.0.1:80）。只转发 HTTP，保存后重启服务生效。'),
				serve.root,
				E('p', { 'class': 'mh-note' }, '名称不能在这里修改：规则、策略组与 ts://' + t.name + ' 都按名称引用它。已登录时修改 auth-key 不会切换账号，要换账号请先退出登录。')
			], { tools: i === 0 ? [ mui.btn('添加', () => this.tsAdd(), 'mh-btn-sm cbi-button-add') ] : null }));
			return this.mount(box, 'ts' + i, 'tailscale', 'ts' + i, t, s => {
				let o;
				o = s.option(form.Value, 'hostname', '主机名', '在 Tailnet 中显示的名称');
				o.validate = (sid, v) => (!v || /^[A-Za-z0-9-]{1,63}$/.test(v)) ? true : '只能包含字母、数字与 -';
				o = s.option(form.Value, 'auth-key', 'Auth key', '留空时用「网页登录」');
				o.password = true;
				o = s.option(form.Flag, 'udp', '转发 UDP');
				o = s.option(form.Flag, 'accept-routes', '接受子网路由');
				o = s.option(form.Value, 'exit-node', '使用出口节点', '经 Tailnet 里的这台设备上网，填设备名或 IP；留空不使用');
				o.validate = (sid, v) => (!v || /^\S{1,253}$/.test(v)) ? true : '不能包含空格';
				o = s.option(form.Flag, 'advertise-exit-node', '作为出口节点');
				o = s.option(form.DynamicList, 'advertise-routes', '通告子网路由', '例如 192.168.77.0/24；需要在 Tailscale 管理后台批准');
				o.datatype = 'ipaddr';
				o = s.option(form.Value, 'listen-port', 'UDP 监听端口', '留空或 0 表示随机端口');
				o.datatype = 'range(0,65535)';
			}, { name: t.name, serve: serve, serveBefore: serveData(serve.rows) });
		}));
	},

	// serve 列表：端口 → http://IP:端口 或 unix:套接字
	serveTable(list) {
		const rows = (Array.isArray(list) ? list : []).map(e => ({ port: String((e && e.port) || ''), target: (e && e.target) || '' }));
		const tbody = E('tbody', {});
		const draw = () => {
			tbody.replaceChildren(...rows.map((r, i) => {
				const port = E('input', { 'class': 'cbi-input-text', type: 'number', min: 1, max: 65535, value: r.port, placeholder: '8080', style: 'width:7em' });
				const target = E('input', { 'class': 'cbi-input-text', value: r.target, placeholder: 'http://127.0.0.1:80', style: 'width:100%' });
				port.addEventListener('input', () => { r.port = port.value; });
				target.addEventListener('input', () => { r.target = target.value; });
				return E('tr', {}, [
					E('td', {}, port), E('td', {}, target),
					E('td', { 'class': 'mh-actions' }, E('button', { 'class': 'mh-x', title: '删除', 'click': () => { rows.splice(i, 1); draw(); } }, '✕'))
				]);
			}));
			if (!rows.length) tbody.appendChild(E('tr', {}, E('td', { colspan: 3 }, mui.empty('没有端口转发'))));
		};
		draw();
		return {
			rows: rows,
			root: E('div', {}, [
				E('div', { 'class': 'mh-scroll-x' }, E('table', { 'class': 'mh-table' }, [
					E('thead', {}, E('tr', {}, [ E('th', {}, 'Tailnet 端口'), E('th', {}, '转发到'), E('th', {}, '') ])), tbody
				])),
				E('div', { 'class': 'mh-toolbar', style: 'margin-top:8px' }, mui.btn('添加转发', () => { rows.push({ port: '', target: '' }); draw(); }, 'mh-btn-sm cbi-button-add'))
			])
		};
	},

	// 有 auth key 时让内核立即登录（不必等第一条流量）
	tsConnect(name) {
		mui.notify('正在连接 ' + name + '…');
		return tsKernelLogin(name, 25).then(st => {
			if (st.state === 'Running') mui.notify('Tailscale 已连接');
			else if (st.authURL) mui.notify('auth key 无效或已过期，请改用网页登录', 'error');
			else mui.notify('还没有连上（' + (st.state || '未知状态') + '）' + (st.error ? '：' + st.error : ''), 'error');
			return this.reload();
		}, e => mui.notify(e.status === 404 ? '当前内核不支持，请更新内核或等有流量时自动登录' : '连接失败：' + e.message, 'error'));
	},

	// 新增：写入出站与 Tailnet 规则（配置任务会在服务运行时重启），不填 auth key 时接着网页登录
	tsAdd() {
		const name = E('input', { 'class': 'cbi-input-text', value: 'Tailscale' });
		const host = E('input', { 'class': 'cbi-input-text', value: 'openwrt-mihomo' });
		const key = E('input', { 'class': 'cbi-input-password', type: 'password', placeholder: '可选，留空用网页登录' });
		const err = E('p', { 'class': 'mh-warn' });
		const submit = () => {
			const n = name.value.trim(), h = host.value.trim(), k = key.value.trim();
			if (!/^[A-Za-z0-9_.-]{1,64}$/.test(n)) return (err.textContent = '名称只能包含字母、数字、_ . -');
			if (!/^[A-Za-z0-9-]{1,63}$/.test(h)) return (err.textContent = '主机名只能包含字母、数字与 -');
			if (/\s/.test(k)) return (err.textContent = 'auth key 不能含空格');
			const data = { hostname: h };
			if (k) data['auth-key'] = k;
			mui.runJob(api.rpc.patch([ { op: 'tailscale.add', name: n, data: data } ], this.rev), { quiet: true }).then(s => {
				if (s.state !== 'done') return;
				return this.reload().then(() => {
					if (!k) this.tsLogin(n);
					else mui.notify('已添加 ' + n + '，tsnet 会用 auth key 自动登录');
				});
			});
		};
		ui.showModal('添加 Tailscale', [
			mui.field('名称', name, '规则与策略组按这个名称引用它'),
			mui.field('主机名', host, '在 Tailnet 中显示的名称'),
			mui.field('Auth key', key),
			E('p', { 'class': 'mh-note' }, '会在 DNS 接管规则之后加入 100.64.0.0/10 与 fd7a:115c:a1e0::/48 两条规则，并让 eBPF 不把这两个网段当作私网放行。'),
			err,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '取消'), ' ',
				E('button', { 'class': 'btn cbi-button-positive', 'click': submit }, '添加')
			])
		]);
	},

	tsDelete(name) {
		mui.confirm('删除 ' + name, '同时删除指向它的规则与策略组成员；登录状态目录保留，重新添加时会继续使用。', '删除', true).then(yes => {
			if (!yes) return;
			return mui.runJob(api.rpc.patch([ { op: 'tailscale.delete', name: name } ], this.rev)).then(s => {
				if (s.state === 'done' || s.state === 'rolled_back') return this.reload();
			});
		});
	},

	tsLogout(name) {
		mui.confirm('退出登录', '删除 ' + name + ' 的登录状态并重启服务，设备会从 Tailnet 中离线，之后需要重新登录。', '退出登录', true).then(yes => {
			if (!yes) return;
			// 先让内核注销节点（Tailnet 后台里会立即消失），旧内核或服务未运行时忽略
			const kernel = api.request('POST', '/tailscale/' + encodeURIComponent(name) + '/logout', undefined, { timeout: 15000 }).catch(() => null);
			return kernel.then(() => api.rpc.tailscaleLogout(name)).then(r => {
				if (!r || !r.ok) throw new Error((r && r.error) || '退出登录失败');
				mui.notify('已退出登录');
				return this.reload();
			}).catch(e => mui.notify(e.message, 'error'));
		});
	},

	// 网页登录：订阅控制器日志（有订阅者时内核会输出 info 日志），再对出站测速唤醒 tsnet，从日志取登录链接；
	// 之后轮询状态文件直到登录成功。tsnet 已在运行而没有新链接时，提供重启服务后重试。
	tsLogin(name, restart) {
		const msg = E('p', {}, restart ? '正在重启服务…' : '正在获取登录链接…');
		const link = E('div', {});
		const retry = E('div', {});
		const timers = new Set();
		let stream = null, closed = false, url = null, poller = null, polling = false;
		const close = () => {
			closed = true;
			if (stream) stream.close();
			if (poller) poller.close();
			timers.forEach(t => clearTimeout(t));
			timers.clear();
		};
		const later = (fn, ms) => {
			if (closed) return;
			const timer = setTimeout(() => {
				timers.delete(timer);
				if (!closed) fn();
			}, ms);
			timers.add(timer);
		};
		ui.showModal('登录 Tailscale：' + name, [ msg, link, retry,
			E('div', { 'class': 'right' }, [ E('button', { 'class': 'btn', 'click': () => { close(); ui.hideModal(); this.reload(); } }, '关闭') ]) ]);
		const fail = text => {
			if (closed) return;
			if (stream) stream.close();
			msg.textContent = text;
			retry.replaceChildren(mui.btn('重启服务后重新获取', () => { close(); this.tsLogin(name, true); }, 'cbi-button-action'));
		};
		const done = login => {
			if (closed) return;
			close();
			ui.hideModal();
			mui.notify('Tailscale 已登录' + (login ? '：' + login : ''));
			return this.reload();
		};
		// 优先看内核实时状态，旧内核退回到读状态文件
		const poll = () => {
			if (closed) return Promise.resolve();
			return api.get('/tailscale/' + encodeURIComponent(name), { timeout: 8000 }).then(st => {
				if (st && st.state === 'Running') return done(st.login);
			}, error => {
				if (closed || error.status !== 404) return;
				return api.rpc.tailscale().then(result => {
					const state = ((result && result.ok && result.list) || []).find(item => item.name === name);
					if (state && state.logged_in) return done(state.login);
				});
			}).catch(() => null);
		};
		poller = api.poll(msg, 3000, () => polling ? poll() : null);
		const copy = () => (navigator.clipboard && window.isSecureContext)
			? navigator.clipboard.writeText(url).then(() => mui.notify('已复制'), () => mui.notify('复制失败，请手动复制', 'error'))
			: mui.notify('当前页面不能使用剪贴板，请手动复制链接', 'error');
		const show = u => {
			if (closed) return;
			url = u;
			if (stream) stream.close();
			msg.textContent = '在新标签页里登录 Tailscale 账号并授权这台设备，完成后这里会自动更新。';
			link.replaceChildren(
				E('p', {}, E('a', { href: url, target: '_blank', rel: 'noopener noreferrer', style: 'word-break:break-all' }, url)),
				E('div', { 'class': 'mh-toolbar' }, [
					mui.btn('在新标签页打开', () => window.open(url, '_blank', 'noopener'), 'cbi-button-action'), ' ',
					mui.btn('复制链接', copy)
				]));
			retry.replaceChildren();
			polling = true;
		};
		// 新内核：/tailscale/NAME/login 直接返回登录链接；旧内核（404）退回到从日志里抓链接
		const viaKernel = () => tsKernelLogin(name, 20).then(st => {
			if (closed) return;
			if (st && st.state === 'Running') return done(st.login);
			if (st && st.authURL) return show(st.authURL);
			fail('没有拿到登录链接（' + ((st && st.state) || '未知状态') + '）' + (st && st.error ? '：' + st.error : ''));
		}, e => {
			if (closed) return;
			if (e.status === 404) return begin();
			fail('获取登录链接失败：' + e.message);
		});
		const prefix = '[Tailscale](' + name + ') ';
		const begin = () => {
			stream = api.stream('/logs?level=info', d => {
				const p = d && d.payload;
				if (closed || typeof p !== 'string' || p.indexOf(prefix) !== 0) return;
				const m = /go to: (https?:\/\/[^\s"]+)/.exec(p);
				if (m && !url) show(m[1]);
				else if (/AuthLoop: state is Running/.test(p)) poll();
			}, msg);
			// 订阅建立后再唤醒 tsnet：它只在第一次连接时启动，登录链接只输出一次
			later(() => api.get('/proxies/' + encodeURIComponent(name) + '/delay?url=' + encodeURIComponent('http://100.100.100.100') + '&timeout=8000',
				{ timeout: 12000 }).catch(() => null), 1000);
			later(() => {
				if (url) return;
				polling = true;
				poll();
				fail('没有拿到登录链接：tsnet 可能已经在运行。重启服务后再获取一次。');
			}, 12000);
		};
		const ready = restart ? api.rpc.service('restart')
			: api.rpc.status().then(s => (s && s.running) ? { ok: true } : api.rpc.service('start'));
		Promise.resolve(ready).then(r => {
			if (closed) return;
			if (r && r.ok === false) return fail('服务启动失败：' + (r.error || ''));
			msg.textContent = '正在获取登录链接…';
			return api.controller(true).then(c => (c && c.base) ? viaKernel() : fail('浏览器无法连接控制器：' + ((c && c.reason) || '')));
		}, e => fail(e.message));
	},

	/* ---------- 保存 ---------- */

	collect() {
		const ops = [];
		let ctlChanged = false;
		Object.keys(this.forms).forEach(key => {
			const f = this.forms[key];
			const now = f.s.formvalue(f.sid);
			const names = changedFields(f.before, now);
			let data = names.length ? fromForm(f.kind, now, names) : null;
			if (key === 'dns') {
				const before = policyData(f.extra.policy), after = policyData(f.extra.table.rows);
				if (changed(before, after)) {
					data = data || {};
					data['nameserver-policy'] = after;
				}
			}
			if (f.kind === 'tailscale') {
				const after = serveData(f.extra.serve.rows, true);
				if (changed(f.extra.serveBefore, after)) {
					data = data || {};
					data.serve = after;
				}
			}
			if (!data) return;
			if (key === 'ebpf') ops.push({ op: 'ebpf.set', data: data });
			else if (key === 'basic') {
				ops.push({ op: 'basic.set', data: data });
				ctlChanged = 'external-controller' in data || 'secret' in data;
			} else if (key === 'dns') ops.push({ op: 'dns.set', data: data });
			else ops.push({ op: 'tailscale.set', name: f.extra.name, data: data });
		});
		return { ops: ops, ctlChanged: ctlChanged };
	},

	save() {
		const maps = Object.keys(this.forms).map(k => this.forms[k].m);
		Promise.all(maps.map(m => m.parse())).then(() => {
			let c;
			try { c = this.collect(); } catch (e) { return mui.notify(e.message, 'error'); }
			if (!c.ops.length) return mui.notify('没有修改');
			return mui.runJob(api.rpc.patch(c.ops, this.rev)).then(s => {
				if (s.state === 'done' && c.ctlChanged) api.controller(true);
				if (s.state === 'done' || s.state === 'rolled_back') return this.reload();
			});
		}, e => mui.notify('表单有错误：' + e.message, 'error'));
	}
});
