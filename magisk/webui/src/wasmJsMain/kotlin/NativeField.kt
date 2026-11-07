@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package mihomo

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.HtmlElementView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.w3c.dom.HTMLElement
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.theme.MiuixTheme

// 原生输入框：用真实的 <input>/<textarea> 嵌在界面里。界面画在 canvas 上，Compose 自绘的输入框长按不会出现
// 系统原生的文本菜单（粘贴、全选、翻译等）；换成真实输入元素后，长按、选择、输入法、自动填充都由浏览器原生处理。
// 背景、边框、标签仍由界面绘制，输入元素本身透明，外观与 Miuix 输入框一致。

// 密码用 <input>；其余一律用 <textarea>，单行框内容过长（如订阅链接）时自动折行显示，但不允许输入换行
@JsFun("""(password) => {
    const el = document.createElement(password ? 'input' : 'textarea');
    if (password) el.type = 'password';
    el.rows = 1;
    el.autocomplete = password ? 'current-password' : 'off';
    el.spellcheck = false;
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('autocorrect', 'off');
    el.style.cssText = 'box-sizing:border-box;display:block;width:100%;height:100%;margin:0;padding:0;border:0;outline:none;' +
        'background:transparent;resize:none;overflow:auto;-webkit-tap-highlight-color:transparent;' +
        'font:16px/22px -apple-system,BlinkMacSystemFont,"MiSans","PingFang SC","Noto Sans CJK SC",Roboto,sans-serif;';
    return el;
}""")
private external fun createField(password: Boolean): HTMLElement

@JsFun("""(el, singleLine, onInput, onFocus, onLines) => {
    // 按内容实际折行后的高度换算行数（行高 22px），界面据此调整输入框高度
    const measure = () => {
        if (el.tagName !== 'TEXTAREA' || !el.isConnected) return;
        const keep = el.style.height;
        el.style.height = '0px';
        const lines = Math.max(1, Math.round(el.scrollHeight / 22));
        el.style.height = keep;
        onLines(lines);
    };
    el.addEventListener('input', () => {
        // 单行框：粘贴进来的换行去掉
        if (singleLine && /[\r\n]/.test(el.value)) {
            const at = el.selectionStart;
            const before = el.value.length;
            el.value = el.value.replace(/[\r\n]+/g, '');
            const pos = Math.max(0, at - (before - el.value.length));
            el.setSelectionRange(pos, pos);
        }
        onInput(el.value);
        measure();
    });
    // 单行框（链接、地址等）按字符折行，填满每一行
    if (singleLine) el.style.wordBreak = 'break-all';
    el.addEventListener('focus', () => onFocus(true));
    el.addEventListener('blur', () => onFocus(false));
    el.addEventListener('keydown', (event) => {
        // 界面的返回键、快捷键监听在 window 上；输入时不让按键冒泡给界面
        event.stopPropagation();
        if (singleLine && event.key === 'Enter') { event.preventDefault(); el.blur(); }
    });
    // 宽度变化（旋转屏幕、窗口缩放）后重新折行
    let width = 0;
    new ResizeObserver(() => { if (el.clientWidth !== width) { width = el.clientWidth; measure(); } }).observe(el);
    el.__measure = measure;
}""")
private external fun bindField(el: HTMLElement, singleLine: Boolean, onInput: (String) -> Unit, onFocus: (Boolean) -> Unit, onLines: (Int) -> Unit)

@JsFun("""(el, value, color, caret, disabled, shown, scroll) => {
    el.style.overflowY = scroll ? 'auto' : 'hidden';
    if (el.value !== value) { el.value = value; if (el.__measure) queueMicrotask(el.__measure); }
    el.style.color = color;
    el.style.caretColor = caret;
    el.disabled = disabled;
    el.style.visibility = shown ? '' : 'hidden';
    if (!shown && document.activeElement === el) el.blur();
}""")
private external fun updateField(el: HTMLElement, value: String, color: String, caret: String, disabled: Boolean, shown: Boolean, scroll: Boolean)

// ---------------- 浮层层级 ----------------
// 原生输入元素盖在 canvas 之上，界面画的对话框、底部弹窗、下拉列表盖不住它们。
// 每个打开的浮层占一层；输入框只在自己所在的层是最上层时显示，其余时候隐藏（并失去焦点）。

private object Overlays {
    /** 当前打开的浮层，按打开顺序；最后一个在最上层 */
    val open = mutableStateListOf<Int>()
    var next = 0
    val top: Int get() = open.lastOrNull() ?: 0
}

/** 当前内容所在的浮层层级：页面为 0，对话框/底部弹窗内为它打开时分到的层级。 */
val LocalFieldLayer = compositionLocalOf { 0 }

/**
 * 浮层显示期间占一层，返回该浮层内容的层级（按打开顺序分配，与代码里是否嵌套无关）。
 * 关闭时稍后才释放，等退场动画结束，避免下层输入框先冒出来。
 */
@Composable
fun OverlayLayer(show: Boolean): Int {
    var layer by remember { mutableStateOf(Int.MAX_VALUE) }
    DisposableEffect(show) {
        if (show) {
            val id = ++Overlays.next
            layer = id
            Overlays.open += id
        }
        val id = layer
        onDispose {
            if (show) liveScope.launch { delay(320); Overlays.open.remove(id) }
        }
    }
    return layer
}

private fun Color.css(): String =
    "rgba(${(red * 255).toInt()},${(green * 255).toInt()},${(blue * 255).toInt()},$alpha)"

/**
 * 原生输入框。高度随内容实际折行的行数增长：单行框不允许换行，但过长内容会折行显示（最多 [maxLines] 行，默认 6）；
 * 多行框在 minLines..maxLines 之间增高，超出后在框内滚动。
 */
@Composable
fun NativeField(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 6 else 8,
    password: Boolean = false,
    onChange: (String) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    var measured by remember { mutableStateOf(1) }
    val change by rememberUpdatedState(onChange)
    val colors = MiuixTheme.colorScheme
    val raised = label.isNotEmpty() && (focused || value.isNotEmpty())
    val lines = if (password) 1 else maxOf(measured, if (singleLine) 1 else value.count { it == '\n' } + 1)
        .coerceIn(minLines, maxLines.coerceAtLeast(minLines))
    // 超出最大行数后才在框内滚动，否则不显示滚动条
    val overflow = !password && maxOf(measured, value.lines().size) > lines
    val textColor = (if (enabled) colors.onSurface else colors.disabledOnSecondaryVariant).css()
    val caretColor = colors.primary.css()
    val shape = RoundedCornerShape(16.dp)
    // 只在最上层、且所在页面正显示在前台时显示（分页器里常驻的其它标签页、被子页面盖住的标签页都隐藏）
    val shown = nativeShown()
    Box(
        modifier.fillMaxWidth().clip(shape).background(fieldBackground())
            .then(if (focused) Modifier.border(2.dp, colors.primary, shape) else Modifier),
    ) {
        if (label.isNotEmpty()) {
            if (raised) {
                Text(label, fontSize = 11.sp, lineHeight = 14.sp, color = if (focused) colors.primary else colors.onSurfaceVariantSummary,
                    maxLines = 1, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp))
            } else {
                // 空且未聚焦：标签作占位文字，与输入行对齐
                Text(label, fontSize = 16.sp, lineHeight = 22.sp, color = colors.onSurfaceVariantSummary, maxLines = 1,
                    modifier = Modifier.align(if (singleLine) Alignment.CenterStart else Alignment.TopStart)
                        .padding(start = 16.dp, end = 16.dp, top = if (singleLine) 0.dp else 26.dp))
            }
        }
        HtmlElementView(
            factory = {
                createField(password).also { element ->
                    bindField(element, singleLine, { change(it) }, { focused = it }, { measured = it })
                }
            },
            modifier = Modifier.fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = if (label.isEmpty()) 16.dp else 26.dp, bottom = if (label.isEmpty()) 16.dp else 10.dp)
                .height((22 * lines).dp),
            update = { updateField(it, value, textColor, caretColor, !enabled, shown, overflow) },
        )
    }
}

/** 原生元素当前是否应显示：只在最上层、且所在页面正显示在前台时显示。 */
@Composable
internal fun nativeShown(): Boolean = LocalFieldLayer.current == Overlays.top && LocalPageActive.current
