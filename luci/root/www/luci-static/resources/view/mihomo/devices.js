'use strict';
'require view';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';
'require mihomo.devices as dl';

/* 设备：下联设备列表，逐台选择走不走代理（黑 / 白名单，写进 eBPF 入站的 shared.include-* / exclude-*），
 * 并显示每台设备经代理的速率与流量。
 * 耗电与性能：流量每 2 秒读一次内核 /connections/sources（内核只读计数器，不遍历连接）；
 * 设备列表每 10 秒读一次邻居表与 DHCP 租约；页面不可见时都暂停。 */

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.resolve();
	},

	render() {
		mui.loadCss();
		this.stats = {};
		this.sampler = dl.sampler();
		this.unsupported = false;
		this.devs = [];
		this.body = E('div', {}, mui.card('', mui.empty('读取中…')));
		this.saveBtn = mui.btn('保存并应用', () => this.save(), 'cbi-button-apply');
		this.resetBtn = mui.btn('放弃修改', () => this.reload(), '');
		this.saveBtn.disabled = this.resetBtn.disabled = true;
		const root = E('div', { 'class': 'mh mh-devices' }, [
			header.render(),
			this.body,
			E('div', { 'class': 'mh-set-foot' }, [ this.resetBtn, this.saveBtn ])
		]);
		this.reload();
		if (this.devPoll) this.devPoll.close();
		if (this.trafficPoll) this.trafficPoll.close();
		this.devPoll = api.poll(root, 10000, () => api.rpc.devices().then(r => {
			if (r && r.ok && JSON.stringify(r.list) !== JSON.stringify(this.devs)) {
				this.devs = r.list;
				this.draw();
			}
		}), false);
		this.trafficPoll = api.poll(root, 2000, () => this.unsupported ? null : api.get('/connections/sources').then(d => {
			this.stats = this.sampler.push(d && d.sources, Date.now());
			this.paint();
		}, e => {
			// 旧内核没有这个接口：不退回轮询全部连接（那样耗电），只提示更新内核
			if (e && (e.status === 404 || e.status === 405)) {
				this.unsupported = true;
				this.paint();
			}
		}));
		return root;
	},

	reload() {
		this.saveBtn.disabled = this.resetBtn.disabled = true;
		return Promise.all([ api.rpc.sections([ 'ebpf' ]), api.rpc.devices().catch(() => null) ]).then(([ s, devs ]) => {
			if (!s || !s.ok) throw new Error((s && s.error) || '读取失败');
			const sec = s.ebpf || {};
			const goSettings = E('a', { href: L.url('admin/services/mihomo/settings') }, '打开设置 › 透明代理');
			if (s.parse_error) return this.body.replaceChildren(mui.card('', mui.empty(s.parse_error)));
			if (sec.unsupported || sec.missing) return this.body.replaceChildren(mui.card('下联设备',
				mui.empty(sec.unsupported ? sec.reason : '配置中没有 eBPF 入站，先在设置里创建。下联设备名单在内核的 eBPF 程序里生效。', goSettings)));
			const d = sec.data || {};
			if (d.shared_enable === false) return this.body.replaceChildren(mui.card('下联设备',
				mui.empty('eBPF 入站的「下联设备」角色未开启，局域网设备现在不经过透明代理。', goSettings)));
			this.rev = s.rev;
			this.shared = d.shared || {};
			this.devs = (devs && devs.ok && devs.list) || [];
			this.lists = {};
			dl.KEYS.forEach(k => { this.lists[k] = (this.shared[k] || []).map(String); });
			const p = dl.policy(this.shared);
			this.mode = p.mode;
			this.entries = p.entries.slice();
			this.mixed = p.mixed;
			this.build();
		}).catch(e => {
			this.body.replaceChildren(mui.card('', mui.empty('无法读取设置：' + e.message)));
		});
	},

	// 四个列表是否与配置里的不同
	dirty() {
		let now;
		try { now = dl.data(this.mode, this.entries); } catch (e) { return true; }
		return dl.KEYS.some(k => JSON.stringify(now[k]) !== JSON.stringify(this.lists[k]));
	},

	known() {
		const ifaces = this.shared.interface || [];
		return this.devs.filter(d => d.mac && (!d.dev || !ifaces.length || ifaces.indexOf(d.dev) >= 0))
			.sort((a, b) => (b.online - a.online) || String(a.name || a.ip4 || a.mac).localeCompare(String(b.name || b.ip4 || b.mac)));
	},

	build() {
		this.modeSel = E('select', { 'class': 'cbi-input-select' }, [
			[ 'exclude', '黑名单：默认都走代理，取消勾选的设备直连' ], [ 'include', '白名单：只有勾选的设备走代理' ]
		].map(([ v, t ]) => E('option', { value: v, selected: this.mode === v ? '' : null }, t)));
		this.modeSel.addEventListener('change', () => this.switchMode(this.modeSel.value));
		this.input = E('input', { type: 'text', 'class': 'cbi-input-text mh-dev-input',
			placeholder: 'MAC（aa:bb:cc:dd:ee:ff）或 IP / 网段（192.168.1.20、192.168.1.0/28）' });
		this.input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); this.add(); } });
		this.summary = E('span', { 'class': 'mh-muted' });
		this.tbody = E('tbody', {});
		this.note = E('p', { 'class': 'mh-note' });
		this.body.replaceChildren(mui.card('下联设备', [
			this.mixed ? E('div', { 'class': 'mh-banner warn' }, '配置里同时有「只代理」与「不代理」两种名单，这里按白名单显示；保存会去掉「不代理」名单。') : '',
			E('div', { 'class': 'mh-toolbar' }, [ this.modeSel, E('span', { 'class': 'mh-grow' }), this.summary ]),
			E('div', { 'class': 'mh-scroll-x' }, E('table', { 'class': 'mh-table' }, [
				E('thead', {}, E('tr', {}, [ E('th', {}, '走代理'), E('th', {}, '设备'), E('th', {}, 'MAC'), E('th', {}, 'IP'), E('th', {}, '网卡'),
					E('th', { 'class': 'mh-num' }, '速率'), E('th', { 'class': 'mh-num' }, '流量') ])),
				this.tbody
			])),
			E('div', { 'class': 'mh-toolbar' }, [ this.input, ' ', mui.btn('添加', () => this.add(), 'cbi-button-add') ]),
			this.note
		]));
		this.draw();
	},

	setEntry(value, inList) {
		this.entries = this.entries.filter(e => e !== value);
		if (inList) this.entries.push(value);
		this.draw();
	},

	// 换模式时按 MAC 保留每台已知设备现在走不走代理；IP 名单在两种模式间无法等价换算，换模式时去掉
	switchMode(mode) {
		if (mode === this.mode) return;
		const devs = this.known();
		const proxiedNow = devs.filter(d => dl.proxied(this.mode, this.entries, d)).map(d => d.mac);
		const macs = devs.map(d => d.mac).concat(this.entries.filter(e => (dl.entry(e) || {}).kind === 'mac'))
			.filter((v, i, a) => a.indexOf(v) === i);
		const wasProxied = mac => proxiedNow.indexOf(mac) >= 0 || (devs.every(d => d.mac !== mac) && (this.mode === 'include') === (this.entries.indexOf(mac) >= 0));
		this.mode = mode;
		this.entries = macs.filter(mac => (mode === 'include') === wasProxied(mac));
		this.draw();
	},

	add() {
		const e = dl.entry(this.input.value);
		if (!e) return mui.notify('请填写有效的 MAC 地址或 IP / 网段', 'error');
		if (this.entries.indexOf(e.value) < 0) this.entries.push(e.value);
		this.input.value = '';
		this.draw();
	},

	draw() {
		if (!this.tbody) return;
		const include = this.mode === 'include';
		const known = this.known();
		this.cells = [];
		const cells = (addrs, on) => {
			const rate = E('td', { 'class': 'mh-num' }), total = E('td', { 'class': 'mh-num' });
			this.cells.push({ addrs, on, rate, total });
			return [ rate, total ];
		};
		const rows = known.map(d => {
			const on = dl.proxied(this.mode, this.entries, d);
			const addrs = [ d.ip4 ].concat(d.ip6 || []).filter(Boolean);
			// 被名单里的 IP / 网段决定时，单独勾这台设备不起作用
			const byIp = this.entries.find(e => e !== d.mac && addrs.some(a => dl.contains(e, a)));
			const box = E('input', { type: 'checkbox', checked: on ? '' : null, disabled: byIp ? '' : null,
				title: byIp ? '由名单里的 ' + byIp + ' 决定' : '',
				'change': ev => this.setEntry(d.mac, ev.target.checked === include) });
			return E('tr', {}, [
				E('td', {}, box),
				E('td', {}, [ E('strong', {}, d.name || '（未命名）'), d.online ? '' : E('span', { 'class': 'mh-muted' }, ' · 离线'),
					byIp ? E('div', { 'class': 'mh-muted' }, '按名单 ' + byIp) : '' ]),
				E('td', {}, d.mac),
				E('td', {}, [ d.ip4 || '', ...(d.ip6 || []).slice(0, 1).map(a => E('div', { 'class': 'mh-muted' }, a)) ]),
				E('td', {}, d.dev || ''),
				...cells(addrs, on)
			]);
		});
		const extra = this.entries.filter(e => !known.some(d => d.mac === e)).map(e => {
			const k = dl.entry(e) || {};
			return E('tr', {}, [
				E('td', {}, E('input', { type: 'checkbox', checked: include ? '' : null, 'change': () => this.setEntry(e, false) })),
				E('td', {}, E('span', { 'class': 'mh-muted' }, k.kind === 'mac' ? '名单里的设备（未发现）' : '按 IP / 网段')),
				E('td', {}, k.kind === 'mac' ? e : ''),
				E('td', {}, k.kind === 'mac' ? '' : e),
				E('td', {}, ''),
				...cells(k.kind === 'mac' ? [] : [ e ], include)
			]);
		});
		const all = rows.concat(extra);
		this.tbody.replaceChildren(...(all.length ? all
			: [ E('tr', {}, E('td', { colspan: 7 }, E('span', { 'class': 'mh-muted' }, '没有发现下联设备，可以在下面手动添加'))) ]));
		const count = known.filter(d => dl.proxied(this.mode, this.entries, d)).length;
		this.summary.textContent = known.length ? count + ' / ' + known.length + ' 台走代理' : '';
		const dirty = this.dirty();
		this.saveBtn.disabled = !dirty;
		this.resetBtn.disabled = !dirty;
		this.paint();
	},

	paint() {
		if (!this.cells) return;
		this.cells.forEach(c => {
			const t = c.addrs.length ? dl.traffic(this.stats, c.addrs) : null;
			if (!c.on) {
				c.rate.textContent = '直连';
				c.rate.className = 'mh-num mh-muted';
				c.total.textContent = '';
				return;
			}
			c.rate.className = 'mh-num' + (t && t.downRate + t.upRate > 0 ? ' mh-ok' : ' mh-muted');
			c.rate.textContent = this.unsupported ? '—' : t ? '↓ ' + mui.fmtRate(t.downRate) + '  ↑ ' + mui.fmtRate(t.upRate) : '—';
			c.total.textContent = t ? mui.fmtBytes(t.up + t.down) : '';
		});
		this.note.textContent = '在内核的 eBPF 程序里按来源 MAC / IP 判断（任一命中即算），不走代理的设备直接放行、不进 mihomo，所以只统计走代理设备的速率与流量（本次运行累计）。' +
			'开启名单时下联设备的 DNS 改为「按规则」，直连设备的 DNS 查询也不经过 mihomo。按 MAC 最可靠（IPv4、IPv6 都能匹配），按 IP 只匹配所填的地址。' +
			'保存后内核热重载，下联设备已有的连接会断开重连一次。' + (this.unsupported ? '当前内核不支持按设备统计流量，更新内核后显示。' : '');
	},

	save() {
		let now;
		try {
			now = dl.data(this.mode, this.entries);
		} catch (e) {
			return mui.notify(e.message, 'error');
		}
		const shared = Object.assign({}, now);
		const active = dl.KEYS.some(k => now[k].length), was = dl.KEYS.some(k => this.lists[k].length);
		const dns = this.shared['dns-mode'];
		// 开启名单时 DNS 改为按规则（直连设备的 DNS 也不进 mihomo），关掉名单时恢复默认
		if (active && (!dns || dns === 'hijack')) shared['dns-mode'] = 'respect_policy';
		else if (!active && was && dns === 'respect_policy') shared['dns-mode'] = '';
		return mui.runJob(api.rpc.patch([ { op: 'ebpf.set', data: { shared } } ], this.rev)).then(s => {
			if (s.state === 'done' || s.state === 'rolled_back') return this.reload();
		});
	}
});
