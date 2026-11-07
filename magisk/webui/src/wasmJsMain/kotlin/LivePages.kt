package mihomo

import androidx.compose.foundation.background
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.layout.ContentScale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import top.yukonga.miuix.kmp.icon.extended.Timer
import kotlin.io.encoding.Base64
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import top.yukonga.miuix.kmp.basic.BasicComponent
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.CardDefaults
import top.yukonga.miuix.kmp.basic.CircularProgressIndicator
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Delete
import top.yukonga.miuix.kmp.icon.extended.Info
import top.yukonga.miuix.kmp.icon.extended.Ok
import top.yukonga.miuix.kmp.icon.extended.Report
import top.yukonga.miuix.kmp.icon.extended.Link
import top.yukonga.miuix.kmp.icon.extended.Notes
import top.yukonga.miuix.kmp.icon.extended.Pause
import top.yukonga.miuix.kmp.icon.extended.Play
import top.yukonga.miuix.kmp.icon.extended.Refresh
import top.yukonga.miuix.kmp.icon.extended.Settings
import top.yukonga.miuix.kmp.icon.extended.Tune
import top.yukonga.miuix.kmp.theme.MiuixTheme
import top.yukonga.miuix.kmp.utils.PressFeedbackType

/**
 * 代理：参照 zashboard——每个策略组一张卡片（图标、类型、当前节点、延迟），
 * 点按展开为节点网格，点节点切换，点延迟单独测速；配置里 hidden: true 的组不显示。
 */
@Composable
fun ProxiesPage(onBack: (() -> Unit)?) {
    val state = LiveProxies
    val columns = (LocalPageWidth.current.value / 235).toInt().coerceIn(2, 5)
    var expanded by remember { mutableStateOf<Set<String>>(emptySet()) }
    val active = LocalPageActive.current
    LaunchedEffect(active) { if (active && state.stale) liveRead("读取代理组中…") { state.load() } }
    Page(title = "代理", fullWidth = true, navigationIcon = { if (onBack != null) BackIcon(onBack) }, actions = {
        BarAction(MiuixIcons.Regular.Refresh, "刷新", enabled = liveIdle) { state.refresh() }
    }) {
        banner(if (!liveIdle) liveActivity else "", BannerKind.Progress, "activity")
        banner(state.error.ifEmpty { state.feedback.error }, BannerKind.Error, "error")
        if (state.groups != null) banner(when {
            state.loading -> "刷新中 · 显示上次快照"
            state.stale -> "快照已过期 · 请刷新后操作"
            else -> ""
        }, BannerKind.Info, "snapshot")
        val groups = state.groups?.filter { !it.hidden }
        if (groups != null && groups.isEmpty()) item(key = "empty") { EmptyState(MiuixIcons.Regular.Tune, "没有策略组，请先启动服务") }
        for (group in groups.orEmpty()) {
            val open = group.key in expanded
            item(key = "group:${group.key}") {
                ProxyGroupCard(group, open) { expanded = if (open) expanded - group.key else expanded + group.key }
            }
            if (open) {
                if (!group.selectable) item(key = "auto:${group.key}") {
                    Text("该组由内核自动选择，不能手动切换", fontSize = 12.sp, color = Tone.muted,
                        modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 8.dp))
                }
                val rows = group.options.chunked(columns)
                items(rows.size, key = { "nodes:${group.key}:$it" }) { index -> ProxyNodeRow(group, rows[index], columns) }
                item(key = "gap:${group.key}") { Spacer(Modifier.height(12.dp)) }
            }
        }
    }
}

@Composable
private fun delayColor(delay: Int?): Color = when {
    delay == null -> Tone.muted
    delay <= 0 -> Tone.danger
    delay < 300 -> Tone.success
    delay < 800 -> Tone.warning
    else -> Tone.danger
}

private fun delayText(delay: Int?): String = when {
    delay == null -> "测速"
    delay <= 0 -> "超时"
    else -> "$delay"
}

private fun groupLabel(type: String): String = when (type) {
    "Selector" -> "手动"
    "URLTest" -> "自动"
    "Fallback" -> "故障转移"
    "Smart" -> "智能"
    "LoadBalance" -> "负载均衡"
    else -> type
}

@Composable
private fun DelayChip(name: String, modifier: Modifier = Modifier) {
    val state = LiveProxies
    val delay = state.delays[name]
    val testing = name in state.testing
    // 固定高度与最小宽度：测速时文字换成转圈，尺寸不变，卡片不会跟着跳
    Box(modifier.height(20.dp).defaultMinSize(minWidth = 40.dp).clip(RoundedCornerShape(8.dp)).clickable(enabled = !testing) { state.testNode(name) }
        .padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
        if (testing) CircularProgressIndicator(size = 12.dp, strokeWidth = 1.5.dp)
        else Text(delayText(delay), fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, color = delayColor(delay), maxLines = 1)
    }
}

@Composable
private fun ProxyGroupCard(group: LiveProxyGroup, open: Boolean, onToggle: () -> Unit) {
    val state = LiveProxies
    val testing = group.key in state.testing
    Card(Modifier.padding(horizontal = 12.dp).padding(bottom = if (open) 8.dp else 12.dp).fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(start = 16.dp, end = 8.dp, top = 14.dp, bottom = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            GroupIcon(group.icon, group.name)
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(group.name, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = MiuixTheme.colorScheme.onSurface, modifier = Modifier.weight(1f, fill = false))
                    Tag(groupLabel(group.type), Tone.muted)
                    Text("${group.options.size}", fontSize = 12.sp, color = Tone.muted)
                }
                Text(group.selected.ifEmpty { "未选择" }, fontSize = 13.sp, color = Tone.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (group.selected.isNotEmpty()) DelayChip(group.selected)
            Box(Modifier.size(36.dp).clip(CircleShape).clickable(enabled = !testing) { state.test(group) }, contentAlignment = Alignment.Center) {
                if (testing) CircularProgressIndicator(size = 18.dp, strokeWidth = 2.dp)
                else Icon(MiuixIcons.Regular.Timer, "测试 ${group.name} 的延迟", tint = MiuixTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
private fun ProxyNodeRow(group: LiveProxyGroup, names: List<String>, columns: Int) {
    Row(Modifier.padding(horizontal = 12.dp).padding(bottom = 8.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (name in names) ProxyNodeChip(group, name, Modifier.weight(1f))
        repeat(columns - names.size) { Spacer(Modifier.weight(1f)) }
    }
}

@Composable
private fun ProxyNodeChip(group: LiveProxyGroup, name: String, modifier: Modifier) {
    val state = LiveProxies
    val selected = name == group.selected
    val node = state.nodes[name]
    val primary = MiuixTheme.colorScheme.primary
    Column(
        modifier.clip(RoundedCornerShape(14.dp))
            .background(if (selected) primary.copy(alpha = 0.14f) else MiuixTheme.colorScheme.surfaceContainer)
            .clickable(enabled = group.selectable && state.writable && !selected) { state.select(group, name) }
            .padding(start = 12.dp, end = 6.dp, top = 10.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GroupIcon(node?.icon.orEmpty(), name, 28.dp)
            Text(name, fontSize = 13.sp, lineHeight = 17.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(end = 6.dp),
                color = if (selected) primary else MiuixTheme.colorScheme.onSurface,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            val subtitle = when {
                node == null -> ""
                node.type in setOf("Selector", "URLTest", "Fallback", "Smart", "LoadBalance") -> "策略组"
                else -> node.type + if (node.udp) " · UDP" else ""
            }
            Text(subtitle, fontSize = 11.sp, color = Tone.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            DelayChip(name)
        }
    }
}

/** 策略组图标：配置里的 icon（http(s) 或 data: 链接），PNG/JPEG/WebP 由 Skia 解码，SVG 用 SVGDOM 栅格化。 */
private class GroupIconState {
    var bitmap by mutableStateOf<ImageBitmap?>(null)
    var loaded = false
}

private val groupIcons = linkedMapOf<String, GroupIconState>()
private val groupIconLoads = Semaphore(3)

private fun decodeIcon(uri: String): ImageBitmap? {
    if (!uri.startsWith("data:image/") || !uri.contains(";base64,")) return null
    val bytes = Base64.decode(uri.substringAfter(";base64,"))
    if (uri.startsWith("data:image/svg")) {
        val data = org.jetbrains.skia.Data.makeFromBytes(bytes)
        try {
            val dom = org.jetbrains.skia.svg.SVGDOM(data)
            try {
                val size = 96
                dom.setContainerSize(size.toFloat(), size.toFloat())
                val surface = org.jetbrains.skia.Surface.makeRasterN32Premul(size, size)
                try {
                    dom.render(surface.canvas)
                    return surface.makeImageSnapshot().toComposeImageBitmap()
                } finally { surface.close() }
            } finally { dom.close() }
        } finally { data.close() }
    }
    return org.jetbrains.skia.Image.makeFromEncoded(bytes).toComposeImageBitmap()
}

@Composable
private fun GroupIcon(url: String, name: String, size: androidx.compose.ui.unit.Dp = 36.dp) {
    val modifier = Modifier.size(size).clip(RoundedCornerShape(8.dp))
    if (url.isEmpty()) {
        Box(modifier.background(MiuixTheme.colorScheme.secondaryContainer), contentAlignment = Alignment.Center) {
            Text(name.take(1).ifEmpty { "?" }, color = MiuixTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
        }
        return
    }
    val state = remember(url) {
        groupIcons.remove(url)?.also { groupIcons[url] = it } ?: GroupIconState().also {
            groupIcons[url] = it
            if (groupIcons.size > 96) groupIcons.remove(groupIcons.keys.first())
        }
    }
    LaunchedEffect(url) {
        if (state.loaded) return@LaunchedEffect
        groupIconLoads.withPermit {
            if (state.loaded) return@withPermit
            try {
                state.bitmap = decodeIcon(request("proxyIcon", json("url" to url)).string("icon"))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
            }
            state.loaded = true
        }
    }
    val bitmap = state.bitmap
    if (bitmap != null) {
        Image(bitmap, name, modifier, contentScale = ContentScale.Fit)
    } else {
        Box(modifier.background(MiuixTheme.colorScheme.secondaryContainer), contentAlignment = Alignment.Center) {
            Text(name.take(1).ifEmpty { "?" }, color = MiuixTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
        }
    }
}

/** 连接：搜索 + 列表，点按查看详情并可断开；5 秒自动刷新。 */
@Composable
fun ConnectionsPage(onBack: () -> Unit) {
    val state = LiveConnections
    var query by remember { mutableStateOf("") }
    var detail by remember { mutableStateOf<LiveConnection?>(null) }
    var detailVisible by remember { mutableStateOf(false) }
    var confirmAll by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        liveRead("读取连接中…") { state.load() }
        while (true) {
            delay(5000)
            awaitWebuiVisible()
            if (liveIdle && detail == null) liveRead("") { state.load() }
        }
    }
    val connections = state.connections.orEmpty()
    val filtered = remember(connections, query) {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) connections else connections.filter {
            connectionTitle(it.value).lowercase().contains(needle) || connectionChain(it.value).lowercase().contains(needle) ||
                connectionProcess(it.value).lowercase().contains(needle)
        }
    }
    Page(
        title = "连接",
        fullWidth = true,
        subtitle = state.total?.let { "共 $it 个 · 上传 ${formatBytes(state.upload)} 下载 ${formatBytes(state.download)}" } ?: "",
        navigationIcon = { BackIcon(onBack) },
        actions = {
            BarAction(MiuixIcons.Regular.Refresh, "刷新连接", enabled = liveIdle) { state.refresh() }
            BarAction(MiuixIcons.Regular.Delete, "断开全部", enabled = state.writable && connections.isNotEmpty()) { confirmAll = true }
        },
    ) {
        item(key = "search") {
            Box(Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp)) {
                InputField("搜索域名、节点或应用", query) { query = it }
            }
        }
        banner(state.error.ifEmpty { state.feedback.error }, BannerKind.Error, "error")
        banner(state.feedback.message, BannerKind.Success, "message")
        if (state.connections != null) banner(when {
            state.loading -> "刷新中 · 显示上次快照"
            state.stale -> "快照已过期 · 请刷新后操作"
            else -> ""
        }, BannerKind.Info, "snapshot")
        if (state.connections != null && filtered.isEmpty()) item(key = "empty") { EmptyState(MiuixIcons.Regular.Link, "没有连接") }
        items(filtered, key = { "connection:${it.key}" }) { connection ->
            Card(Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth()) {
                val value = connection.value
                BasicComponent(
                    title = connectionTitle(value),
                    summary = listOf(connectionProcess(value), connectionChain(value)).filter { it.isNotEmpty() }.joinToString(" · "),
                    onClick = { detail = connection; detailVisible = true },
                    endActions = { Text("" + formatBytes(value.string("download").toDoubleOrNull()), fontSize = 12.sp, color = Tone.muted) },
                )
            }
        }
    }
    ConfirmDialog(show = confirmAll, title = "断开全部连接", summary = "正在进行的下载和通话会被中断。", confirm = "断开", danger = true,
        onDismiss = { confirmAll = false }) { confirmAll = false; state.close() }
    val shown = detail
    Sheet(show = detailVisible, title = "连接详情", onDismissRequest = { detailVisible = false }, onDismissFinished = { detail = null }) {
        if (shown != null) {
            val value = shown.value
            val metadata = value["metadata"] as? JsonObject
            Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
                Card(colors = CardDefaults.defaultColors(color = MiuixTheme.colorScheme.secondaryContainer)) {
                    for ((label, text) in listOf(
                        "目标" to connectionTitle(value),
                        "链路" to connectionChain(value),
                        "规则" to listOf(value.string("rule"), value.string("rulePayload")).filter { it.isNotEmpty() }.joinToString(" · "),
                        "应用" to connectionProcess(value),
                        "来源" to listOf(metadata?.string("sourceIP").orEmpty(), metadata?.string("sourcePort").orEmpty())
                            .filter { it.isNotEmpty() }.joinToString(":"),
                        "流量" to "上传 ${formatBytes(value.string("upload").toDoubleOrNull())}  下载 ${formatBytes(value.string("download").toDoubleOrNull())}",
                    )) if (text.isNotEmpty()) InfoRow(label, text)
                }
                Spacer(Modifier.height(12.dp))
                TextButton("断开此连接", onClick = { detailVisible = false; state.close(value.string("id")) }, enabled = state.writable && value.string("id").isNotBlank(),
                    modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.textButtonColors(textColor = MiuixTheme.colorScheme.error))
            }
        }
    }
}

private fun connectionTitle(value: JsonObject): String {
    val metadata = value["metadata"] as? JsonObject
    val host = metadata?.string("host").orEmpty().ifEmpty { metadata?.string("destinationIP").orEmpty() }
    val port = metadata?.string("destinationPort").orEmpty()
    val network = metadata?.string("network").orEmpty().uppercase()
    return listOf(if (port.isEmpty()) host else "$host:$port", network).filter { it.isNotEmpty() }.joinToString("  ").ifEmpty { "未知目标" }
}

private fun connectionProcess(value: JsonObject): String = (value["metadata"] as? JsonObject)?.string("process").orEmpty()

private fun connectionChain(value: JsonObject): String =
    (value["chains"] as? JsonArray)?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
        ?.asReversed()?.joinToString(" » ").orEmpty().ifEmpty { "DIRECT" }
