@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package mihomo

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.viewinterop.HtmlElementView
import org.w3c.dom.HTMLElement
import top.yukonga.miuix.kmp.theme.MiuixTheme

// 代码编辑器：原生 <textarea> 叠在语法高亮层之上（文字透明、只显示光标与选区），左侧固定行号栏。
// 输入、长按菜单、选择、输入法、撤销都由浏览器原生处理；高亮按行缓存，只在内容变化后的下一帧重绘。
// 支持：行号、YAML 高亮、当前行高亮、出错行标记、回车保持缩进（冒号结尾再缩进两格）、Tab 插入两个空格、查找、跳到行。

@JsFun("""(onInput, onCursor) => {
    const LH = 20, PAD = 8;
    if (!document.getElementById('mh-code-style')) {
        const style = document.createElement('style');
        style.id = 'mh-code-style';
        style.textContent =
            '.mh-code-ta::selection{background:var(--mh-sel)}' +
            '.mh-k{color:var(--mh-k)}.mh-s{color:var(--mh-s)}.mh-n{color:var(--mh-n)}' +
            '.mh-c{color:var(--mh-c);font-style:italic}.mh-m{color:var(--mh-m)}' +
            '.mh-e{color:var(--mh-e);font-weight:700}.mh-cur{color:var(--mh-text)}';
        document.head.appendChild(style);
    }
    const font = 'font:13px/20px ui-monospace,"SFMono-Regular","Roboto Mono","Noto Sans Mono","Droid Sans Mono",Menlo,Consolas,monospace;tab-size:2;letter-spacing:0;';
    const root = document.createElement('div');
    root.style.cssText = 'position:absolute;inset:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;-webkit-overflow-scrolling:touch;';
    const inner = document.createElement('div');
    inner.style.cssText = 'position:relative;display:flex;width:max-content;min-width:100%;min-height:100%;';
    const gutter = document.createElement('div');
    gutter.style.cssText = 'position:sticky;left:0;z-index:2;flex:none;box-sizing:border-box;padding:8px 8px 8px 10px;text-align:right;white-space:pre;user-select:none;-webkit-user-select:none;' + font;
    const area = document.createElement('div');
    area.style.cssText = 'position:relative;flex:1;min-width:0;';
    const current = document.createElement('div');
    current.style.cssText = 'position:absolute;left:0;right:0;top:8px;height:20px;pointer-events:none;';
    const pre = document.createElement('pre');
    pre.style.cssText = 'position:relative;margin:0;padding:8px 24px 8px 10px;white-space:pre;pointer-events:none;' + font;
    const ta = document.createElement('textarea');
    ta.className = 'mh-code-ta';
    ta.wrap = 'off';
    ta.spellcheck = false;
    ta.autocomplete = 'off';
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;margin:0;padding:8px 24px 8px 10px;border:0;outline:none;resize:none;overflow:hidden;' +
        'background:transparent;color:transparent;-webkit-text-fill-color:transparent;white-space:pre;-webkit-tap-highlight-color:transparent;' + font;
    area.append(current, pre, ta);
    inner.append(gutter, area);
    root.appendChild(inner);

    // ---------- 高亮 ----------
    const keyRe = /^(\s*)(- +)?((?:"[^"]*"|'[^']*'|[^\s#'"{}\[\],:][^#:]*?))(:)(?=\s|$)/;
    const scalarRe = /^(?:true|false|null|~|yes|no|on|off|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|0x[0-9A-Fa-f]+)$/i;
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const span = (cls, s) => s ? '<span class="mh-' + cls + '">' + esc(s) + '</span>' : '';
    const commentStart = (line) => {
        let quote = null;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (quote) { if (c === quote) quote = null; }
            else if (c === '"' || c === "'") { if (i === 0 || /\s/.test(line[i - 1]) || ':-[{,'.includes(line[i - 1])) quote = c; }
            else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return i;
        }
        return -1;
    };
    let cache = new Map();
    const highlight = (line) => {
        const hit = cache.get(line);
        if (hit !== undefined) return hit;
        const cs = commentStart(line);
        const code = cs >= 0 ? line.slice(0, cs) : line;
        let out = '', vs = 0;
        const m = keyRe.exec(code);
        if (m) {
            out += esc(m[1]);
            if (m[2]) out += span('m', '-') + esc(m[2].slice(1));
            out += span('k', m[3]) + ':';
            vs = m[0].length;
        } else {
            const t = code.trimStart();
            if (t.startsWith('- ') || t === '-') {
                const d = code.indexOf('-');
                out += esc(code.slice(0, d)) + span('m', '-');
                vs = d + 1;
            }
        }
        const rest = code.slice(vs);
        const v = rest.trim();
        if (v) {
            const b = rest.indexOf(v[0]);
            out += esc(rest.slice(0, b));
            let cls = null;
            if (v[0] === '"' || v[0] === "'") cls = 's';
            else if ('&*!'.includes(v[0]) || v === '|' || v === '>' || v.startsWith('|-') || v.startsWith('>-')) cls = 'm';
            else if (scalarRe.test(v)) cls = 'n';
            out += cls ? span(cls, v) : esc(v);
            out += esc(rest.slice(b + v.length));
        } else out += esc(rest);
        if (cs >= 0) out += span('c', line.slice(cs));
        if (cache.size > 20000) cache = new Map();
        cache.set(line, out);
        return out;
    };

    // ---------- 渲染 ----------
    let lineCount = -1, marks = new Set(), marksKey = '', curLine = -1, frame = 0;
    const renderGutter = (count) => {
        let html = '';
        for (let i = 1; i <= count; i++) {
            const cls = marks.has(i) ? 'mh-e' : (i === curLine + 1 ? 'mh-cur' : '');
            html += (cls ? '<span class="' + cls + '">' + i + '</span>' : i) + (i < count ? '\n' : '');
        }
        gutter.innerHTML = html;
        gutter.style.minWidth = (String(count).length * 8 + 22) + 'px';
    };
    const render = () => {
        frame = 0;
        const lines = ta.value.split('\n');
        pre.innerHTML = lines.map(highlight).join('\n') + '\n';
        if (lines.length !== lineCount) { lineCount = lines.length; renderGutter(lineCount); }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    const lineOf = (pos) => { let n = 0, i = -1; while ((i = ta.value.indexOf('\n', i + 1)) !== -1 && i < pos) n++; return n; };
    const cursor = () => {
        const pos = ta.selectionStart;
        const line = lineOf(pos);
        const col = pos - (ta.value.lastIndexOf('\n', pos - 1) + 1);
        current.style.top = (PAD + line * LH) + 'px';
        if (line !== curLine) { curLine = line; if (lineCount > 0) renderGutter(lineCount); }
        onCursor(line + 1, col + 1);
    };
    // 让光标所在位置可见（跳行、查找后）
    const reveal = (pos) => {
        const line = lineOf(pos);
        const top = PAD + line * LH;
        if (top < root.scrollTop + LH) root.scrollTop = Math.max(0, top - root.clientHeight / 3);
        else if (top + LH * 2 > root.scrollTop + root.clientHeight) root.scrollTop = top - root.clientHeight / 3;
        const col = pos - (ta.value.lastIndexOf('\n', pos - 1) + 1);
        const x = col * 7.8 + 10;
        const visible = root.clientWidth - gutter.offsetWidth;
        if (x < root.scrollLeft + 20 || x > root.scrollLeft + visible - 40) root.scrollLeft = Math.max(0, x - visible / 2);
    };
    const insert = (text) => {
        // execCommand 保留浏览器撤销栈；不支持时退回直接改值
        if (!document.execCommand('insertText', false, text)) {
            const s = ta.selectionStart, e = ta.selectionEnd;
            ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
            ta.selectionStart = ta.selectionEnd = s + text.length;
            ta.dispatchEvent(new Event('input'));
        }
    };

    ta.addEventListener('input', () => { schedule(); cursor(); onInput(ta.value); });
    ta.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            insert('  ');
        } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            const s = ta.selectionStart;
            const start = ta.value.lastIndexOf('\n', s - 1) + 1;
            const before = ta.value.slice(start, s);
            let indent = /^\s*/.exec(before)[0];
            const code = before.replace(/\s+#.*$/, '').trimEnd();
            if (code.endsWith(':') || code.endsWith('|') || code.endsWith('>') || code.endsWith('|-') || code.endsWith('>-')) indent += '  ';
            else if (/^\s*- /.test(before) && code.trim() !== '-') indent += '  ';
            event.preventDefault();
            insert('\n' + indent);
        }
    });
    document.addEventListener('selectionchange', () => { if (document.activeElement === ta) cursor(); });
    ta.addEventListener('click', cursor);
    ta.addEventListener('keyup', cursor);

    root.__set = (value) => { if (ta.value !== value) { ta.value = value; schedule(); } };
    root.__theme = (json) => {
        const t = JSON.parse(json);
        for (const k in t) root.style.setProperty('--mh-' + k, t[k]);
        pre.style.color = t.text;
        ta.style.caretColor = t.caret;
        gutter.style.background = t.gutter;
        gutter.style.color = t.gutterText;
        gutter.style.borderRight = '1px solid ' + t.line;
        current.style.background = t.line;
    };
    root.__marks = (list) => {
        if (list === marksKey) return;
        marksKey = list;
        marks = new Set(list ? list.split(',').map(Number) : []);
        if (lineCount > 0) renderGutter(lineCount);
    };
    root.__shown = (shown) => {
        root.style.visibility = shown ? '' : 'hidden';
        if (!shown && document.activeElement === ta) ta.blur();
    };
    root.__goto = (line) => {
        let pos = 0;
        for (let n = 1; n < line && pos !== -1; n++) { pos = ta.value.indexOf('\n', pos); if (pos !== -1) pos++; }
        if (pos === -1) pos = ta.value.length;
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(pos, pos);
        reveal(pos);
        cursor();
    };
    // 查找：从当前选区之后（或之前）找下一处，循环；返回匹配总数
    root.__find = (query, backward) => {
        if (!query) return 0;
        const text = ta.value.toLowerCase(), q = query.toLowerCase();
        let total = 0;
        for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) total++;
        if (!total) return 0;
        let at = backward ? text.lastIndexOf(q, ta.selectionStart - 1) : text.indexOf(q, ta.selectionEnd);
        if (at === -1) at = backward ? text.lastIndexOf(q) : text.indexOf(q);
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(at, at + q.length);
        reveal(at);
        cursor();
        return total;
    };
    root.__command = (name) => { ta.focus({ preventScroll: true }); document.execCommand(name); };
    return root;
}""")
private external fun createCodeEditor(onInput: (String) -> Unit, onCursor: (Int, Int) -> Unit): HTMLElement

@JsFun("(el, value) => el.__set(value)")
private external fun codeSet(el: HTMLElement, value: String)

@JsFun("(el, theme) => el.__theme(theme)")
private external fun codeTheme(el: HTMLElement, theme: String)

@JsFun("(el, marks) => el.__marks(marks)")
private external fun codeMarks(el: HTMLElement, marks: String)

@JsFun("(el, shown) => el.__shown(shown)")
private external fun codeShown(el: HTMLElement, shown: Boolean)

@JsFun("(el, line) => el.__goto(line)")
private external fun codeGoto(el: HTMLElement, line: Int)

@JsFun("(el, query, backward) => el.__find(query, backward)")
private external fun codeFind(el: HTMLElement, query: String, backward: Boolean): Int

@JsFun("(el, name) => el.__command(name)")
private external fun codeCommand(el: HTMLElement, name: String)

/** 编辑器操作入口：跳行、查找、撤销/重做。 */
internal class CodeEditorController {
    internal var element: HTMLElement? = null
    var line by mutableStateOf(1)
    var column by mutableStateOf(1)

    fun goto(line: Int) { element?.let { codeGoto(it, line) } }
    /** 返回匹配总数；0 表示没找到。 */
    fun find(query: String, backward: Boolean = false): Int = element?.let { codeFind(it, query, backward) } ?: 0
    fun undo() { element?.let { codeCommand(it, "undo") } }
    fun redo() { element?.let { codeCommand(it, "redo") } }
}

@Composable
internal fun CodeEditor(
    value: String,
    onChange: (String) -> Unit,
    controller: CodeEditorController,
    modifier: Modifier = Modifier,
    errorLines: Set<Int> = emptySet(),
) {
    val change by rememberUpdatedState(onChange)
    val scheme = MiuixTheme.colorScheme
    val entries = listOf(
        "text" to scheme.onSurface, "caret" to scheme.primary, "k" to scheme.primary, "s" to Tone.success,
        "n" to Tone.warning, "c" to Tone.muted, "m" to Tone.danger, "e" to Tone.danger,
        "gutter" to scheme.surfaceContainer, "gutterText" to scheme.onSurfaceVariantSummary,
        "line" to scheme.primary.copy(alpha = 0.08f), "sel" to scheme.primary.copy(alpha = 0.28f),
    )
    val theme = remember(entries) {
        fun Color.css() = "rgba(${(red * 255).toInt()},${(green * 255).toInt()},${(blue * 255).toInt()},$alpha)"
        entries.joinToString(",", "{", "}") { (key, color) -> "\"$key\":\"${color.css()}\"" }
    }
    val marks = errorLines.sorted().joinToString(",")
    val shown = nativeShown()
    HtmlElementView(
        factory = {
            createCodeEditor({ change(it) }, { line, column -> controller.line = line; controller.column = column })
                .also { controller.element = it }
        },
        modifier = modifier,
        update = {
            codeTheme(it, theme)
            codeSet(it, value)
            codeMarks(it, marks)
            codeShown(it, shown)
        },
        onRelease = { if (controller.element === it) controller.element = null },
    )
}
