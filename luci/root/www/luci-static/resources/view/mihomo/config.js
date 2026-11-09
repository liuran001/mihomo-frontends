'use strict';
'require view';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';

/* 配置文件：直接编辑 config.yaml，保存前校验，重启失败自动回滚；备份管理。 */

function lineNumbers(text) {
	const n = text.split('\n').length;
	let out = '1';
	for (let i = 2; i <= n; i++) out += '\n' + i;
	return out;
}

// Tab / Shift+Tab：无选区时插入两个空格；多行选区整体缩进或反缩进
function indent(text, start, end, outdent) {
	if (start === end && !outdent)
		return { text: text.slice(0, start) + '  ' + text.slice(end), start: start + 2, end: start + 2 };
	const ls = text.lastIndexOf('\n', start - 1) + 1;
	const block = text.slice(ls, end);
	const lines = block.split('\n');
	const changed = lines.map(l => outdent ? l.replace(/^ {1,2}/, '') : '  ' + l).join('\n');
	const delta = changed.length - block.length;
	const firstDelta = outdent ? -(lines[0].length - lines[0].replace(/^ {1,2}/, '').length) : 2;
	return {
		text: text.slice(0, ls) + changed + text.slice(end),
		start: start === ls ? ls : Math.max(ls, start + firstDelta),
		end: end + delta
	};
}

// mihomo 的 YAML 错误形如 "yaml: line 383: did not find expected node content"；新版 yq 为 "at L1.C1-L4.C2: …"
function errorLine(msg) {
	msg = msg || '';
	const m = /\bline (\d+)\b/.exec(msg) || /\bL\d+\.C\d+-L(\d+)\.C\d+/.exec(msg) || /\bL(\d+)\.C\d+/.exec(msg);
	return m ? +m[1] : null;
}

// 语法高亮：逐行切分为键、字符串、标量、注释与锚点，输出 HTML（覆盖在透明文字的 textarea 下面）
const HL_LIMIT = 400 * 1024;
const SCALAR = /^(true|false|yes|no|on|off|null|~|-?\d+(\.\d+)?|0x[0-9a-fA-F]+)$/i;

function esc(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 高亮层的文字放在 data-t 属性里、由 CSS ::before 画出来：浏览器的页内查找（Ctrl+F）搜不到生成内容，
// 只会命中下面的文本框，不会同一个词出现两次，也不会把高亮层单独滚走、和文本框错位
function attr(s) {
	return esc(s).replace(/"/g, '&quot;');
}

function txt(s) {
	return s ? '<i data-t="' + attr(s) + '"></i>' : '';
}

function span(cls, s) {
	return s ? '<span class="mh-hl-' + cls + '" data-t="' + attr(s) + '"></span>' : '';
}

// 注释从第一个不在引号里、前面是空白的 # 开始
function splitComment(s) {
	let q = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) { if (c === q) q = null; }
		else if (c === '"' || c === "'") q = c;
		else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return [ s.slice(0, i), s.slice(i) ];
	}
	return [ s, '' ];
}

function value(v) {
	const m = /^(\s*)(.*?)(\s*)$/.exec(v);
	const body = m[2];
	let html;
	if (!body) html = '';
	else if (/^(["']).*\1$/.test(body)) html = span('str', body);
	else if (/^[&*!]\S*/.test(body)) {
		const t = /^([&*!]\S*)(.*)$/.exec(body);
		html = span('mark', t[1]) + value(t[2]);
		return txt(m[1]) + html + txt(m[3]);
	} else if (SCALAR.test(body)) html = span('num', body);
	else if (/^[|>][-+]?\d*$/.test(body) || /^[\[\]{},]+$/.test(body)) html = span('mark', body);
	else html = txt(body);
	return txt(m[1]) + html + txt(m[3]);
}

function highlightLine(line) {
	const [ code, comment ] = splitComment(line);
	let out = '';
	let rest = code;
	const lead = /^(\s*)((?:-\s+)*)/.exec(rest);
	out += txt(lead[1]) + span('mark', lead[2]);
	rest = rest.slice(lead[0].length);
	const key = /^("[^"]*"|'[^']*'|[^\s#'"\[\]{},:][^:#]*?)(\s*:)(?=\s|$)/.exec(rest);
	if (key) {
		out += span('key', key[1]) + span('mark', key[2]);
		rest = rest.slice(key[0].length);
	}
	return out + value(rest) + span('cmt', comment);
}

function highlight(text, errLine) {
	return text.split('\n').map((l, i) => {
		const html = highlightLine(l);
		return i + 1 === errLine ? '<span class="mh-hl-err">' + (html || ' ') + '</span>' : html;
	}).join('\n') + '\n ';
}

// 第 n 行（从 1 开始）在文本中的字符范围，超出时取最后一行
function lineRange(text, n) {
	let start = 0;
	for (let i = 1; i < n; i++) {
		const next = text.indexOf('\n', start);
		if (next < 0) break;
		start = next + 1;
	}
	const end = text.indexOf('\n', start);
	return { start: start, end: end < 0 ? text.length : end };
}

return view.extend({
	lineNumbers, indent, errorLine, lineRange, highlight, highlightLine,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.all([ api.rpc.configRead(), api.rpc.backups() ]);
	},

	render(data) {
		mui.loadCss();
		const cfg = data[0] || {}, bk = data[1] || {};
		const root = E('div', { 'class': 'mh' }, header.render());
		if (!cfg.ok) {
			root.appendChild(mui.card('配置文件', mui.empty(cfg.error || '无法读取配置文件')));
			return root;
		}
		this.saved = cfg.content;
		this.rev = cfg.rev;

		const ta = E('textarea', { 'class': 'mh-code', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
		const gutter = E('pre', { 'class': 'mh-gutter', 'aria-hidden': 'true' });
		const hl = E('pre', { 'class': 'mh-hl', 'aria-hidden': 'true' });
		const wrap = E('div', { 'class': 'mh-code-wrap' }, [ hl, ta ]);
		// 外层统一滚动：文本框不自己滚，高度、宽度由下面的高亮层撑开（与内容一样大），
		// 行号、高亮层、文本框跟着同一个外层容器一起滚，不需要在 scroll 事件里互相同步，手机惯性滚动也不会错位
		const scroller = E('div', { 'class': 'mh-editor' }, E('div', { 'class': 'mh-editor-inner' }, [ gutter, wrap ]));
		this.scroller = scroller;
		this.lint = E('div', { 'class': 'mh-lint' });
		this.errLine = null;
		ta.value = cfg.content;
		this.ta = ta;
		this.badge = E('span', { 'class': 'mh-badge' }, '未保存的修改');
		this.badge.hidden = true;
		this.result = E('div', { 'class': 'mh-result' });

		const undoBtn = mui.btn('撤销全部修改', () => { ta.value = this.saved; sync(); this.result.replaceChildren(); });
		// 高亮在下一帧重画，连续输入只画一次；超过上限时退回普通文本框
		let frame = 0, lintTimer = null;
		const paint = () => {
			frame = 0;
			const on = ta.value.length <= HL_LIMIT;
			wrap.classList.toggle('mh-hl-on', on);
			// 不高亮时也要用原文撑开尺寸（放在属性里由 CSS 画出、且不可见，页内查找同样搜不到）
			hl.innerHTML = on ? highlight(ta.value, this.errLine) : '<i data-t="' + attr(ta.value + '\n ') + '"></i>';
			// 重画前（下一帧）文本框可能比内容小一瞬间，浏览器会让它自己滚一点去露出光标；撑开后归零，改由外层露出光标。
			// 输入后都核对一次光标是否在可见范围（粘贴大段、撤销跳到别处时浏览器不一定会滚外层）
			ta.scrollTop = 0;
			ta.scrollLeft = 0;
			if (document.activeElement === ta) this.reveal(ta.selectionEnd);
		};
		this.repaint = () => { if (!frame) frame = requestAnimationFrame(paint); };
		const sync = () => {
			gutter.setAttribute('data-t', lineNumbers(ta.value));
			this.badge.hidden = ta.value === this.saved;
			undoBtn.disabled = ta.value === this.saved;
			this.repaint();
			clearTimeout(lintTimer);
			lintTimer = setTimeout(() => this.checkSyntax(), 800);
		};
		ta.addEventListener('input', sync);
		ta.addEventListener('keydown', ev => {
			if (ev.key === 'Tab') {
				ev.preventDefault();
				const r = indent(ta.value, ta.selectionStart, ta.selectionEnd, ev.shiftKey);
				ta.value = r.text;
				ta.setSelectionRange(r.start, r.end);
				sync();
			} else if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
				ev.preventDefault();
				this.save();
			}
		});
		sync();

		window.addEventListener('beforeunload', ev => {
			if (this.ta.value !== this.saved) { ev.preventDefault(); ev.returnValue = ''; }
		});

		const editor = mui.card('编辑 config.yaml', [
			E('div', { 'class': 'mh-toolbar' }, [
				mui.btn('下载当前配置', () => this.downloadCurrent()),
				E('span', { 'class': 'mh-grow' }),
				undoBtn,
				mui.btn('校验', () => this.validate()),
				mui.btn('保存并应用', () => this.save(), 'cbi-button-apply')
			]),
			scroller,
			this.lint,
			this.result
		], { tools: [ this.badge, E('span', { 'class': 'mh-sub' }, 'Tab 缩进 · Ctrl+S 保存') ] });

		this.backupBox = E('div', { 'class': 'mh-scroll-x' });
		this.renderBackups(bk.list || []);
		const backups = mui.card('备份（重启型修改前自动备份，保留最近 10 份）', this.backupBox);

		root.appendChild(editor);
		root.appendChild(backups);
		return root;
	},

	showResult(ok, title, detail) {
		const line = ok ? null : errorLine(title);
		this.result.replaceChildren(
			E('p', { 'class': ok ? 'mh-ok' : 'mh-err' }, [
				title,
				line ? [ ' ', mui.btn('跳到第 ' + line + ' 行', () => this.gotoLine(line), 'mh-btn-sm') ] : ''
			]),
			detail ? E('details', {}, [ E('summary', {}, '完整输出'), E('pre', { 'class': 'mh-pre' }, detail) ]) : ''
		);
	},

	// 输入停顿后只查 YAML 语法（yq，很快）；完整校验（mihomo -t）仍由「校验」按钮触发
	checkSyntax() {
		const text = this.ta.value;
		if (this.linted === text) return;
		this.linted = text;
		return api.rpc.yamlCheck(text).then(r => {
			if (this.ta.value !== text) return;
			if (!r || !r.ok) {
				this.lint.replaceChildren(r && r.error ? E('span', { 'class': 'mh-sub' }, r.error) : '');
				this.errLine = null;
			} else if (r.valid) {
				this.errLine = null;
				this.lint.replaceChildren(E('span', { 'class': 'mh-ok' }, '✓ YAML 语法正确'), E('span', { 'class': 'mh-sub' }, '　保存前会再用 mihomo 完整校验'));
			} else {
				this.errLine = r.line || null;
				this.lint.replaceChildren(E('span', { 'class': 'mh-err' }, '✕ YAML 语法错误' + (r.line ? '（第 ' + r.line + ' 行）' : '') + '：' + r.error),
					r.line ? [ ' ', mui.btn('跳到该行', () => this.gotoLine(r.line), 'mh-btn-sm') ] : '');
			}
			this.repaint();
		}, () => { this.linted = null; });
	},

	// 让文本中 pos 处在外层滚动容器里可见（跳行、粘贴大段文字后）
	reveal(pos) {
		const ta = this.ta, box = this.scroller;
		const cs = getComputedStyle(ta);
		const lh = parseFloat(cs.lineHeight) || 19, pad = parseFloat(cs.paddingTop) || 0;
		const before = ta.value.slice(0, pos), line = before.split('\n').length - 1;
		const top = pad + line * lh;
		if (top < box.scrollTop || top + lh > box.scrollTop + box.clientHeight)
			box.scrollTop = Math.max(0, top - box.clientHeight / 3);
		// 横向按真实字宽算（中文比英文宽）
		const ctx = (this.measure = this.measure || document.createElement('canvas').getContext('2d'));
		ctx.font = cs.font;
		// 行号栏固定在左边（sticky），文本区从它右边开始
		const gutterW = ta.parentNode.offsetLeft;
		const x = gutterW + (parseFloat(cs.paddingLeft) || 0) + ctx.measureText(before.slice(before.lastIndexOf('\n') + 1)).width;
		if (x < box.scrollLeft + gutterW + 20 || x > box.scrollLeft + box.clientWidth - 40)
			box.scrollLeft = Math.max(0, x - gutterW - (box.clientWidth - gutterW) / 2);
	},

	gotoLine(n) {
		const ta = this.ta, r = lineRange(ta.value, n);
		ta.focus({ preventScroll: true });
		ta.setSelectionRange(r.start, r.end);
		this.reveal(r.start);
	},

	validate() {
		this.result.replaceChildren(E('p', { 'class': 'mh-sub' }, '校验中…'));
		return api.rpc.validate(this.ta.value).then(r => {
			if (!r.ok) return this.showResult(false, r.error);
			if (r.valid) this.showResult(true, '校验通过');
			else this.showResult(false, '校验失败：' + r.error, r.detail);
		}, e => this.showResult(false, '校验请求失败：' + e.message));
	},

	save() {
		if (this.ta.value === this.saved) {
			mui.notify('没有修改');
			return;
		}
		this.result.replaceChildren();
		mui.runJob(api.rpc.saveRaw(this.ta.value, this.rev)).then(s => {
			if (s.state === 'failed' && s.error && s.error.indexOf('校验失败') === 0)
				this.showResult(false, s.error, s.detail);
			if (s.state !== 'failed') this.reload(s.state === 'done');
		});
	},

	// 保存成功（fromDisk）时用磁盘上的内容刷新编辑器；回滚时保留编辑内容，方便修改后重试
	reload(fromDisk) {
		return Promise.all([ api.rpc.configRead(), api.rpc.backups() ]).then(([ cfg, bk ]) => {
			if (cfg.ok) {
				this.saved = cfg.content;
				this.rev = cfg.rev;
				if (fromDisk) this.ta.value = cfg.content;
				this.ta.dispatchEvent(new Event('input'));
			}
			this.renderBackups(bk.list || []);
		});
	},

	downloadCurrent() {
		api.rpc.configRead().then(r => {
			if (r.ok) mui.download('config.yaml', r.content);
			else mui.notify(r.error, 'error');
		});
	},

	renderBackups(list) {
		if (!list.length) {
			this.backupBox.replaceChildren(mui.empty('还没有备份'));
			return;
		}
		this.backupBox.replaceChildren(E('table', { 'class': 'mh-table' }, [
			E('tr', {}, [ E('th', {}, '时间'), E('th', {}, '大小'), E('th', {}, '') ]),
			...list.map(b => E('tr', {}, [
				E('td', {}, mui.fmtDate(b.time)),
				E('td', {}, mui.fmtBytes(b.size)),
				E('td', { 'class': 'mh-actions' }, [
					mui.btn('恢复', () => this.restore(b), 'mh-btn-sm'), ' ',
					mui.btn('下载', () => this.downloadBackup(b), 'mh-btn-sm'), ' ',
					mui.btn('删除', () => this.removeBackup(b), 'mh-btn-sm cbi-button-negative')
				])
			]))
		]));
	},

	restore(b) {
		mui.confirm('恢复备份', '用 ' + mui.fmtDate(b.time) + ' 的备份替换当前配置并重启服务？当前配置会先自动备份。', '恢复').then(yes => {
			if (!yes) return;
			mui.runJob(api.rpc.backupRestore(b.name)).then(s => { if (s.state !== 'failed') this.reload(true); });
		});
	},

	downloadBackup(b) {
		api.rpc.backupRead(b.name).then(r => {
			if (r.ok) mui.download(b.name, r.content);
			else mui.notify(r.error, 'error');
		});
	},

	removeBackup(b) {
		mui.confirm('删除备份', '删除 ' + mui.fmtDate(b.time) + ' 的备份？', '删除', true).then(yes => {
			if (!yes) return;
			api.rpc.backupDelete(b.name).then(r => {
				if (!r.ok) mui.notify(r.error, 'error');
				return api.rpc.backups().then(bk => this.renderBackups(bk.list || []));
			});
		});
	}
});
