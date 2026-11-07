package mihomo

// 通用界面骨架，统一遵循 Miuix 规范：
// - 页面 = 大标题 TopAppBar（随滚动折叠）+ LazyColumn，overScroll 回弹；
// - 设置分组 = SmallTitle + Card，卡片内为 BasicComponent / Preference 行，行间不加分割线；
// - 主操作用 TextButton/Button 放在卡片外或底部，确认与编辑用 WindowDialog / WindowBottomSheet；
// - 状态反馈用卡片顶部的提示条，不再在每页堆叠多行说明文字。

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import top.yukonga.miuix.kmp.basic.BasicComponent
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.CircularProgressIndicator
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.IconButton
import top.yukonga.miuix.kmp.basic.ScrollBehavior
import top.yukonga.miuix.kmp.basic.SmallTitle
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.basic.TextField
import top.yukonga.miuix.kmp.basic.TopAppBar
import top.yukonga.miuix.kmp.basic.MiuixScrollBehavior
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.ChevronBackward
import top.yukonga.miuix.kmp.preference.ArrowPreference
import top.yukonga.miuix.kmp.preference.SwitchPreference
import top.yukonga.miuix.kmp.preference.WindowDropdownPreference
import top.yukonga.miuix.kmp.theme.MiuixTheme
import top.yukonga.miuix.kmp.utils.overScrollVertical
import top.yukonga.miuix.kmp.window.WindowDialog

/** 语义色：在浅色/深色主题下都保持足够对比度。 */
object Tone {
    val success: Color @Composable get() = if (MiuixTheme.colorScheme.background.luminanceApprox() < 0.5f) Color(0xFF4ADE80) else Color(0xFF16A34A)
    val warning: Color @Composable get() = if (MiuixTheme.colorScheme.background.luminanceApprox() < 0.5f) Color(0xFFFBBF24) else Color(0xFFD97706)
    val danger: Color @Composable get() = MiuixTheme.colorScheme.error
    val muted: Color @Composable get() = MiuixTheme.colorScheme.onSurfaceVariantSummary
}

private fun Color.luminanceApprox(): Float = 0.2126f * red + 0.7152f * green + 0.0722f * blue

val LocalWideLayout = staticCompositionLocalOf { false }
val LocalPageWidth = staticCompositionLocalOf { 720.dp }
/** 当前页是否正显示在前台（分页器里常驻的其它标签为 false），页面据此决定何时刷新数据。 */
val LocalPageActive = compositionLocalOf { true }

/** 标准页面：大标题 + 折叠 + 回弹列表。 */
@Composable
fun Page(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String = "",
    navigationIcon: @Composable () -> Unit = {},
    actions: @Composable RowScope.() -> Unit = {},
    listState: LazyListState = rememberLazyListState(),
    bottomPadding: Dp = 0.dp,
    header: (@Composable () -> Unit)? = null,
    /** 表格、网格类页面用满桌面宽度；设置类列表最宽 960dp，避免一行拉得太长难以阅读。 */
    fullWidth: Boolean = false,
    content: LazyListScope.() -> Unit,
) {
    val behavior = MiuixScrollBehavior()
    val width = if (fullWidth) LocalPageWidth.current else LocalPageWidth.current.coerceAtMost(960.dp)
    Column(modifier.fillMaxSize().background(MiuixTheme.colorScheme.surface), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.widthIn(max = width).fillMaxWidth()) {
        TopAppBar(
            title = title,
            subtitle = subtitle,
            navigationIcon = navigationIcon,
            actions = actions,
            scrollBehavior = behavior,
            defaultWindowInsetsPadding = false,
            color = MiuixTheme.colorScheme.surface,
        )
        }
        header?.invoke()
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                state = listState,
                modifier = Modifier.widthIn(max = width).fillMaxSize()
                    .overScrollVertical()
                    .nestedScroll(behavior.nestedScrollConnection),
                contentPadding = PaddingValues(bottom = 24.dp + bottomPadding),
                content = content,
            )
        }
    }
}

@Composable
fun BackIcon(onBack: () -> Unit) {
    IconButton(onClick = onBack, modifier = Modifier.padding(start = 12.dp)) {
        Icon(MiuixIcons.Regular.ChevronBackward, contentDescription = "返回", tint = MiuixTheme.colorScheme.onSurface)
    }
}

@Composable
fun BarAction(icon: ImageVector, description: String, enabled: Boolean = true, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.padding(end = 12.dp)) {
        Icon(icon, contentDescription = description,
            tint = MiuixTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else 0.4f))
    }
}

/** 分组：SmallTitle + Card。 */
fun LazyListScope.group(title: String?, key: String = title ?: "", content: @Composable ColumnScope.() -> Unit) {
    if (!title.isNullOrEmpty()) item(key = "title:$key") { SmallTitle(title) }
    item(key = "card:$key") {
        Card(Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth()) { content() }
    }
}

fun LazyListScope.spacer(height: Dp = 12.dp, key: String? = null) {
    item(key = key) { Spacer(Modifier.height(height)) }
}

/** 卡片内的说明/状态文字，左右与 BasicComponent 对齐。 */
@Composable
fun Caption(text: String, color: Color = Tone.muted, modifier: Modifier = Modifier) {
    if (text.isBlank()) return
    Text(text, modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        fontSize = 13.sp, lineHeight = 18.sp, color = color)
}

/** 页面级提示条：进行中 / 成功 / 失败 三态，统一替代各页零散的提示。 */
enum class BannerKind { Progress, Success, Error, Info }

@Composable
fun Banner(text: String, kind: BannerKind, modifier: Modifier = Modifier) {
    if (text.isBlank()) return
    val tint = when (kind) {
        BannerKind.Progress, BannerKind.Info -> MiuixTheme.colorScheme.primary
        BannerKind.Success -> Tone.success
        BannerKind.Error -> Tone.danger
    }
    Row(
        modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth()
            .clip(RoundedCornerShape(16.dp)).background(tint.copy(alpha = 0.10f))
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (kind == BannerKind.Progress) CircularProgressIndicator(size = 16.dp, strokeWidth = 2.dp)
        Text(text, fontSize = 13.sp, lineHeight = 18.sp,
            color = if (kind == BannerKind.Error) Tone.danger else MiuixTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f))
    }
}

fun LazyListScope.banner(text: String, kind: BannerKind, key: String = "banner") {
    if (text.isNotBlank()) item(key = key) { Banner(text, kind) }
}

/** 状态徽标：小号圆角标签。 */
@Composable
fun Tag(text: String, color: Color = MiuixTheme.colorScheme.primary) {
    Box(Modifier.clip(RoundedCornerShape(6.dp)).background(color.copy(alpha = 0.12f)).padding(horizontal = 6.dp, vertical = 2.dp)) {
        Text(text, fontSize = 11.sp, color = color, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

/** 只读信息行：标题 + 右侧值。 */
@Composable
fun InfoRow(title: String, value: String, summary: String? = null, valueColor: Color = Tone.muted, onClick: (() -> Unit)? = null) {
    BasicComponent(
        title = title,
        summary = summary,
        onClick = onClick,
        endActions = {
            Text(value, fontSize = 14.sp, color = valueColor, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 200.dp))
        },
    )
}

@Composable
fun SwitchRow(title: String, checked: Boolean, summary: String? = null, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    SwitchPreference(checked = checked, onCheckedChange = onChange, title = title, summary = summary, enabled = enabled)
}

@Composable
fun ArrowRow(title: String, summary: String? = null, value: String? = null, enabled: Boolean = true,
             startIcon: ImageVector? = null, startContent: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    ArrowPreference(
        title = title,
        summary = summary,
        enabled = enabled,
        onClick = onClick,
        startAction = startContent ?: startIcon?.let { icon -> { RowIcon(icon) } },
        endActions = {
            if (!value.isNullOrEmpty()) Text(value, fontSize = 14.sp, color = Tone.muted, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp))
        },
    )
}

@Composable
fun RowIcon(icon: ImageVector, tint: Color = MiuixTheme.colorScheme.onSurface) {
    Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.padding(end = 16.dp).size(24.dp))
}

@Composable
fun DropdownRow(title: String, options: List<String>, selected: Int, summary: String? = null, enabled: Boolean = true, onSelect: (Int) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    OverlayLayer(expanded)
    WindowDropdownPreference(
        onExpandedChange = { expanded = it },
        items = options,
        selectedIndex = selected.coerceIn(0, (options.size - 1).coerceAtLeast(0)),
        title = title,
        summary = summary,
        enabled = enabled,
        onSelectedIndexChange = onSelect,
    )
}

/** 卡片底部的一组文字按钮。 */
@Composable
fun ButtonRow(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Row(modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), content = content)
}

@Composable
fun RowScope.ActionButton(text: String, primary: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    TextButton(
        text = text,
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.weight(1f),
        colors = if (primary) ButtonDefaults.textButtonColorsPrimary() else ButtonDefaults.textButtonColors(),
    )
}

/** 输入框底色：放在与默认底色相同的浅灰卡片里时（如弹窗内的 SheetCard）改用页面底色，否则未选中的输入框与卡片融在一起。 */
val LocalFieldBackground = staticCompositionLocalOf<Color?> { null }

@Composable
fun fieldBackground(): Color = LocalFieldBackground.current ?: MiuixTheme.colorScheme.secondaryContainer

/** 输入框（miuix TextField），卡片内左右留白。 */
@Composable
fun InputField(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 6 else 8,
    onChange: (String) -> Unit,
) {
    // 原生输入元素：长按出系统文本菜单，输入法与自动填充走浏览器原生
    NativeField(label, value, modifier, enabled = enabled, singleLine = singleLine, minLines = minLines, maxLines = maxLines, onChange = onChange)
}

/** 确认对话框（WindowDialog），按钮固定为「取消 / 确认」。 */
@Composable
fun ConfirmDialog(
    show: Boolean,
    title: String,
    summary: String,
    confirm: String = "确定",
    danger: Boolean = false,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    Dialog(show = show, title = title, summary = summary, onDismissRequest = onDismiss) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(text = "取消", onClick = onDismiss, modifier = Modifier.weight(1f))
            TextButton(
                text = confirm,
                onClick = onConfirm,
                modifier = Modifier.weight(1f),
                colors = if (danger) ButtonDefaults.textButtonColors(textColor = MiuixTheme.colorScheme.error)
                else ButtonDefaults.textButtonColorsPrimary(),
            )
        }
    }
}

/** 文本编辑对话框：用于列表、地址等需要多行输入的字段。 */
@Composable
fun EditDialog(
    show: Boolean,
    title: String,
    initial: String,
    summary: String? = null,
    multiline: Boolean = false,
    onDismiss: () -> Unit,
    onSave: (String) -> String?,
) {
    var text by remember(show, initial) { mutableStateOf(initial) }
    var error by remember(show) { mutableStateOf("") }
    Dialog(show = show, title = title, summary = summary, onDismissRequest = onDismiss) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            NativeField("", text, singleLine = !multiline, minLines = if (multiline) 4 else 1, maxLines = if (multiline) 10 else 6) { text = it; error = "" }
            if (error.isNotEmpty()) Text(error, fontSize = 13.sp, color = Tone.danger)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton(text = "取消", onClick = onDismiss, modifier = Modifier.weight(1f))
                TextButton(text = "确定", onClick = { error = onSave(text).orEmpty() }, modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.textButtonColorsPrimary())
            }
        }
    }
}

/** 空态：图标 + 一句话。 */
@Composable
fun EmptyState(icon: ImageVector, text: String, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(icon, null, tint = Tone.muted.copy(alpha = 0.6f), modifier = Modifier.size(40.dp))
        Text(text, fontSize = 14.sp, color = Tone.muted)
    }
}

/** 代码/日志块：等宽、可选中。 */
@Composable
fun CodeBlock(text: String, modifier: Modifier = Modifier) {
    androidx.compose.foundation.text.selection.SelectionContainer {
        Text(text.ifEmpty { "（空）" }, modifier = modifier.fillMaxWidth().padding(16.dp), fontSize = 12.sp, lineHeight = 17.sp,
            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, color = MiuixTheme.colorScheme.onSurface)
    }
}

fun formatBytes(bytes: Double?): String {
    if (bytes == null || !bytes.isFinite() || bytes < 0) return "—"
    val units = listOf("B", "KB", "MB", "GB", "TB")
    var amount = bytes
    var index = 0
    while (amount >= 1024 && index < units.lastIndex) { amount /= 1024; index++ }
    val text = if (index == 0 || amount >= 100) amount.toLong().toString() else ((amount * 10).toLong() / 10.0).toString()
    return "$text ${units[index]}"
}

/** 内核版本精简显示："Mihomo Meta alpha-smart-xxx android arm64 with go…" → "alpha-smart-xxx"。 */
fun shortVersion(raw: String): String {
    val text = raw.trim().removePrefix("Mihomo").trim().removePrefix("Meta").trim()
    return text.substringBefore(' ').ifBlank { raw.trim() }
}

/** 底部弹窗：WindowBottomSheet + 系统返回键关闭。 */
@Composable
fun Sheet(
    show: Boolean,
    title: String? = null,
    onDismissRequest: () -> Unit,
    onDismissFinished: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    BackHandler(enabled = show, onBack = onDismissRequest)
    val layer = OverlayLayer(show)
    top.yukonga.miuix.kmp.window.WindowBottomSheet(show = show, title = title, onDismissRequest = onDismissRequest,
        onDismissFinished = onDismissFinished) { CompositionLocalProvider(LocalFieldLayer provides layer, content = content) }
}

/** 对话框：WindowDialog + 系统返回键关闭。 */
@Composable
fun Dialog(
    show: Boolean,
    title: String? = null,
    summary: String? = null,
    onDismissRequest: () -> Unit,
    content: @Composable () -> Unit,
) {
    BackHandler(enabled = show, onBack = onDismissRequest)
    val layer = OverlayLayer(show)
    WindowDialog(show = show, title = title, summary = summary, onDismissRequest = onDismissRequest) {
        CompositionLocalProvider(LocalFieldLayer provides layer, content = content)
    }
}
