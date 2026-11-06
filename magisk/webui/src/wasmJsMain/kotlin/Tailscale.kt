@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package mihomo

// Tailscale：内核内置的 tailscale 出站（tsnet）。新内核提供 /tailscale 控制器接口：
// 状态（含 IP、登录链接、错误）直接向内核查询，「连接 / 网页登录」让内核立即启动 tsnet 并返回登录链接；
// 旧内核退回到订阅日志、测速唤醒 tsnet 并从日志里取登录链接的方式。页面轮询状态，登录成功后自动更新。
// 出站的增删改走配置引擎（tailscale.add / set / delete），保存流程与「内核配置」相同：patch » 校验 » 写入并重启。

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.CardDefaults
import top.yukonga.miuix.kmp.basic.CircularProgressIndicator
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Link
import top.yukonga.miuix.kmp.theme.MiuixTheme

@JsFun("""(text) => {
    try { if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text); return true; } } catch (e) {}
    try {
        const area = document.createElement('textarea');
        area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
        document.body.appendChild(area); area.select();
        const ok = document.execCommand('copy'); area.remove(); return ok;
    } catch (e) { return false; }
}""")
internal external fun copyText(text: String): Boolean

internal data class TailscaleEntry(
    val name: String,
    val stateDir: String,
    val authKey: Boolean,
    val loggedIn: Boolean,
    val login: String,
    val tailnet: String,
    val magicDns: String,
    val fields: List<ConfigField>,
    val webui: Boolean = false,
    /** 内核报告的 tsnet 状态：NotStarted / NeedsLogin / Starting / Running / NeedsMachineAuth …；旧内核为空 */
    val state: String = "",
    val kernel: Boolean = false,
    val ips: List<String> = emptyList(),
    val dnsName: String = "",
    val problem: String = "",
    /** 用户的 serve 转发（不含网页管理）：端口 → 目标 */
    val serve: List<Pair<Int, String>> = emptyList(),
)

private fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

internal object TailscaleState {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    var loaded by mutableStateOf(false)
    var entries by mutableStateOf<List<TailscaleEntry>>(emptyList())
    var template by mutableStateOf<List<ConfigField>>(emptyList())
    var busy by mutableStateOf("")
    var error by mutableStateOf("")
    var notice by mutableStateOf("")
    private var source: String? = null

    // 网页登录
    var loginFor by mutableStateOf<String?>(null)
    var loginUrl by mutableStateOf("")
    var loginQr by mutableStateOf<List<String>>(emptyList())
    var loginMessage by mutableStateOf("")
    var loginBusy by mutableStateOf(false)
    var loginMissed by mutableStateOf(false)
    private var loginJob: Job? = null
    private var poll: Job? = null

    fun load(force: Boolean = false) {
        if (busy.isNotEmpty() || (loaded && !force)) return
        run("读取配置…") { refresh() }
    }

    private suspend fun refresh() {
        val schema = request("tailscaleRead")
        val status = schema.objects("list").associateBy { it.string("name") }
        source = schema.string("content")
        template = schema.objects("tailscaleFields").map { it.field() }
        entries = schema.objects("tailscale").map { item ->
            val name = item.string("name")
            val state = status[name] ?: JsonObject(emptyMap())
            TailscaleEntry(name, state.string("stateDir"), state.boolean("authKey"), state.boolean("loggedIn"),
                state.string("login"), state.string("tailnet"), state.string("magicDns"), item.objects("fields").map { it.field() },
                item.boolean("webui"), state = state.string("state"), kernel = state.boolean("kernel"), ips = state.strings("ips"),
                dnsName = state.string("dnsName"), problem = state.string("error"),
                serve = item.objects("serve").mapNotNull { serve ->
                    val port = (serve["port"] as? JsonPrimitive)?.intOrNull ?: return@mapNotNull null
                    port to serve.string("target")
                })
        }
        loaded = true
    }

    private fun run(label: String, block: suspend () -> Unit) {
        busy = label
        error = ""
        scope.launch {
            try {
                block()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                error = failure.message ?: "操作失败"
            } finally {
                busy = ""
            }
        }
    }

    /** 修改配置：patch » 校验 » 写入并重启服务，然后重新读取。 */
    private suspend fun apply(ops: List<JsonObject>) {
        val content = source ?: request("configRead").string("content")
        busy = "生成配置…"
        val patched = request("configPatch", JsonObject(mapOf("content" to JsonPrimitive(content), "ops" to JsonArray(ops)))).string("content")
        if (request("coreInfo").boolean("installed")) {
            busy = "校验配置…"
            request("validate", json("content" to patched))
        }
        busy = "写入配置并重启服务…"
        markToolsConfigChanged()
        val result = request("apply", json("content" to patched, "restart" to true))
        LiveOverview.invalidate()
        if (result.boolean("paused")) notice = "已保存；服务因 Wi-Fi 条件暂停，恢复运行后才能登录"
        refresh()
    }

    private fun op(op: String, name: String, values: Map<String, JsonElement> = emptyMap()) =
        JsonObject(mapOf("op" to JsonPrimitive(op), "name" to JsonPrimitive(name), "values" to JsonObject(values)))

    fun add(name: String, values: Map<String, JsonElement>) {
        notice = ""
        run("添加 Tailscale…") {
            apply(listOf(op("tailscale.add", name, values)))
            val authKey = (values["auth-key"] as? JsonPrimitive)?.contentOrNull.orEmpty()
            if (authKey.isEmpty()) startLogin(name) else notice = "已添加，tsnet 会用 auth key 自动登录"
        }
    }

    fun save(name: String, values: Map<String, JsonElement>) {
        if (values.isEmpty()) return
        notice = ""
        run("保存…") { apply(listOf(op("tailscale.set", name, values))); notice = "已保存并重启服务" }
    }

    fun setServe(name: String, serve: List<Pair<Int, String>>) {
        notice = ""
        val list = JsonArray(serve.map { (port, target) -> JsonObject(mapOf("port" to JsonPrimitive(port), "target" to JsonPrimitive(target))) })
        run("保存端口转发…") {
            apply(listOf(JsonObject(mapOf("op" to JsonPrimitive("tailscale.serve"), "name" to JsonPrimitive(name), "serve" to list))))
            notice = "已保存并重启服务"
        }
    }

    fun delete(name: String) {
        notice = ""
        run("删除 $name…") { apply(listOf(op("tailscale.delete", name))); notice = "已删除 $name；登录状态仍保留在数据目录，重新添加时会继续使用" }
    }

    /** 网页管理：把 tailscale serve 挂到这个出站（其它出站上的会被撤掉），然后重启服务。 */
    suspend fun setWebui(name: String, enable: Boolean) {
        if (!loaded) refresh()
        apply(listOf(JsonObject(mapOf("op" to JsonPrimitive("tailscale.webui"), "name" to JsonPrimitive(name), "enable" to JsonPrimitive(enable)))))
    }

    fun logout(name: String) {
        notice = ""
        run("退出登录…") {
            request("tailscaleLogout", json("name" to name))
            LiveOverview.invalidate()
            refresh()
            notice = "已退出登录"
        }
    }

    fun startLogin(name: String, restart: Boolean = false, connect: Boolean = false) {
        loginJob?.cancel()
        poll?.cancel()
        loginFor = name
        loginUrl = ""
        loginQr = emptyList()
        loginMissed = false
        loginBusy = true
        loginJob = scope.launch {
            try {
                val running = request("status").boolean("running")
                if (restart || !running) {
                    loginMessage = if (running) "正在重启服务…" else "正在启动服务…"
                    request("service", json("action" to if (running) "restart" else "start"))
                    LiveOverview.invalidate()
                    if (!request("status").boolean("running")) error("服务没有运行（可能因 Wi-Fi 条件暂停），无法登录")
                }
                loginMessage = if (connect) "正在连接 Tailscale…" else "正在获取登录链接…"
                val result = request("tailscaleLogin", json("name" to name, "wait" to if (connect) 25 else 15))
                val url = (result["url"] as? JsonPrimitive)?.contentOrNull.orEmpty()
                when {
                    url.isNotEmpty() -> {
                        loginUrl = url
                        loginQr = (request("qrCode", json("text" to url))["rows"] as? JsonArray)
                            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
                        loginMessage = "在浏览器里登录 Tailscale 账号并授权这台设备，完成后这里会自动更新。"
                        watch(name)
                    }
                    result.boolean("running") -> finishLogin(name)
                    else -> {
                        loginMissed = true
                        val problem = result.string("error")
                        loginMessage = when {
                            problem.isNotEmpty() -> "没有登录成功：$problem"
                            result.boolean("kernel") && result.string("state") == "NeedsMachineAuth" -> "已连接，等待 Tailnet 管理员在后台批准这台设备。"
                            result.boolean("kernel") -> "还没有登录成功（状态：${result.string("state").ifEmpty { "未知" }}）。auth key 可能已失效或过期，可以删除 auth key 后改用网页登录。"
                            else -> "没有拿到登录链接：tsnet 可能已经在运行。重启服务后再获取一次。"
                        }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                loginMissed = true
                loginMessage = failure.message ?: "获取登录链接失败"
            } finally {
                if (loginJob == coroutineContext[Job]) loginBusy = false
            }
        }
    }

    private fun watch(name: String) {
        poll = scope.launch {
            repeat(200) {
                delay(3000)
                awaitWebuiVisible()
                if (loginFor != name) return@launch
                val logged = try {
                    request("tailscaleStatus").objects("list").firstOrNull { it.string("name") == name }?.boolean("loggedIn") == true
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    false
                }
                if (logged) {
                    finishLogin(name)
                    return@launch
                }
            }
            if (loginFor == name) {
                loginMissed = true
                loginMessage = "等待超时。链接可能已失效，可以重启服务后重新获取。"
            }
        }
    }

    private suspend fun finishLogin(name: String) {
        refresh()
        val entry = entries.firstOrNull { it.name == name }
        notice = when {
            entry?.loggedIn != true -> "tsnet 已在运行"
            entry.login.isEmpty() -> "已登录"
            else -> "已登录：${entry.login}"
        }
        closeLogin()
    }

    fun closeLogin() {
        loginJob?.cancel()
        loginJob = null
        poll?.cancel()
        poll = null
        loginFor = null
        loginBusy = false
        loginUrl = ""
        loginQr = emptyList()
    }

    fun open(url: String) {
        scope.launch {
            try {
                request("openUrl", json("url" to url))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                loginMessage = failure.message ?: "无法打开浏览器"
            }
        }
    }

    fun copy(url: String) {
        loginMessage = if (copyText(url)) "链接已复制，可以在其它设备的浏览器里打开。" else "复制失败，请长按链接手动复制。"
    }

    /** 外部改动配置后调用，下次进入时重新读取。 */
    fun invalidate() {
        loaded = false
    }
}

@Composable
fun TailscalePage(onBack: () -> Unit) {
    val state = TailscaleState
    var editing by remember { mutableStateOf<TailscaleEntry?>(null) }
    var removing by remember { mutableStateOf<TailscaleEntry?>(null) }
    var leaving by remember { mutableStateOf<TailscaleEntry?>(null) }
    var adding by remember { mutableStateOf(false) }
    var serving by remember { mutableStateOf<TailscaleEntry?>(null) }
    LaunchedEffect(Unit) { state.load(force = true) }
    DisposableEffect(state) { onDispose { state.closeLogin() } }
    Page(title = "Tailscale", navigationIcon = { BackIcon(onBack) }) {
        banner(state.busy, BannerKind.Progress, "busy")
        banner(state.error, BannerKind.Error, "error")
        banner(state.notice, BannerKind.Success, "notice")
        if (!state.loaded) return@Page
        if (state.entries.isEmpty()) {
            item(key = "empty") {
                Column {
                    EmptyState(MiuixIcons.Regular.Link, "还没有 Tailscale 出站")
                    Caption("Tailscale 能把你的手机、电脑、家里的设备连成一个私有网络，在外面也能互相访问。添加后用浏览器登录账号即可，不需要填写 auth key。")
                    ButtonRow { ActionButton("添加 Tailscale", primary = true, enabled = state.busy.isEmpty()) { adding = true } }
                }
            }
            return@Page
        }
        for (entry in state.entries) {
            group(entry.name, "ts:${entry.name}") {
                val (label, tone) = statusLabel(entry)
                InfoRow("状态", label, valueColor = tone, summary = statusSummary(entry))
                if (entry.problem.isNotEmpty()) Caption(entry.problem, Tone.warning)
                if (entry.login.isNotEmpty()) {
                    val liveIdentity = entry.kernel && entry.state != "NotStarted"
                    InfoRow(if (liveIdentity) "设备所属账号" else "已保存的登录账号", entry.login,
                        summary = if (liveIdentity) "来自内核上报的本机节点所属用户，不是当前浏览器账号" else "来自本机状态文件的当前登录资料；连接后以内核返回为准")
                }
                if (entry.tailnet.isNotEmpty()) InfoRow("Tailnet", entry.tailnet)
                if (entry.dnsName.isNotEmpty()) InfoRow("域名", entry.dnsName)
                else if (entry.magicDns.isNotEmpty()) InfoRow("MagicDNS", entry.magicDns)
                if (entry.ips.isNotEmpty()) InfoRow("Tailnet 地址", entry.ips.joinToString("\n"))
                val hostname = entry.fields.firstOrNull { it.id == "hostname" }?.let { fieldText(it.value) }.orEmpty()
                ArrowRow("设置", "设备名、登录密钥、共享的网段与出口节点", value = hostname, enabled = state.busy.isEmpty()) { editing = entry }
                ArrowRow("端口转发", "让 Tailnet 里的设备访问本机上的网页服务",
                    value = if (entry.serve.isEmpty()) "未设置" else "${entry.serve.size} 个", enabled = state.busy.isEmpty()) { serving = entry }
                if (entry.stateDir.isEmpty() && !entry.kernel) Caption("登录信息没有保存在模块数据目录里，这里无法显示是否已登录", Tone.warning)
                ButtonRow(Modifier.padding(top = 4.dp)) {
                    val idle = state.busy.isEmpty()
                    when {
                        entry.loggedIn -> {
                            if (entry.kernel && entry.state == "NotStarted") ActionButton("立即连接", enabled = idle) { state.startLogin(entry.name, connect = true) }
                            ActionButton("退出登录", enabled = idle) { leaving = entry }
                        }
                        entry.authKey -> ActionButton("立即连接", primary = true, enabled = idle) { state.startLogin(entry.name, connect = true) }
                        else -> ActionButton("网页登录", primary = true, enabled = idle && (entry.stateDir.isNotEmpty() || entry.kernel)) { state.startLogin(entry.name) }
                    }
                    ActionButton("删除", enabled = idle) { removing = entry }
                }
            }
        }
        item(key = "note") {
            Caption("访问 Tailscale 里其它设备（100.x.x.x 地址）的流量会自动走 Tailscale。登录状态会保存下来，重启后不用重新登录。设备所属账号由注册信息决定，使用他人提供的 auth key 或已有登录状态时可能显示该账号；更换浏览器账号或修改 auth key 不会自动切换设备身份。")
        }
    }
    AddSheet(adding, onDismiss = { adding = false })
    EditSheet(editing, onDismiss = { editing = null })
    ServeSheet(serving, onDismiss = { serving = null })
    LoginSheet()
    ConfirmDialog(show = removing != null, title = "删除 ${removing?.name.orEmpty()}",
        summary = "同时删除指向它的规则与策略组成员，然后重启服务。", confirm = "删除", danger = true,
        onDismiss = { removing = null }) {
        removing?.let { state.delete(it.name) }
        removing = null
    }
    ConfirmDialog(show = leaving != null, title = "退出登录",
        summary = if (leaving?.kernel == true) "通过内核退出 ${leaving?.name.orEmpty()} 的登录，不重启代理服务。设备会从 Tailnet 中离线，之后需要重新登录。" else "删除 ${leaving?.name.orEmpty()} 的登录状态并重启服务。设备会从 Tailnet 中离线，之后需要重新登录。", confirm = "退出登录", danger = true,
        onDismiss = { leaving = null }) {
        leaving?.let { state.logout(it.name) }
        leaving = null
    }
}

@Composable
private fun statusLabel(entry: TailscaleEntry): Pair<String, Color> = when (entry.state) {
    "Running" -> "在线" to Tone.success
    "Starting" -> "连接中" to Tone.muted
    "NeedsLogin" -> "需要登录" to Tone.warning
    "NeedsMachineAuth" -> "等待管理员批准" to Tone.warning
    "Stopped" -> "已停止" to Tone.muted
    "NoState" -> "初始化中" to Tone.muted
    "NotStarted" -> if (entry.loggedIn) "已登录，未启动" to Tone.success else "未启动" to Tone.muted
    else -> if (entry.loggedIn) "已登录" to Tone.success else "未登录" to Tone.warning
}

private fun statusSummary(entry: TailscaleEntry): String? = when {
    entry.state == "NotStarted" -> "第一次访问 Tailnet 时自动启动，也可以点「立即连接」"
    !entry.loggedIn && entry.authKey && !entry.kernel -> "已填写 auth key，服务启动并有流量时自动登录"
    !entry.loggedIn && entry.authKey -> "已填写 auth key，点「立即连接」登录"
    else -> null
}

private val serveHttp = Regex("^http://(\\d{1,3}(\\.\\d{1,3}){3}|\\[[0-9A-Fa-f:.]+]):(\\d{1,5})/?$")
private val serveUnix = Regex("^unix:(//)?\\S+$")

/** 端口转发：Tailnet 端口 → 本机 http://IP:端口 或 unix 套接字（tailscale serve，仅 HTTP）。 */
@Composable
private fun ServeSheet(entry: TailscaleEntry?, onDismiss: () -> Unit) {
    val state = TailscaleState
    var list by remember(entry) { mutableStateOf(entry?.serve.orEmpty()) }
    var port by remember(entry) { mutableStateOf("") }
    var target by remember(entry) { mutableStateOf("http://127.0.0.1:") }
    var error by remember(entry) { mutableStateOf("") }
    val host = entry?.dnsName?.ifEmpty { null }
        ?: entry?.fields?.firstOrNull { it.id == "hostname" }?.let { fieldText(it.value) }?.ifEmpty { null } ?: "设备名"
    Sheet(show = entry != null, title = "端口转发", onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Caption("Tailnet 里的设备打开 http://$host:端口/ 时，转到本机的网页服务。只支持 HTTP；目标填 http://IP:端口（如 http://127.0.0.1:8080）或 unix:套接字路径。")
            if (entry?.webui == true) Caption("80 端口已用于网页管理。")
            if (list.isNotEmpty()) {
                Card(colors = CardDefaults.defaultColors(color = MiuixTheme.colorScheme.secondaryContainer)) {
                    for (item in list) {
                        ArrowRow("${item.first} → ${item.second}", "点按移除") { list = list - item }
                    }
                }
            }
            InputField("Tailnet 端口", port) { port = it.filter(Char::isDigit).take(5); error = "" }
            InputField("转发到", target) { target = it.trim(); error = "" }
            if (error.isNotEmpty()) Text(error, fontSize = 13.sp, color = Tone.danger)
            TextButton("添加一条", modifier = Modifier.fillMaxWidth(), onClick = {
                val number = port.toIntOrNull()
                val http = serveHttp.find(target)
                error = when {
                    number == null || number !in 1..65535 -> "端口必须是 1–65535"
                    number == 80 && entry?.webui == true -> "80 端口已用于网页管理"
                    list.any { it.first == number } -> "端口 $number 已存在"
                    http == null && !serveUnix.matches(target) -> "目标须为 http://IP:端口 或 unix:路径"
                    http != null && (http.groupValues[3].toIntOrNull() ?: 0) !in 1..65535 -> "目标端口无效"
                    else -> {
                        list = list + (number to target.removeSuffix("/"))
                        port = ""
                        target = "http://127.0.0.1:"
                        ""
                    }
                }
            })
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton("取消", onClick = onDismiss, modifier = Modifier.weight(1f))
                TextButton("保存并重启", modifier = Modifier.weight(1f), enabled = entry != null && list != entry.serve && state.busy.isEmpty(),
                    colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                        entry?.let { state.setServe(it.name, list) }
                        onDismiss()
                    })
            }
        }
    }
}

@Composable
private fun AddSheet(show: Boolean, onDismiss: () -> Unit) {
    val state = TailscaleState
    var name by remember(show) { mutableStateOf("Tailscale") }
    var hostname by remember(show) { mutableStateOf("mihomo-android") }
    var authKey by remember(show) { mutableStateOf("") }
    var error by remember(show) { mutableStateOf("") }
    Sheet(show = show, title = "添加 Tailscale", onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            InputField("出站名称", name) { name = it; error = "" }
            InputField("设备名（在 Tailnet 中显示）", hostname) { hostname = it; error = "" }
            InputField("Auth key（可选，留空用网页登录）", authKey) { authKey = it; error = "" }
            if (error.isNotEmpty()) Text(error, fontSize = 13.sp, color = Tone.danger)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton("取消", onClick = onDismiss, modifier = Modifier.weight(1f))
                TextButton(if (authKey.isBlank()) "添加并登录" else "添加", modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                    val trimmedName = name.trim()
                    val trimmedHost = hostname.trim()
                    when {
                        !trimmedName.matches(Regex("^[A-Za-z0-9_.-]{1,64}$")) -> error = "出站名称只能包含字母、数字、_ . -"
                        !trimmedHost.matches(Regex("^[A-Za-z0-9-]{1,63}$")) -> error = "设备名只能包含字母、数字与 -"
                        authKey.trim().contains(' ') -> error = "auth key 不能含空格"
                        else -> {
                            val values = mutableMapOf<String, JsonElement>("hostname" to JsonPrimitive(trimmedHost))
                            if (authKey.isNotBlank()) values["auth-key"] = JsonPrimitive(authKey.trim())
                            state.add(trimmedName, values)
                            onDismiss()
                        }
                    }
                })
            }
        }
    }
}

@Composable
private fun EditSheet(entry: TailscaleEntry?, onDismiss: () -> Unit) {
    val state = TailscaleState
    var values by remember(entry) { mutableStateOf<Map<String, JsonElement>>(emptyMap()) }
    var editing by remember(entry) { mutableStateOf<ConfigField?>(null) }
    Sheet(show = entry != null, title = entry?.name, onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            Card(colors = CardDefaults.defaultColors(color = MiuixTheme.colorScheme.secondaryContainer)) {
                for (field in entry?.fields.orEmpty()) {
                    val value = values[field.id] ?: field.value
                    val title = if (field.id in values) "${field.label} ·" else field.label
                    if (field.type == "bool") {
                        SwitchRow(title, (value as? JsonPrimitive)?.booleanOrNull ?: ((field.default as? JsonPrimitive)?.booleanOrNull ?: false),
                            field.summary.ifEmpty { null }) { values = values + (field.id to JsonPrimitive(it)) }
                    } else {
                        ArrowRow(title, field.summary.ifEmpty { null }, value = fieldDisplay(field, value)) { editing = field }
                    }
                }
            }
            Caption("已登录时修改 auth key 不会切换账号；要换账号请先退出登录。")
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton("取消", onClick = onDismiss, modifier = Modifier.weight(1f))
                TextButton("保存并重启", modifier = Modifier.weight(1f), enabled = values.isNotEmpty(), colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                    entry?.let { state.save(it.name, values) }
                    onDismiss()
                })
            }
        }
    }
    EditDialog(show = editing != null, title = editing?.label.orEmpty(),
        initial = editing?.let { field -> if (field.type == "secret") "" else fieldText(values[field.id] ?: field.value) }.orEmpty(),
        summary = editing?.let { field -> when (field.type) {
            "secret" -> "留空表示删除"
            "list" -> "一行一个，例如 192.168.1.0/24；留空表示删除"
            else -> field.summary.ifEmpty { null }
        } },
        multiline = editing?.type == "list",
        onDismiss = { editing = null }) { text ->
        val field = editing ?: return@EditDialog null
        val trimmed = text.trim()
        if (field.type == "list") {
            val list = trimmed.split('\n', ',').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
            list.firstOrNull { !it.matches(Regex("^[0-9A-Fa-f:.]+/[0-9]{1,3}$")) }?.let { return@EditDialog "网段格式无效：$it" }
            values = values + (field.id to (if (list.isEmpty()) JsonNull else JsonArray(list.map { JsonPrimitive(it) })))
            editing = null
            return@EditDialog null
        }
        if (field.id == "hostname" && !trimmed.matches(Regex("^[A-Za-z0-9-]{1,63}$"))) return@EditDialog "设备名只能包含字母、数字与 -"
        if (trimmed.contains(' ')) return@EditDialog "不能含空格"
        values = values + (field.id to (if (trimmed.isEmpty()) JsonNull else JsonPrimitive(trimmed)))
        editing = null
        null
    }
}

@Composable
private fun LoginSheet() {
    val state = TailscaleState
    val name = state.loginFor
    Sheet(show = name != null, title = "登录 Tailscale", onDismissRequest = { state.closeLogin() }) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (state.loginBusy) CircularProgressIndicator(size = 28.dp, strokeWidth = 3.dp)
            Text(state.loginMessage, fontSize = 14.sp, lineHeight = 20.sp, color = MiuixTheme.colorScheme.onSurface, modifier = Modifier.fillMaxWidth())
            if (state.loginUrl.isNotEmpty()) {
                if (state.loginQr.isNotEmpty()) QrCode(state.loginQr)
                Text("也可以在电脑或另一台手机上扫码登录", fontSize = 12.sp, color = Tone.muted)
                SelectionContainer {
                    Text(state.loginUrl, fontSize = 13.sp, color = MiuixTheme.colorScheme.primary, modifier = Modifier.fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp)).background(MiuixTheme.colorScheme.secondaryContainer).padding(12.dp))
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    TextButton("复制链接", onClick = { state.copy(state.loginUrl) }, modifier = Modifier.weight(1f))
                    TextButton("在浏览器打开", onClick = { state.open(state.loginUrl) }, modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.textButtonColorsPrimary())
                }
            }
            if (state.loginMissed && name != null) {
                TextButton("重启服务后重新获取", onClick = { state.startLogin(name, restart = true) }, enabled = !state.loginBusy,
                    modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.textButtonColorsPrimary())
            }
            TextButton("关闭", onClick = { state.closeLogin() }, modifier = Modifier.fillMaxWidth())
        }
    }
    DisposableEffect(Unit) { onDispose { state.closeLogin() } }
}

/** 二维码：始终白底黑块并留 4 格静区，深色主题下也能被扫码。 */
@Composable
private fun QrCode(rows: List<String>) {
    Box(Modifier.size(232.dp).clip(RoundedCornerShape(12.dp)).background(Color.White)) {
        Canvas(Modifier.size(232.dp)) {
            val count = rows.size
            val cell = size.minDimension / (count + 8)
            val origin = (size.minDimension - cell * count) / 2
            rows.forEachIndexed { y, row ->
                row.forEachIndexed { x, module ->
                    if (module == '1') drawRect(Color.Black, Offset(origin + x * cell, origin + y * cell), Size(cell + 0.6f, cell + 0.6f))
                }
            }
        }
    }
}
