@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package mihomo

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.collectLatest
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.CardDefaults
import top.yukonga.miuix.kmp.basic.CircularProgressIndicator
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.SmallTitle
import top.yukonga.miuix.kmp.basic.Switch
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Info
import top.yukonga.miuix.kmp.icon.extended.Layers
import top.yukonga.miuix.kmp.icon.extended.Link
import top.yukonga.miuix.kmp.icon.extended.Notes
import top.yukonga.miuix.kmp.icon.extended.Ok
import top.yukonga.miuix.kmp.icon.extended.Pause
import top.yukonga.miuix.kmp.icon.extended.Play
import top.yukonga.miuix.kmp.icon.extended.Refresh
import top.yukonga.miuix.kmp.icon.extended.Report
import top.yukonga.miuix.kmp.icon.extended.Settings
import top.yukonga.miuix.kmp.theme.MiuixTheme
import top.yukonga.miuix.kmp.utils.PressFeedbackType
import kotlin.coroutines.resume

// 首页：参照 LuCI 概览——状态卡、实时网速曲线、流量/连接/内存/出口、连通性、eBPF、订阅。

// ---------------- 浏览器侧小工具 ----------------

@JsFun("() => Date.now()")
private external fun nowMs(): Double

@JsFun("(s) => { const t = Date.parse(s); return isNaN(t) ? 0 : t; }")
private external fun parseTime(s: String): Double

@JsFun("(sec) => { const d = new Date(sec * 1000); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }")
private external fun formatDate(seconds: Double): String

@JsFun("(k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }")
private external fun storageGet(key: String): String

@JsFun("(k, v) => { try { localStorage.setItem(k, v); } catch (e) {} }")
private external fun storageSet(key: String, value: String)

private suspend fun ctl(path: String, method: String = "GET"): JsonObject? =
    request("controller", json("path" to path, "method" to method))["data"] as? JsonObject

private fun JsonObject.num(key: String): Double? = (this[key] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
private fun JsonObject.arr(key: String): List<JsonObject> = (this[key] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()

private fun encodeName(value: String): String = buildString {
    for (octet in value.encodeToByteArray()) {
        val code = octet.toInt() and 255
        if (code in 65..90 || code in 97..122 || code in 48..57 || code in listOf(45, 46, 95, 126)) append(code.toChar())
        else append('%').append("0123456789ABCDEF"[code shr 4]).append("0123456789ABCDEF"[code and 15])
    }
}

fun formatRate(bytes: Double?): String = if (bytes == null) "—" else formatBytes(bytes) + "/s"

private fun formatUptime(seconds: Double): String {
    val minutes = (seconds / 60).toLong()
    return when {
        minutes < 1 -> "不到 1 分钟"
        minutes < 60 -> "$minutes 分钟"
        minutes < 1440 -> "${minutes / 60} 小时 ${minutes % 60} 分"
        else -> "${minutes / 1440} 天 ${minutes % 1440 / 60} 小时"
    }
}

private fun formatAgo(ms: Double): String {
    if (ms <= 0) return "未知"
    val minutes = ((nowMs() - ms) / 60000).toLong()
    return when {
        minutes < 1 -> "刚刚"
        minutes < 60 -> "$minutes 分钟前"
        minutes < 1440 -> "${minutes / 60} 小时前"
        else -> "${minutes / 1440} 天前"
    }
}

// ---------------- 数据 ----------------

internal data class SubInfo(
    val name: String, val total: Int, val used: Double, val quota: Double,
    val expire: Double, val updatedAt: Double,
) {
    val ratio: Double? get() = if (quota > 0) (used / quota).coerceIn(0.0, 1.0) else null
}

internal data class Site(val name: String, val url: String)

private val SITES = listOf(
    Site("百度", "https://www.baidu.com/favicon.ico"),
    Site("Google", "https://www.gstatic.com/generate_204"),
    Site("GitHub", "https://github.githubassets.com/favicon.ico"),
    Site("YouTube", "https://www.youtube.com/favicon.ico"),
)
private const val SPARK = 40
private const val IP_KEY = "mihomo.home.exitip"

internal object LiveHome {
    var down by mutableStateOf<Double?>(null)
    var up by mutableStateOf<Double?>(null)
    var downHist by mutableStateOf<List<Double>>(emptyList())
    var upHist by mutableStateOf<List<Double>>(emptyList())
    var connHist by mutableStateOf<List<Double>>(emptyList())
    var downTotal by mutableStateOf<Double?>(null)
    var upTotal by mutableStateOf<Double?>(null)
    var conns by mutableStateOf<Int?>(null)
    var trafficError by mutableStateOf("")
    private var summaryUnsupported = false
    private var last: Triple<Double, Double, Double>? = null
    val hasSample: Boolean get() = last != null

    var exitNode by mutableStateOf("")
    var exitChain by mutableStateOf("")
    private var overviewUnsupported = false
    private var ebpfSummaryUnsupported = false

    var ebpf by mutableStateOf<JsonObject?>(null)
    var ebpfError by mutableStateOf("")
    var ebpfDetails by mutableStateOf<JsonObject?>(null)
    var ebpfInspecting by mutableStateOf(false)
    var ebpfDetailsError by mutableStateOf("")
    var subs by mutableStateOf<List<SubInfo>?>(null)
    var subsError by mutableStateOf("")
    var updating by mutableStateOf(false)
    var updateResult by mutableStateOf("")

    var sites by mutableStateOf<Map<String, Int?>>(emptyMap())
    var ipEnabled by mutableStateOf(storageGet(IP_KEY) != "0")
    var ipCn by mutableStateOf("")
    var ipIntl by mutableStateOf("")
    var checkedOnce = false

    fun reset() {
        last = null
        down = null; up = null
        downHist = emptyList(); upHist = emptyList(); connHist = emptyList()
        summaryUnsupported = false
        overviewUnsupported = false
        ebpfSummaryUnsupported = false
        trafficError = ""
        ebpfDetails = null
        ebpfDetailsError = ""
    }

    /**
     * WebUI 打开期间一直运行（不随首页离开而停）：服务运行时每 2 秒读网速，每 30 秒读出口、eBPF、订阅并静默刷新状态。
     * 服务重新启动（running 由否变是）时才清空曲线，切换页面不清。
     */
    suspend fun run() {
        snapshotFlow { LiveOverview.running == true }.distinctUntilChanged().collectLatest { on ->
            if (!on) return@collectLatest
            reset()
            if (!checkedOnce) { checkedOnce = true; checkSites(); checkIp() }
            coroutineScope {
                var lastSlow = nowMs()
                launch { pollSlow() }
                while (true) {
                    awaitWebuiVisible()
                    if (!liveIdle) { delay(300); continue }
                    val now = nowMs()
                    if (webuiVisible() && now - lastSlow >= 30_000) {
                        lastSlow = now
                        launch { LiveOverview.refreshQuiet(); pollSlow() }
                    }
                    val first = !hasSample && trafficError.isEmpty()
                    pollFast()
                    // 网速由两次采样差值得出：首次采样后 1 秒就补第二次，之后每 2 秒
                    delay(if (first) 1000 else 2000)
                }
            }
        }
    }

    /** 每 2 秒：由累计流量差值算出实时网速。 */
    suspend fun pollFast() {
        if (summaryUnsupported) return
        val data = try {
            ctl("/connections/summary")?.also { trafficError = "" } ?: return
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            summaryUnsupported = failure.message.orEmpty().let { "404" in it || "405" in it }
            trafficError = if (summaryUnsupported) "请更新内核以启用低开销流量概览" else "无法读取流量概览"
            return
        }
        val dl = data.num("downloadTotal") ?: return
        val ul = data.num("uploadTotal") ?: return
        val now = nowMs()
        val n = data.num("connectionCount")?.toInt() ?: return
        LiveOverview.memoryInUse = data.num("memory")
        downTotal = dl; upTotal = ul; conns = n
        connHist = (connHist + n.toDouble()).takeLast(SPARK)
        val prev = last
        last = Triple(now, dl, ul)
        if (prev != null && now > prev.first) {
            val seconds = (now - prev.first) / 1000
            val d = ((dl - prev.second) / seconds).coerceAtLeast(0.0)
            val u = ((ul - prev.third) / seconds).coerceAtLeast(0.0)
            down = d; up = u
            downHist = (downHist + d).takeLast(SPARK)
            upHist = (upHist + u).takeLast(SPARK)
        }
    }

    /** 每 15 秒：出口、eBPF、订阅。 */
    suspend fun pollSlow() {
        if (!overviewUnsupported) try {
            val overview = ctl("/overview")
            val exit = overview?.obj("exit")
            val chain = (exit?.get("chain") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
            val smart = (exit?.get("smart") as? JsonPrimitive)?.booleanOrNull == true
            exitNode = chain.lastOrNull()?.let { if (smart) "$it（智能）" else it }.orEmpty()
            exitChain = chain.joinToString(" → ")
            val providers = overview?.obj("providers")
            subs = providers?.entries?.mapNotNull { (key, value) ->
                val p = value as? JsonObject ?: return@mapNotNull null
                if (p.string("vehicleType") != "HTTP") return@mapNotNull null
                val info = p.obj("subscriptionInfo")
                SubInfo(
                    name = p.string("name").ifEmpty { key },
                    total = p.num("count")?.toInt() ?: 0,
                    used = (info?.num("Upload") ?: 0.0) + (info?.num("Download") ?: 0.0),
                    quota = info?.num("Total") ?: 0.0,
                    expire = info?.num("Expire") ?: 0.0,
                    updatedAt = parseTime(p.string("updatedAt")),
                )
            }?.sortedBy { it.name }.orEmpty()
            subsError = ""
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            overviewUnsupported = failure.message.orEmpty().let { "404" in it || "405" in it }
            subsError = if (overviewUnsupported) "请更新内核以启用低开销概览" else failure.message ?: "无法读取概览"
        }
        if (!webuiVisible() || ebpfSummaryUnsupported) return
        try {
            ebpf = ctl("/ebpf/summary"); ebpfError = ""
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            ebpf = null
            ebpfSummaryUnsupported = failure.message.orEmpty().let { "404" in it || "405" in it }
            ebpfError = if (ebpfSummaryUnsupported) "请更新内核以读取轻量 eBPF 状态" else "无法读取 eBPF 状态"
        }
    }

    fun inspectEbpf() {
        if (ebpfInspecting) return
        ebpfInspecting = true
        liveScope.launch {
            try {
                ebpfDetails = ctl("/ebpf")
                ebpfDetailsError = ""
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                ebpfDetailsError = failure.message ?: "诊断失败"
            } finally {
                ebpfInspecting = false
            }
        }
    }

    var netVia by mutableStateOf("")

    /** 连通性在模块所在设备上测（经内核代理），而不是在打开网页的浏览器里测。 */
    fun checkSites() {
        sites = SITES.associate { it.name to null }
        liveScope.launch {
            sites = try {
                val result = request("netCheck")
                netVia = result.string("via")
                val measured = result.objects("sites").associate { it.string("name") to (it.num("ms")?.toInt() ?: 0) }
                SITES.associate { it.name to (measured[it.name] ?: 0) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                SITES.associate { it.name to 0 }
            }
        }
    }

    fun checkIp() {
        ipCn = ""; ipIntl = ""
        if (!ipEnabled) return
        ipCn = "查询中…"; ipIntl = "查询中…"
        liveScope.launch {
            val result = try { request("exitIp") } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }
            fun parse(text: String?): JsonObject? = text?.takeIf { it.isNotBlank() }?.let { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() }
            val d = parse(result?.string("cn"))?.obj("data")
            ipCn = if (d == null) "查询失败" else {
                val loc = (d["location"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank) }.orEmpty()
                d.string("ip", "-") + if (loc.isEmpty()) "" else " · " + loc.distinct().joinToString(" ")
            }
            val w = parse(result?.string("intl"))
            ipIntl = if (w == null || w.string("ip").isEmpty()) "查询失败" else {
                val isp = w.obj("connection")?.let { it.string("isp").ifEmpty { it.string("org") } }.orEmpty()
                w.string("ip") + " · " + listOf(w.string("country"), w.string("city"), isp).filter { it.isNotBlank() }.joinToString(" ")
            }
        }
    }

    fun toggleIp(on: Boolean) {
        ipEnabled = on
        storageSet(IP_KEY, if (on) "1" else "0")
        checkIp()
    }

    fun updateAll() {
        val names = subs.orEmpty().map { it.name }
        if (updating || names.isEmpty()) return
        updating = true
        updateResult = ""
        liveScope.launch {
            val failed = mutableListOf<String>()
            for (name in names) {
                try { ctl("/providers/proxies/${encodeName(name)}", "PUT") }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { failed += name }
            }
            updateResult = if (failed.isEmpty()) "订阅已全部更新" else "更新失败：" + failed.joinToString("、")
            updating = false
            pollSlow()
        }
    }
}

// ---------------- 页面 ----------------

@Composable
fun HomePage(onNavigate: (String) -> Unit) {
    val state = LiveOverview
    val home = LiveHome
    val active = LocalPageActive.current
    // 状态已读过就不再整页重读（那会让按钮短暂不可用、要等几秒）；后台轮询会每 30 秒静默刷新一次
    LaunchedEffect(active) { if (active && state.status == null && liveIdle) liveRead("读取状态中…") { state.load() } }
    Page(title = "mihomo", actions = {
        BarAction(MiuixIcons.Regular.Refresh, "刷新", enabled = liveIdle) {
            state.refresh()
            if (state.running == true) liveScope.launch { home.pollSlow() }
        }
    }) {
        item(key = "hero") { HomeStatusCard(onNavigate) }
        banner(state.feedback.error, BannerKind.Error, "error")
        banner(state.feedback.message, BannerKind.Success, "message")
        val issues = listOf("服务状态" to state.statusError, "内核" to state.coreError, "控制器" to state.controllerError)
            .filter { it.second.isNotEmpty() }.joinToString("\n") { "${it.first}：${it.second}" }
        banner(issues, BannerKind.Error, "issues")
        banner(home.trafficError, BannerKind.Error, "traffic-error")
        if (state.running == true) {
            item(key = "speed") { SpeedCard() }
            item(key = "kpis") { KpiGrid(onNavigate) }
            if (state.policy?.boolean("tethering") == true) item(key = "devices") { DevicesCard(onNavigate) }
            item(key = "net") { ConnectivityCard() }
            item(key = "ebpf") { EbpfCard() }
            item(key = "subs") { SubsCard() }
        }
        item(key = "tools-title") { SmallTitle("常用") }
        item(key = "tools") { Shortcuts(onNavigate) }
        group("本机") {
            val core = state.core
            ArrowRow("内核版本", value = when {
                core == null -> "—"
                core.boolean("installed") != true -> "未安装"
                else -> shortVersion(core.string("version")).ifBlank { "未知" }
            }) { onNavigate("core") }
            ArrowRow("开机自启", value = when (state.policy?.let { it.boolean("autostart") }) {
                true -> "已开启"; false -> "已关闭"; null -> "—"
            }) { onNavigate("settings") }
            ArrowRow("共享给其它设备", value = when (state.policy?.let { it.boolean("tethering") }) {
                true -> "已开启"; false -> "已关闭"; null -> "—"
            }) { onNavigate("settings") }
            val ssid = state.status?.string("current_ssid").orEmpty()
            if (ssid.isNotEmpty()) InfoRow("当前 Wi-Fi", ssid)
        }
    }
}

// ---------------- 状态卡 ----------------

/** 状态卡：整卡按状态着色，右下角放溢出卡片边缘的大号状态徽标；运行中时下方追加操作按钮。 */
@Composable
private fun HomeStatusCard(onNavigate: (String) -> Unit) {
    val state = LiveOverview
    val running = state.running
    val coreMissing = state.core?.boolean("installed") == false
    val dark = MiuixTheme.colorScheme.background.red < 0.5f
    val (container, accent) = when {
        running == true -> if (dark) Color(0xFF1B3A26) to Color(0xFF4ADE80) else Color(0xFFDFFAE4) to Color(0xFF36D167)
        running == null && state.statusError.isNotEmpty() -> if (dark) Color(0xFF3D1E1E) to Color(0xFFF87171) else Color(0xFFFFE4E4) to Color(0xFFF26B6B)
        state.paused || coreMissing -> if (dark) Color(0xFF3B2F17) to Color(0xFFFBBF24) else Color(0xFFFFF1D6) to Color(0xFFF5A524)
        else -> MiuixTheme.colorScheme.surfaceContainer to Tone.muted
    }
    val title = when {
        running == null && state.statusError.isEmpty() -> "读取中"
        running == null -> "状态未知"
        running -> "代理运行中"
        state.paused -> "已暂停"
        coreMissing -> "未安装内核"
        else -> "未运行"
    }
    val line1 = when {
        running == true -> {
            val uptime = state.status?.string("uptime")?.toDoubleOrNull()?.let(::formatUptime).orEmpty()
            if (uptime.isNotEmpty()) "已运行 $uptime"
            else "内核 " + shortVersion(state.core?.string("version")?.ifBlank { null } ?: state.controllerVersion.ifBlank { "—" })
        }
        coreMissing -> "点击下载 mihomo 内核"
        state.paused -> "当前 Wi-Fi 不在允许范围内"
        running == null -> if (state.statusError.isEmpty()) "正在检查服务状态" else "无法读取服务状态"
        else -> "点击卡片启动透明代理"
    }
    val line2 = when {
        !liveIdle -> liveActivity
        running == true -> LiveHome.exitNode.takeIf { it.isNotEmpty() }?.let { "出口 $it" }
            ?: ("eBPF 透明代理" + if (state.policy?.boolean("tethering") == true) " · 共享已开启" else "")
        state.paused -> "切换到允许的网络后自动恢复"
        else -> ""
    }
    val icon = when {
        running == true -> MiuixIcons.Regular.Ok
        state.paused -> MiuixIcons.Regular.Pause
        coreMissing -> MiuixIcons.Regular.Info
        running == null && state.statusError.isNotEmpty() -> MiuixIcons.Regular.Report
        else -> MiuixIcons.Regular.Play
    }
    val clickable = liveIdle && (coreMissing || (running == false && !state.paused))
    Card(
        modifier = Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth(),
        insideMargin = PaddingValues(0.dp),
        colors = CardDefaults.defaultColors(color = container),
        pressFeedbackType = if (clickable) PressFeedbackType.Sink else PressFeedbackType.None,
        onClick = if (clickable) ({ if (coreMissing) onNavigate("core") else state.service("start") }) else null,
    ) {
        Box(Modifier.fillMaxWidth().heightIn(min = 120.dp).clip(RoundedCornerShape(16.dp))) {
            Box(
                Modifier.align(Alignment.BottomEnd).offset(x = 26.dp, y = 30.dp).size(120.dp)
                    .clip(CircleShape).background(accent.copy(alpha = 0.18f)).padding(14.dp)
                    .clip(CircleShape).background(accent),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = container, modifier = Modifier.size(52.dp))
            }
            Column(Modifier.padding(20.dp).padding(end = 72.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, fontSize = 24.sp, fontWeight = FontWeight.Bold, color = MiuixTheme.colorScheme.onSurface)
                Text(line1, fontSize = 14.sp, color = MiuixTheme.colorScheme.onSurface.copy(alpha = 0.8f),
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (line2.isNotEmpty()) Text(line2, fontSize = 14.sp, color = MiuixTheme.colorScheme.onSurface.copy(alpha = 0.8f),
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!liveIdle) CircularProgressIndicator(size = 16.dp, strokeWidth = 2.dp, modifier = Modifier.padding(top = 8.dp))
            }
        }
    }
    if (running == true || state.paused) {
        Row(Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton("停止", onClick = { state.service("stop") }, enabled = liveIdle, modifier = Modifier.weight(1f))
            TextButton("重启", onClick = { state.service("restart") }, enabled = liveIdle && running == true, modifier = Modifier.weight(1f))
            TextButton("切换节点", onClick = { onNavigate("proxies") }, enabled = running == true, modifier = Modifier.weight(1f),
                colors = ButtonDefaults.textButtonColorsPrimary())
        }
    }
}

// ---------------- 卡片 ----------------

private val DownColor = Color(0xFF3482FF)
private val UpColor = Color(0xFF22B573)

/** 带标题栏的卡片：左侧标题，右侧可放一个小操作。 */
@Composable
private fun HomeCard(
    title: String,
    modifier: Modifier = Modifier,
    tools: @Composable () -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth(),
        insideMargin = PaddingValues(horizontal = 16.dp, vertical = 14.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 28.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = MiuixTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f))
            tools()
        }
        Spacer(Modifier.height(10.dp))
        content()
    }
}

@Composable
private fun SmallAction(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(Modifier.clip(RoundedCornerShape(10.dp)).background(MiuixTheme.colorScheme.secondaryContainer)
        .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 12.dp, vertical = 5.dp)) {
        Text(text, fontSize = 13.sp, color = if (enabled) MiuixTheme.colorScheme.primary else Tone.muted, fontWeight = FontWeight.Medium)
    }
}

/** 共享设备：正在用网的排前面，可直接拨开关决定走不走代理；完整列表与热点开关在「设备」页。 */
@Composable
private fun DevicesCard(onNavigate: (String) -> Unit) {
    val devices = SharedDevices
    val active = LocalPageActive.current
    LaunchedEffect(active) { if (active) devices.poll(share = false) }
    val clients = devices.sortedClients()
    val saving = devices.pending || ProfileState.busy.isNotEmpty()
    val failure = devices.localError.ifEmpty { ProfileState.error }
    // 没有设备连着时整张卡片不显示（仍在后台按页面可见时读取，设备一连上就出现）；正在保存或出错时保留，免得看不到结果
    if (clients.isEmpty() && !saving && failure.isEmpty()) return
    HomeCard("共享设备" + if (clients.isEmpty()) "" else "（${clients.size}）", tools = { SmallAction("管理") { onNavigate("devices") } }) {
        when {
            saving -> Text("正在保存并热重载…", fontSize = 12.sp, color = Tone.muted)
            failure.isNotEmpty() -> Text(failure, fontSize = 12.sp, color = Tone.danger)
        }
        for (client in clients.take(4)) ClientRow(client, compact = true)
        if (clients.size > 4) {
            Text("还有 ${clients.size - 4} 台设备", fontSize = 13.sp, color = MiuixTheme.colorScheme.primary,
                modifier = Modifier.clickable { onNavigate("devices") }.padding(vertical = 8.dp))
        }
    }
}

@Composable
private fun SpeedCard() {
    val home = LiveHome
    HomeCard("实时网速") {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SpeedValue("↓ 下载", formatRate(home.down), DownColor, Modifier.weight(1f))
            SpeedValue("↑ 上传", formatRate(home.up), UpColor, Modifier.weight(1f))
        }
        Spacer(Modifier.height(12.dp))
        Box(Modifier.fillMaxWidth().height(110.dp), contentAlignment = Alignment.Center) {
            LineChart(listOf(home.downHist to DownColor, home.upHist to UpColor), Modifier.fillMaxWidth().height(110.dp))
            val idle = (home.downHist + home.upHist).all { it <= 0 }
            if (idle) Text(if (home.downHist.isEmpty()) "正在采样…" else "暂无流量经过代理", fontSize = 12.sp, color = Tone.muted)
        }
        val peak = (home.downHist + home.upHist).maxOrNull()
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Text("近 80 秒", fontSize = 11.sp, color = Tone.muted, modifier = Modifier.weight(1f))
            if (peak != null && peak > 0) Text("峰值 ${formatRate(peak)}", fontSize = 11.sp, color = Tone.muted)
        }
    }
}

@Composable
private fun SpeedValue(label: String, value: String, color: Color, modifier: Modifier) {
    Column(modifier) {
        Text(label, fontSize = 12.sp, color = color, fontWeight = FontWeight.Medium)
        Text(value, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = MiuixTheme.colorScheme.onSurface, maxLines = 1)
    }
}

/** 折线图：数据靠右对齐，最多 [points] 个点，带渐隐填充。 */
@Composable
fun LineChart(series: List<Pair<List<Double>, Color>>, modifier: Modifier, points: Int = SPARK, fill: Boolean = true, grid: Boolean = true) {
    val gridColor = MiuixTheme.colorScheme.onSurface.copy(alpha = 0.06f)
    Canvas(modifier) {
        if (grid) for (i in 0..3) {
            val y = size.height * i / 3f
            drawLine(gridColor, Offset(0f, y), Offset(size.width, y), strokeWidth = 1f)
        }
        val max = series.flatMap { it.first }.maxOrNull()?.takeIf { it > 0 } ?: return@Canvas
        val step = size.width / (points - 1)
        for ((data, color) in series) {
            if (data.size < 2) continue
            val line = Path()
            val area = Path()
            data.forEachIndexed { i, v ->
                val x = size.width - (data.size - 1 - i) * step
                val y = size.height - (v / max * size.height * 0.92).toFloat()
                if (i == 0) {
                    line.moveTo(x, y); area.moveTo(x, size.height); area.lineTo(x, y)
                } else {
                    line.lineTo(x, y); area.lineTo(x, y)
                }
            }
            if (fill) {
                area.lineTo(size.width, size.height)
                area.close()
                drawPath(area, Brush.verticalGradient(listOf(color.copy(alpha = 0.28f), color.copy(alpha = 0f))))
            }
            drawPath(line, color, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

@Composable
private fun KpiGrid(onNavigate: (String) -> Unit) {
    val home = LiveHome
    val state = LiveOverview
    val memory = state.memoryInUse ?: state.status?.string("rss_kb")?.toDoubleOrNull()?.let { it * 1024 }
    Column(Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Kpi("本次流量", "↓ " + formatBytes(home.downTotal), "↑ " + formatBytes(home.upTotal), Modifier.weight(1f))
            Kpi("活动连接", home.conns?.toString() ?: "—", null, Modifier.weight(1f), spark = home.connHist) { onNavigate("connections") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Kpi("内存", formatBytes(memory), "mihomo 进程", Modifier.weight(1f))
            Kpi("当前出口", home.exitNode.ifEmpty { "—" }, home.exitChain.takeIf { "→" in it } ?: "兜底规则的去向",
                Modifier.weight(1f)) { onNavigate("proxies") }
        }
    }
}

@Composable
private fun Kpi(label: String, value: String, sub: String?, modifier: Modifier, spark: List<Double>? = null, onClick: (() -> Unit)? = null) {
    Card(modifier.height(96.dp), insideMargin = PaddingValues(0.dp),
        pressFeedbackType = if (onClick != null) PressFeedbackType.Sink else PressFeedbackType.None, onClick = onClick) {
        Column(Modifier.fillMaxWidth().fillMaxHeight().padding(horizontal = 14.dp, vertical = 12.dp)) {
            Text(label, fontSize = 12.sp, color = Tone.muted)
            Text(value, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = MiuixTheme.colorScheme.onSurface)
            Spacer(Modifier.weight(1f))
            if (spark != null && spark.size >= 2) {
                LineChart(listOf(spark to MiuixTheme.colorScheme.primary), Modifier.fillMaxWidth().height(22.dp), grid = false)
            } else if (sub != null) {
                Text(sub, fontSize = 12.sp, color = Tone.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun delayTone(ms: Int?): Color = when {
    ms == null -> Tone.muted
    ms <= 0 -> Tone.danger
    ms < 300 -> Tone.success
    ms < 800 -> Tone.warning
    else -> Tone.danger
}

@Composable
private fun ConnectivityCard() {
    val home = LiveHome
    HomeCard("连通性", tools = { SmallAction("重测") { home.checkSites(); home.checkIp() } }) {
        // 四个平台等宽排列：宽屏一行四个，窄屏两行两列，各项上下左右对齐
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val columns = if (maxWidth >= 480.dp) 4 else 2
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (row in SITES.chunked(columns)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (site in row) {
                            val ms = home.sites[site.name]
                            val tested = site.name in home.sites
                            val color = if (!tested) Tone.muted else delayTone(ms)
                            Row(Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(color.copy(alpha = 0.12f)).padding(horizontal = 10.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Box(Modifier.size(6.dp).clip(CircleShape).background(color))
                                Text(site.name, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = MiuixTheme.colorScheme.onSurface,
                                    maxLines = 1, modifier = Modifier.weight(1f))
                                Text(when {
                                    !tested -> "-"
                                    ms == null -> "测试中"
                                    ms <= 0 -> "超时"
                                    else -> "$ms ms"
                                }, fontSize = 12.sp, color = color, maxLines = 1)
                            }
                        }
                        repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }
        Text(if (home.netVia == "direct") "在模块所在设备上直连测试" else "在模块所在设备上经代理测试",
            fontSize = 11.sp, color = Tone.muted, modifier = Modifier.padding(top = 6.dp))
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("出口 IP", fontSize = 14.sp, color = MiuixTheme.colorScheme.onSurface)
                Text("由模块所在设备查询 ipip.net 与 ipwho.is", fontSize = 11.sp, color = Tone.muted)
            }
            Switch(checked = home.ipEnabled, onCheckedChange = { home.toggleIp(it) })
        }
        if (home.ipEnabled) {
            Spacer(Modifier.height(8.dp))
            IpLine("国内", home.ipCn)
            IpLine("海外", home.ipIntl)
        }
    }
}

@Composable
private fun IpLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.Top) {
        Text(label, fontSize = 13.sp, color = Tone.muted, modifier = Modifier.width(40.dp))
        Text(value.ifEmpty { "-" }, fontSize = 13.sp, color = MiuixTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun KeyValue(label: String, value: String, color: Color = MiuixTheme.colorScheme.onSurface) {
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, fontSize = 14.sp, color = Tone.muted, modifier = Modifier.weight(1f))
        Text(value, fontSize = 14.sp, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun EbpfCard() {
    val home = LiveHome
    val data = home.ebpf
    HomeCard("eBPF 透明代理", tools = {
        SmallAction(if (home.ebpfInspecting) "诊断中…" else "详细诊断", enabled = !home.ebpfInspecting) { home.inspectEbpf() }
    }) {
        val inbound = data?.arr("inbounds")?.firstOrNull()
        when {
            data == null -> Text(home.ebpfError.ifEmpty { "读取中…" }, fontSize = 13.sp, color = Tone.muted)
            inbound == null -> Text("没有启用 eBPF 入站", fontSize = 13.sp, color = Tone.muted)
            else -> {
                val detail = home.ebpfDetails?.arr("inbounds")?.firstOrNull { it.num("id") == inbound.num("id") }
                val res = detail?.obj("resources")
                val report = res?.obj("maps")
                val maps = report?.arr("maps").orEmpty()
                val pressured = maps.count { it.string("pressure") in setOf("warning", "degraded") }
                val (mapText, mapColor) = when (report?.string("status")) {
                    "pass" -> "正常" to Tone.success
                    "warning" -> "接近上限" to Tone.warning
                    "degraded" -> "已满" to Tone.danger
                    else -> "部分无法读取" to Tone.warning
                }
                val failures = inbound.arr("maintenance").sumOf { it.num("failures") ?: 0.0 }.toInt()
                KeyValue("模式", when (inbound.string("mode")) {
                    "hybrid" -> "本机 + 共享设备"; "local" -> "仅本机"; "shared" -> "仅共享设备"; else -> inbound.string("mode")
                })
                KeyValue("本机数据面", inbound.string("local_data_plane").ifEmpty { "-" })
                if (inbound.string("shared_data_plane").isNotEmpty()) KeyValue("共享数据面", inbound.string("shared_data_plane"))
                if (res != null) {
                    KeyValue("已加载程序", "${(res["programs"] as? JsonArray)?.size ?: 0} 个")
                    KeyValue("Map 占用（上次诊断）", "$mapText · ${maps.size} 个" + if (pressured > 0) " · $pressured 个接近上限" else "", mapColor)
                    val inspectionError = report?.string("error").orEmpty()
                    if (inspectionError.isNotEmpty()) Text("诊断未完成：$inspectionError", fontSize = 12.sp, color = Tone.warning)
                } else Text("日常概览不扫描流量表；详细占用请手动诊断。", fontSize = 12.sp, color = Tone.muted)
                KeyValue("后台清理", if (failures > 0) "$failures 次失败" else "正常", if (failures > 0) Tone.danger else Tone.success)
                val error = home.ebpfDetailsError.ifEmpty { detail?.string("resource_error").orEmpty() }
                if (error.isNotEmpty()) Text(error, fontSize = 13.sp, color = Tone.danger, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}

@Composable
private fun SubsCard() {
    val home = LiveHome
    val list = home.subs
    if (list != null && list.isEmpty() && home.subsError.isEmpty()) return
    HomeCard("订阅", tools = {
        SmallAction(if (home.updating) "更新中…" else "全部更新", enabled = !home.updating && !list.isNullOrEmpty()) { home.updateAll() }
    }) {
        if (home.updateResult.isNotEmpty()) Text(home.updateResult, fontSize = 12.sp,
            color = if (home.updateResult.startsWith("更新失败")) Tone.danger else Tone.success, modifier = Modifier.padding(bottom = 8.dp))
        when {
            home.subsError.isNotEmpty() -> Text("无法读取订阅：${home.subsError}", fontSize = 13.sp, color = Tone.danger)
            list == null -> Text("读取中…", fontSize = 13.sp, color = Tone.muted)
            else -> Column(verticalArrangement = Arrangement.spacedBy(14.dp)) { for (sub in list) SubItem(sub) }
        }
    }
}

@Composable
private fun SubItem(sub: SubInfo) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(sub.name, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = MiuixTheme.colorScheme.onSurface,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text("${sub.total} 个节点", fontSize = 12.sp, color = Tone.muted)
        }
        sub.ratio?.let { ratio ->
            val color = when {
                ratio > 0.9 -> Tone.danger
                ratio > 0.7 -> Tone.warning
                else -> MiuixTheme.colorScheme.primary
            }
            Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(color.copy(alpha = 0.15f))) {
                Box(Modifier.fillMaxWidth(ratio.toFloat()).fillMaxHeight().clip(RoundedCornerShape(3.dp)).background(color))
            }
        }
        val expireLeft = if (sub.expire > 0) sub.expire * 1000 - nowMs() else null
        val expireColor = when {
            expireLeft == null -> Tone.muted
            expireLeft <= 0 -> Tone.danger
            expireLeft < 7 * 86400000.0 -> Tone.warning
            else -> Tone.muted
        }
        Row {
            Text(if (sub.quota > 0) "已用 ${formatBytes(sub.used)} / ${formatBytes(sub.quota)}" else "无流量信息",
                fontSize = 12.sp, color = Tone.muted, modifier = Modifier.weight(1f))
            Text(if (sub.expire > 0) "到期 ${formatDate(sub.expire)}" else "长期", fontSize = 12.sp, color = expireColor)
        }
        Text("更新于 ${formatAgo(sub.updatedAt)}", fontSize = 11.sp, color = Tone.muted)
    }
}

@Composable
private fun Shortcuts(onNavigate: (String) -> Unit) {
    Row(Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Shortcut(MiuixIcons.Regular.Link, "连接", Modifier.weight(1f)) { onNavigate("connections") }
        Shortcut(MiuixIcons.Regular.Notes, "日志", Modifier.weight(1f)) { onNavigate("logs") }
        Shortcut(MiuixIcons.Regular.Layers, "面板", Modifier.weight(1f)) {
            LiveOverview.feedback.clear()
            Dashboard.open { message -> LiveOverview.feedback.error = message }
        }
        Shortcut(MiuixIcons.Regular.Settings, "内核配置", Modifier.weight(1f)) { onNavigate("profile") }
    }
}

@Composable
private fun Shortcut(icon: ImageVector, label: String, modifier: Modifier, onClick: () -> Unit) {
    Card(modifier, insideMargin = PaddingValues(vertical = 14.dp), pressFeedbackType = PressFeedbackType.Sink, onClick = onClick) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(MiuixTheme.colorScheme.primary.copy(alpha = 0.12f)), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = MiuixTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
            }
            Text(label, fontSize = 12.sp, color = MiuixTheme.colorScheme.onSurface, maxLines = 1)
        }
    }
}
