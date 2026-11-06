'use strict';
'require view';
'require ui';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';

/* Sub-Store：合并、筛选、改名多个机场订阅后交给 mihomo。可以使用已有的 Sub-Store 服务，或在路由器上运行（按需安装）。 */

const MODES = [ [ 'off', '不使用' ], [ 'local', '在路由器上运行' ], [ 'remote', '使用已有的 Sub-Store 服务' ] ];
const REMOTE_FRONTEND = 'https://sub-store.vercel.app/';

// 浏览器里打开的地址：前端带 ?api=后端地址。本机模式只有开放局域网访问时浏览器才连得上
function openUrl(st, hostname) {
	if (st.mode === 'local') {
		if (!st.lan || !st.path) return null;
		const host = hostname.indexOf(':') >= 0 && hostname[0] !== '[' ? '[' + hostname + ']' : hostname;
		const base = 'http://' + host + ':' + st.port;
		return (st.installed.frontend ? base + '/' : REMOTE_FRONTEND) + '?api=' + encodeURIComponent(base + '/' + st.path);
	}
	if (st.mode === 'remote' && st.url) return REMOTE_FRONTEND + '?api=' + encodeURIComponent(st.url);
	return null;
}

// 订阅名：mihomo 的 proxy-providers 键，不能含 / , \ 也不能以 . 开头
function providerName(title) {
	return String(title || '').replace(/[\/,\\]/g, '_').replace(/^\.+/, '').trim().slice(0, 64) || 'Sub-Store';
}

function kb(n) {
	return n == null ? '未知' : mui.fmtBytes(n * 1024);
}

return view.extend({
	openUrl, providerName,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return api.rpc.substoreStatus().catch(e => ({ ok: false, error: e.message }));
	},

	render(st) {
		mui.loadCss();
		this.body = E('div', {});
		const root = E('div', { 'class': 'mh' }, [ header.render(), this.body ]);
		this.show(st);
		if (this.poller) this.poller.close();
		this.poller = api.poll(root, 3000, () => this.st && this.st.install.installing ? this.refresh() : null, false);
		return root;
	},

	refresh() {
		return api.rpc.substoreStatus().then(st => this.show(st), e => mui.notify(e.message, 'error'));
	},

	show(st) {
		if (!st || !st.ok) {
			this.body.replaceChildren(mui.card('Sub-Store', mui.empty((st && st.error) || '读取失败')));
			return;
		}
		this.st = st;
		const parts = [ this.settingsCard(st) ];
		if (st.mode === 'local') parts.push(this.localCard(st));
		if (st.mode !== 'off') parts.push(this.subsCard(st));
		this.body.replaceChildren(...parts);
	},

	settingsCard(st) {
		const mode = E('select', { 'class': 'cbi-input-select' }, MODES.map(m => E('option', { value: m[0] }, m[1])));
		mode.value = st.mode;
		const port = E('input', { 'class': 'cbi-input-text', type: 'number', min: 1024, max: 65535, value: st.port, style: 'width:8em' });
		const lan = E('input', { type: 'checkbox' });
		lan.checked = st.lan;
		const url = E('input', { 'class': 'cbi-input-text', value: st.url, placeholder: 'https://sub.example.com/后端路径', style: 'width:100%' });
		const localRows = E('div', {}, [
			mui.field('端口', port, '前端与接口共用这个端口'),
			mui.field('允许局域网访问', lan, '开启后可以在电脑或手机的浏览器里打开 Sub-Store 管理订阅；接口带随机路径，不知道路径的人读不到订阅')
		]);
		const remoteRows = E('div', {}, mui.field('后端地址', url, 'Sub-Store 的后端地址（含路径），例如在 Sub-Store 的设置里看到的「后端地址」'));
		const toggle = () => {
			localRows.hidden = mode.value !== 'local';
			remoteRows.hidden = mode.value !== 'remote';
		};
		mode.addEventListener('change', toggle);
		toggle();
		const saveBtn = mui.btn('保存', () => {
			saveBtn.disabled = true;
			api.rpc.substoreSet(mode.value, Number(port.value), lan.checked, url.value.trim()).then(r => {
				if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
				mui.notify('已保存');
				this.show(r);
			}).catch(e => mui.notify(e.message, 'error')).then(() => { saveBtn.disabled = false; });
		}, 'cbi-button-apply');
		return mui.card('Sub-Store', [
			E('p', { 'class': 'mh-note' }, 'Sub-Store 可以把多个机场订阅合并、筛选、改名后输出给 mihomo。可以使用已有的 Sub-Store 服务，也可以在路由器上运行（需要按需下载 node 与 Sub-Store，约占 30–60 MB 闪存）。'),
			mui.field('使用方式', mode),
			localRows,
			remoteRows,
			E('div', { 'class': 'mh-toolbar' }, saveBtn)
		]);
	},

	localCard(st) {
		const inst = st.installed, v = st.versions, job = st.install;
		const ready = inst.node && inst.backend;
		const btns = [];
		const busy = job.installing;
		if (!ready) btns.push(mui.btn(busy ? '正在下载…' : '下载并启动', () => this.install('all'), 'cbi-button-action'));
		else {
			btns.push(st.running ? mui.btn('停止', () => this.service('stop'), 'cbi-button-negative') : mui.btn('启动', () => this.service('start'), 'cbi-button-action'));
			btns.push(' ', mui.btn('更新 Sub-Store', () => this.install('backend'), ''));
			btns.push(' ', mui.btn('更新网页前端', () => this.install('frontend'), ''));
		}
		btns.forEach(b => { if (b && b.tagName) b.disabled = busy; });
		const state = !ready ? E('span', { 'class': 'mh-warn' }, '未下载')
			: st.running ? E('span', { 'class': 'mh-ok' }, '运行中') : E('span', { 'class': 'mh-warn' }, '已停止');
		const children = [
			mui.row('状态', state),
			mui.row('node', inst.node ? v.node : E('span', { 'class': 'mh-warn' }, '未安装（会用软件包管理器安装）')),
			mui.row('Sub-Store', inst.backend ? (v.backend || '已下载') : '未下载'),
			mui.row('网页前端', inst.frontend ? (v.frontend || '已下载') : '未下载（可用在线前端 ' + REMOTE_FRONTEND + '）'),
			mui.row('处理器架构', st.arch || '未知'),
			mui.row('剩余空间', kb(st.free_kb)),
			E('div', { 'class': 'mh-toolbar', style: 'margin:8px 0' }, btns)
		];
		if (job.installing || (job.result && job.result !== 'ok'))
			children.push(E('p', { 'class': job.installing ? 'mh-sub' : 'mh-err' }, job.installing ? '正在下载与安装，可以离开这个页面，完成后会自动启动。' : '上次安装失败：' + job.result));
		if (job.log && (job.installing || job.result !== 'ok'))
			children.push(E('pre', { 'class': 'mh-pre', style: 'max-height:240px;overflow:auto' }, job.log));
		if (ready)
			children.push(E('details', { style: 'margin-top:8px' }, [
				E('summary', {}, '维护'),
				E('div', { 'class': 'mh-toolbar', style: 'margin-top:8px' }, [
					mui.btn('更换后端路径', () => mui.confirm('更换后端路径', '旧的订阅链接与浏览器里保存的后端地址都会失效，mihomo 里通过「添加到订阅」加入的链接需要重新添加。', '更换', true)
						.then(yes => yes && this.service('reset-path')), ''), ' ',
					mui.btn('删除 Sub-Store 程序', () => mui.confirm('删除 Sub-Store', '停止服务并删除下载的 Sub-Store（保留订阅数据；node 软件包不卸载）。', '删除', true)
						.then(yes => yes && this.service('uninstall')), 'cbi-button-remove')
				])
			]));
		return mui.card('在路由器上运行', children);
	},

	subsCard(st) {
		const link = openUrl(st, location.hostname);
		const box = E('div', {}, mui.empty('读取中…'));
		const card = mui.card('订阅', [
			E('p', { 'class': 'mh-note' }, '在 Sub-Store 里添加机场订阅或组合订阅后，可以在这里把它加入 mihomo 的订阅（proxy-providers），之后由 mihomo 定时更新。'),
			E('div', { 'class': 'mh-toolbar' }, [
				link ? mui.btn('打开 Sub-Store', () => window.open(link, '_blank', 'noopener'), 'cbi-button-action')
					: E('span', { 'class': 'mh-sub' }, st.mode === 'local' ? '开启「允许局域网访问」后可以在浏览器里打开 Sub-Store' : ''),
				' ', mui.btn('刷新列表', () => this.loadList(box))
			]),
			box
		]);
		if (st.mode === 'remote' || st.running) this.loadList(box);
		else box.replaceChildren(mui.empty('Sub-Store 未运行'));
		return card;
	},

	loadList(box) {
		box.replaceChildren(mui.empty('读取中…'));
		return api.rpc.substoreList().then(r => {
			if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
			if (!r.list.length) return box.replaceChildren(mui.empty('Sub-Store 里还没有订阅'));
			box.replaceChildren(E('div', { 'class': 'mh-scroll-x' }, E('table', { 'class': 'mh-table' }, [
				E('tr', {}, [ E('th', {}, '名称'), E('th', {}, '类型'), E('th', {}, '') ]),
				...r.list.map(e => E('tr', {}, [
					E('td', {}, e.title),
					E('td', {}, e.kind === 'collection' ? '组合订阅' : '单个订阅'),
					E('td', { 'class': 'mh-actions' }, mui.btn('添加到订阅', () => this.addProvider(e), 'mh-btn-sm cbi-button-add'))
				]))
			])));
		}).catch(e => box.replaceChildren(mui.empty('读取订阅失败：' + e.message)));
	},

	addProvider(e) {
		const name = E('input', { 'class': 'cbi-input-text', value: providerName(e.title) });
		ui.showModal('添加到订阅', [
			mui.field('订阅名称', name, '在 mihomo 里显示的名称；已存在同名订阅时请换一个'),
			E('p', { 'class': 'mh-note' }, '会加入 proxy-providers，每小时更新一次，并加入引用全部订阅的策略组。'),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '取消'), ' ',
				E('button', { 'class': 'btn cbi-button-positive', 'click': () => {
					const n = name.value.trim();
					return api.rpc.sections([ 'providers' ]).then(s => {
						if (!s || !s.ok) throw new Error((s && s.error) || '读取配置失败');
						return mui.runJob(api.rpc.patch([ { op: 'provider.add', name: n, data: { url: e.url, interval: 3600 } } ], s.rev));
					}).then(s => { if (s && s.state === 'done') mui.notify('已添加订阅 ' + n); }, err => mui.notify(err.message, 'error'));
				} }, '添加')
			])
		]);
	},

	install(what) {
		return api.rpc.substoreInstall(what).then(r => {
			if (!r || !r.ok) throw new Error((r && r.error) || '启动安装失败');
			this.show(r);
		}).catch(e => mui.notify(e.message, 'error'));
	},

	service(action) {
		return api.rpc.substoreService(action).then(r => {
			if (!r || !r.ok) throw new Error(((r && r.error) || '操作失败') + (r && r.detail ? '：' + r.detail : ''));
			this.show(r);
		}).catch(e => mui.notify(e.message, 'error'));
	}
});
