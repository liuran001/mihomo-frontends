@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package mihomo

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Refresh

@JsFun("(value) => { const date = new Date(Number(value)); return Number.isFinite(date.getTime()) ? date.toLocaleString() : value; }")
private external fun messageTime(value: String): String

@Composable
fun EnhancedPage(onBack: () -> Unit, onNavigate: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var session by remember { mutableStateOf<JsonObject?>(null) }
    var battery by remember { mutableStateOf<JsonObject?>(null) }
    var hotspot by remember { mutableStateOf<JsonObject?>(null) }
    var messages by remember { mutableStateOf<List<JsonObject>?>(null) }
    var terminal by remember { mutableStateOf<JsonObject?>(null) }
    var busy by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var command by remember { mutableStateOf("") }
    var timeout by remember { mutableStateOf("15") }
    var configureHotspot by remember { mutableStateOf(false) }
    var showHotspotPassword by remember { mutableStateOf(false) }
    var confirmTerminal by remember { mutableStateOf(false) }
    var confirmHotspot by remember { mutableStateOf<Boolean?>(null) }
    var editScrcpyPort by remember { mutableStateOf(false) }
    var editScrcpyQuality by remember { mutableStateOf(false) }
    var confirmEnable by remember { mutableStateOf(false) }
    val unlocked = session?.boolean("unlocked") == true
    val idle = busy.isEmpty()

    fun operate(action: String, label: String, payload: JsonObject = json(), accept: (JsonObject) -> Unit = {}) {
        if (busy.isNotEmpty()) return
        busy = label
        error = ""
        notice = ""
        scope.launch {
            try {
                accept(request("enhanced", json("action" to action, "payload" to payload)))
                if (action != "status") session = request("enhanced", json("action" to "status"))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                error = failure.message ?: "设备操作失败"
                if (error.contains("操作密码") || error.contains("已锁定")) {
                    session = session?.let { JsonObject(it + json("unlocked" to false)) }
                    messages = null
                    terminal = null
                }
            } finally {
                busy = ""
            }
        }
    }

    LaunchedEffect(Unit) { operate("status", "读取增强状态…") { session = it } }
    // 解锁后自动读一次热点：状态、系统热点配置与已连接设备
    LaunchedEffect(unlocked, busy.isEmpty()) {
        if (unlocked && hotspot == null && busy.isEmpty()) operate("hotspot", "读取热点状态…") { hotspot = it }
    }
    DisposableEffect(Unit) {
        onDispose {
            password = ""
            messages = null
            terminal = null
            command = ""
        }
    }
    Page(title = "设备控制", navigationIcon = { BackIcon(onBack) }, actions = {
        BarAction(MiuixIcons.Regular.Refresh, "刷新增强状态", enabled = idle) { operate("status", "读取增强状态…") { session = it } }
    }) {
        banner(busy, BannerKind.Progress, "busy")
        banner(error, BannerKind.Error, "error")
        banner(notice, BannerKind.Success, "notice")
        val current = session ?: return@Page
        if (current.boolean("public_access")) item(key = "public") {
            Caption("当前允许公网来源访问。强烈建议仅在局域网或 Tailscale 使用增强功能。", Tone.warning)
        }
        if (!current.boolean("enabled")) {
            group("尚未启用", "disabled") {
                if (current.boolean("can_configure")) {
                    Caption("开启后在这里直接使用，无需密码，也不需要开启网页管理。")
                    ButtonRow { ActionButton("开启增强功能", primary = true, enabled = idle) { confirmEnable = true } }
                } else {
                    Caption("请在手机上的模块管理器里开启增强功能。")
                }
                ArrowRow("网页管理设置", "其它设备的浏览器使用增强功能需要开启网页管理并设置密码") { onNavigate("webui") }
            }
            return@Page
        }
        if (current.boolean("requires_main")) {
            group("需要主密码登录", "main-login") {
                Caption("其它设备使用设备控制须设置网页管理登录密码、要求密码访问，并用主密码登录；Tailnet 免密会话不能直接使用。")
                ButtonRow { ActionButton("使用主密码登录", primary = true) { enhancedLogin() } }
            }
            return@Page
        }
        if (!unlocked) {
            group("解锁设备控制", "unlock") {
                Caption("输入独立操作密码，解锁有效期 15 分钟。")
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    PasswordField("操作密码", password) { password = it }
                }
                ButtonRow {
                    ActionButton("解锁", primary = true, enabled = idle && password.isNotEmpty()) {
                        val entered = password
                        password = ""
                        operate("unlock", "验证操作密码…", json("password" to entered))
                    }
                }
            }
            return@Page
        }
        group(null, "access") {
            Caption("信息仅在点击时读取，不在后台轮询。离开页面后清除短信和终端显示内容。")
            // 管理器里不需要操作密码，也就不需要锁定
            if (current.boolean("has_password") && !current.boolean("can_configure")) ButtonRow {
                ActionButton("立即锁定", enabled = idle) {
                    messages = null
                    terminal = null
                    operate("lock", "锁定中…")
                }
            }
        }
        group("电量", "battery") {
            battery?.let { value ->
                InfoRow("剩余电量", value.string("percent") + "%", valueColor = Tone.success)
                InfoRow("电源", if (value.boolean("powered")) "已接通电源" else "使用电池")
                if (value.containsKey("temperature")) InfoRow("电池温度", value.string("temperature") + " °C")
            }
            ButtonRow { ActionButton("读取电量", enabled = idle) { operate("battery", "读取电量…") { battery = it } } }
        }
        group("最近短信", "sms") {
            Caption("仅按需读取最近 20 条，不发送或修改短信。短信可能含验证码，请妥善保管操作密码。")
            ButtonRow {
                ActionButton("读取最近短信", enabled = idle) { operate("sms", "读取短信…", json("limit" to 20)) { messages = it.objects("messages") } }
                if (messages != null) ActionButton("清除显示") { messages = null }
            }
            if (messages?.isEmpty() == true) Caption("暂无短信")
        }
        items(messages.orEmpty(), key = { "sms:" + it.string("id") }) { message ->
            Card(Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth()) {
                InfoRow(message.string("address"), if (message.string("type") == "1") "收到" else "发出", messageTime(message.string("date")))
                SelectionContainer { Caption(message.string("body")) }
            }
        }
        group("热点", "hotspot") {
            val status = hotspot
            val config = status?.get("config") as? JsonObject
            InfoRow("热点状态", when (status?.get("enabled")?.toString()) { "true" -> "开启"; "false" -> "关闭"; else -> "未读取" })
            status?.get("tethered")?.let { InfoRow("系统网络共享", if (it.toString() == "true") "已启用" else "未启用") }
            if (config != null) {
                // 系统保存的热点配置（与系统设置里看到的一致）
                InfoRow("名称", config.string("ssid").ifEmpty { "-" })
                val secret = config.string("password")
                val security = config.int("security")
                if (security != 0) InfoRow("密码", if (secret.isEmpty()) "-" else if (showHotspotPassword) secret else "••••••••",
                    if (secret.isEmpty()) null else "点按${if (showHotspotPassword) "隐藏" else "显示"}") { showHotspotPassword = !showHotspotPassword }
                InfoRow("加密", hotspotSecurityName(security))
                InfoRow("频段", hotspotBandName(config.int("band")), if (config.boolean("hidden")) "隐藏网络" else null)
                if (config.int("max_clients") > 0) InfoRow("最多连接", "${config.int("max_clients")} 台")
            }
            status?.string("config_error")?.takeIf { it.isNotEmpty() }?.let { Caption(it, Tone.warning) }
            val clients = status?.objects("clients")
            if (clients != null && status.boolean("tethered")) {
                InfoRow("已连接设备", "${clients.size} 台")
                for (client in clients) {
                    InfoRow(client.string("ipv4").ifEmpty { (client["ipv6"] as? kotlinx.serialization.json.JsonArray)?.firstOrNull()?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content } ?: "-" },
                        client.string("mac"), if (client.string("state") == "REACHABLE") "在线" else "最近在线")
                }
            }
            Caption("读取和修改的是系统热点设置（与系统设置里一致），ROM 不支持时会明确报错。开关热点可能断开当前连接；共享流量策略在「共享与数据面」设置。")
            ArrowRow("修改热点设置", "名称、密码、加密方式、频段；写入系统", enabled = idle && config != null) { configureHotspot = true }
            ButtonRow {
                ActionButton("刷新", enabled = idle) { operate("hotspot", "读取热点状态…") { hotspot = it } }
                ActionButton("开启", enabled = idle) { confirmHotspot = true }
                ActionButton("关闭", enabled = idle) { confirmHotspot = false }
            }
        }
        group("终端", "terminal") {
            Caption("以 root 执行命令；每次执行独立，最长 60 秒。不要在这里启动常驻服务。", Tone.warning)
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                InputField("命令", command, singleLine = false, minLines = 3, maxLines = 8, enabled = idle) { command = it }
                InputField("超时（秒）", timeout, enabled = idle) { timeout = it }
            }
            ButtonRow {
                ActionButton("执行命令", primary = true, enabled = idle && command.isNotBlank()) {
                    if (timeout.toIntOrNull() !in 1..60) error = "超时须为 1–60 秒" else confirmTerminal = true
                }
                if (terminal != null) ActionButton("清除输出") { terminal = null }
            }
            terminal?.let { result ->
                InfoRow("退出码", result.string("errno"))
                if (result.boolean("truncated")) Caption("输出超过限制，已截断。", Tone.warning)
                CodeBlock(result.string("stdout") + result.string("stderr").let { if (it.isEmpty()) "" else "\n$it" })
            }
        }
        group("web scrcpy", "scrcpy") {
            val builtin = current.string("scrcpy_mode", "builtin") == "builtin"
            val service = current["screen_service"] as? JsonObject
            SwitchRow("允许屏幕控制入口", current.boolean("scrcpy"), "页面与实时连接均经 WebUI 转发；关闭后断开正在使用的连接", enabled = idle) {
                operate("scrcpy-set", "保存屏幕入口…", json("enabled" to it))
            }
            SwitchRow("使用内置屏幕服务", builtin, "随模块安装，无需 Node、ADB 或另装 ws-scrcpy；更改后停止当前屏幕会话", enabled = idle) {
                operate("scrcpy-set", "切换屏幕服务…", json("mode" to if (it) "builtin" else "external"))
            }
            if (builtin) {
                InfoRow("内置 scrcpy", if (service?.boolean("installed") == true) "已安装 ${service.string("version")}" else "未安装，请重新安装完整模块")
                InfoRow("服务状态", if (service?.boolean("running") == true) "正在使用" else "已停止，不占用录屏资源")
                if (service?.string("last_error")?.isNotEmpty() == true) Caption(service.string("last_error"), Tone.warning)
                ArrowRow("画质与资源限制", "修改后重新连接生效", value = "${current.string("scrcpy_max_size", "1280")} / ${current.string("scrcpy_fps", "24")} fps", enabled = idle) { editScrcpyQuality = true }
                Caption("打开后点击「开始连接」才启动录屏；隐藏、关闭页面或退出登录后停止。一次只允许一个会话，最长 15 分钟，无音频，不常驻、不自动重启。")
            } else {
                ArrowRow("本机服务端口", "外部服务只应监听 127.0.0.1", value = current.string("scrcpy_port", "8080"), enabled = idle) { editScrcpyPort = true }
                Caption("兼容已有 ws-scrcpy：设置 WS_SCRCPY_PATHNAME=/enhanced/scrcpy/。外部模式仅管理代理入口，不接管其他服务进程。")
            }
            if (current.boolean("scrcpy")) ButtonRow {
                ActionButton("打开屏幕控制", primary = true, enabled = idle) {
                    scope.launch {
                        try {
                            val url = request("scrcpyUrl").string("url")
                            Dashboard.openUrl(url) { error = it }
                        } catch (failure: Exception) { error = failure.message ?: "无法打开屏幕控制" }
                    }
                }
                if (builtin && service?.boolean("running") == true) ActionButton("停止屏幕服务", enabled = idle) {
                    operate("scrcpy-stop", "停止屏幕服务…") { notice = "已请求停止屏幕会话" }
                }
            }
        }
    }
    ConfirmDialog(confirmEnable, "开启增强功能",
        "可读取短信、管理热点、执行 root 终端命令。在管理器里直接使用；其它设备的浏览器还需开启网页管理并用密码登录。",
        confirm = "开启", danger = true, onDismiss = { confirmEnable = false }) {
        confirmEnable = false
        if (busy.isEmpty()) {
            busy = "开启增强功能…"
            error = ""
            scope.launch {
                try {
                    request("enhancedSet", json("settings" to json("enabled" to true)))
                    session = request("enhanced", json("action" to "status"))
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    error = failure.message ?: "开启失败"
                } finally {
                    busy = ""
                }
            }
        }
    }
    ConfirmDialog(confirmTerminal, "执行 root 命令", "命令会直接修改本机，确认内容无误后执行。", confirm = "执行", danger = true,
        onDismiss = { confirmTerminal = false }) {
        confirmTerminal = false
        operate("terminal", "执行命令…", json("command" to command, "timeout" to (timeout.toIntOrNull() ?: 15))) { terminal = it }
    }
    ConfirmDialog(confirmHotspot != null, "${if (confirmHotspot == true) "开启" else "关闭"}热点", "操作可能断开当前 Wi-Fi 连接。", confirm = "继续", danger = true,
        onDismiss = { confirmHotspot = null }) {
        val enabled = confirmHotspot == true
        confirmHotspot = null
        operate("hotspot-set", "设置热点…", json("enabled" to enabled)) { hotspot = it; notice = if (enabled) "热点已开启" else "热点已关闭" }
    }
    HotspotDialog(configureHotspot, hotspot?.get("config") as? JsonObject, { configureHotspot = false }) { config ->
        configureHotspot = false
        operate("hotspot-set", "写入系统热点设置…", json("config" to config)) {
            hotspot = it
            notice = if (it.boolean("enabled")) "热点设置已写入系统；部分系统需关闭再开启热点后生效" else "热点设置已写入系统"
        }
    }
    EditDialog(editScrcpyPort, "web scrcpy 端口", session?.string("scrcpy_port", "8080") ?: "8080", summary = "指向本机已安装的 ws-scrcpy 服务，不能与 WebUI 端口相同。", onDismiss = { editScrcpyPort = false }) { value ->
        val port = value.toIntOrNull()
        if (port == null || port !in 1..65535) return@EditDialog "端口须为 1–65535"
        editScrcpyPort = false
        operate("scrcpy-set", "保存屏幕服务端口…", json("enabled" to (session?.boolean("scrcpy") == true), "port" to port))
        null
    }
    EditDialog(editScrcpyQuality, "屏幕画质", "${session?.string("scrcpy_max_size", "1280") ?: "1280"},${session?.string("scrcpy_fps", "24") ?: "24"},${session?.string("scrcpy_bit_rate", "2000000") ?: "2000000"}",
        summary = "最长边 640–1920、帧率 5–60、码率 256000–8000000，以英文逗号分隔。建议 1280,24,2000000；更低参数更省电。", onDismiss = { editScrcpyQuality = false }) { value ->
        val parts = value.split(',').map { it.trim().toIntOrNull() }
        if (parts.size != 3 || parts[0] !in 640..1920 || parts[1] !in 5..60 || parts[2] !in 256000..8000000) return@EditDialog "请输入有效的最长边、帧率和码率"
        editScrcpyQuality = false
        operate("scrcpy-set", "保存屏幕画质…", json("max_size" to parts[0], "fps" to parts[1], "bit_rate" to parts[2]))
        null
    }
}

internal fun hotspotSecurityName(type: Int): String = when (type) {
    0 -> "开放（无密码）"
    1 -> "WPA2-Personal"
    2 -> "WPA2/WPA3-Personal"
    3 -> "WPA3-Personal"
    else -> "其它"
}

internal fun hotspotBandName(band: Int): String {
    val names = listOfNotNull(if (band and 1 != 0) "2.4 GHz" else null, if (band and 2 != 0) "5 GHz" else null,
        if (band and 4 != 0) "6 GHz" else null, if (band and 8 != 0) "60 GHz" else null)
    return names.joinToString(" + ").ifEmpty { "-" }
}

private fun JsonObject.int(key: String): Int = string(key).toDoubleOrNull()?.toInt() ?: -1

/** 修改系统热点设置：以系统当前配置为初值；密码留空则不改；只提交改动过的项。 */
@Composable
private fun HotspotDialog(show: Boolean, current: JsonObject?, onDismiss: () -> Unit, onSave: (JsonObject) -> Unit) {
    val initialSsid = current?.string("ssid").orEmpty()
    val initialSecurity = current?.int("security")?.takeIf { it in 0..3 } ?: 1
    val initialBand = current?.int("band") ?: 1
    val initialHidden = current?.boolean("hidden") == true
    val bands = listOf(1, 2, 3)
    var ssid by remember(show) { mutableStateOf(initialSsid) }
    var password by remember(show) { mutableStateOf("") }
    var security by remember(show) { mutableStateOf(initialSecurity) }
    // 系统当前是 6 GHz 等本页不提供的频段时，默认保持不变
    var band by remember(show) { mutableStateOf(initialBand.takeIf { it in bands } ?: 0) }
    var hidden by remember(show) { mutableStateOf(initialHidden) }
    var error by remember(show) { mutableStateOf("") }
    Dialog(show, "热点设置", "写入系统热点设置；密码留空则保持不变。", onDismissRequest = onDismiss) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            InputField("热点名称", ssid) { ssid = it }
            DropdownRow("加密", listOf("WPA2-Personal", "WPA2/WPA3-Personal", "WPA3-Personal", "开放（无密码）"),
                listOf(1, 2, 3, 0).indexOf(security).coerceAtLeast(0)) { security = listOf(1, 2, 3, 0)[it] }
            if (security != 0) PasswordField(if (initialSecurity == 0) "密码" else "新密码（留空不变）", password) { password = it }
            val bandOptions = (if (band == 0) listOf("保持不变（${hotspotBandName(initialBand)}）") else emptyList()) + listOf("2.4 GHz", "5 GHz", "2.4 + 5 GHz")
            val bandValues = (if (band == 0) listOf(0) else emptyList()) + bands
            DropdownRow("频段", bandOptions, bandValues.indexOf(band).coerceAtLeast(0)) { band = bandValues[it] }
            SwitchRow("隐藏网络", hidden, "不广播名称，需手动输入才能连接") { hidden = it }
            if (error.isNotEmpty()) Text(error, color = Tone.danger, fontSize = 13.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton("取消", onClick = onDismiss, modifier = Modifier.weight(1f))
                TextButton("写入", modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                    error = when {
                        ssid.encodeToByteArray().size !in 1..32 || ssid.any { it == '\n' || it == '\r' || it == '\u0000' } -> "名称须为 1–32 字节"
                        password.isNotEmpty() && (password.length !in 8..63 || password.any { it.code !in 32..126 }) -> "密码须为 8–63 个 ASCII 字符"
                        security != 0 && password.isEmpty() && initialSecurity == 0 -> "从开放改为加密需要设置密码"
                        else -> {
                            val changes = mutableListOf<Pair<String, Any?>>()
                            if (ssid != initialSsid) changes += "ssid" to ssid
                            if (security != initialSecurity || password.isNotEmpty()) changes += "security" to security
                            if (security != 0 && password.isNotEmpty()) changes += "password" to password
                            if (band != 0 && band != initialBand) changes += "band" to band
                            if (hidden != initialHidden) changes += "hidden" to hidden
                            if (changes.isEmpty()) { onDismiss(); "" } else { onSave(json(*changes.toTypedArray())); "" }
                        }
                    }
                })
            }
        }
    }
}
