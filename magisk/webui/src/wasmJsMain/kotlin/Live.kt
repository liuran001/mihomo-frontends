package mihomo

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.CardDefaults
import top.yukonga.miuix.kmp.basic.CircularProgressIndicator
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Backup
import top.yukonga.miuix.kmp.icon.extended.Close
import top.yukonga.miuix.kmp.icon.extended.Download
import top.yukonga.miuix.kmp.icon.extended.File
import top.yukonga.miuix.kmp.icon.extended.Help
import top.yukonga.miuix.kmp.icon.extended.Home
import top.yukonga.miuix.kmp.icon.extended.Info
import top.yukonga.miuix.kmp.icon.extended.Layers
import top.yukonga.miuix.kmp.icon.extended.Link
import top.yukonga.miuix.kmp.icon.extended.Notes
import top.yukonga.miuix.kmp.icon.extended.Ok
import top.yukonga.miuix.kmp.icon.extended.Pause
import top.yukonga.miuix.kmp.icon.extended.Refresh
import top.yukonga.miuix.kmp.icon.extended.Remove
import top.yukonga.miuix.kmp.icon.extended.Settings
import top.yukonga.miuix.kmp.icon.extended.Timer
import top.yukonga.miuix.kmp.icon.extended.Update
import top.yukonga.miuix.kmp.theme.MiuixTheme
import kotlin.math.roundToLong

internal val liveScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
private val liveMutex = Mutex()
internal var liveActivity by mutableStateOf("")
internal val liveIdle: Boolean get() = liveActivity.isEmpty()
private val liveSelectableGroupTypes = setOf("Selector", "URLTest", "Fallback", "Smart")
private val liveGroupTypes = liveSelectableGroupTypes + "LoadBalance"

internal class LiveFeedback {
    var message by mutableStateOf("")
    var error by mutableStateOf("")

    fun clear() {
        message = ""
        error = ""
    }
}

private data class LiveResponse(val value: JsonObject? = null, val error: String = "")

private fun JsonObject.liveText(name: String): String =
    (this[name] as? JsonPrimitive)?.contentOrNull.orEmpty()

private fun JsonObject.liveBoolean(name: String): Boolean? =
    (this[name] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

private fun JsonObject.liveNumber(name: String): Double? =
    liveText(name).toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0 }

private fun JsonObject.liveStrings(name: String): List<String> =
    (this[name] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

private fun liveFailure(failure: Exception): String =
    failure.message?.takeIf { it.isNotBlank() } ?: "读取或操作失败"

private suspend fun liveCapture(block: suspend () -> JsonObject): LiveResponse = try {
    LiveResponse(value = block())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (failure: Exception) {
    LiveResponse(error = liveFailure(failure))
}

private suspend fun liveRequest(operation: String, payload: JsonObject = json()): JsonObject {
    val response = request(operation, payload)
    check(response.liveBoolean("ok") == true) { response.liveText("error").ifBlank { "后台未确认操作成功" } }
    return response
}

private suspend fun liveController(
    path: String,
    method: String = "GET",
    body: JsonObject? = null,
): JsonObject? {
    val payload = if (body == null) json("path" to path, "method" to method)
    else json("path" to path, "method" to method, "body" to body)
    val response = liveRequest("controller", payload)
    val data = response["data"]
    check(response.containsKey("data")) { "控制器响应缺少 data" }
    if (method == "GET") {
        return data as? JsonObject ?: error("控制器响应 data 不是 JSON 对象")
    }
    check(data == JsonNull || data is JsonObject) { "控制器响应 data 格式无效" }
    return data as? JsonObject
}

private suspend fun liveControllerRead(path: String): JsonObject =
    liveController(path) ?: error("控制器响应为空")

private fun liveEncodeComponent(value: String): String = buildString {
    val hexadecimal = "0123456789ABCDEF"
    for (octet in value.encodeToByteArray()) {
        val code = octet.toInt() and 255
        if (code in 65..90 || code in 97..122 || code in 48..57 || code in listOf(45, 46, 95, 126)) {
            append(code.toChar())
        } else {
            append('%')
            append(hexadecimal[code shr 4])
            append(hexadecimal[code and 15])
        }
    }
}

private fun liveBytes(bytes: Double?): String {
    if (bytes == null || !bytes.isFinite() || bytes < 0) return "—"
    val units = listOf("B", "KB", "MB", "GB", "TB", "PB", "EB")
    var amount: Double = bytes
    var unitIndex = 0
    while (amount >= 1024 && unitIndex < units.lastIndex) {
        amount /= 1024
        unitIndex++
    }
    val number = if (unitIndex == 0 || amount >= 100) amount.roundToLong().toString()
    else {
        val tenths = (amount * 10).roundToLong()
        "${tenths / 10}.${tenths % 10}"
    }
    return "$number ${units[unitIndex]}"
}

private fun liveUptime(seconds: Double?): String {
    if (seconds == null) return "—"
    val minutes = (seconds / 60).toLong()
    val days = minutes / 1440
    val hours = minutes % 1440 / 60
    return buildString {
        if (days > 0) append("${days}天 ")
        if (hours > 0) append("${hours}时 ")
        append("${minutes % 60}分")
    }
}

private fun liveControllerAddress(content: String): String {
    val raw = content.lineSequence().filter { it.startsWith("external-controller:") }
        .lastOrNull()?.substringAfter(':')?.trim() ?: error("配置中没有 external-controller")
    val address = when {
        raw.startsWith('"') -> {
            val quoted = Regex("^\"(?:[^\"\\\\]|\\\\.)*\"").find(raw)?.value
                ?: error("控制器地址引号无效")
            check(Regex("^\\s*(?:#.*)?$").matches(raw.substring(quoted.length))) { "控制器地址格式无效" }
            (Json.parseToJsonElement(quoted) as? JsonPrimitive)?.contentOrNull.orEmpty()
        }
        raw.startsWith('\'') -> {
            val quoted = Regex("^'((?:[^']|'')*)'\\s*(?:#.*)?$").matchEntire(raw)
                ?: error("控制器地址引号无效")
            quoted.groupValues[1].replace("''", "'")
        }
        else -> raw.replace(Regex("\\s+#.*$"), "").trim()
    }
    check(Regex("^(?:\\[[0-9a-fA-F:]+\\]|[\\w.*-]*):[0-9]{1,5}$").matches(address)) { "控制器地址无效" }
    val port = address.substringAfterLast(':').toIntOrNull()
    check(port != null && port in 1..65535) { "控制器端口无效" }
    val host = address.substringBeforeLast(':').let {
        if (it in setOf("", "0.0.0.0", "[::]", "*")) "127.0.0.1" else it
    }
    return "http://$host:$port"
}

internal suspend fun liveRead(label: String, block: suspend () -> Unit) {
    liveMutex.lock()
    liveScope.async {
        liveActivity = label
        try {
            block()
        } finally {
            liveActivity = ""
            liveMutex.unlock()
        }
    }.await()
}

private fun liveRun(
    label: String,
    feedback: LiveFeedback,
    invalidate: () -> Unit = {},
    block: suspend () -> Unit,
) {
    if (!liveMutex.tryLock()) return
    liveActivity = label
    feedback.clear()
    liveScope.launch {
        try {
            block()
        } catch (cancelled: CancellationException) {
            invalidate()
            feedback.error = "等待已取消，后台可能仍在执行；操作结果未知，请刷新确认，勿重复提交。"
            throw cancelled
        } catch (failure: Exception) {
            invalidate()
            feedback.error = liveFailure(failure) + "；请刷新确认实际状态，勿重复提交。"
        } finally {
            liveActivity = ""
            liveMutex.unlock()
        }
    }
}

internal object LiveOverview {
    val feedback = LiveFeedback()
    var status by mutableStateOf<JsonObject?>(null)
    var statusError by mutableStateOf("")
    var core by mutableStateOf<JsonObject?>(null)
    var coreError by mutableStateOf("")
    var policy by mutableStateOf<JsonObject?>(null)
    var policyError by mutableStateOf("")
    var controllerVersion by mutableStateOf("")
    var controllerAddress by mutableStateOf("")
    var controllerError by mutableStateOf("")
    var trafficUp by mutableStateOf<Double?>(null)
    var trafficDown by mutableStateOf<Double?>(null)
    var connectionCount by mutableStateOf<Int?>(null)
    var memoryInUse by mutableStateOf<Double?>(null)
    val running: Boolean? get() = status?.liveBoolean("running")
    val paused: Boolean get() = running == false && status?.liveBoolean("allowed") == false &&
        status?.liveText("desired") in setOf("manual", "auto")
    val enabled: Boolean get() = running == true || status?.liveText("desired") in setOf("manual", "auto")

    fun invalidate() {
        status = null
        controllerVersion = ""
        controllerAddress = ""
        controllerError = ""
        LiveProxies.invalidate()
        LiveConnections.invalidate()
    }

    suspend fun load() {
        // 刷新期间保留上次的值，避免卡片闪成「—」；失败时由对应的 *Error 提示
        statusError = ""
        coreError = ""
        policyError = ""
        controllerAddress = ""
        controllerError = ""
        val statusResult = liveCapture {
            liveRequest("status").also { check(it.liveBoolean("running") != null) { "服务状态缺少 running 布尔值" } }
        }
        status = statusResult.value
        statusError = statusResult.error
        val coreResult = liveCapture {
            liveRequest("coreInfo").also { check(it.liveBoolean("installed") != null) { "内核安装状态无效" } }
        }
        core = coreResult.value
        coreError = coreResult.error
        val policyResult = liveCapture {
            liveRequest("policyGet").also { check(it.liveBoolean("autostart") != null) { "开机自启状态无效" } }
        }
        policy = policyResult.value
        policyError = policyResult.error
        if (running != true) return
        val versionResult = liveCapture { liveControllerRead("/version") }
        controllerError = versionResult.error
        if (versionResult.value != null) controllerVersion = versionResult.value.liveText("version").ifBlank { "未知版本" }
        pollTraffic()
    }

    suspend fun pollTraffic() {
        val traffic = liveCapture { liveControllerRead("/connections/summary") }.value ?: return
        trafficUp = traffic.liveNumber("uploadTotal")
        trafficDown = traffic.liveNumber("downloadTotal")
        connectionCount = traffic.liveNumber("connectionCount")?.toInt()
        memoryInUse = traffic.liveNumber("memory")
    }

    fun refresh() = liveRun("刷新概览中…", feedback) { load() }

    fun service(action: String) {
        if (running == null || action !in setOf("start", "restart", "stop")) return
        val title = when (action) {
            "start" -> "启动"
            "restart" -> "重启"
            else -> "停止"
        }
        liveRun("正在${title}服务…", feedback, ::invalidate) {
            invalidate()
            val result = liveCapture { liveRequest("service", json("action" to action)) }
            if (result.value != null) {
                feedback.message = result.value.liveText("message").ifBlank {
                    if (result.value.liveBoolean("paused") == true) "服务已启用，因 SSID 策略暂停，策略允许后自动恢复。"
                    else "后台已确认服务${title}操作成功。"
                }
            } else {
                feedback.error = "${title}结果未确认：${result.error}。后台可能仍在执行，请核对刷新状态，勿重复提交。"
            }
            liveActivity = "服务操作已返回，刷新状态中…"
            load()
        }
    }
}

internal data class LiveProxyGroup(
    val key: String,
    val name: String,
    val type: String,
    val selected: String,
    val options: List<String>,
    val icon: String = "",
    val hidden: Boolean = false,
) {
    val selectable: Boolean get() = type in liveSelectableGroupTypes
}

internal object LiveProxies {
    val feedback = LiveFeedback()
    var groups by mutableStateOf<List<LiveProxyGroup>?>(null)
    var error by mutableStateOf("")
    var loading by mutableStateOf(false)
        private set
    var stale by mutableStateOf(true)
        private set
    val writable: Boolean get() = liveIdle && !loading && !stale && groups != null

    fun invalidate() {
        stale = true
    }

    suspend fun load() {
        loading = true
        stale = true
        error = ""
        try {
            val result = liveCapture {
                liveControllerRead("/proxies").also {
                    check(it["proxies"] is JsonObject) { "控制器响应缺少 proxies 对象" }
                }
            }
            error = result.error
            val proxies = result.value?.get("proxies") as? JsonObject ?: return
            readDelays(proxies)
            nodes = proxies.mapNotNull { (name, element) ->
                val proxy = element as? JsonObject ?: return@mapNotNull null
                name to LiveNode(proxy.liveText("type"), proxy.liveBoolean("udp") == true, proxy.liveText("icon"))
            }.toMap()
            groups = proxies.mapNotNull { (name, element) ->
                val proxy = element as? JsonObject ?: return@mapNotNull null
                val type = proxy.liveText("type")
                if (type !in liveGroupTypes) return@mapNotNull null
                LiveProxyGroup(
                    key = name,
                    name = proxy.liveText("name").ifEmpty { name },
                    type = type,
                    selected = proxy.liveText("now"),
                    options = proxy.liveStrings("all").distinct(),
                    icon = proxy.liveText("icon"),
                    hidden = proxy.liveBoolean("hidden") == true,
                )
            }.let { list ->
                // 控制器按名称返回；GLOBAL 的 all 保持配置文件中的顺序，据此排序，GLOBAL 放最后。
                val order = (proxies["GLOBAL"] as? JsonObject)?.liveStrings("all").orEmpty()
                    .withIndex().associate { it.value to it.index }
                list.sortedWith(compareBy({ it.name == "GLOBAL" }, { order[it.name] ?: Int.MAX_VALUE }))
            }
            stale = false
        } finally {
            loading = false
        }
    }

    fun refresh() = liveRun("刷新代理组中…", feedback) { load() }

    var delays by mutableStateOf<Map<String, Int>>(emptyMap())
    var nodes by mutableStateOf<Map<String, LiveNode>>(emptyMap())
    var testing by mutableStateOf<Set<String>>(emptySet())

    private fun readDelays(proxies: JsonObject) {
        delays = proxies.mapNotNull { (name, element) ->
            val history = (element as? JsonObject)?.get("history") as? JsonArray
            val delay = (history?.lastOrNull() as? JsonObject)?.liveNumber("delay")?.toInt()
            if (delay != null && delay > 0) name to delay else null
        }.toMap()
    }

    /** 组测速：一次请求测完组内全部节点，未返回的节点视为超时。 */
    fun test(group: LiveProxyGroup) {
        if (group.key in testing) return
        testing = testing + group.key
        liveScope.launch {
            try {
                val url = liveEncodeComponent("https://cp.cloudflare.com/generate_204")
                val result = liveCapture { liveControllerRead("/group/${liveEncodeComponent(group.name)}/delay?url=$url&timeout=5000") }
                val measured = result.value?.mapNotNull { (name, value) ->
                    (value as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toInt()?.let { name to it }
                }?.toMap().orEmpty()
                if (result.value != null) delays = delays + group.options.associateWith { measured[it] ?: 0 }
                if (result.error.isNotEmpty()) feedback.error = "测速失败：${result.error}"
            } finally {
                testing = testing - group.key
            }
        }
    }

    /** 单节点测速（点按节点上的延迟）。 */
    fun testNode(name: String) {
        if (name in testing) return
        testing = testing + name
        liveScope.launch {
            try {
                val url = liveEncodeComponent("https://cp.cloudflare.com/generate_204")
                val result = liveCapture { liveControllerRead("/proxies/${liveEncodeComponent(name)}/delay?url=$url&timeout=5000") }
                val delay = result.value?.liveNumber("delay")?.toInt()
                delays = delays + (name to (delay ?: 0))
            } finally {
                testing = testing - name
            }
        }
    }

    fun select(group: LiveProxyGroup, name: String) {
        if (!writable || !group.selectable || groups?.contains(group) != true || name !in group.options) return
        liveRun("切换 ${group.name} 中…", feedback, ::invalidate) {
            val result = liveCapture {
                liveController("/proxies/${liveEncodeComponent(group.name)}", "PUT", json("name" to name))
                json()
            }
            if (result.value != null) feedback.message = "已请求将 ${group.name} 切换为 $name，以刷新后的当前选择为准。"
            else feedback.error = "切换结果未确认：${result.error}。请核对刷新结果，勿重复提交。"
            load()
        }
    }
}

internal data class LiveNode(val type: String, val udp: Boolean, val icon: String = "")

internal data class LiveConnection(val key: String, val value: JsonObject)

private fun liveConnectionSnapshot(entries: List<JsonObject>): List<LiveConnection> {
    val occurrences = mutableMapOf<String, Int>()
    return entries.map { connection ->
        val metadata = connection["metadata"] as? JsonObject
        val identity = JsonArray(
            (listOf(connection.liveText("id"), connection.liveText("start")) +
                listOf("network", "sourceIP", "sourcePort", "destinationIP", "destinationPort").map {
                    metadata?.liveText(it).orEmpty()
                }).map { JsonPrimitive(it) },
        ).toString()
        val occurrence = occurrences[identity] ?: 0
        occurrences[identity] = occurrence + 1
        LiveConnection("connection:$identity:$occurrence", connection)
    }
}

internal object LiveConnections {
    val feedback = LiveFeedback()
    var connections by mutableStateOf<List<LiveConnection>?>(null)
    var total by mutableStateOf<Int?>(null)
    var upload by mutableStateOf<Double?>(null)
    var download by mutableStateOf<Double?>(null)
    var error by mutableStateOf("")
    var loading by mutableStateOf(false)
        private set
    var stale by mutableStateOf(true)
        private set
    val writable: Boolean get() = liveIdle && !loading && !stale && connections != null

    fun invalidate() {
        stale = true
    }

    suspend fun load() {
        loading = true
        stale = true
        error = ""
        try {
            val result = liveCapture {
                liveControllerRead("/connections").also { response ->
                    val entries = response["connections"]
                    check(entries == JsonNull || entries is JsonArray) { "控制器响应缺少 connections 数组" }
                    if (entries is JsonArray) check(entries.all { it is JsonObject }) { "连接记录格式无效" }
                }
            }
            error = result.error
            val response = result.value ?: return
            val entries = response["connections"] as? JsonArray
            connections = liveConnectionSnapshot(entries?.takeLast(200)?.asReversed()?.map { it as JsonObject }.orEmpty())
            total = entries?.size ?: 0
            upload = response.liveNumber("uploadTotal")
            download = response.liveNumber("downloadTotal")
            stale = false
        } finally {
            loading = false
        }
    }

    fun refresh() = liveRun("刷新连接中…", feedback) { load() }

    fun close(identifier: String? = null) {
        if (!writable) return
        if (identifier != null && (identifier.isEmpty() || connections.orEmpty().none { it.value.liveText("id") == identifier })) return
        val title = if (identifier == null) "全部连接" else "连接"
        liveRun("断开${title}中…", feedback, ::invalidate) {
            val path = if (identifier == null) "/connections" else "/connections/${liveEncodeComponent(identifier)}"
            val result = liveCapture {
                liveController(path, "DELETE")
                json()
            }
            if (result.value != null) feedback.message = "已请求断开$title。刷新后可能出现新建立的连接。"
            else feedback.error = "断开结果未确认：${result.error}。请核对刷新结果，勿重复提交。"
            load()
        }
    }
}

