package mihomo

// 首次启动向导：检测本机 » 选择配置来源（订阅链接 / 内置模板 / 粘贴） »  按本机情况优化 » 运行偏好 » 应用。
// 订阅链接下载后自动识别：完整配置走「导入 + 优化」，节点订阅走「内置模板」；有多个订阅时直接选「内置模板」逐个填写。

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import top.yukonga.miuix.kmp.basic.BasicComponent
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Checkbox
import top.yukonga.miuix.kmp.basic.CircularProgressIndicator
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.LinearProgressIndicator
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Close
import top.yukonga.miuix.kmp.icon.extended.Ok
import top.yukonga.miuix.kmp.theme.MiuixTheme

private fun JsonObject.setupBoolean(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: error("后台缺少有效的 $key")

/** 只保留 policySet 接受的字段。 */
private fun JsonObject.setupPolicy(): JsonObject {
    setupBoolean("autostart")
    setupBoolean("tethering")
    for (name in listOf("tethering_interfaces", "bypass_packages", "wifi_mode", "wifi_ssids")) {
        require((this[name] as? JsonPrimitive)?.isString == true) { "策略缺少 $name，未覆盖设置" }
    }
    return JsonObject(filterKeys { it !in setOf("ok", "current_ssid", "allowed") })
}

private fun setupUrl(value: String): String {
    val text = value.trim()
    require(Regex("https?://[^/\\s?#]+(?:[/?#]\\S*)?").matches(text)) { "请输入 http:// 或 https:// 开头的链接" }
    return text
}

internal enum class SetupSource { Subscription, Template, Paste }

internal data class SetupSub(val name: String = "", val url: String = "", val ua: String = "")

internal const val MAX_SETUP_SUBS = 32

/** 内置模板的订阅行：忽略整行为空的行，名称留空时按行号补「订阅N」（避开已有名称）。规则与 LuCI 向导一致。 */
internal fun setupSubs(rows: List<SetupSub>): List<JsonObject> {
    val kept = rows.map { SetupSub(it.name.trim(), it.url.trim(), it.ua.trim()) }
        .filter { it.name.isNotEmpty() || it.url.isNotEmpty() || it.ua.isNotEmpty() }
    require(kept.isNotEmpty()) { "至少需要一个订阅" }
    require(kept.size <= MAX_SETUP_SUBS) { "订阅过多（最多 $MAX_SETUP_SUBS 个）" }
    val used = kept.map { it.name }.filter { it.isNotEmpty() }.toMutableSet()
    val seen = mutableSetOf<String>()
    return kept.mapIndexed { index, row ->
        val name = row.name.ifEmpty {
            var k = index + 1
            while ("订阅$k" in used) k++
            "订阅$k".also { used += it }
        }
        require(name.length <= 64) { "订阅名称「$name」过长（最多 64 个字符）" }
        require(seen.add(name)) { "订阅名称重复：$name" }
        require(row.url.isNotEmpty()) { "订阅「$name」缺少地址" }
        require(Regex("https?://[^/\\s?#]+(?:[/?#]\\S*)?").matches(row.url)) { "订阅「$name」的地址需要以 http:// 或 https:// 开头" }
        json("name" to name, "url" to row.url, "ua" to row.ua.ifEmpty { null })
    }
}

internal data class SetupChange(val id: String, val title: String, val detail: String, val optional: Boolean, val applied: Boolean)
internal data class SetupStage(val title: String, val detail: String, val state: Int) // 0 进行中 1 成功 2 失败

internal object SetupState {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    const val MIRROR = "https://ghfast.top/"

    var step by mutableStateOf(0)
    var busy by mutableStateOf("")
    var error by mutableStateOf("")

    // 0. 本机
    var host by mutableStateOf<JsonObject?>(null)
    var core by mutableStateOf<JsonObject?>(null)
    var hasConfig by mutableStateOf(false)
    var useMirror by mutableStateOf(true)
    var downloading by mutableStateOf(false)

    // 1. 来源
    var source by mutableStateOf(SetupSource.Subscription)
    var url by mutableStateOf("")
    var userAgent by mutableStateOf("")
    var pasted by mutableStateOf("")
    var subs by mutableStateOf(listOf(SetupSub()))
    var imported by mutableStateOf<String?>(null)
    var importedSummary by mutableStateOf<JsonObject?>(null)
    /** 链接下载到完整配置时，用户可选择仅把它当作节点订阅。 */
    var asProvider by mutableStateOf(false)
    var detected by mutableStateOf("")

    // 2. 优化
    var base by mutableStateOf("")
    var optimized by mutableStateOf("")
    var changes by mutableStateOf<List<SetupChange>>(emptyList())
    var skip by mutableStateOf<Set<String>>(emptySet())
    var summary by mutableStateOf<JsonObject?>(null)

    // 3. 偏好
    var autostart by mutableStateOf(true)
    var tethering by mutableStateOf(false)
    var startNow by mutableStateOf(true)

    // 4. 应用
    var stages by mutableStateOf<List<SetupStage>>(emptyList())
    var confirmOverwrite by mutableStateOf(false)
    var finished by mutableStateOf(false)
    private var started = false

    val coreInstalled: Boolean get() = core?.boolean("installed") == true
    val ebpfReady: Boolean get() = host?.let { it.boolean("btf") && it.boolean("kernel_ok") && it.boolean("cgroup2") } ?: true

    fun reset() {
        if (busy.isNotEmpty()) return
        step = 0; error = ""; imported = null; importedSummary = null; asProvider = false; detected = ""
        base = ""; optimized = ""; changes = emptyList(); skip = emptySet(); summary = null
        stages = emptyList(); finished = false; confirmOverwrite = false; started = false
    }

    private fun launch(label: String, block: suspend () -> Unit) {
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

    fun start() {
        if (started) return
        started = true
        probe()
    }

    fun probe() = launch("检测本机…") {
        host = request("hostProbe")
        core = request("coreInfo")
        hasConfig = request("onboardingState").setupBoolean("has_config")
        val mirror = host?.string("mirror").orEmpty()
        useMirror = mirror.isNotEmpty() || host?.string("mirror") == null
        tethering = request("policyGet").boolean("tethering")
    }

    fun downloadCore() {
        if (busy.isNotEmpty()) return
        downloading = true
        launch("下载内核（约 20 MB，请勿离开）…") {
            try {
                val settings = request("coreGetSet")
                val mirror = if (useMirror) settings.string("mirror").ifBlank { MIRROR } else ""
                if (mirror != settings.string("mirror")) {
                    request("coreSet", json("repo" to settings.string("repo"), "tag" to settings.string("tag"), "mirror" to mirror))
                }
                request("coreUpdate")
                core = request("coreInfo")
                host = request("hostProbe")
            } finally {
                downloading = false
            }
        }
    }

    /** 读取来源：链接自动识别完整配置与节点订阅。 */
    fun loadSource() {
        // 粘贴框里只有一个链接时按订阅处理，避免误报 YAML 错误
        if (source == SetupSource.Paste && Regex("^https?://\\S+$").matches(pasted.trim())) {
            url = pasted.trim()
            pasted = ""
            source = SetupSource.Subscription
        }
        readSource()
    }

    private fun readSource() = launch("读取配置…") {
        imported = null
        importedSummary = null
        detected = ""
        when (source) {
            SetupSource.Subscription -> {
                val address = setupUrl(url)
                busy = "下载订阅…"
                val content = try {
                    request("importUrl", json("url" to address, "ua" to userAgent.trim()))
                        .string("content")
                } catch (failure: Exception) {
                    // 下载失败时仍可作为订阅交给内核在运行时拉取
                    detected = "无法预先下载（${failure.message}），将作为节点订阅写入，由内核启动后拉取。"
                    asProvider = true
                    ""
                }
                if (content.isNotEmpty()) {
                    val analysis = request("configAnalyze", json("content" to content))
                    when (analysis.string("kind")) {
                        "config" -> {
                            imported = content
                            importedSummary = analysis["summary"] as? JsonObject
                            asProvider = false
                            detected = "这是一份完整配置，将保留其中的节点、策略组与规则，并按本机情况优化。"
                        }
                        else -> {
                            asProvider = true
                            detected = "识别为节点订阅，将使用内置模板（分流规则、广告拦截、地区策略组）。"
                        }
                    }
                }
            }
            SetupSource.Template -> {
                val list = setupSubs(subs)
                asProvider = true
                detected = "使用内置模板：${list.size} 个订阅（${list.joinToString("、") { it.string("name") }}），包含分流规则、广告拦截与地区策略组。"
            }
            SetupSource.Paste -> {
                require(pasted.isNotBlank()) { "请粘贴配置内容" }

                val analysis = request("configAnalyze", json("content" to pasted))
                when (analysis.string("kind")) {
                    "subscription" -> error("粘贴的是节点链接，请改用「订阅链接」导入")
                    "partial" -> detected = analysis.string("message")
                }
                imported = pasted
                importedSummary = analysis["summary"] as? JsonObject
                asProvider = false
            }
        }
        busy = "按本机情况优化…"
        base = buildBase()
        optimize()
        step = 2
    }

    private suspend fun buildBase(): String {
        val content = imported
        if (content != null && !asProvider) return content
        val list = if (source == SetupSource.Template) setupSubs(subs) else {
            val address = setupUrl(url)
            val name = Regex("^https?://([^/:?#]+)").find(address)?.groupValues?.get(1)?.substringBefore('.')?.take(16)?.ifBlank { null } ?: "订阅"
            listOf(json("name" to name, "url" to address, "ua" to userAgent.trim().ifEmpty { null }))
        }
        val payload = mutableMapOf<String, JsonElement>("subscriptions" to JsonArray(list))
        val mirror = host?.string("mirror").orEmpty()
        if (mirror.isNotEmpty()) {
            payload["uiUrl"] = JsonPrimitive(mirror + "https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip")
            payload["rulesUrl"] = JsonPrimitive(mirror + "https://github.com/DustinWin/ruleset_geodata/raw/refs/heads/mihomo-ruleset/fakeip-filter.mrs")
        }
        return request("template", JsonObject(payload)).string("content").also { check(it.isNotBlank()) { "模板生成失败" } }
    }

    private suspend fun optimize() {
        val info = host
        val hostPayload = json(
            "ipv6" to info?.let { (it["ipv6"] as? JsonPrimitive)?.booleanOrNull },
            "memMb" to info?.string("mem_mb")?.toIntOrNull(),
            "sdk" to info?.string("sdk")?.toIntOrNull(),
            "mirror" to info?.string("mirror").orEmpty(),
        )
        val result = request("configOptimize", json("content" to base, "host" to hostPayload, "skip" to skip.toList()))
        optimized = result.string("content")
        summary = result["summary"] as? JsonObject
        changes = result.objects("changes").map {
            SetupChange(it.string("id"), it.string("title"), it.string("detail"), it.boolean("optional"), it.boolean("applied"))
        }
    }

    fun toggle(change: SetupChange) {
        if (!change.optional || busy.isNotEmpty()) return
        skip = if (change.id in skip) skip - change.id else skip + change.id
        launch("重新生成…") { optimize() }
    }

    fun apply() {
        if (busy.isNotEmpty()) return
        if (hasConfig && !confirmOverwrite) { confirmOverwrite = true; return }
        confirmOverwrite = false
        step = 4
        stages = emptyList()
        launch("应用配置…") {
            suspend fun stage(title: String, block: suspend () -> String) {
                stages = stages + SetupStage(title, "", 0)
                try {
                    val detail = block()
                    stages = stages.dropLast(1) + SetupStage(title, detail, 1)
                } catch (failure: Exception) {
                    stages = stages.dropLast(1) + SetupStage(title, failure.message ?: "失败", 2)
                    throw failure
                }
            }
            stage("校验配置") {
                check(request("coreInfo").boolean("installed")) { "内核未安装，无法校验" }
                request("validate", json("content" to optimized))
                "通过"
            }
            stage("写入配置") {
                markToolsConfigChanged()
                request("apply", json("content" to optimized, "restart" to false))
                val replaced = hasConfig
                hasConfig = true
                if (replaced) "已保存，原配置已备份" else "已保存"
            }
            stage("运行设置") {
                val current = request("policyGet").setupPolicy()
                request("policySet", JsonObject(current + json("autostart" to autostart, "tethering" to tethering)))
                listOf(if (autostart) "开机自启" else null, if (tethering) "共享代理" else null).filterNotNull()
                    .joinToString("、").ifEmpty { "保持默认" }
            }
            if (startNow) stage("启动服务") {
                val result = request("service", json("action" to "start"))
                if (result.boolean("paused")) "当前 Wi-Fi 不满足条件，已暂停" else "已启动"
            }
            stage("完成") {
                request("onboardingComplete", json())
                "可在「设置」中重新运行向导"
            }
            finished = true
        }
    }

    fun skipWizard(onDone: () -> Unit) = launch("保存…") {
        request("onboardingComplete", json())
        onDone()
    }
}

@Composable
fun SetupWizard(firstRun: Boolean, onExit: () -> Unit) {
    val state = SetupState
    LaunchedEffect(Unit) { state.start() }
    val titles = listOf("检测本机", "配置来源", "本机优化", "运行偏好", "应用")
    val canExit = !firstRun && !state.finished && state.busy.isEmpty()
    val levels = (if (state.step in 1..3) state.step else 0) + if (canExit) 1 else 0
    BackHandler(enabled = levels > 0, levels = levels) {
        if (state.step in 1..3) { state.step--; state.error = "" } else onExit()
    }
    Box(Modifier.fillMaxSize()) {
        Page(
            title = if (firstRun && state.step == 0) "欢迎使用" else titles[state.step],
            subtitle = "第 ${state.step + 1} 步，共 ${titles.size} 步",
            navigationIcon = {
                when {
                    state.step in 1..3 -> BackIcon { state.step--; state.error = "" }
                    !firstRun && !state.finished -> BackIcon(onExit)
                }
            },
            bottomPadding = 88.dp,
            header = { SetupProgress(state.step, titles.size) },
        ) {
            banner(state.busy, BannerKind.Progress, "busy")
            banner(state.error, BannerKind.Error, "error")
            when (state.step) {
                0 -> setupHost()
                1 -> setupSource()
                2 -> setupOptimize()
                3 -> setupPreferences()
                else -> setupApply()
            }
        }
        Row(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(MiuixTheme.colorScheme.surface)
                .padding(horizontal = 12.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val idle = state.busy.isEmpty()
            when (state.step) {
                0 -> {
                    if (firstRun) TextButton("稍后设置", onClick = { state.skipWizard(onExit) }, enabled = idle, modifier = Modifier.weight(1f))
                    if (state.core != null && !state.coreInstalled) {
                        TextButton(if (state.downloading) "下载中…" else "下载内核", onClick = { state.downloadCore() }, enabled = idle,
                            modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary())
                    } else {
                        TextButton("下一步", onClick = { state.step = 1 }, enabled = idle && state.coreInstalled, modifier = Modifier.weight(1f),
                            colors = ButtonDefaults.textButtonColorsPrimary())
                    }
                }
                1 -> TextButton("读取并优化", onClick = { state.loadSource() }, enabled = idle, modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.textButtonColorsPrimary())
                2 -> TextButton("下一步", onClick = { state.step = 3 }, enabled = idle && state.optimized.isNotEmpty(), modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.textButtonColorsPrimary())
                3 -> TextButton(if (state.startNow) "应用并启动" else "应用", onClick = { state.apply() }, enabled = idle,
                    modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary())
                else -> {
                    val failed = state.stages.any { it.state == 2 }
                    if (failed) TextButton("返回修改", onClick = { state.step = 3 }, enabled = idle, modifier = Modifier.weight(1f))
                    TextButton(if (state.finished) "进入主页" else "请稍候…", onClick = { state.reset(); onExit() },
                        enabled = idle && state.finished, modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary())
                }
            }
        }
    }
    ConfirmDialog(show = state.confirmOverwrite, title = "替换现有配置？", summary = "当前 config.yaml 会先自动备份，可在「备份」中恢复。",
        confirm = "替换", onDismiss = { state.confirmOverwrite = false }) { state.apply() }
}

@Composable
private fun SetupProgress(step: Int, total: Int) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        repeat(total) { index ->
            Box(Modifier.weight(1f).height(4.dp).clip(RoundedCornerShape(2.dp))
                .background(if (index <= step) MiuixTheme.colorScheme.primary else MiuixTheme.colorScheme.secondaryContainer))
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.setupHost() {
    val state = SetupState
    val host = state.host
    item(key = "intro") {
        Caption("mihomo 通过 eBPF 透明代理接管本机与共享设备的流量。向导会检测本机环境、导入你的配置，并自动调整为适合手机的设置。")
    }
    if (host != null) {
        group("本机", "host") {
            InfoRow("设备", listOf(host.string("model"), "Android ${host.string("android")}").filter { it.isNotBlank() }.joinToString(" · "))
            InfoRow("内核", host.string("kernel").substringBefore('-').ifBlank { "未知" },
                valueColor = if (host.boolean("kernel_ok")) Tone.muted else Tone.warning)
            InfoRow("eBPF 支持", if (state.ebpfReady) "可用" else "可能不可用",
                summary = if (state.ebpfReady) null else "需要 5.10+ 内核、BTF 与 cgroup v2；不满足时服务可能无法启动",
                valueColor = if (state.ebpfReady) Tone.success else Tone.warning)
            InfoRow("IPv6", if (host.boolean("ipv6")) "可用" else "无 IPv6 出口")
            InfoRow("内存", host.string("mem_mb").toLongOrNull()?.let { "${(it + 512) / 1024} GB" } ?: "—")
            val network = listOf(host.string("ssid").ifBlank { null }, host.string("upstream").ifBlank { null }).filterNotNull()
            InfoRow("当前网络", network.joinToString(" · ").ifEmpty { "未连接" })
        }
    }
    group("内核", "core") {
        val core = state.core
        InfoRow("mihomo 内核", when {
            core == null -> "—"
            state.coreInstalled -> shortVersion(core.string("version")).ifBlank { "已安装" }
            else -> "未安装"
        }, valueColor = if (state.coreInstalled) Tone.success else Tone.warning)
        if (!state.coreInstalled) {
            SwitchRow("使用下载镜像", state.useMirror, "通过 ghfast.top 加速 GitHub 下载", enabled = state.busy.isEmpty()) { state.useMirror = it }
        }
    }
    if (state.downloading) item(key = "dl") {
        LinearProgressIndicator(modifier = Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth())
    }
    if (state.host == null && state.busy.isEmpty()) item(key = "retry") {
        ButtonRow { ActionButton("重新检测", primary = true) { state.probe() } }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.setupSource() {
    val state = SetupState
    group("来源", "source") {
        SourceOption("订阅链接（推荐）", "机场提供的订阅或 Clash 配置链接，自动识别类型", state.source == SetupSource.Subscription) {
            state.source = SetupSource.Subscription
        }
        SourceOption("内置模板", "填写一个或多个节点订阅，使用内置的分流规则与地区策略组", state.source == SetupSource.Template) {
            state.source = SetupSource.Template
        }
        SourceOption("粘贴配置", "已有的 mihomo / Clash Meta 配置文件内容", state.source == SetupSource.Paste) {
            state.source = SetupSource.Paste
        }
    }
    when (state.source) {
        SetupSource.Subscription -> group("订阅", "url") {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                InputField("订阅链接", state.url, enabled = state.busy.isEmpty()) { state.url = it }
                InputField("User-Agent（可选，默认 clash.meta）", state.userAgent, enabled = state.busy.isEmpty()) { state.userAgent = it }
            }
        }
        SetupSource.Template -> {
            val idle = state.busy.isEmpty()
            state.subs.forEachIndexed { index, sub ->
                group("订阅 ${index + 1}", "sub$index") {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        fun edit(row: SetupSub) { state.subs = state.subs.toMutableList().also { it[index] = row } }
                        InputField("名称（可选，默认 订阅${index + 1}）", sub.name, enabled = idle) { edit(sub.copy(name = it)) }
                        InputField("订阅地址", sub.url, enabled = idle) { edit(sub.copy(url = it)) }
                        InputField("User-Agent（可选）", sub.ua, enabled = idle) { edit(sub.copy(ua = it)) }
                    }
                    if (state.subs.size > 1) ButtonRow {
                        ActionButton("删除", enabled = idle) { state.subs = state.subs.filterIndexed { i, _ -> i != index } }
                    }
                }
            }
            if (state.subs.size < MAX_SETUP_SUBS) item(key = "sub-add") {
                ButtonRow { ActionButton("添加订阅", enabled = state.busy.isEmpty()) { state.subs = state.subs + SetupSub() } }
            }
        }
        SetupSource.Paste -> group("配置内容", "paste") {
            Column(Modifier.padding(16.dp)) {
                InputField("粘贴 YAML", state.pasted, singleLine = false, minLines = 8, maxLines = 16, enabled = state.busy.isEmpty()) {
                    state.pasted = it
                }
            }
        }
    }
    item(key = "hint") {
        Caption(if (state.source == SetupSource.Template)
            "模板内容：按地区自动选择的 Smart 策略组、国内直连与国外代理分流、广告拦截与 zashboard 面板；与手机运行相关的调整会在下一步列出，可逐项取消。"
        else "导入后会保留你的节点、策略组与规则，只调整与手机运行相关的设置；每一项都会在下一步列出，可逐项取消。")
    }
}

@Composable
private fun SourceOption(title: String, summary: String, selected: Boolean, onClick: () -> Unit) {
    BasicComponent(title = title, summary = summary, onClick = onClick, startAction = {
        Checkbox(state = if (selected) androidx.compose.ui.state.ToggleableState.On else androidx.compose.ui.state.ToggleableState.Off,
            onClick = onClick, modifier = Modifier.padding(end = 12.dp))
    })
}

private fun androidx.compose.foundation.lazy.LazyListScope.setupOptimize() {
    val state = SetupState
    if (state.detected.isNotEmpty()) item(key = "detected") { Banner(state.detected, BannerKind.Info) }
    if (state.imported != null && state.source == SetupSource.Subscription) group(null, "mode") {
        SwitchRow("仅作为节点订阅", state.asProvider, "关闭：使用这份配置的规则；开启：使用内置模板规则", enabled = state.busy.isEmpty()) {
            state.asProvider = it
            state.loadSource()
        }
    }
    state.summary?.let { summary ->
        group("配置概况", "summary") {
            InfoRow("节点", "${summary.string("proxies")} 个" + if (summary.string("providers") != "0") " · ${summary.string("providers")} 个订阅" else "")
            InfoRow("策略组", "${summary.string("groups")} 个")
            InfoRow("规则", "${summary.string("rules")} 条")
        }
    }
    val required = state.changes.filter { !it.optional }
    val optional = state.changes.filter { it.optional }
    if (required.isNotEmpty()) group("必要调整", "required") {
        for (change in required) ChangeRow(change)
    }
    if (optional.isNotEmpty()) group("推荐优化", "optional") {
        for (change in optional) ChangeRow(change)
    }
    if (state.changes.isEmpty() && state.optimized.isNotEmpty()) item(key = "none") {
        Banner("配置已适合本机，无需调整", BannerKind.Success)
    }
}

@Composable
private fun ChangeRow(change: SetupChange) {
    val state = SetupState
    val checked = change.id !in state.skip
    BasicComponent(
        title = change.title,
        summary = change.detail,
        onClick = if (change.optional) ({ state.toggle(change) }) else null,
        startAction = {
            Checkbox(
                state = if (checked) androidx.compose.ui.state.ToggleableState.On else androidx.compose.ui.state.ToggleableState.Off,
                onClick = if (change.optional) ({ state.toggle(change) }) else null,
                enabled = change.optional && state.busy.isEmpty(),
                modifier = Modifier.padding(end = 12.dp),
            )
        },
    )
}

private fun androidx.compose.foundation.lazy.LazyListScope.setupPreferences() {
    val state = SetupState
    group("运行", "run") {
        SwitchRow("开机自启", state.autostart, "开机后自动启动代理") { state.autostart = it }
        SwitchRow("共享代理", state.tethering, "热点、USB、蓝牙共享的设备也走代理") { state.tethering = it }
        SwitchRow("完成后立即启动", state.startNow) { state.startNow = it }
    }
    item(key = "later") {
        Caption("不走代理的应用、Wi-Fi 条件、DNS 与 eBPF 细节可在完成后到「设置」中调整。")
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.setupApply() {
    val state = SetupState
    group(null, "stages") {
        for (stage in state.stages) {
            BasicComponent(title = stage.title, summary = stage.detail.ifEmpty { null }, startAction = {
                Box(Modifier.padding(end = 12.dp).size(24.dp), contentAlignment = Alignment.Center) {
                    when (stage.state) {
                        0 -> CircularProgressIndicator(size = 18.dp, strokeWidth = 2.dp)
                        1 -> Icon(MiuixIcons.Regular.Ok, null, tint = Tone.success, modifier = Modifier.size(20.dp))
                        else -> Icon(MiuixIcons.Regular.Close, null, tint = Tone.danger, modifier = Modifier.size(20.dp))
                    }
                }
            })
        }
    }
    if (state.finished) item(key = "done") {
        Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(56.dp).clip(CircleShape).background(Tone.success.copy(alpha = 0.15f)), contentAlignment = Alignment.Center) {
                Icon(MiuixIcons.Regular.Ok, null, tint = Tone.success, modifier = Modifier.size(28.dp))
            }
            Text("设置完成", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = MiuixTheme.colorScheme.onSurface)
        }
    }
}
