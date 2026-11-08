package mihomo

import androidx.compose.foundation.background
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import top.yukonga.miuix.kmp.basic.BasicComponent
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.CardDefaults
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.IconButton
import top.yukonga.miuix.kmp.basic.TabRowWithContour
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Close
import top.yukonga.miuix.kmp.icon.extended.Refresh
import top.yukonga.miuix.kmp.icon.extended.Search
import top.yukonga.miuix.kmp.icon.extended.Tune
import top.yukonga.miuix.kmp.icon.extended.Update
import top.yukonga.miuix.kmp.icon.extended.Link
import top.yukonga.miuix.kmp.icon.extended.Layers
import top.yukonga.miuix.kmp.icon.extended.Info
import top.yukonga.miuix.kmp.icon.extended.File
import top.yukonga.miuix.kmp.icon.extended.Notes
import top.yukonga.miuix.kmp.icon.extended.Backup
import top.yukonga.miuix.kmp.preference.CheckboxPreference
import top.yukonga.miuix.kmp.theme.MiuixTheme

internal val settingsDefaultInterfaces = listOf("ap0", "wlan1", "rndis0", "usb0", "bt-pan")
private val settingsInterfacePattern = Regex("[A-Za-z0-9_][A-Za-z0-9_.-]{0,14}")
private val settingsPackagePattern = Regex("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)+")

/** 共享网卡模式：全部共享网卡 / 仅所选网卡 / 全部但排除所选网卡。 */
internal val settingsTetherModes = listOf("all", "only", "exclude")

private fun String.interfaceList(): List<String> = split(',').map { it.trim() }.filter { it.isNotEmpty() }.distinct()

private fun String.settingsLines(): String = replace("\r\n", "\n").replace('\r', '\n')

private fun String.settingsPackages(): Set<String> =
    settingsLines().split('\n').map { it.trim() }.filter { it.isNotEmpty() }.toSet()

private data class SettingsPolicy(
    val autostart: Boolean,
    val tethering: Boolean,
    val interfaces: String,
    val packages: String,
    val wifiMode: String,
    val ssids: String,
    val tetherMode: String = "only",
    val excludes: String = "",
    /** 后端算出的实际接管网卡（只读，不参与比较与提交）。 */
    val effective: String = "",
) {
    fun interfaceNames(): List<String> = interfaces.interfaceList().ifEmpty { settingsDefaultInterfaces }
    fun excludeNames(): List<String> = excludes.interfaceList()

    /** 当前模式下弹窗里勾选的网卡：仅所选模式是接管的网卡，排除模式是排除的网卡，全部模式没有。 */
    fun pickedNames(): List<String> = when (tetherMode) { "only" -> interfaceNames(); "exclude" -> excludeNames(); else -> emptyList() }

    fun normalized(): SettingsPolicy = copy(
        interfaces = interfaceNames().joinToString(","),
        excludes = excludeNames().joinToString(","),
        effective = "",
        packages = packages.settingsPackages().joinToString("\n"),
        ssids = ssids.settingsLines().trimEnd('\n'),
    )

    fun validated(): SettingsPolicy {
        val candidate = normalized()
        require(candidate.wifiMode in listOf("off", "only", "exclude")) { "请选择有效的 Wi-Fi 模式。" }
        require(candidate.tetherMode in settingsTetherModes) { "请选择有效的共享网卡模式。" }
        require((candidate.interfaceNames() + candidate.excludeNames()).all { settingsInterfacePattern.matches(it) }) {
            "接口须为逗号分隔的网卡名称，每个名称最多 15 个字符。"
        }
        require(candidate.packages.settingsPackages().all { settingsPackagePattern.matches(it) }) {
            "包名格式无效，例如 com.example.app；每行填写一个包名。"
        }
        for ((label, value) in listOf(
            "共享接口" to candidate.interfaces,
            "绕过包名" to candidate.packages,
            "SSID 列表" to candidate.ssids,
        )) {
            require(value.encodeToByteArray().size <= 32768) { "$label 超过 32768 字节。" }
            require(value.none { (it.code < 32 && it != '\n') || it.code == 127 }) {
                "$label 含不支持的控制字符。"
            }
        }
        require(candidate.ssids.split('\n').all { it.encodeToByteArray().size <= 32 }) {
            "每个 SSID 最多 32 个 UTF-8 字节，中文可能占多个字节。"
        }
        return candidate
    }

    fun payload(): JsonObject = json(
        "autostart" to autostart,
        "tethering" to tethering,
        "tethering_mode" to tetherMode,
        "tethering_interfaces" to interfaces,
        "tethering_exclude" to excludes,
        "bypass_packages" to packages,
        "wifi_mode" to wifiMode,
        "wifi_ssids" to ssids,
    )
}

private fun JsonObject.settingsPolicy(): SettingsPolicy = SettingsPolicy(
    autostart = boolean("autostart"),
    tethering = boolean("tethering"),
    interfaces = string("tethering_interfaces", settingsDefaultInterfaces.joinToString(",")),
    packages = string("bypass_packages"),
    wifiMode = string("wifi_mode", "off"),
    ssids = string("wifi_ssids"),
    // 旧后端没有模式：按原来的行为（仅所选网卡）
    tetherMode = string("tethering_mode", "only").takeIf { it in settingsTetherModes } ?: "only",
    excludes = string("tethering_exclude"),
    effective = string("tethering_effective"),
)

private data class SettingsInterface(
    val name: String,
    val kind: String,
    val present: Boolean,
    val state: String,
    val upstream: Boolean,
    val suggested: Boolean,
)

private data class SettingsApp(
    val packageName: String,
    val label: String,
    val system: Boolean,
    val uid: String?,
    val installed: Boolean = true,
)

private enum class SettingsAppFilter(val title: String) {
    USER("用户"), SYSTEM("系统"), ALL("全部"), SELECTED("已选"),
}

private class SettingsState(private val scope: CoroutineScope) {
    private var initialLoadAttempted = false

    var draft by mutableStateOf<SettingsPolicy?>(null)
        private set
    var saved by mutableStateOf<SettingsPolicy?>(null)
        private set
    var currentSsid by mutableStateOf("")
        private set
    var allowed by mutableStateOf<Boolean?>(null)
        private set
    var policyLoading by mutableStateOf(false)
        private set
    var saving by mutableStateOf(false)
        private set
    var pendingVerification by mutableStateOf<SettingsPolicy?>(null)
        private set
    var policyError by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
        private set
    var interfaces by mutableStateOf<List<SettingsInterface>>(emptyList())
        private set
    var interfacesLoaded by mutableStateOf(false)
        private set
    var interfacesLoading by mutableStateOf(false)
        private set
    var interfaceError by mutableStateOf<String?>(null)
        private set
    var apps by mutableStateOf<List<SettingsApp>>(emptyList())
        private set
    var appsLoaded by mutableStateOf(false)
        private set
    var appsLoading by mutableStateOf(false)
        private set
    var appsError by mutableStateOf<String?>(null)
        private set
    var showInterfaces by mutableStateOf(false)
    var showPackages by mutableStateOf(false)
    var showSsids by mutableStateOf(false)
    var showHelp by mutableStateOf(false)
    var ssidInput by mutableStateOf("")
    var ssidError by mutableStateOf<String?>(null)
    var ssidLoading by mutableStateOf(false)
        private set
    var pickerOpen by mutableStateOf(false)
        private set
    var pickerSelection by mutableStateOf<Set<String>>(emptySet())
        private set
    var pickerOriginal by mutableStateOf<Set<String>>(emptySet())
        private set
    var search by mutableStateOf("")
    var filter by mutableStateOf(SettingsAppFilter.USER)

    val editable: Boolean get() = draft != null && !saving
    val dirty: Boolean get() = draft?.normalized() != saved?.normalized()

    fun loadOnce() {
        if (initialLoadAttempted || saving) return
        initialLoadAttempted = true
        loadPolicy()
        discoverInterfaces()
    }

    fun edit(change: (SettingsPolicy) -> SettingsPolicy) {
        val previous = draft ?: return
        if (!editable || pickerOpen) return
        draft = change(previous)
        notice = null
    }

    private fun acceptPolicy(response: JsonObject, expected: SettingsPolicy?) {
        val received = response.settingsPolicy()
        saved = received
        currentSsid = response.string("current_ssid")
        allowed = response.boolean("allowed")
        val firstLoad = draft == null
        if (firstLoad) draft = received
        if (expected != null) {
            if (received.normalized() == expected) {
                if (draft?.normalized() == expected) draft = received
                pendingVerification = null
                notice = if (dirty) "已保存；仍有未保存的修改" else "已保存"
            } else {
                policyError = "回读的设置与提交内容不一致，未覆盖你的草稿。请重试回读或重新保存。"
            }
        } else {
            notice = if (firstLoad) null else "已重新读取；未保存的修改保持不变"
        }
    }

    fun discard() {
        if (saving || pickerOpen) return
        draft = saved
        policyError = null
        notice = null
    }

    fun loadPolicy() {
        if (policyLoading || saving || pickerOpen) return
        val expected = pendingVerification
        policyLoading = true
        saving = expected != null
        policyError = null
        notice = null
        scope.launch {
            try {
                acceptPolicy(request("policyGet"), expected)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                policyError = "${if (expected == null) "读取设置失败" else "回读校验失败，草稿已保留"}：${failure.message ?: "未知错误"}"
            } finally {
                policyLoading = false
                saving = false
            }
        }
    }

    fun save() {
        if (!editable || policyLoading || pickerOpen) return
        val candidate = try {
            draft?.validated() ?: return
        } catch (failure: IllegalArgumentException) {
            policyError = failure.message
            return
        }
        submit(candidate)
    }

    /**
     * 只保存共享开关与共享网卡（设备页用）：以已保存的设置为底提交，草稿里别处未保存的修改保持不动、不会被顺带保存。
     * [add] 里的网卡追加到共享网卡，[remove] 里的移除。
     */
    fun applyTethering(change: (SettingsPolicy) -> SettingsPolicy) {
        if (saving || policyLoading || pickerOpen) return
        val base = saved ?: return
        val candidate = try {
            change(base).validated()
        } catch (failure: IllegalArgumentException) {
            policyError = failure.message
            return
        }
        if (candidate == base.normalized()) return
        draft = draft?.copy(tethering = candidate.tethering, interfaces = candidate.interfaces,
            tetherMode = candidate.tetherMode, excludes = candidate.excludes)
        submit(candidate)
    }

    /** 设备页里关闭共享网卡弹窗时：只把网卡模式与网卡的改动保存下来。 */
    fun applyInterfaceDraft() {
        val current = draft ?: return
        applyTethering { it.copy(tetherMode = current.tetherMode, interfaces = current.interfaces, excludes = current.excludes) }
    }

    /** 共享网卡弹窗显示在哪一页（设置页与设备页同时在组合里，只让一处弹出）。 */
    var interfacesHost by mutableStateOf("settings")

    private fun submit(candidate: SettingsPolicy) {
        saving = true
        pendingVerification = candidate
        policyError = null
        notice = "正在保存并回读校验…"
        scope.launch {
            var submitted = false
            try {
                request("policySet", candidate.payload())
                submitted = true
                acceptPolicy(request("policyGet"), candidate)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                policyError = if (submitted) {
                    "保存请求已完成，但回读失败；尚未确认保存结果。${failure.message ?: ""}"
                } else {
                    "保存未确认，草稿已保留。${failure.message ?: "未知错误"}"
                }
            } finally {
                if (policyError != null) notice = null
                saving = false
            }
        }
    }

    fun discoverInterfaces() {
        if (interfacesLoading || saving) return
        interfacesLoading = true
        interfaceError = null
        scope.launch {
            try {
                val response = request("discoveryInterfaces")
                val discovered = response.objects("interfaces").map { item ->
                    SettingsInterface(
                        name = item.string("name"), kind = item.string("kind"),
                        present = item.boolean("present"), state = item.string("state"),
                        upstream = item.boolean("upstream"), suggested = item.boolean("suggested"),
                    )
                }.filter { settingsInterfacePattern.matches(it.name) }.distinctBy { it.name }
                interfaces = discovered
                interfacesLoaded = true
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                interfaceError = "探测接口失败，保留上次结果：${failure.message ?: "未知错误"}"
            } finally {
                interfacesLoading = false
            }
        }
    }

    fun loadApps(refresh: Boolean = false) {
        if (appsLoading || saving) return
        appsLoading = true
        appsError = null
        scope.launch {
            try {
                apps = request("apps", json("refresh" to refresh)).objects("apps").mapNotNull { item ->
                    val packageName = item.string("packageName")
                    if (packageName.isEmpty()) return@mapNotNull null
                    SettingsApp(
                        packageName = packageName,
                        label = item.string("appLabel").ifEmpty { packageName },
                        system = item.boolean("isSystem"),
                        uid = (item["uid"] as? JsonPrimitive)?.contentOrNull
                            ?.takeIf { (it.toLongOrNull() ?: -1L) >= 0L },
                    )
                }.distinctBy { it.packageName }
                    .sortedWith(compareBy<SettingsApp> { it.label.lowercase() }.thenBy { it.packageName })
                appsLoaded = true
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                appsError = "读取应用失败，已有列表及选择保持不变：${failure.message ?: "未知错误"}"
            } finally {
                appsLoading = false
            }
        }
    }

    fun toggleInterface(name: String) {
        if (!editable || pickerOpen) return
        val policy = draft ?: return
        if (policy.tetherMode == "exclude") {
            val excluded = policy.excludeNames()
            edit { it.copy(excludes = (if (name in excluded) excluded - name else excluded + name).joinToString(",")) }
            return
        }
        val selected = policy.interfaceNames()
        if (selected == listOf(name)) {
            policyError = "至少保留一个共享接口；空列表会被后端恢复为默认接口。若无需共享，请关闭共享开关。"
            return
        }
        edit { it.copy(interfaces = (if (name in selected) selected - name else selected + name).joinToString(",")) }
    }

    fun setTetherMode(mode: String) {
        if (mode in settingsTetherModes) edit { it.copy(tetherMode = mode) }
    }

    fun addSsid(ssid: String): Boolean {
        if (!editable || pickerOpen) return false
        ssidError = when {
            ssid.isEmpty() -> "请输入 Wi-Fi 名称。"
            ssid.any { it.code < 32 || it.code == 127 } -> "名称不能含换行或控制字符。"
            ssid.encodeToByteArray().size > 32 -> "名称超过 32 个 UTF-8 字节，请缩短后添加。"
            else -> null
        }
        if (ssidError != null) return false
        val existing = draft?.ssids?.settingsLines().orEmpty()
        if (ssid in existing.split('\n')) return true
        val updated = existing + (if (existing.isEmpty() || existing.endsWith('\n')) "" else "\n") + ssid
        if (updated.encodeToByteArray().size > 32768) {
            ssidError = "SSID 列表超过 32768 字节。"
            return false
        }
        edit { it.copy(ssids = updated) }
        return true
    }

    fun addCurrentSsid() {
        if (!editable || ssidLoading) return
        ssidLoading = true
        ssidError = null
        scope.launch {
            try {
                currentSsid = request("policySsid").string("current_ssid")
                if (currentSsid.isEmpty()) ssidError = "未连接 Wi-Fi 或系统未提供名称，请手动添加。"
                else addSsid(currentSsid)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                ssidError = failure.message ?: "读取 Wi-Fi 失败"
            } finally { ssidLoading = false }
        }
    }

    fun removeSsid(index: Int) {
        edit { policy ->
            policy.copy(
                ssids = policy.ssids.settingsLines().split('\n')
                    .filterIndexed { lineIndex, _ -> lineIndex != index }.joinToString("\n"),
            )
        }
    }

    fun openPicker() {
        if (!editable || pickerOpen) return
        pickerOriginal = draft?.packages?.settingsPackages().orEmpty()
        pickerSelection = pickerOriginal.toSet()
        search = ""
        filter = SettingsAppFilter.USER
        pickerOpen = true
        if (!appsLoaded && !appsLoading) loadApps()
    }

    fun selectPackage(packageName: String) {
        if (!editable || !pickerOpen) return
        if (packageName !in pickerSelection && !settingsPackagePattern.matches(packageName)) return
        pickerSelection = if (packageName in pickerSelection) pickerSelection - packageName else pickerSelection + packageName
    }

    fun clearPicker() {
        if (editable && pickerOpen) pickerSelection = emptySet()
    }

    fun closePicker(confirm: Boolean) {
        if (!editable || !pickerOpen) return
        if (confirm) {
            draft = draft?.copy(packages = pickerSelection.joinToString("\n"))
            notice = null
        }
        pickerOpen = false
    }

    fun pickerDismissed() {
        if (!pickerOpen) {
            pickerSelection = emptySet()
            pickerOriginal = emptySet()
        }
    }
}

private val settingsScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
private val settingsState = SettingsState(settingsScope)

/** 设备页用到的共享设置：共享开关与共享网卡，改动立即保存（只保存这两项）。 */
internal object TetherPolicy {
    private val state get() = settingsState
    val loaded: Boolean get() = state.saved != null
    val enabled: Boolean? get() = state.saved?.tethering
    val mode: String get() = state.saved?.tetherMode ?: "only"
    val interfaces: List<String> get() = state.saved?.interfaceNames().orEmpty()
    val excludes: List<String> get() = state.saved?.excludeNames().orEmpty()

    /** 共享网卡这一行右侧的简短说明。 */
    val summary: String get() = when (mode) {
        "all" -> "全部"
        "exclude" -> if (excludes.isEmpty()) "全部" else "排除 ${excludes.joinToString("、")}"
        else -> interfaces.joinToString("、")
    }

    /** 这张网卡上连入的设备会不会被接管（不考虑设备名单）。 */
    fun covers(name: String): Boolean = when (mode) {
        "all" -> true
        "exclude" -> name !in excludes
        else -> name in interfaces
    }
    val busy: Boolean get() = state.saving || state.policyLoading
    val error: String? get() = state.policyError
    val notice: String? get() = state.notice.takeIf { !busy }

    fun load() = state.loadOnce()
    fun reload() = state.loadPolicy()
    fun setEnabled(value: Boolean) = state.applyTethering { it.copy(tethering = value) }

    /** 让这些网卡上的设备也走代理：仅所选模式加入所选，排除模式从排除里移除。 */
    fun addInterfaces(names: List<String>) = state.applyTethering { policy ->
        when (policy.tetherMode) {
            "only" -> policy.copy(interfaces = (policy.interfaceNames() + names).distinct().joinToString(","))
            "exclude" -> policy.copy(excludes = (policy.excludeNames() - names.toSet()).joinToString(","))
            else -> policy
        }
    }

    fun openInterfaces() {
        if (state.draft == null) return
        state.interfacesHost = "devices"
        state.showInterfaces = true
        if (!state.interfacesLoaded) state.discoverInterfaces()
    }

    @Composable
    fun Sheet() = SettingsInterfaceSheet(state, "devices")
}


/** 设置：运行策略（自启、共享、应用绕过、Wi-Fi 条件），改动后底部出现保存条。 */
@Composable
fun SettingsPage(onNavigate: (String) -> Unit) {
    val state = settingsState
    LaunchedEffect(Unit) { state.loadOnce() }
    val draft = state.draft
    var editSsid by remember { mutableStateOf(false) }
    var dashboardError by remember { mutableStateOf("") }
    Box(Modifier.fillMaxSize()) {
        Page(title = "设置", bottomPadding = if (state.dirty) 88.dp else 0.dp, actions = {
            BarAction(MiuixIcons.Regular.Refresh, "重新读取", enabled = !state.policyLoading && !state.saving) { state.loadPolicy() }
        }) {
            banner(if (state.policyLoading || state.saving) (state.notice ?: "读取中…") else "", BannerKind.Progress, "progress")
            banner(state.policyError.orEmpty(), BannerKind.Error, "error")
            banner(dashboardError, BannerKind.Error, "dashboard")
            if (!state.policyLoading && !state.saving) banner(state.notice.orEmpty(), BannerKind.Success, "notice")
            if (draft == null) {
                if (!state.policyLoading) item(key = "retry") {
                    ButtonRow { ActionButton("重新读取", primary = true) { state.loadPolicy() } }
                }
                return@Page
            }
            group("启动") {
                SwitchRow("开机自启", draft.autostart, "开机后按 Wi-Fi 条件自动运行", enabled = state.editable) { value ->
                    state.edit { it.copy(autostart = value) }
                }
            }
            group("共享代理") {
                ArrowRow("热点与共享设备", "Wi-Fi 热点、USB、蓝牙共享的开关，共享设备走不走代理",
                    value = if (state.saved?.tethering == true) "代理已开启" else "代理未开启") { onNavigate("devices") }
                ArrowRow("共享高级设置", "共享方式、共享设备的 DNS 等") { onNavigate("network") }
            }
            group("应用绕过") {
                val count = draft.packages.settingsPackages().size
                ArrowRow("不走代理的应用", if (count == 0) "全部应用走代理" else "银行、游戏等可在这里排除",
                    value = if (count == 0) "无" else "$count 个", enabled = state.editable) { state.openPicker() }
            }
            group("Wi-Fi 条件") {
                val modes = listOf("off", "only", "exclude")
                DropdownRow("运行条件", listOf("不限制", "仅在所列 Wi-Fi", "排除所列 Wi-Fi"), modes.indexOf(draft.wifiMode).coerceAtLeast(0),
                    summary = state.currentSsid.ifEmpty { null }?.let { "当前：$it" }, enabled = state.editable) { index ->
                    state.edit { it.copy(wifiMode = modes[index]) }
                }
                if (draft.wifiMode != "off") {
                    val ssids = draft.ssids.settingsLines().split('\n').filter { it.isNotEmpty() }
                    ArrowRow("Wi-Fi 列表", if (ssids.isEmpty()) "尚未添加" else ssids.joinToString("、"),
                        value = "${ssids.size} 个", enabled = state.editable) { state.showSsids = true }
                    if (state.allowed != null) InfoRow("当前状态", if (state.allowed == true) "允许运行" else "已暂停",
                        valueColor = if (state.allowed == true) Tone.success else Tone.warning)
                }
            }
            group("代理与内核") {
                ArrowRow("内核配置", "订阅、分流规则、DNS 与透明代理参数", startIcon = MiuixIcons.Regular.Tune) { onNavigate("profile") }
                ArrowRow("更新", "模块、内核、面板、GEO 数据、订阅与规则集", startIcon = MiuixIcons.Regular.Update) { onNavigate("updates") }
                ArrowRow("Sub-Store", "合并、筛选多个机场订阅后交给内核", startIcon = MiuixIcons.Regular.Backup) { onNavigate("substore") }
            }
            group("远程访问") {
                ArrowRow("网页管理", "在其它设备的浏览器里管理本模块", startIcon = MiuixIcons.Regular.Link) { onNavigate("webui") }
                ArrowRow("设备控制", "增强功能：短信、电量、热点、终端与屏幕", startIcon = MiuixIcons.Regular.Tune) { onNavigate("enhanced") }
                ArrowRow("Tailscale", "在外网安全访问本机与家里的设备", startIcon = MiuixIcons.Regular.Layers) { onNavigate("tailscale") }
                ArrowRow("zashboard 面板", if (Dashboard.opening) "正在打开…" else "功能更全的代理面板，在浏览器里打开",
                    startIcon = MiuixIcons.Regular.Info) {
                    Dashboard.open { message -> dashboardError = message }
                }
            }
            group("维护") {
                ArrowRow("配置文件与备份", "查看、导入与恢复配置", startIcon = MiuixIcons.Regular.File) { onNavigate("config") }
                ArrowRow("日志", "排查连不上、规则不生效等问题", startIcon = MiuixIcons.Regular.Notes) { onNavigate("logs") }
                ArrowRow("重新运行向导", "重新检测本机网络并生成配置", startIcon = MiuixIcons.Regular.Refresh) { onNavigate("setup") }
            }
        }
        if (state.dirty) {
            Row(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(MiuixTheme.colorScheme.surface)
                    .padding(horizontal = 12.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                TextButton("撤销", onClick = { state.discard() }, enabled = !state.saving, modifier = Modifier.weight(1f))
                TextButton(if (state.saving) "保存中…" else "保存", onClick = { state.save() }, enabled = state.editable,
                    modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary())
            }
        }
    }
    SettingsInterfaceSheet(state, "settings")
    SettingsSsidSheet(state, onAdd = { editSsid = true })
    EditDialog(show = editSsid, title = "添加 Wi-Fi", initial = state.currentSsid, summary = "名称区分大小写",
        onDismiss = { editSsid = false }) { text ->
        if (state.addSsid(text)) { editSsid = false; null } else state.ssidError
    }
    SettingsAppPicker(state)
}

@Composable
private fun SettingsInterfaceSheet(state: SettingsState, host: String) {
    val draft = state.draft
    Sheet(show = state.showInterfaces && state.interfacesHost == host, title = "共享网卡", onDismissRequest = {
        state.showInterfaces = false
        if (host == "devices") state.applyInterfaceDraft()
    }) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            if (state.interfacesLoading) Banner("正在探测网卡…", BannerKind.Progress)
            state.interfaceError?.let { Banner(it, BannerKind.Error) }
            val mode = draft?.tetherMode ?: "only"
            TabRowWithContour(
                tabs = listOf("全部网卡", "仅所选", "排除所选"),
                selectedTabIndex = settingsTetherModes.indexOf(mode).coerceAtLeast(0),
                onTabSelected = { state.setTetherMode(settingsTetherModes[it]) },
            )
            Spacer(Modifier.height(12.dp))
            val selected = draft?.pickedNames().orEmpty()
            val known = state.interfaces.filter { !it.upstream }
            val names = (selected + known.map { it.name } + settingsDefaultInterfaces).distinct()
            val effective = draft?.effective?.takeIf { it.isNotEmpty() && state.saved?.tetherMode == "all" }
            if (mode == "all") {
                Text("热点、USB、蓝牙等所有共享网卡上连入的设备都走代理，之后新出现的共享网卡也会自动接管。" +
                    (effective?.let { "\n当前接管：${it.replace(",", "、")}" } ?: ""),
                    fontSize = 13.sp, color = Tone.muted)
            } else // 网卡多时列表在弹窗内滚动，底部说明保持可见
            Card(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                colors = CardDefaults.defaultColors(color = MiuixTheme.colorScheme.secondaryContainer)) {
                for (name in names) {
                    val info = known.firstOrNull { it.name == name }
                    val summary = listOfNotNull(
                        when (info?.kind) { "wifi" -> "热点"; "usb" -> "USB"; "bluetooth" -> "蓝牙"; "ethernet" -> "有线"; else -> null },
                        when { info == null -> "未出现"; info.state == "up" -> "已连接"; else -> "未启用" },
                        if (info?.suggested == true) "推荐" else null,
                    ).joinToString(" · ")
                    CheckboxPreference(checked = name in selected, onCheckedChange = { state.toggleInterface(name) }, title = name,
                        summary = summary, enabled = state.editable)
                }
            }
            if (mode != "all") Text(if (mode == "exclude") "勾选的网卡上连入的设备直接上网，其余共享网卡（包括之后新出现的）都走代理。"
                else "只有经由勾选网卡连入的设备流量会被代理。", fontSize = 13.sp, color = Tone.muted,
                modifier = Modifier.padding(top = 12.dp))
        }
    }
}

@Composable
private fun SettingsSsidSheet(state: SettingsState, onAdd: () -> Unit) {
    val draft = state.draft
    Sheet(show = state.showSsids, title = "Wi-Fi 列表", onDismissRequest = { state.showSsids = false }) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            val ssids = draft?.ssids?.settingsLines()?.split('\n').orEmpty()
            state.ssidError?.let { Banner(it, BannerKind.Error) }
            Card(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                colors = CardDefaults.defaultColors(color = MiuixTheme.colorScheme.secondaryContainer)) {
                ssids.forEachIndexed { index, ssid ->
                    if (ssid.isNotEmpty()) BasicComponent(title = ssid, endActions = {
                        IconButton(onClick = { state.removeSsid(index) }, enabled = state.editable) {
                            Icon(MiuixIcons.Regular.Close, "移除 $ssid", tint = Tone.muted)
                        }
                    })
                }
                if (ssids.none { it.isNotEmpty() }) BasicComponent(title = "尚未添加", summary = "添加后才会按条件暂停或运行")
            }
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton(if (state.ssidLoading) "读取中…" else "添加当前 Wi-Fi", onClick = { state.addCurrentSsid() },
                    enabled = state.editable && !state.ssidLoading, modifier = Modifier.weight(1f))
                TextButton("手动添加", onClick = onAdd, enabled = state.editable, modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.textButtonColorsPrimary())
            }
        }
    }
}

@Composable
private fun SettingsAppPicker(state: SettingsState) {
    Sheet(
        show = state.pickerOpen,
        title = "不走代理的应用",
        onDismissRequest = { state.closePicker(false) },
        onDismissFinished = { state.pickerDismissed() },
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            InputField("搜索应用名或包名", state.search) { state.search = it }
            Spacer(Modifier.height(12.dp))
            TabRowWithContour(
                tabs = SettingsAppFilter.entries.map { if (it == SettingsAppFilter.SELECTED) "${it.title} ${state.pickerSelection.size}" else it.title },
                selectedTabIndex = state.filter.ordinal,
                onTabSelected = { state.filter = SettingsAppFilter.entries[it] },
            )
            Spacer(Modifier.height(12.dp))
            if (state.appsLoading) Banner("读取应用列表…", BannerKind.Progress)
            state.appsError?.let { Banner(it, BannerKind.Error) }
            val needle = state.search.trim().lowercase()
            val known = state.apps.associateBy { it.packageName }
            val selectedOnly = state.pickerSelection.filter { it !in known }.map { SettingsApp(it, it, false, null, installed = false) }
            val visible = remember(state.apps, state.filter, needle, state.pickerSelection) {
                (state.apps + selectedOnly).filter { app ->
                    when (state.filter) {
                        SettingsAppFilter.USER -> !app.system && app.installed
                        SettingsAppFilter.SYSTEM -> app.system
                        SettingsAppFilter.ALL -> true
                        SettingsAppFilter.SELECTED -> app.packageName in state.pickerSelection
                    } && (needle.isEmpty() || app.label.lowercase().contains(needle) || app.packageName.lowercase().contains(needle))
                }
            }
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 440.dp)) {
                items(visible, key = { it.packageName }) { app ->
                    CheckboxPreference(
                        checked = app.packageName in state.pickerSelection,
                        onCheckedChange = { state.selectPackage(app.packageName) },
                        title = app.label,
                        summary = if (app.installed) app.packageName else "${app.packageName} · 未安装",
                        startAction = { AppIcon(app.packageName, app.label, Modifier.padding(end = 12.dp)) },
                    )
                }
                if (visible.isEmpty() && !state.appsLoading) item { EmptyState(MiuixIcons.Regular.Search, "没有匹配的应用") }
            }
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton("清空", onClick = { state.clearPicker() }, modifier = Modifier.weight(1f))
                TextButton("完成", onClick = { state.closePicker(true) }, modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.textButtonColorsPrimary())
            }
        }
    }
}
