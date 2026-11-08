package mihomo

// 网页管理：mihomo-webd 在局域网 / Tailnet 上提供与这里相同的界面，类似 OpenWrt 的 LuCI。
// 设置保存在 webui.json（webui.sh set），服务会自动重新读取；只有端口与局域网监听变化时才重启服务。
// Tailnet 访问经内核 tailscale serve 转发到 root 才能连接的 unix socket，开关时同时修改内核配置。

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Refresh
import top.yukonga.miuix.kmp.theme.MiuixTheme

internal data class WebUiSettings(
    val enabled: Boolean = false,
    val port: Int = 9099,
    val lan: Boolean = false,
    val allowCidrs: List<String> = emptyList(),
    val requirePassword: Boolean = true,
    val tailscale: Boolean = false,
    val tailscaleNoPassword: Boolean = false,
    val tailscaleUsers: List<String> = emptyList(),
    val sessionHours: Int = 168,
    val hasPassword: Boolean = false,
    val enhanced: Boolean = false,
    val operationPassword: Boolean = false,
    val publicAccess: Boolean = false,
)

private fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

private fun JsonObject.int(key: String, default: Int): Int = (this[key] as? JsonPrimitive)?.intOrNull ?: default

private fun JsonObject.webUiSettings(): WebUiSettings = WebUiSettings(
    enabled = boolean("enabled"), port = int("port", 9099), lan = boolean("lan"), allowCidrs = strings("allow_cidrs"),
    requirePassword = boolean("require_password", true), tailscale = boolean("tailscale"),
    tailscaleNoPassword = boolean("tailscale_no_password"), tailscaleUsers = strings("tailscale_users"),
    sessionHours = int("session_hours", 168), hasPassword = boolean("has_password"),
    enhanced = (this["enhanced"] as? JsonObject)?.boolean("enabled") == true,
    operationPassword = (this["enhanced"] as? JsonObject)?.boolean("has_password") == true,
    publicAccess = boolean("public_access"),
)

private fun strings(values: List<String>): JsonArray = JsonArray(values.map { JsonPrimitive(it) })

internal object WebUiState {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    var loaded by mutableStateOf(false)
    var installed by mutableStateOf(true)
    var running by mutableStateOf(false)
    var settings by mutableStateOf(WebUiSettings())
    var addrs by mutableStateOf<List<Pair<String, String>>>(emptyList())
    var busy by mutableStateOf("")
    var error by mutableStateOf("")
    var notice by mutableStateOf("")

    // 当前页面是否经网页管理打开
    var remote by mutableStateOf(false)
    var via by mutableStateOf("")
    var login by mutableStateOf("")
    var sessionError by mutableStateOf("")
    var sessionLoaded by mutableStateOf(false)
    private var sessionLoading = false

    fun load() {
        if (busy.isNotEmpty()) return
        run("读取设置…") { refresh() }
        TailscaleState.load(force = true)
        if (!sessionLoading) {
            sessionLoading = true
            sessionError = ""
            scope.launch {
                try {
                    val session = request("webuiSession")
                    remote = session.boolean("remote")
                    via = session.string("via")
                    login = session.string("login")
                    sessionLoaded = true
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    sessionError = failure.message ?: "无法读取当前会话"
                } finally {
                    sessionLoading = false
                }
            }
        }
    }

    // 最近一次服务端返回的原始设置；开关先在本地生效，保存失败时回退
    private var raw = JsonObject(emptyMap())
    private val saveLock = kotlinx.coroutines.sync.Mutex()
    var pending by mutableStateOf(0)
        private set

    private fun accept(status: JsonObject, settingsToo: Boolean = true) {
        installed = status.boolean("installed")
        running = status.boolean("running")
        val values = status["settings"] as? JsonObject
        if (values != null && settingsToo) {
            raw = values
            settings = values.webUiSettings()
            addrs = values.objects("addrs").map { it.string("iface") to it.string("addr") }
        }
        loaded = true
    }

    private suspend fun refresh() = accept(request("webuiStatus"))

    private fun run(label: String, block: suspend () -> Unit) {
        if (busy.isNotEmpty()) return
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

    private suspend fun save(values: Map<String, JsonElement>) {
        accept(request("webuiSet", JsonObject(mapOf("settings" to JsonObject(values)))))
    }

    /** 开关类设置：界面立即切换，后台依次保存；只有最后一个请求的结果覆盖界面，失败时回退。 */
    fun set(values: Map<String, JsonElement>, message: String = "已保存", after: (() -> Unit)? = null) {
        notice = ""
        error = ""
        val before = raw
        raw = JsonObject(raw + values)
        settings = raw.webUiSettings()
        pending++
        scope.launch {
            try {
                saveLock.withLock {
                    val status = request("webuiSet", JsonObject(mapOf("settings" to JsonObject(values))))
                    accept(status, settingsToo = pending == 1)
                }
                notice = message
                after?.invoke()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                raw = before
                settings = before.webUiSettings()
                error = failure.message ?: "保存失败"
            } finally {
                pending--
            }
        }
    }

    fun set(key: String, value: JsonElement, message: String = "已保存") = set(mapOf(key to value), message)

    /** 密码只在经 Tailnet 访问且没有开启账号免密时强制；本机与局域网没有密码时自动免密。 */
    fun setEnabled(enabled: Boolean) {
        if (enabled && settings.tailscale && !settings.tailscaleNoPassword && !settings.hasPassword) {
            error = "已允许 Tailnet 访问：请先设置登录密码，或开启「Tailnet 账号免密」"
            return
        }
        val values = mutableMapOf<String, JsonElement>("enabled" to JsonPrimitive(enabled))
        val passwordless = enabled && !settings.hasPassword && settings.requirePassword
        if (passwordless) values["require_password"] = JsonPrimitive(false)
        set(values, when {
            !enabled -> "已停止"
            passwordless -> "已启动；没有设置密码，本机与局域网可直接访问"
            else -> "已启动"
        })
    }

    fun setPassword(password: String) {
        notice = ""
        run("保存密码…") {
            request("webuiPasswd", json("password" to password))
            refresh()
            notice = if (password.isEmpty()) "已清除密码" else "已设置密码；已登录的浏览器需要重新登录"
        }
    }

    fun setEnhanced(values: JsonObject) {
        notice = ""
        run("保存增强设置…") {
            check(sessionLoaded && !remote) { "请在本机模块 WebUI 中修改增强设置" }
            accept(request("enhancedSet", json("settings" to values)))
            notice = "增强设置已保存"
        }
    }

    /** Tailnet 访问：同时改网页管理设置与内核配置（serve 只挂在一个 Tailscale 出站上）。 */
    fun setTailscale(enabled: Boolean, outbound: String?) {
        notice = ""
        run(if (enabled) "开启 Tailnet 访问…" else "关闭 Tailnet 访问…") {
            if (enabled && outbound == null) error("先在 Tailscale 页添加并登录一个 Tailscale 出站")
            val name = outbound ?: TailscaleState.entries.firstOrNull { it.webui }?.name
            save(mapOf("tailscale" to JsonPrimitive(enabled)))
            if (name != null) {
                val current = TailscaleState.entries.firstOrNull { it.name == name }?.webui == true
                if (current != enabled) TailscaleState.setWebui(name, enabled)
            }
            notice = if (enabled) "已开启；在 Tailnet 里的设备上访问 http://设备名/" else "已关闭 Tailnet 访问"
        }
    }

    fun logout() {
        scope.launch {
            try {
                request("webuiLogout")
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                error = failure.message ?: "退出失败"
            }
        }
    }
}

/** 一键打开 zashboard：带 setup 参数，面板会自动添加并连接本机控制器。 */
internal object Dashboard {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    var opening by mutableStateOf(false)
    var upgrading by mutableStateOf(false)

    fun openUrl(url: String, onError: (String) -> Unit) {
        scope.launch {
            try {
                request("openUrl", json("url" to url))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                onError(failure.message ?: "无法打开浏览器")
            }
        }
    }

    /** 让内核重新下载面板（external-ui-url），完成后刷新浏览器里的面板即可。 */
    fun upgrade(onDone: (String) -> Unit, onError: (String) -> Unit) {
        if (upgrading) return
        upgrading = true
        scope.launch {
            try {
                request("dashboardUpgrade")
                onDone("面板已更新，浏览器里刷新一下即可")
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                onError("更新面板失败：" + (failure.message ?: "未知错误"))
            } finally {
                upgrading = false
            }
        }
    }

    fun open(onError: (String) -> Unit) {
        if (opening) return
        opening = true
        scope.launch {
            try {
                val result = request("dashboard")
                if (!result.boolean("available")) {
                    onError(result.string("reason").ifEmpty { "面板未启用" } + "：在「内核配置 › 控制器与面板」里填写面板目录与下载地址")
                } else {
                    request("openUrl", json("url" to result.string("url")))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                onError(failure.message ?: "无法打开面板")
            } finally {
                opening = false
            }
        }
    }
}

private val cidrPattern = Regex("^[0-9A-Fa-f:.]+/[0-9]{1,3}$")
private val loginPattern = Regex("^[^\\s,]{1,254}$")

@Composable
fun WebUiPage(onBack: () -> Unit, onNavigate: (String) -> Unit) {
    val state = WebUiState
    val ts = TailscaleState
    val current = state.settings
    var editPort by remember { mutableStateOf(false) }
    var editCidrs by remember { mutableStateOf(false) }
    var editUsers by remember { mutableStateOf(false) }
    var editHours by remember { mutableStateOf(false) }
    var editPassword by remember { mutableStateOf(false) }
    var clearPassword by remember { mutableStateOf(false) }
    var confirmDisable by remember { mutableStateOf(false) }
    var confirmEnhanced by remember { mutableStateOf(false) }
    var editOperationPassword by remember { mutableStateOf(false) }
    var clearOperationPassword by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { state.load() }
    val idle = state.busy.isEmpty()
    val tailscaleIdle = idle && ts.busy.isEmpty()
    // 开关在保存期间仍可操作；端口、密码等弹窗类操作等保存完成
    val quiet = idle && state.pending == 0
    Page(title = "网页管理", navigationIcon = { BackIcon(onBack) }, actions = {
        BarAction(MiuixIcons.Regular.Refresh, "重新读取", enabled = idle) { state.load() }
    }) {
        banner(state.busy.ifEmpty { if (state.pending > 0) "保存中…" else "" }, BannerKind.Progress, "busy")
        banner(state.error, BannerKind.Error, "error")
        banner(state.sessionError, BannerKind.Error, "session-error")
        banner(state.notice, BannerKind.Success, "notice")
        if (!state.loaded) return@Page
        if (!state.installed) {
            item(key = "missing") { Caption("模块里缺少 mihomo-webd，请重新安装完整的模块包。", Tone.warning) }
            return@Page
        }
        if (state.remote) {
            group("当前会话", "session") {
                InfoRow("访问方式", when (state.via) { "tailscale" -> "Tailnet"; "lan" -> "局域网"; "local" -> "本机"; else -> state.via })
                if (state.login.isNotEmpty()) InfoRow("Tailscale 账号", state.login)
                ButtonRow(Modifier.padding(top = 4.dp)) { ActionButton("退出登录") { state.logout() } }
            }
        }
        group(null, "main") {
            SwitchRow("启用网页管理", current.enabled, "在电脑或其它手机的浏览器里管理模块，功能与这里相同", enabled = idle) {
                if (!it && state.remote) confirmDisable = true else state.setEnabled(it)
            }
            InfoRow("服务状态", when {
                state.pending > 0 && current.enabled != state.running -> if (current.enabled) "启动中…" else "停止中…"
                // 只开增强功能时服务也在运行，但不监听网页端口
                !current.enabled -> "未启用"
                state.running -> "运行中"
                else -> "未运行"
            }, valueColor = if (state.running && current.enabled) Tone.success else Tone.muted)
            ArrowRow("端口", "改动后服务会重启", value = current.port.toString(), enabled = quiet) { editPort = true }
        }
        group("登录", "login") {
            ArrowRow("登录密码", "至少 6 个字符；修改后所有已登录的浏览器需要重新登录",
                value = if (current.hasPassword) "已设置" else "未设置", enabled = quiet) { editPassword = true }
            if (current.hasPassword) ArrowRow("清除密码", "清除后本机与局域网免密访问；Tailnet 只能用账号免密访问", enabled = quiet) { clearPassword = true }
            SwitchRow("本机和局域网访问需要密码", current.requirePassword && current.hasPassword,
                if (!current.hasPassword) "设置密码后才能开启"
                else if (current.enhanced) "关闭后本机应用和同一网络里的设备都能直接管理，但其它设备不能再用增强功能"
                else "关闭后本机应用和同一网络里的设备都能直接管理", enabled = idle && current.hasPassword) {
                state.set("require_password", JsonPrimitive(it))
            }
            ArrowRow("登录有效期", "超过后需要重新输入密码", value = "${current.sessionHours} 小时", enabled = quiet) { editHours = true }
        }
        group("增强功能", "enhanced") {
            SwitchRow("启用增强功能", current.enhanced,
                when {
                    !state.sessionLoaded -> "正在确认访问方式"
                    state.remote -> "只能在手机的模块管理器 WebUI 中开启或关闭"
                    else -> "短信、电量、热点、终端；不依赖网页管理，在管理器里直接使用无需密码"
                }, enabled = quiet && state.sessionLoaded && !state.remote) {
                if (it) confirmEnhanced = true else state.setEnhanced(json("enabled" to false))
            }
            if (current.publicAccess) Caption("当前允许公网来源访问。强烈建议仅在局域网或 Tailscale 开启增强功能；终端和屏幕控制拥有本机管理权限。", Tone.warning)
            if (current.enhanced) {
                if (!(current.enabled && current.hasPassword && current.requirePassword)) {
                    Caption("其它设备的浏览器要用增强功能，需开启网页管理、设置登录密码并要求密码访问；在管理器里不受影响。")
                }
                ArrowRow("操作密码", if (current.operationPassword) "仅用于其它设备的浏览器，解锁后 15 分钟失效；管理器里不需要" else "其它设备未设置时使用已验证的主 WebUI 会话；管理器里不需要",
                    value = if (current.operationPassword) "独立密码" else "使用主密码", enabled = quiet && state.sessionLoaded && !state.remote) { editOperationPassword = true }
                if (current.operationPassword) ArrowRow("清除操作密码", "仍然必须通过主 WebUI 密码登录", enabled = quiet && state.sessionLoaded && !state.remote) { clearOperationPassword = true }
                ArrowRow("打开设备控制", "查看设备信息、短信与终端") { onNavigate("enhanced") }
            }
        }
        group("局域网", "lan") {
            SwitchRow("允许局域网访问", current.lan, "关闭时只监听本机 127.0.0.1", enabled = idle) {
                state.set("lan", JsonPrimitive(it), if (it) "已允许局域网访问" else "已关闭局域网访问")
            }
            if (current.lan) {
                ArrowRow("允许的网段", "来源地址不在这些网段内时拒绝访问",
                    value = if (current.allowCidrs.isEmpty()) "所有私网地址" else current.allowCidrs.joinToString("、"), enabled = quiet) { editCidrs = true }
            }
        }
        if (current.lan && current.enabled) {
            item(key = "addrs") {
                val links = state.addrs.filter { (_, addr) -> !addr.startsWith("100.") && !addr.startsWith("fd7a:") }
                    .map { (iface, addr) -> iface to "http://${if (':' in addr) "[$addr]" else addr}:${current.port}/" }
                if (links.isNotEmpty()) {
                    Column(Modifier.padding(bottom = 12.dp)) {
                        SmallTitleText("访问地址")
                        SelectionContainer {
                            Column(Modifier.padding(horizontal = 28.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                for ((iface, link) in links) {
                                    Text("$link  ($iface)", fontSize = 13.sp, color = MiuixTheme.colorScheme.primary)
                                }
                            }
                        }
                    }
                }
            }
        }
        group("Tailscale", "tailscale") {
            if (ts.busy.isNotEmpty()) Caption(ts.busy)
            if (ts.error.isNotEmpty()) Caption(ts.error, Tone.warning)
            val published = ts.entries.firstOrNull { it.webui }
            val target = published ?: ts.entries.firstOrNull { it.loggedIn } ?: ts.entries.firstOrNull()
            SwitchRow("允许 Tailnet 访问", current.tailscale && published != null,
                if (target == null) "需要先添加 Tailscale 出站" else "经 ${target.name} 发布到本机的 Tailnet 地址，会重启内核",
                enabled = tailscaleIdle && ts.error.isEmpty() && target != null) { state.setTailscale(it, target?.name) }
            if (target == null) {
                ArrowRow("添加 Tailscale", enabled = tailscaleIdle) { onNavigate("tailscale") }
            } else if (current.tailscale) {
                val host = target.fields.firstOrNull { it.id == "hostname" }?.let { fieldText(it.value) }.orEmpty()
                if (host.isNotEmpty()) InfoRow("访问地址", "http://$host/")
                if (!target.loggedIn) Caption("${target.name} 还没有登录 Tailscale，登录后才能从 Tailnet 访问", Tone.warning)
                SwitchRow("Tailnet 账号免密", current.tailscaleNoPassword,
                    "按 Tailscale 身份直接登录；带标签的设备（tagged）没有账号身份，仍需要密码", enabled = tailscaleIdle) {
                    state.set("tailscale_no_password", JsonPrimitive(it))
                }
                ArrowRow("允许的账号", "只允许这些 Tailscale 登录名访问",
                    value = if (current.tailscaleUsers.isEmpty()) "Tailnet 里的所有账号" else current.tailscaleUsers.joinToString("、"),
                    enabled = tailscaleIdle) { editUsers = true }
            }
        }
        item(key = "note") {
            if (current.enabled && !(current.requirePassword && current.hasPassword)) {
                Caption("当前免密：本机任何应用${if (current.lan) "和同一网络里的任何设备" else ""}都能以 root 权限管理本模块。只在可信环境下这样用，建议设置密码。", Tone.warning)
            } else {
                Caption("网页管理的权限与本应用相同（root），只在可信网络中开启，并设置足够长的密码。")
            }
        }
    }
    EditDialog(show = editPort, title = "端口", initial = current.port.toString(), summary = "1024–65535",
        onDismiss = { editPort = false }) { text ->
        val port = text.trim().toIntOrNull()
        if (port == null || port !in 1024..65535) return@EditDialog "请输入 1024–65535 之间的端口"
        editPort = false
        if (port != current.port) state.set("port", JsonPrimitive(port), "已保存，服务正在重启")
        null
    }
    EditDialog(show = editHours, title = "登录有效期（小时）", initial = current.sessionHours.toString(), summary = "1–8760",
        onDismiss = { editHours = false }) { text ->
        val hours = text.trim().toIntOrNull()
        if (hours == null || hours !in 1..8760) return@EditDialog "请输入 1–8760 之间的整数"
        editHours = false
        if (hours != current.sessionHours) state.set("session_hours", JsonPrimitive(hours))
        null
    }
    EditDialog(show = editCidrs, title = "允许的网段", initial = current.allowCidrs.joinToString("\n"),
        summary = "一行一个，例如 192.168.1.0/24；留空表示所有私网地址", multiline = true,
        onDismiss = { editCidrs = false }) { text ->
        val list = text.split('\n', ',').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        list.firstOrNull { !cidrPattern.matches(it) }?.let { return@EditDialog "网段格式无效：$it" }
        if (list.size > 64) return@EditDialog "最多 64 个网段"
        editCidrs = false
        state.set("allow_cidrs", strings(list))
        null
    }
    val suggestion = TailscaleState.entries.map { it.login }.filter { it.isNotEmpty() }.distinct()
    EditDialog(show = editUsers, title = "允许的账号", initial = current.tailscaleUsers.joinToString("\n"),
        summary = "一行一个登录名，留空表示 Tailnet 里的所有账号" + if (suggestion.isEmpty()) "" else "；本机登录的是 ${suggestion.joinToString("、")}",
        multiline = true, onDismiss = { editUsers = false }) { text ->
        val list = text.split('\n', ',').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        list.firstOrNull { !loginPattern.matches(it) }?.let { return@EditDialog "登录名无效：$it" }
        if (list.size > 64) return@EditDialog "最多 64 个账号"
        editUsers = false
        state.set("tailscale_users", strings(list))
        null
    }
    PasswordDialog(editPassword, onDismiss = { editPassword = false }) { password ->
        editPassword = false
        state.setPassword(password)
    }
    PasswordDialog(editOperationPassword, title = "设置独立操作密码", onDismiss = { editOperationPassword = false }) { password ->
        editOperationPassword = false
        state.setEnhanced(json("password" to password))
    }
    ConfirmDialog(show = confirmEnhanced, title = "开启增强功能",
        summary = "在管理器里可直接读取短信、管理热点、执行 root 终端命令；开启网页管理并设置密码后，已登录的浏览器也能使用。强烈建议仅在局域网或 Tailscale 使用。" +
            if (current.publicAccess) "当前允许公网访问，请先检查允许的网段。" else "可设置独立操作密码。",
        confirm = "开启", danger = true, onDismiss = { confirmEnhanced = false }) {
        confirmEnhanced = false
        state.setEnhanced(json("enabled" to true))
    }
    ConfirmDialog(show = clearOperationPassword, title = "清除操作密码", summary = "设备控制将仅要求主 WebUI 密码登录。",
        confirm = "清除", danger = true, onDismiss = { clearOperationPassword = false }) {
        clearOperationPassword = false
        state.setEnhanced(json("password" to ""))
    }
    ConfirmDialog(show = confirmDisable, title = "停止网页管理",
        summary = "当前页面正是经网页管理打开的，停止后会立即断开，之后只能在手机上的管理器里重新开启。",
        confirm = "停止", danger = true, onDismiss = { confirmDisable = false }) {
        confirmDisable = false
        state.setEnabled(false)
    }
    ConfirmDialog(show = clearPassword, title = "清除密码",
        summary = (if (current.enhanced) "其它设备将不能使用增强功能，web scrcpy 入口一并关闭（管理器里照常可用）。" else "") + "清除后本机应用${if (current.lan) "和局域网设备" else ""}无需密码即可管理；" +
            if (current.tailscale && !current.tailscaleNoPassword) "Tailnet 设备将无法登录，直到重新设置密码。" else "建议只在可信环境下这样用。",
        confirm = "清除", danger = true, onDismiss = { clearPassword = false }) {
        clearPassword = false
        state.setPassword("")
    }
}

@Composable
private fun SmallTitleText(text: String) {
    top.yukonga.miuix.kmp.basic.SmallTitle(text)
}

@Composable
internal fun PasswordDialog(show: Boolean, title: String = "设置登录密码", onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var first by remember(show) { mutableStateOf("") }
    var second by remember(show) { mutableStateOf("") }
    var error by remember(show) { mutableStateOf("") }
    Dialog(show = show, title = title, summary = "6–256 个字符", onDismissRequest = onDismiss) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            PasswordField("新密码", first) { first = it; error = "" }
            PasswordField("再输入一次", second) { second = it; error = "" }
            if (error.isNotEmpty()) Text(error, fontSize = 13.sp, color = Tone.danger)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton(text = "取消", onClick = onDismiss, modifier = Modifier.weight(1f))
                TextButton(text = "保存", modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                    error = when {
                        first.length !in 6..256 -> "密码须为 6–256 个字符"
                        first != second -> "两次输入不一致"
                        else -> { onSave(first); "" }
                    }
                })
            }
        }
    }
}

@Composable
internal fun PasswordField(label: String, value: String, onChange: (String) -> Unit) {
    NativeField(label, value, password = true, onChange = onChange)
}
