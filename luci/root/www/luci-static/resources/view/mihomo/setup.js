'use strict';
'require view';
'require ui';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';
'require mihomo.corecard as corecard';

/* 设置向导：① 安装内核 ② 准备配置（内置模板 / 从链接下载 / 导入文件）③ 写入配置并启动。
 * 写入沿用配置任务：校验 → 备份 → 替换 → 启动，失败自动回滚；覆盖现有配置前先备份。 */

const STEPS = [
	[ '内核', '下载适配本机的 eBPF 内核' ],
	[ '配置', '模板、下载或导入' ],
	[ '启动', '写入配置并启动服务' ]
];
const SOURCES = [
	[ 'template', '内置模板', '填写订阅链接，生成为本机调好的完整配置' ],
	[ 'url', '从链接下载', '下载现成的 mihomo 配置，例如订阅转换后的 YAML' ],
	[ 'import', '导入文件', '粘贴或上传已有的 mihomo 配置' ]
];
const MAX_SUBS = 32;
const NAME_BAD = /[\/,\\]/;
const URL_RE = /^https?:\/\/\S+$/i;
const CONFIG_PATH = '/etc/mihomo/config.yaml';

/* ---------- 纯函数 ---------- */

// 订阅行：去掉首尾空白，忽略整行为空的行；没填名称时按行号补「订阅N」（避开已有名称）。规则与后端 check_subs 一致
function validateSubs(rows) {
	const kept = (rows || []).map(r => ({ name: String(r.name || '').trim(), url: String(r.url || '').trim(), ua: String(r.ua || '').trim() }))
		.filter(r => r.name || r.url || r.ua);
	if (!kept.length) return { ok: false, error: '至少需要一个订阅' };
	if (kept.length > MAX_SUBS) return { ok: false, error: '订阅过多（最多 ' + MAX_SUBS + ' 个）' };
	const used = new Set(kept.map(r => r.name).filter(Boolean));
	const seen = new Set(), subs = [];
	for (let i = 0; i < kept.length; i++) {
		const r = kept[i];
		let name = r.name;
		if (!name) {
			let k = i + 1;
			while (used.has('订阅' + k)) k++;
			name = '订阅' + k;
			used.add(name);
		}
		if (name.length > 64 || name[0] === '.' || NAME_BAD.test(name))
			return { ok: false, error: '订阅名称「' + name + '」无效：不能包含 / , \\，不能以 . 开头，最长 64 个字符' };
		if (seen.has(name)) return { ok: false, error: '订阅名称重复：' + name };
		seen.add(name);
		if (!r.url) return { ok: false, error: '订阅「' + name + '」缺少地址' };
		if (!URL_RE.test(r.url)) return { ok: false, error: '订阅「' + name + '」的地址需要以 http:// 或 https:// 开头' };
		const s = { name: name, url: r.url };
		if (r.ua) s.ua = r.ua;
		subs.push(s);
	}
	return { ok: true, subs: subs };
}

// 默认勾选的下联接口：network.lan 的设备 → br-lan → 第一个不是默认出口的网桥。读不到接口列表时信任 network.lan
function defaultLan(ifs, lanDefault) {
	ifs = ifs || [];
	lanDefault = lanDefault || [];
	if (!ifs.length) return lanDefault.length ? lanDefault.slice() : [ 'br-lan' ];
	const names = ifs.map(i => i.name);
	const pick = lanDefault.filter(n => names.indexOf(n) >= 0);
	if (pick.length) return pick;
	if (names.indexOf('br-lan') >= 0) return [ 'br-lan' ];
	const br = ifs.find(i => i.kind === 'bridge' && !i.master && !i.is_default_upstream);
	return br ? [ br.name ] : [];
}

// 可勾选的接口：桥接成员不单独列出；默认出口（上游）放在最后；已选但不在列表里的名称补上
function lanChoices(ifs, selected) {
	// 只列能当网关的接口（已连接且有地址）；已选中的始终保留，避免已保存的选择看不到
	const sel = selected || [];
	const list = (ifs || []).filter(i => !i.master && (sel.indexOf(i.name) >= 0 || (i.up && i.addrs && i.addrs.length)));
	const names = list.map(i => i.name);
	const mk = i => ({ name: i.name, label: mui.ifLabel(i), upstream: !!i.is_default_upstream });
	const extra = (selected || []).filter(n => names.indexOf(n) < 0).map(n => ({ name: n, label: n, upstream: false }));
	return list.filter(i => !i.is_default_upstream).map(mk).concat(extra, list.filter(i => i.is_default_upstream).map(mk));
}

// setup_apply 的参数：只带当前来源需要的字段；rev 为空表示当前没有配置文件
function buildArgs(st, rev) {
	const a = { source: st.source, start: !!st.start, rev: rev || '' };
	if (st.source === 'template') {
		a.subs = st.subs;
		a.lan = st.lan;
		a.secret = String(st.secret || '').trim();
		return a;
	}
	a.adapt = !!st.adapt;
	a.lan = st.adapt ? st.lan : [];
	if (st.adapt && st.skip && st.skip.length) a.skip = st.skip.slice();
	// 链接内容已在第二步读取并预览过补全：按导入写入同一份内容，保证写入的与预览一致
	if (st.source === 'url' && st.fetched) {
		a.source = 'import';
		a.content = st.fetched.content;
	} else if (st.source === 'url') {
		a.url = String(st.url || '').trim();
		a.ua = String(st.ua || '').trim();
	} else {
		a.content = st.content;
	}
	return a;
}

// 已装好内核就从第二步开始
function firstStep(status) {
	return status && status.ok && status.core ? 1 : 0;
}

function resultLines(s) {
	const lines = [];
	if (s.adapted && s.adapted.length) lines.push('已补全：' + s.adapted.join('、'));
	if (s.launched) lines.push('服务已启动，并设为开机自启');
	else if (s.restarted) lines.push('服务已按新配置重启');
	if (s.note) lines.push(s.note);
	if (!lines.length) lines.push('配置已保存');
	return lines;
}

// 下载内容的概况：「12 个节点 · 2 个订阅 · 8 个策略组 · 120 条规则」，没有的项省略
function summaryText(sum) {
	if (!sum) return '';
	const parts = [ [ sum.proxies, '个节点' ], [ sum.providers, '个订阅' ], [ sum.groups, '个策略组' ], [ sum.rules, '条规则' ] ]
		.filter(x => x[0] > 0).map(x => x[0] + ' ' + x[1]);
	return parts.length ? parts.join(' · ') : '没有节点与规则';
}

// 节点订阅改用内置模板时预填的订阅行：名称取域名（去掉端口），与后端名称规则兼容
function subFromUrl(url, ua) {
	const name = urlHost(url).replace(/:\d+$/, '').slice(0, 64) || '订阅1';
	const r = { name: name, url: String(url || '').trim() };
	if (ua) r.ua = String(ua).trim();
	return r;
}

// 跳过项只保留仍存在的可选改动
function keepSkip(skip, changes) {
	const ok = (changes || []).filter(c => c.optional).map(c => c.id);
	return (skip || []).filter(id => ok.indexOf(id) >= 0);
}

function urlHost(u) {
	const m = /^https?:\/\/([^/?#]+)/i.exec(u || '');
	return m ? m[1].replace(/^.*@/, '') : '';
}

function randomSecret() {
	const a = new Uint8Array(16);
	crypto.getRandomValues(a);
	return Array.from(a, b => (b < 16 ? '0' : '') + b.toString(16)).join('');
}

/* ---------- 页面 ---------- */

return view.extend({
	validateSubs, defaultLan, lanChoices, buildArgs, firstStep, resultLines, summaryText, subFromUrl, keepSkip,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.all([
			api.rpc.setupStatus().catch(e => ({ ok: false, error: e.message })),
			api.rpc.interfaces().catch(() => null)
		]);
	},

	render(data) {
		mui.loadCss();
		const status = data[0] || { ok: false };
		this.status = status;
		this.ifs = (data[1] && data[1].ok && data[1].list) || [];
		this.st = {
			source: 'template', lan: defaultLan(this.ifs, status.lan_default), secret: '', subs: [],
			url: '', ua: '', content: '', adapt: true, start: true, keep: false,
			fetched: null, fetchFailed: false, changes: null, skip: []
		};
		this.reached = 0;

		this.stepEls = STEPS.map((s, i) => E('li', { 'class': 'mh-step', 'click': () => { if (i < this.step) this.go(i); } }, [
			E('span', { 'class': 'mh-step-no' }, String(i + 1)),
			E('div', { 'class': 'mh-step-text' }, [ E('b', {}, s[0]), E('span', {}, s[1]) ])
		]));
		const head = E('div', { 'class': 'mh-card mh-setup-head' }, [
			E('div', { 'class': 'mh-setup-title' }, [
				E('h2', {}, '设置向导'),
				E('p', {}, '三步完成：安装内核 → 准备配置 → 启动服务。覆盖现有配置前自动备份，启动失败自动回滚。')
			]),
			E('ol', { 'class': 'mh-steps' }, this.stepEls)
		]);

		const root = E('div', { 'class': 'mh mh-setup' }, [ header.render({ setup: true }), head ]);
		if (!status.ok) {
			root.appendChild(mui.card('', mui.empty('无法读取设置状态：' + (status.error || '未知错误'))));
			return root;
		}
		this.panels = [ this.panelCore(), this.panelConfig(), this.panelFinish() ];
		this.panels.forEach(p => root.appendChild(p));
		this.go(firstStep(status));
		this.core.refresh();
		return root;
	},

	go(i) {
		this.step = i;
		this.reached = Math.max(this.reached, i);
		this.stepEls.forEach((el, k) => {
			el.className = 'mh-step' + (k < i ? ' done' : (k === i ? ' active' : '')) + (k < i ? ' link' : '');
		});
		this.panels.forEach((p, k) => { p.hidden = k !== i; });
		if (i === 1) this.syncConfig();
		if (i === 2) this.drawSummary();
		window.scrollTo(0, 0);
	},

	refreshStatus() {
		return api.rpc.setupStatus().then(s => { if (s && s.ok) this.status = s; }, () => {});
	},

	/* ---------- 第一步：内核 ---------- */

	panelCore() {
		this.core = corecard.create({ title: '内核', onChange: i => this.onCore(i) });
		this.coreNext = mui.btn('下一步', () => this.go(1), 'cbi-button-action');
		this.coreNext.disabled = true;
		this.coreNote = E('span', { 'class': 'mh-foot-note' });
		return E('div', { 'class': 'mh-setup-panel' }, [
			this.core.el,
			E('p', { 'class': 'mh-note' }, '内核从 GitHub Release 下载并用 checksums.txt 校验 sha256；服务运行时先经本机代理下载，否则走「内核」页设置的镜像。'),
			E('div', { 'class': 'mh-setup-foot' }, [ this.coreNote, E('span', { 'class': 'mh-grow' }), this.coreNext ])
		]);
	},

	onCore(info) {
		const ready = !!(info && info.ok && info.installed);
		this.coreNext.disabled = !ready;
		this.coreNote.textContent = ready ? '内核已就绪：' + info.version : '安装内核后继续';
		this.coreNote.className = 'mh-foot-note' + (ready ? ' mh-ok' : '');
		this.coreVersion = ready ? info.version : null;
		this.coreRunning = !!(info && info.running);
	},

	/* ---------- 第二步：配置 ---------- */

	panelConfig() {
		this.srcBtns = SOURCES.map(s => E('button', { 'class': 'mh-choice', 'type': 'button', 'data-src': s[0], 'click': () => this.setSource(s[0]) }, [
			E('b', {}, s[1]), E('span', {}, s[2])
		]));
		this.cfgErr = E('span', { 'class': 'mh-foot-note mh-err' });
		this.cards = {
			template: this.cardTemplate(),
			url: this.cardUrl(),
			import: this.cardImport(),
			router: this.cardRouter()
		};
		const keep = this.status.config ? E('div', { 'class': 'mh-callout' }, [
			E('div', {}, [
				E('b', {}, '已有配置文件'),
				E('span', {}, '继续会用新配置覆盖 ' + CONFIG_PATH + '，覆盖前自动备份，可在「配置文件」页恢复。')
			]),
			mui.btn('保留现有配置，跳到启动', () => { this.st.keep = true; this.go(2); }, 'mh-btn-sm')
		]) : '';
		return E('div', { 'class': 'mh-setup-panel' }, [
			keep,
			mui.card('配置来源', E('div', { 'class': 'mh-choices' }, this.srcBtns)),
			this.cards.template, this.cards.url, this.cards.import, this.cards.router,
			E('div', { 'class': 'mh-setup-foot' }, [
				mui.btn('上一步', () => this.go(0)), this.cfgErr, E('span', { 'class': 'mh-grow' }),
				mui.btn('下一步', () => this.nextFromConfig(), 'cbi-button-action')
			])
		]);
	},

	cardTemplate() {
		this.subList = E('div', { 'class': 'mh-subrows' });
		this.addSubRow();
		const add = mui.btn('＋ 添加订阅', () => { if (this.subList.children.length < MAX_SUBS) this.addSubRow().querySelector('input').focus(); }, 'mh-btn-sm');
		return mui.card('订阅', [
			E('div', { 'class': 'mh-subrow mh-subrow-head' }, [ E('span', {}, '名称'), E('span', {}, '订阅地址'), E('span', {}, 'User-Agent'), E('span', {}) ]),
			this.subList,
			E('div', { 'class': 'mh-actions mh-actions-left' }, add),
			E('p', { 'class': 'mh-note' }, '模板内容：按地区自动选择的 Smart 策略组、国内直连与国外代理分流、redir-host DNS、eBPF 透明代理与 zashboard 面板。' +
				'名称留空时自动编号；User-Agent 留空使用 mihomo 默认值。')
		], { cls: 'mh-src-card' });
	},

	addSubRow() {
		const input = (cls, ph, type) => E('input', { 'class': 'cbi-input-text ' + cls, type: type || 'text', placeholder: ph, spellcheck: 'false', autocomplete: 'off' });
		const row = E('div', { 'class': 'mh-subrow' }, [
			input('mh-sub-name', '订阅' + (this.subList.children.length + 1)),
			input('mh-sub-url', 'https://…', 'url'),
			input('mh-sub-ua', '可选'),
			E('button', { 'class': 'btn cbi-button mh-btn-sm mh-icon-btn', type: 'button', title: '删除', 'click': () => {
				if (this.subList.children.length > 1) row.remove();
				else row.querySelectorAll('input').forEach(x => { x.value = ''; });
			} }, '×')
		]);
		this.subList.appendChild(row);
		return row;
	},

	readSubs() {
		return Array.from(this.subList.children).map(r => ({
			name: r.querySelector('.mh-sub-name').value,
			url: r.querySelector('.mh-sub-url').value,
			ua: r.querySelector('.mh-sub-ua').value
		}));
	},

	cardUrl() {
		this.urlInput = E('input', { 'class': 'cbi-input-text', type: 'url', placeholder: 'https://…', spellcheck: 'false', autocomplete: 'off' });
		this.uaInput = E('input', { 'class': 'cbi-input-text', type: 'text', placeholder: 'clash.meta' });
		// 地址或 UA 改了，之前读取的内容就作废
		const reset = () => { this.st.fetched = null; this.st.fetchFailed = false; this.urlNote.replaceChildren(); };
		this.urlInput.addEventListener('input', reset);
		this.uaInput.addEventListener('input', reset);
		this.urlNote = E('div', {});
		return mui.card('从链接下载', [
			mui.field('配置地址', this.urlInput, '返回完整 mihomo（Clash Meta）配置的链接。服务运行时经本机代理下载，否则直连；地址不会写进日志。'),
			mui.field('User-Agent', this.uaInput, '留空使用 clash.meta；部分订阅按 UA 决定返回的格式'),
			this.urlNote,
			E('p', { 'class': 'mh-note' }, '点「下一步」时先读取一次链接，确认是 mihomo 配置；如果是节点订阅（分享链接或 base64），请改用内置模板。')
		], { cls: 'mh-src-card' });
	},

	cardImport() {
		this.contentInput = E('textarea', { 'class': 'mh-textarea', rows: 14, spellcheck: 'false', placeholder: '在此粘贴 YAML 配置，或选择文件' });
		const file = E('input', { type: 'file', accept: '.yaml,.yml,.txt', 'change': ev => {
			const f = ev.target.files && ev.target.files[0];
			if (!f) return;
			if (f.size > 4 * 1024 * 1024) { mui.notify('文件过大（超过 4 MB）', 'error'); return; }
			f.text().then(t => { this.contentInput.value = t; }, e => mui.notify('读取文件失败：' + e.message, 'error'));
		} });
		return mui.card('导入文件', [ this.contentInput, E('div', { 'class': 'mh-actions mh-actions-left' }, [ file ]) ], { cls: 'mh-src-card' });
	},

	cardRouter() {
		this.adaptBox = E('input', { type: 'checkbox', 'change': () => this.syncConfig() });
		this.adaptBox.checked = true;
		this.adaptField = mui.field('补全设置', E('label', { 'class': 'mh-check' }, [ this.adaptBox, ' 补全路由器所需设置（推荐）' ]),
			'添加 eBPF 透明代理入站、DNS 监听与劫持规则，控制器改为 0.0.0.0 并配好 zashboard，关闭 TUN，移除冲突的透明代理入站；已有的同类设置保持不变。下一步会列出具体改动，可逐项取消可选项。');
		this.lanBox = E('div', { 'class': 'mh-lan' });
		this.lanField = mui.field('下联接口', this.lanBox, '经过这些接口的局域网设备流量走透明代理，通常是 br-lan');
		this.drawLan();
		this.secretInput = E('input', { 'class': 'cbi-input-text', type: 'text', placeholder: '留空则随机生成', spellcheck: 'false', autocomplete: 'off' });
		this.secretField = mui.field('面板密钥', [
			E('div', { 'class': 'mh-inline' }, [ this.secretInput, mui.btn('随机', () => { this.secretInput.value = randomSecret(); }, 'mh-btn-sm') ])
		], '控制器（zashboard 与本页实时数据）的访问密钥。打开面板时会自动带上，不必记住。');
		this.previewBtn = mui.btn('预览生成的配置', () => this.preview(), 'mh-btn-sm');
		return mui.card('路由器设置', [ this.adaptField, this.lanField, this.secretField, E('div', { 'class': 'mh-actions mh-actions-left' }, this.previewBtn) ]);
	},

	drawLan() {
		const sel = this.st.lan;
		const choices = lanChoices(this.ifs, sel);
		if (!choices.length) {
			this.lanBox.replaceChildren(E('span', { 'class': 'mh-sub' }, '读不到网络接口列表'));
			return;
		}
		this.lanBox.replaceChildren(...choices.map(c => {
			const box = E('input', { type: 'checkbox', value: c.name, 'change': ev => {
				const on = ev.target.checked;
				this.st.lan = on ? this.st.lan.concat(c.name).filter((n, i, a) => a.indexOf(n) === i) : this.st.lan.filter(n => n !== c.name);
			} });
			box.checked = sel.indexOf(c.name) >= 0;
			return E('label', { 'class': 'mh-check' + (c.upstream ? ' mh-upstream' : ''), title: c.upstream ? '这是默认出口（上游）接口，一般不要勾选' : '' }, [ box, ' ', c.label ]);
		}));
	},

	setSource(src) {
		this.st.source = src;
		this.cfgErr.textContent = '';
		this.syncConfig();
	},

	syncConfig() {
		const src = this.st.source, tpl = src === 'template';
		this.srcBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-src') === src));
		[ 'template', 'url', 'import' ].forEach(k => { this.cards[k].hidden = k !== src; });
		this.adaptField.hidden = tpl;
		this.lanField.hidden = !tpl && !this.adaptBox.checked;
		this.secretField.hidden = !tpl;
		this.previewBtn.parentNode.hidden = !tpl;
	},

	// 收集当前来源的输入并校验；返回错误文字或 null
	collect() {
		const st = this.st;
		st.adapt = this.adaptBox.checked;
		if (st.source === 'template') {
			const v = validateSubs(this.readSubs());
			if (!v.ok) return v.error;
			st.subs = v.subs;
			st.secret = this.secretInput.value.trim();
			if (/\s/.test(st.secret)) return '面板密钥不能包含空格';
		} else if (st.source === 'url') {
			st.url = this.urlInput.value.trim();
			st.ua = this.uaInput.value.trim();
			if (!URL_RE.test(st.url)) return '配置地址需要以 http:// 或 https:// 开头';
		} else {
			st.content = this.contentInput.value;
			if (!st.content.trim()) return '请粘贴配置内容或选择文件';
		}
		if ((st.source === 'template' || st.adapt) && !st.lan.length) return '请至少选择一个下联接口';
		return null;
	},

	nextFromConfig() {
		const err = this.collect();
		this.cfgErr.textContent = err || '';
		if (err || this.busy) return;
		const st = this.st;
		this.busy = true;
		this.cfgErr.className = 'mh-foot-note';
		this.cfgErr.textContent = '正在检查配置…';
		const fetch = st.source === 'url' && !st.fetched && !st.fetchFailed ? this.fetchUrl() : Promise.resolve();
		fetch.then(() => this.loadChanges()).then(() => {
			this.cfgErr.textContent = '';
			st.keep = false;
			this.go(2);
		}, e => {
			this.cfgErr.className = 'mh-foot-note mh-err';
			this.cfgErr.textContent = e.message;
		}).then(() => {
			this.busy = false;
			this.cfgErr.className = 'mh-foot-note mh-err';
		});
	},

	// 读取链接并识别内容。读取失败时允许再点一次「下一步」改由后台任务下载
	fetchUrl() {
		const st = this.st;
		const note = (cls, kids) => this.urlNote.replaceChildren(E('div', { 'class': 'mh-callout' + (cls ? ' ' + cls : '') }, kids));
		return api.rpc.setupFetch(st.url, st.ua).then(r => {
			if (!r || !r.ok) {
				st.fetchFailed = true;
				note('', [ E('div', {}, [ E('b', {}, '读取失败'),
					E('span', {}, ((r && r.error) || '未知错误') + '。再点一次「下一步」改由后台任务下载（时限更长），但不能提前预览补全。') ]) ]);
				throw new Error('读取链接失败');
			}
			if (r.kind === 'subscription') {
				note('', [
					E('div', {}, [ E('b', {}, '这是节点订阅'), E('span', {}, (r.message || '') + '。内置模板可以直接使用这类订阅。') ]),
					mui.btn('改用内置模板', () => this.useTemplate(st.url, st.ua), 'mh-btn-sm cbi-button-action')
				]);
				throw new Error('链接返回的不是 mihomo 配置');
			}
			if (r.kind !== 'config' && r.kind !== 'partial') {
				note('', [ E('div', {}, [ E('b', {}, '无法识别'), E('span', {}, r.message || '不是 mihomo 配置') ]) ]);
				throw new Error('链接返回的不是 mihomo 配置');
			}
			st.fetched = { content: r.content, summary: r.summary };
			note('', [ E('div', {}, [ E('b', {}, '已读取'),
				E('span', { 'class': r.message ? 'mh-warn' : '' }, summaryText(r.summary) + (r.message ? '。' + r.message : '')) ]) ]);
		});
	},

	// 节点订阅转到内置模板：填进第一条没填地址的订阅行
	useTemplate(url, ua) {
		const sub = subFromUrl(url, ua);
		let row = Array.from(this.subList.children).find(r => !r.querySelector('.mh-sub-url').value.trim());
		if (!row) {
			if (this.subList.children.length >= MAX_SUBS) return mui.notify('订阅过多（最多 ' + MAX_SUBS + ' 个）', 'error');
			row = this.addSubRow();
		}
		if (!row.querySelector('.mh-sub-name').value.trim()) row.querySelector('.mh-sub-name').value = sub.name;
		row.querySelector('.mh-sub-url').value = sub.url;
		row.querySelector('.mh-sub-ua').value = sub.ua || '';
		this.setSource('template');
		row.querySelector('.mh-sub-url').focus();
	},

	// 要补全的内容：导入的文本，或已读取的链接内容；链接读取失败改由后台下载时为 null
	adaptContent() {
		const st = this.st;
		if (st.source === 'import') return st.content;
		return st.fetched ? st.fetched.content : null;
	},

	// 先在临时文件上试一遍补全，得到改动清单；配置本身有错时在这一步就报出来
	loadChanges() {
		const st = this.st;
		const content = st.source !== 'template' && st.adapt ? this.adaptContent() : null;
		if (content == null) {
			st.changes = null;
			return Promise.resolve();
		}
		return api.setupAdapt({ content: content, lan: st.lan, secret: '', skip: [] }).then(r => {
			if (!r || !r.ok) throw new Error('配置有误：' + ((r && r.error) || '未知错误'));
			st.changes = r.changes || [];
			st.skip = keepSkip(st.skip, st.changes);
		});
	},

	drawChanges() {
		const st = this.st;
		if (!st.changes) return '';
		if (!st.changes.length) return mui.row('补全设置', '无需改动，配置已包含路由器所需设置');
		const items = st.changes.map(c => {
			const box = E('input', { type: 'checkbox', 'change': ev => {
				st.skip = ev.target.checked ? st.skip.filter(x => x !== c.id) : st.skip.concat(c.id);
			} });
			box.checked = st.skip.indexOf(c.id) < 0;
			box.disabled = !c.optional;
			return E('label', { 'class': 'mh-check mh-change', title: c.optional ? '' : '透明代理工作所必需，不能取消' }, [
				box, ' ', E('span', {}, [
					E('b', {}, c.title), c.optional ? E('span', { 'class': 'mh-sub' }, '（可选）') : '',
					c.detail ? E('span', { 'class': 'mh-sub mh-change-detail' }, c.detail) : ''
				])
			]);
		});
		return E('div', { 'class': 'mh-changes' }, [
			E('b', {}, '将补全的设置'),
			E('p', { 'class': 'mh-note' }, '必需项是透明代理工作所需，不能取消；可选项可以取消勾选。'),
			E('div', { 'class': 'mh-change-list' }, items),
			E('div', { 'class': 'mh-actions mh-actions-left' }, mui.btn('查看补全后的配置', ev => this.previewAdapt(ev.currentTarget), 'mh-btn-sm'))
		]);
	},

	previewAdapt(btn) {
		const st = this.st;
		btn.disabled = true;
		api.setupAdapt({ content: this.adaptContent(), lan: st.lan, secret: '', skip: st.skip }).then(r => {
			if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
			const rnd = (r.changes || []).some(c => c.id === 'secret' && c.applied);
			ui.showModal('补全后的配置', [
				rnd ? E('p', { 'class': 'mh-note' }, '面板密钥为随机生成，最终写入的值与预览不同。') : '',
				E('pre', { 'class': 'mh-pre mh-pre-tall' }, r.content),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': () => mui.download('config.yaml', r.content) }, '下载'), ' ',
					E('button', { 'class': 'btn cbi-button-action', 'click': () => ui.hideModal() }, '关闭')
				])
			]);
		}).catch(e => mui.notify('生成失败：' + e.message, 'error')).then(() => { btn.disabled = false; });
	},

	preview() {
		const err = this.collect();
		this.cfgErr.textContent = err || '';
		if (err) return;
		this.previewBtn.disabled = true;
		api.setupRender({ subs: this.st.subs, lan: this.st.lan, secret: this.st.secret }).then(r => {
			if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
			ui.showModal('预览配置', [
				E('p', { 'class': 'mh-note' }, this.st.secret ? '' : '密钥留空时每次生成都会随机，最终写入的值与预览不同。'),
				E('pre', { 'class': 'mh-pre mh-pre-tall' }, r.content),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': () => mui.download('config.yaml', r.content) }, '下载'), ' ',
					E('button', { 'class': 'btn cbi-button-action', 'click': () => ui.hideModal() }, '关闭')
				])
			]);
		}).catch(e => mui.notify('生成失败：' + e.message, 'error')).then(() => { this.previewBtn.disabled = false; });
	},

	/* ---------- 第三步：启动 ---------- */

	panelFinish() {
		this.summaryBox = E('div', {});
		this.startBox = E('input', { type: 'checkbox', 'change': () => this.drawSummary() });
		this.startBox.checked = true;
		this.startField = E('label', { 'class': 'mh-check mh-start' }, [ this.startBox, ' 完成后启动服务，并设为开机自启' ]);
		this.applyBtn = mui.btn('写入配置并启动', () => this.apply(), 'cbi-button-apply');
		this.resultBox = E('div', {});
		return E('div', { 'class': 'mh-setup-panel' }, [
			mui.card('确认', [ this.summaryBox, this.startField ]),
			this.resultBox,
			E('div', { 'class': 'mh-setup-foot' }, [ mui.btn('上一步', () => this.go(1)), E('span', { 'class': 'mh-grow' }), this.applyBtn ])
		]);
	},

	drawSummary() {
		const st = this.st, s = this.status;
		const running = this.coreRunning;
		let cfg;
		if (st.keep) cfg = '保留现有配置';
		else if (st.source === 'template') cfg = '内置模板 · ' + st.subs.length + ' 个订阅（' + st.subs.map(x => x.name).join('、') + '）';
		else if (st.source === 'url') cfg = '从 ' + urlHost(st.url) + ' 下载' + (st.fetched ? ' · ' + summaryText(st.fetched.summary) : '');
		else cfg = '导入 · ' + st.content.split('\n').length + ' 行';
		const routerSet = !st.keep && (st.source === 'template' || st.adapt);
		this.summaryBox.replaceChildren(
			mui.row('内核', this.coreVersion || '未安装'),
			mui.row('配置', E('span', { 'class': 'mh-ellipsis', title: cfg }, cfg)),
			!st.keep && st.source !== 'template' && !(st.adapt && st.changes) ? mui.row('补全设置', st.adapt ? '是' : '否') : '',
			routerSet ? mui.row('下联接口', st.lan.join('、')) : '',
			!st.keep && st.source !== 'template' && st.adapt ? this.drawChanges() : '',
			!st.keep && st.source === 'template' ? mui.row('面板密钥', st.secret ? '已填写' : '随机生成') : '',
			!st.keep ? mui.row('现有配置', s.config ? E('span', { 'class': 'mh-warn' }, '将被覆盖（覆盖前自动备份）') : '无') : '',
			mui.row('服务', running ? '运行中，' + (st.keep ? '将重启' : '将按新配置重启') : '未运行')
		);
		this.startField.hidden = running;
		const start = running || this.startBox.checked;
		this.applyBtn.textContent = st.keep ? (running ? '重启服务' : '启动服务') : (running ? '写入并重启' : (start ? '写入配置并启动' : '只写入配置'));
		this.applyBtn.disabled = st.keep && !running && !this.startBox.checked;
	},

	apply() {
		if (this.st.keep) return this.startOnly();
		const args = buildArgs(Object.assign({}, this.st, { start: this.coreRunning || this.startBox.checked }), this.status.rev);
		const ask = this.status.config
			? mui.confirm('覆盖现有配置', '将用新配置覆盖 ' + CONFIG_PATH + '，覆盖前自动备份。继续？', '覆盖并继续', true)
			: Promise.resolve(true);
		ask.then(yes => {
			if (!yes) return;
			this.applyBtn.disabled = true;
			return mui.runJob(api.setupApply(args), { title: '写入配置', quiet: true, failTitle: '设置失败' }).then(s => {
				if (s.state === 'done') this.showResult(resultLines(s), !!(s.launched || s.restarted));
				return Promise.all([ this.refreshStatus(), this.core.refresh() ]);
			}).then(() => { this.applyBtn.disabled = false; });
		});
	},

	startOnly() {
		const running = this.coreRunning;
		this.applyBtn.disabled = true;
		api.rpc.service('enable').then(() => api.rpc.service(running ? 'restart' : 'start')).then(r => {
			if (!r || !r.ok) throw new Error(((r && r.error) || '未知错误') + (r && r.detail ? '：' + r.detail : ''));
			this.showResult([ running ? '服务已重启' : '服务已启动，并设为开机自启' ], true);
			return this.core.refresh();
		}).catch(e => mui.notify('启动失败：' + e.message, 'error')).then(() => { this.applyBtn.disabled = false; });
	},

	showResult(lines, live) {
		const dash = E('a', { 'class': 'btn cbi-button disabled', target: '_blank', rel: 'noopener noreferrer' }, '打开面板 ↗');
		const links = E('div', { 'class': 'mh-actions mh-actions-left' }, [
			E('a', { 'class': 'btn cbi-button cbi-button-action', href: L.url('admin/services/mihomo/overview') }, '查看概览'),
			E('a', { 'class': 'btn cbi-button', href: L.url('admin/services/mihomo/proxies') }, '选择节点'),
			E('a', { 'class': 'btn cbi-button', href: L.url('admin/services/mihomo/config') }, '查看配置文件'),
			dash
		]);
		this.resultBox.replaceChildren(E('div', { 'class': 'mh-card mh-done' }, [
			E('div', { 'class': 'mh-done-icon' }, '✓'),
			E('div', { 'class': 'mh-done-body' }, [
				E('h3', {}, '设置完成'),
				...lines.map(l => E('p', {}, l)),
				live ? E('p', { 'class': 'mh-sub' }, '订阅与规则集首次下载需要一点时间，稍后在「订阅」页确认节点已就绪。') : '',
				links
			])
		]));
		// 新配置可能改了控制器地址或密钥，重新读取后再给出面板链接
		api.controller(true).then(() => api.dashboard()).then(d => {
			if (!d.url) { dash.title = d.reason || ''; return; }
			dash.href = d.url;
			dash.classList.remove('disabled');
		});
		this.resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}
});
