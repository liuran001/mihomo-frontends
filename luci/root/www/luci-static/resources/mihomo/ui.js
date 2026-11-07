'use strict';
'require baseclass';
'require ui';
'require mihomo.api as api';

/* 公共界面工具：格式化、卡片、按钮、确认框、保存任务进度。 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function fmtBytes(n) {
	n = Number(n) || 0;
	let i = 0;
	while (Math.abs(n) >= 1024 && i < UNITS.length - 1) {
		n /= 1024;
		i++;
	}
	return (i === 0 ? String(Math.round(n)) : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + UNITS[i];
}

function fmtRate(n) {
	return fmtBytes(n) + '/s';
}

function fmtDuration(sec) {
	sec = Math.max(0, Math.floor(Number(sec) || 0));
	const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
	if (d) return d + ' 天 ' + h + ' 小时';
	if (h) return h + ' 小时 ' + m + ' 分';
	if (m) return m + ' 分 ' + s + ' 秒';
	return s + ' 秒';
}

function toMs(t) {
	if (t == null || t === '') return NaN;
	if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
	return Date.parse(t);
}

function pad(n) {
	return (n < 10 ? '0' : '') + n;
}

// t 可以是秒级时间戳、毫秒时间戳或 ISO 字符串；Go 的零值时间（0001 年）显示为 '-'
function fmtDate(t) {
	const ms = toMs(t);
	if (isNaN(ms)) return '-';
	const d = new Date(ms);
	if (d.getFullYear() < 2000) return '-';
	return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function fmtAgo(t) {
	const ms = toMs(t);
	if (isNaN(ms) || new Date(ms).getFullYear() < 2000) return '-';
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 60) return '刚刚';
	if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
	if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
	return Math.floor(s / 86400) + ' 天前';
}

// 延迟着色：<200 ms 绿、<500 ms 黄、更高或超时（0）红、未测灰
function delayClass(ms) {
	if (ms == null) return 'none';
	if (ms <= 0) return 'bad';
	if (ms < 200) return 'good';
	if (ms < 500) return 'mid';
	return 'bad';
}

// 网络接口的说明文字：类型、是否默认出口、连接状态、第一个地址
function ifLabel(i) {
	const bits = [];
	if (i.kind === 'bridge') bits.push('网桥');
	else if (i.kind) bits.push(i.kind);
	if (i.is_default_upstream) bits.push('默认出口');
	if (!i.up) bits.push('未连接');
	if (i.addrs && i.addrs.length) bits.push(i.addrs[0]);
	return i.name + (bits.length ? '（' + bits.join('，') + '）' : '');
}

let cssLoaded = false;
function loadCss() {
	if (cssLoaded) return;
	cssLoaded = true;
	// 与 LuCI 加载 JS 模块用同一个版本号，部署后一起失效
	const v = L.env.resource_version;
	document.head.appendChild(E('link', { rel: 'stylesheet', href: L.resource('mihomo/mihomo.css') + (v ? '?v=' + encodeURIComponent(v) : '') }));
}

function card(title, body, opts) {
	opts = opts || {};
	const head = (title || opts.tools)
		? E('div', { 'class': 'mh-card-head' }, [ E('h3', {}, title || ''), opts.tools ? E('div', { 'class': 'mh-tools' }, opts.tools) : '' ])
		: '';
	return E('div', { 'class': 'mh-card' + (opts.cls ? ' ' + opts.cls : '') }, [ head, E('div', { 'class': 'mh-card-body' }, body) ]);
}

function kpi(label, body) {
	return E('div', { 'class': 'mh-card mh-kpi' }, [ E('div', { 'class': 'mh-kpi-label' }, label), E('div', { 'class': 'mh-kpi-body' }, body) ]);
}

function btn(label, onclick, cls) {
	return E('button', { 'class': 'btn cbi-button ' + (cls || ''), 'click': onclick }, label);
}

function row(k, v) {
	return E('div', { 'class': 'mh-row' }, [ E('span', { 'class': 'mh-k' }, k), E('span', { 'class': 'mh-v' }, v) ]);
}

function meter(ratio, cls) {
	const pct = Math.max(0, Math.min(1, Number(ratio) || 0)) * 100;
	return E('div', { 'class': 'mh-meter ' + (cls || '') }, E('i', { style: 'width:' + pct.toFixed(1) + '%' }));
}

// 表单行：左侧标签，右侧控件与说明；control 可以是元素或元素数组
function field(label, control, help) {
	return E('div', { 'class': 'mh-field' }, [
		E('div', { 'class': 'mh-field-label' }, label),
		E('div', { 'class': 'mh-field-ctl' }, [].concat(control, help ? E('div', { 'class': 'mh-field-help' }, help) : []))
	]);
}

function empty(text, action) {
	return E('div', { 'class': 'mh-empty' }, [ E('p', {}, text), action || '' ]);
}

function notify(msg, kind) {
	ui.addTimeLimitedNotification(null, E('p', {}, msg), 5000, kind || 'info');
}

function confirm(title, text, okLabel, danger) {
	return new Promise(resolve => {
		const close = v => { ui.hideModal(); resolve(v); };
		ui.showModal(title, [
			E('p', {}, text),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': () => close(false) }, '取消'), ' ',
				E('button', { 'class': 'btn cbi-button-' + (danger ? 'negative' : 'positive'), 'click': () => close(true) }, okLabel || '确定')
			])
		]);
	});
}

function download(name, text) {
	const url = URL.createObjectURL(new Blob([ text ], { type: 'text/yaml;charset=utf-8' }));
	const a = E('a', { href: url, download: name, style: 'display:none' });
	document.body.appendChild(a);
	a.click();
	setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

const STEPS = {
	queued: '排队中',
	download: '下载配置',
	adapt: '补全路由器所需设置',
	validate: '校验配置',
	backup: '备份当前配置',
	replace: '替换配置文件',
	runtime: '在线生效',
	start: '启动服务并等待就绪',
	restart: '重启服务并等待恢复',
	rollback: '启动失败，正在回滚',
	done: '完成'
};

// 轮询保存任务直到结束。start 是返回 { ok, job } 的 Promise。结果统一为任务状态对象。
function watchJob(start, onStep) {
	return Promise.resolve(start).then(r => {
		if (!r || !r.ok) return { state: 'failed', error: (r && r.error) || '提交失败' };
		return new Promise(resolve => {
			const tick = () => api.rpc.applyStatus(r.job).then(s => {
				if (!s || !s.ok) return resolve({ state: 'failed', error: (s && s.error) || '无法读取任务状态' });
				if (onStep) onStep(s.step);
				if (s.state === 'running') return setTimeout(tick, 700);
				resolve(s);
			}, e => resolve({ state: 'failed', error: e.message }));
			tick();
		});
	}, e => ({ state: 'failed', error: e.message }));
}

// opts.success(s)：成功时的提示文字（默认按保存配置的结果描述）；opts.failTitle：失败弹窗标题
function showJobResult(s, opts) {
	opts = opts || {};
	if (s.state === 'done') {
		ui.hideModal();
		if (opts.success) notify(opts.success(s));
		else notify(s.note || (s.restarted ? '已保存，服务已按新配置重启' : '已保存并生效'), s.note ? 'warning' : 'info');
		return;
	}
	ui.showModal(s.state === 'rolled_back' ? '已自动回滚' : (opts.failTitle || '保存失败'), [
		E('p', {}, s.error || '未知错误'),
		s.detail ? E('pre', { 'class': 'mh-pre' }, s.detail) : '',
		E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': () => ui.hideModal() }, '关闭'))
	]);
}

// 带进度弹窗的任务流程。opts：title 弹窗标题；steps 步骤名称（缺省时用 STEPS）；success、failTitle 见 showJobResult；
// quiet 为 true 时成功只关闭弹窗、不提示（由调用方在页面上展示结果）
function runJob(start, opts) {
	opts = opts || {};
	const steps = opts.steps || STEPS;
	const stepEl = E('span', {}, '提交中…');
	ui.showModal(opts.title || '保存并应用', [ E('div', { 'class': 'mh-job' }, [ E('span', { 'class': 'mh-spinner' }), stepEl ]) ]);
	return watchJob(start, step => { stepEl.textContent = steps[step] || STEPS[step] || step; }).then(s => {
		if (opts.quiet && s.state === 'done') ui.hideModal();
		else showJobResult(s, opts);
		return s;
	});
}

// 配置里的 icon：http(s) 或 data:image/ 链接，与模块网页一致
function iconUrl(v) {
	return (typeof v === 'string' && (/^https?:\/\//.test(v) || /^data:image\//.test(v))) ? v : '';
}

// 已成功加载过的图标：节点列表每次刷新都重建，这些直接显示图片，不再先闪一下首字
const loadedIcons = new Set();

// 图标；没有或加载失败时显示名称首字
function iconBox(cls) {
	const box = E('span', { 'class': 'mh-icon ' + cls });
	box.set = (url, name) => {
		url = iconUrl(url);
		if (box.url === url && box.label === name) return;
		box.url = url;
		box.label = name;
		// 先显示首字，图片加载成功后再替换：图标地址很慢或失效时不会留一块空白
		const img = E('img', { alt: '', referrerpolicy: 'no-referrer' });
		if (url && loadedIcons.has(url)) {
			img.src = url;
			return box.replaceChildren(img);
		}
		box.replaceChildren(E('b', {}, Array.from(name || '?')[0]));
		if (!url) return;
		img.addEventListener('load', () => {
			loadedIcons.add(url);
			if (box.url === url) box.replaceChildren(img);
		});
		img.src = url;
	};
	return box;
}

return baseclass.extend({
	STEPS,
	fmtBytes, fmtRate, fmtDuration, fmtDate, fmtAgo, delayClass, ifLabel,
	loadCss, card, kpi, btn, row, meter, field, empty, notify, confirm, download,
	watchJob, runJob, iconUrl, iconBox
});
