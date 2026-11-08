package mihomo

// 工具页：配置原文、备份、内核、日志。状态对象保留原有的串行执行与确认语义，界面改为 Miuix 设置页样式。

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.ui.draw.clip
import top.yukonga.miuix.kmp.icon.extended.Report
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.LinearProgressIndicator
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.basic.TextField
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Backup
import top.yukonga.miuix.kmp.icon.extended.Notes
import top.yukonga.miuix.kmp.icon.extended.Refresh
import top.yukonga.miuix.kmp.icon.extended.Redo
import top.yukonga.miuix.kmp.icon.extended.Search
import top.yukonga.miuix.kmp.icon.extended.Undo
import top.yukonga.miuix.kmp.basic.SmallTopAppBar
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import top.yukonga.miuix.kmp.theme.MiuixTheme
import kotlin.time.TimeSource

private const val toolsDefaultRepo = "liuran001/mihomo"

private val toolsScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

private var toolsActiveWork by mutableStateOf<ToolsWork?>(null)

private val toolsIdle: Boolean get() = toolsActiveWork == null

private class ToolsWork {
    var status by mutableStateOf("")
    var error by mutableStateOf("")
    var longDownload by mutableStateOf(false)
    var startedAt = TimeSource.Monotonic.markNow()

    fun run(label: String, download: Boolean = false, block: suspend ToolsWork.() -> Unit) {
        if (!toolsIdle) return
        status = label
        error = ""
        longDownload = download
        startedAt = TimeSource.Monotonic.markNow()
        toolsActiveWork = this
        toolsScope.launch {
            try {
                block()
            } catch (cancelled: CancellationException) {
                error = "操作等待已取消；后台可能仍在执行，请刷新状态后再操作。"
                throw cancelled
            } catch (failure: Exception) {
                error = "$status\n${failure.message?.takeIf { it.isNotBlank() } ?: failure.toString()}"
            } finally {
                toolsActiveWork = null
            }
        }
    }
}

private fun toolsApplyMessage(result: JsonObject, mode: ApplyMode): String {
    val message = result.string("message")
    return when {
        result.boolean("paused") -> "配置已保存；服务被策略暂停。${message.ifBlank { "请检查 Wi-Fi / SSID 策略。" }}"
        result.string("result") == "reloaded" -> "配置已保存并立即生效（内核已热重载）。"
        mode == ApplyMode.RESTART || result.string("result") == "restarted" -> "配置已保存。${message.ifBlank { "已请求启动 / 重启服务。" }}"
        mode == ApplyMode.RELOAD -> "配置已保存；服务未运行，启动后生效。"
        else -> "配置已保存，未启动或重启服务。${message}"
    }
}

fun markToolsConfigChanged() {
    ToolsConfig.externalChange = true
    ToolsBackups.dirty = true
    ProfileState.invalidate()
}

private object ToolsConfig {
    val work = ToolsWork()
    var content by mutableStateOf("")
    var baseline by mutableStateOf("")
    var attempted by mutableStateOf(false)
    var loaded by mutableStateOf(false)
    var externalChange by mutableStateOf(false)
    var confirmRefresh by mutableStateOf(false)
    var confirmSave by mutableStateOf<Boolean?>(null)
    val dirty: Boolean get() = content != baseline

    fun read() = work.run("读取配置中…") {
        attempted = true
        val latest = request("configRead").string("content")
        content = latest
        baseline = latest
        loaded = true
        externalChange = false
        confirmRefresh = false
        status = ""
    }

    fun save(mode: ApplyMode) = work.run("检查内核中…") {
        val draft = content
        require(draft.isNotBlank()) { "配置不能为空。" }
        val installed = request("coreInfo").boolean("installed")
        require(mode != ApplyMode.RESTART || installed) { "请先在「内核」页安装内核；也可选择「仅保存」。" }
        if (installed) {
            status = "校验配置中…"
            request("validate", json("content" to draft))
        }
        status = "保存配置中…"
        externalChange = true
        ToolsBackups.dirty = true
        val result = request("apply", mode.payload(draft))
        baseline = draft
        loaded = true
        externalChange = false
        ProfileState.invalidate()
        status = toolsApplyMessage(result, mode) + if (!installed) " 内核未安装，本次未校验；安装后请先校验再启动。" else ""
    }
}

private data class ToolsBackupConfirmation(val name: String, val restore: Boolean)

private object ToolsBackups {
    val work = ToolsWork()
    var attempted by mutableStateOf(false)
    var loaded by mutableStateOf(false)
    var dirty by mutableStateOf(true)
    var list by mutableStateOf<List<JsonObject>>(emptyList())
    var confirmation by mutableStateOf<ToolsBackupConfirmation?>(null)
    var previewName by mutableStateOf<String?>(null)
    var preview by mutableStateOf("")

    suspend fun readList() {
        list = request("backups").objects("list").sortedByDescending { it.string("name") }
        loaded = true
        dirty = false
        if (previewName != null && list.none { it.string("name") == previewName }) {
            previewName = null
            preview = ""
        }
    }

    fun refresh() = work.run("读取备份列表中…") {
        attempted = true
        confirmation = null
        readList()
        status = ""
    }

    fun confirm(action: ToolsBackupConfirmation) = work.run(if (action.restore) "恢复备份中…" else "删除备份中…") {
        confirmation = null
        if (action.restore) ToolsConfig.externalChange = true
        dirty = true
        request(if (action.restore) "backupRestore" else "backupDel", json("name" to action.name))
        if (!action.restore && previewName == action.name) {
            previewName = null
            preview = ""
        }
        val result = if (action.restore) "已恢复 ${action.name}。原服务运行时，后台会按策略重启；原服务停止时不会自动启动。" else "已删除 ${action.name}。"
        status = "$result 正在刷新备份列表…"
        readList()
        status = result
    }
}

private fun toolsBackupSize(backup: JsonObject): String {
    val bytes = backup.string("size").toLongOrNull() ?: return "大小未知"
    return when {
        bytes < 0 -> "大小未知"
        bytes < 1_024 -> "$bytes B"
        bytes < 1_048_576 -> "${bytes / 1_024}.${bytes % 1_024 * 10 / 1_024} KiB"
        else -> "${bytes / 1_048_576}.${bytes % 1_048_576 * 10 / 1_048_576} MiB"
    }
}

private object ToolsCore {
    val work = ToolsWork()
    var attempted by mutableStateOf(false)
    var info by mutableStateOf<JsonObject?>(null)
    /** 最近一次检查更新的结果（core.sh check）；切换下载来源后作废。 */
    var latest by mutableStateOf<JsonObject?>(null)
    var settingsLoaded by mutableStateOf(false)
    var repo by mutableStateOf(toolsDefaultRepo)
    var tag by mutableStateOf("")
    var mirror by mutableStateOf("")
    var savedSettings by mutableStateOf(listOf(toolsDefaultRepo, "", ""))
    var confirmRollback by mutableStateOf(false)
    val settingsDirty: Boolean get() = listOf(repo.trim(), tag.trim(), mirror.trim()) != savedSettings

    fun refresh(settings: Boolean = false) = work.run("读取内核信息中…") {
        attempted = true
        val failures = mutableListOf<String>()
        try {
            info = request("coreInfo")
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            failures += "内核信息：${failure.message ?: failure.toString()}"
        }
        if (settings && !settingsLoaded) {
            try {
                val result = request("coreGetSet")
                repo = result.string("repo").ifBlank { toolsDefaultRepo }
                tag = result.string("tag")
                mirror = result.string("mirror")
                savedSettings = listOf(repo, tag, mirror)
                settingsLoaded = true
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                failures += "下载设置：${failure.message ?: failure.toString()}"
            }
        }
        check(failures.isEmpty()) { failures.joinToString("\n") }
        status = ""
    }

    /** 只查最新版本，不下载内核。 */
    fun check() = work.run("检查更新中…") {
        val result = request("coreCheck")
        latest = result
        status = when {
            result.string("latest").isBlank() -> "最新 release 的文件名里没有版本号，无法比较；可直接更新"
            result.boolean("update_available") -> "有新版本 ${result.string("latest")}"
            else -> "已是最新版本（${result.string("latest")}）"
        }
    }

    /** force：版本相同也重新下载安装。 */
    fun download(force: Boolean = false) = work.run(if (force) "重新下载并安装内核中…" else "下载并安装内核中…", download = true) {
        val result = request("coreUpdate", json("force" to force))
        val version = result.string("version").ifBlank { result.string("tag") }
        if (result.boolean("unchanged")) {
            latest = json("latest" to version, "current" to version, "update_available" to false)
            status = "已是最新版本（$version），未重新下载"
            return@run
        }
        val success = "内核已安装 $version。重启服务后使用新内核。"
        status = "$success 正在刷新内核信息…"
        info = request("coreInfo")
        latest = json("latest" to version, "current" to version, "update_available" to false)
        status = success
    }

    fun saveSettings() = work.run("保存下载设置中…") {
        val repo = this@ToolsCore.repo.trim().ifEmpty { toolsDefaultRepo }
        val tag = this@ToolsCore.tag.trim()
        val mirror = this@ToolsCore.mirror.trim()
        require(Regex("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+").matches(repo)) { "仓库格式须为 owner/repo" }
        toolsHttpUrl(mirror, "镜像", allowEmpty = true)
        request("coreSet", json("repo" to repo, "tag" to tag, "mirror" to mirror))
        this@ToolsCore.repo = repo
        this@ToolsCore.tag = tag
        this@ToolsCore.mirror = mirror
        savedSettings = listOf(repo, tag, mirror)
        latest = null
        status = "下载来源已保存"
    }
}

private fun toolsHttpUrl(value: String, label: String, allowEmpty: Boolean = false) {
    if (allowEmpty && value.isEmpty()) return
    require(Regex("https?://[^/\\s?#]+(?:[/\\?#].*)?").matches(value) && value.none { it.isWhitespace() || it.code < 32 || it.code == 127 }) {
        "$label 需要有效的 http:// 或 https:// 地址，不能包含空白字符。"
    }
}

private object ToolsLogs {
    val work = ToolsWork()
    var attempted by mutableStateOf(false)
    var content by mutableStateOf<String?>(null)

    fun refresh() = work.run("读取日志中…") {
        attempted = true
        content = request("logs", json("lines" to 300)).string("content")
        status = ""
    }

    // 诊断信息：设备、root、模块、内核、网络与最近日志（已脱敏），展示后由用户点按复制
    var diagnostics by mutableStateOf<String?>(null)
    var copied by mutableStateOf("")

    fun collect() = work.run("收集诊断信息…") {
        copied = ""
        diagnostics = request("diagnostics").string("content")
        status = ""
    }
}

/** 工作状态提示条：进行中 / 成功 / 失败。 */
private fun androidx.compose.foundation.lazy.LazyListScope.workBanner(work: ToolsWork) {
    if (toolsActiveWork === work) banner(work.status, BannerKind.Progress, "work")
    else {
        banner(work.error, BannerKind.Error, "work-error")
        if (work.error.isEmpty()) banner(work.status, BannerKind.Success, "work-ok")
    }
}

/** 配置原文：只读预览 + 全屏编辑。 */
@Composable
fun ConfigPage(onBack: () -> Unit, onNavigate: (String) -> Unit) {
    val state = ToolsConfig
    var confirmSave by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { if (!state.attempted || (state.externalChange && !state.dirty)) state.read() }
    val problems = rememberYamlLint(state.content, enabled = state.dirty)
    val errors = problems.orEmpty().filter { it.error }
    Box(Modifier.fillMaxSize()) {
        Page(title = "配置文件", navigationIcon = { BackIcon(onBack) }, actions = {
            BarAction(MiuixIcons.Regular.Refresh, "重新读取", enabled = toolsIdle) {
                if (state.dirty) state.confirmRefresh = true else state.read()
            }
        }) {
            workBanner(state.work)
            group("config.yaml") {
                InfoRow("大小", formatBytes(state.content.encodeToByteArray().size.toDouble()))
                InfoRow("行数", state.content.count { it == '\n' }.toString())
                if (state.dirty) InfoRow("状态", "有未保存修改", valueColor = Tone.warning)
                ArrowRow("编辑原文", "适合熟悉 YAML 的用户", enabled = state.loaded && toolsIdle) { onNavigate("config-edit") }
                ArrowRow("按字段编辑", "DNS、eBPF、订阅等常用项") { onNavigate("profile") }
                ArrowRow("备份", "每次保存前自动备份，保留最近 10 份", startIcon = MiuixIcons.Regular.Backup) { onNavigate("backups") }
            }
            if (state.dirty) item(key = "save") {
                ButtonRow {
                    ActionButton("放弃修改", enabled = toolsIdle) { state.content = state.baseline }
                    ActionButton("保存", primary = true, enabled = toolsIdle && errors.isEmpty()) { confirmSave = true }
                }
            }
            if (state.loaded) group("预览", "preview") {
                CodeBlock(state.content.lineSequence().take(80).joinToString("\n") + if (state.content.lines().size > 80) "\n…" else "")
            }
        }
    }
    SaveDialog(confirmSave, onDismiss = { confirmSave = false }) { mode -> confirmSave = false; state.save(mode) }
    ConfirmDialog(show = state.confirmRefresh, title = "放弃未保存的修改？", summary = "重新读取会覆盖当前编辑内容。", confirm = "重新读取",
        danger = true, onDismiss = { state.confirmRefresh = false }) { state.read() }
}

/** 全屏编辑 config.yaml：行号、语法高亮、实时校验（出错行在行号栏标红，点按问题跳到该行）、查找、撤销/重做。 */
@Composable
fun ConfigEditorPage(onBack: () -> Unit) {
    val state = ToolsConfig
    val editor = remember { CodeEditorController() }
    var confirmSave by remember { mutableStateOf(false) }
    var searching by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var matches by remember { mutableStateOf<Int?>(null) }
    var problemIndex by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) { if (!state.attempted) state.read() }
    val problems = rememberYamlLint(state.content, enabled = state.loaded)
    val errors = problems.orEmpty().filter { it.error }
    val colors = MiuixTheme.colorScheme
    Column(Modifier.fillMaxSize().background(colors.surface)) {
        SmallTopAppBar(
            title = "配置原文",
            navigationIcon = { BackIcon(onBack) },
            actions = {
                BarAction(MiuixIcons.Regular.Undo, "撤销", enabled = state.loaded) { editor.undo() }
                BarAction(MiuixIcons.Regular.Redo, "重做", enabled = state.loaded) { editor.redo() }
                BarAction(MiuixIcons.Regular.Search, "查找", enabled = state.loaded) { searching = !searching; matches = null }
            },
            defaultWindowInsetsPadding = false,
            color = colors.surface,
        )
        if (searching) Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            NativeField("查找", query, Modifier.weight(1f)) { query = it; matches = null }
            TextButton("上一个", onClick = { matches = editor.find(query, backward = true) }, enabled = query.isNotEmpty())
            TextButton("下一个", onClick = { matches = editor.find(query) }, enabled = query.isNotEmpty(),
                colors = ButtonDefaults.textButtonColorsPrimary())
        }
        if (state.work.error.isNotEmpty()) Text(state.work.error, fontSize = 13.sp, color = Tone.danger,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(12.dp))
            .background(colors.surfaceContainerHighest)) {
            if (state.loaded) CodeEditor(state.content, { state.content = it }, editor, Modifier.fillMaxSize(),
                errorLines = errors.mapNotNull { it.line.takeIf { line -> line > 0 } }.toSet())
            else Text(if (toolsActiveWork === state.work) state.work.status else "未读取配置", fontSize = 14.sp, color = Tone.muted,
                modifier = Modifier.align(Alignment.Center))
        }
        // 状态栏：光标位置、匹配数、校验结果（点按依次跳到出问题的行）
        val problem = problems?.getOrNull(problemIndex % problems.size.coerceAtLeast(1))
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("${editor.line}:${editor.column}" + (matches?.let { if (it == 0) " · 无匹配" else " · $it 处匹配" } ?: ""),
                fontSize = 12.sp, color = Tone.muted, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.width(12.dp))
            when {
                problems == null -> Unit
                problems.isEmpty() -> Text("YAML 格式正确", fontSize = 12.sp, color = Tone.success)
                problem != null -> Text((if (problem.line > 0) "第 ${problem.line} 行：" else "") + problem.message +
                    if (problems.size > 1) "（共 ${problems.size} 处，点按切换）" else "",
                    fontSize = 12.sp, lineHeight = 16.sp, maxLines = 2, color = if (problem.error) Tone.danger else Tone.warning,
                    modifier = Modifier.weight(1f).clickable {
                        if (problem.line > 0) editor.goto(problem.line)
                        problemIndex = (problemIndex + 1) % problems.size
                    })
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton("放弃修改", onClick = { state.content = state.baseline }, enabled = state.dirty && toolsIdle, modifier = Modifier.weight(1f))
            TextButton("保存", onClick = { confirmSave = true }, enabled = state.dirty && toolsIdle && errors.isEmpty(),
                modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary())
        }
    }
    SaveDialog(confirmSave, onDismiss = { confirmSave = false }) { mode -> confirmSave = false; state.save(mode) }
}

@Composable
fun BackupsPage(onBack: () -> Unit) {
    val state = ToolsBackups
    LaunchedEffect(Unit) { if (!state.attempted || state.dirty) state.refresh() }
    Page(title = "备份", navigationIcon = { BackIcon(onBack) }, actions = {
        BarAction(MiuixIcons.Regular.Refresh, "刷新", enabled = toolsIdle) { state.refresh() }
    }) {
        workBanner(state.work)
        if (state.loaded && state.list.isEmpty()) item(key = "empty") { EmptyState(MiuixIcons.Regular.Backup, "暂无备份，保存配置后自动生成") }
        if (state.list.isNotEmpty()) group("自动备份", "list") {
            for (backup in state.list) {
                val name = backup.string("name")
                ArrowRow(backupTitle(name), toolsBackupSize(backup), enabled = toolsIdle) {
                    state.work.run("读取 $name…") {
                        state.preview = request("backupRead", json("name" to name)).string("content")
                        state.previewName = name
                        status = ""
                    }
                }
            }
        }
    }
    val name = state.previewName
    Sheet(show = name != null, title = name?.let { backupTitle(it) }.orEmpty(), onDismissRequest = { state.previewName = null }) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            Card(Modifier.heightIn(max = 380.dp)) {
                Box(Modifier.verticalScroll(rememberScrollState())) { CodeBlock(state.preview) }
            }
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton("删除", onClick = { state.confirmation = ToolsBackupConfirmation(name.orEmpty(), false) },
                    enabled = toolsIdle, modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColors(textColor = MiuixTheme.colorScheme.error))
                TextButton("恢复", onClick = { state.confirmation = ToolsBackupConfirmation(name.orEmpty(), true) },
                    enabled = toolsIdle, modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary())
            }
        }
    }
    val confirmation = state.confirmation
    ConfirmDialog(
        show = confirmation != null,
        title = if (confirmation?.restore == true) "恢复此备份？" else "删除此备份？",
        summary = if (confirmation?.restore == true) "当前配置会先被备份；服务运行中会自动重启。" else "删除后无法找回。",
        confirm = if (confirmation?.restore == true) "恢复" else "删除",
        danger = confirmation?.restore != true,
        onDismiss = { state.confirmation = null },
    ) {
        confirmation?.let { state.previewName = null; state.confirm(it); ProfileState.invalidate() }
    }
}

private fun backupTitle(name: String): String {
    val match = Regex("config-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})").find(name) ?: return name
    val (year, month, day, hour, minute, second) = match.destructured
    return "$year-$month-$day $hour:$minute:$second"
}

@Composable
fun CorePage(onBack: () -> Unit) {
    val state = ToolsCore
    var confirmRollback by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { if (!state.attempted) state.refresh(settings = true) }
    Page(title = "内核", navigationIcon = { BackIcon(onBack) }, actions = {
        BarAction(MiuixIcons.Regular.Refresh, "刷新", enabled = toolsIdle) { state.refresh(settings = true) }
    }) {
        workBanner(state.work)
        if (toolsActiveWork === state.work && state.work.longDownload) item(key = "progress") {
            LinearProgressIndicator(modifier = Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth())
        }
        val info = state.info
        group("当前内核") {
            InfoRow("状态", when {
                info == null -> "—"
                info.boolean("installed") -> "已安装"
                else -> "未安装"
            }, valueColor = if (info?.boolean("installed") == true) Tone.success else Tone.warning)
            if (info?.boolean("installed") == true) {
                // "Mihomo Meta <版本> android arm64 with go1.x <构建时间>" 拆成几行显示
                val raw = info.string("version").trim()
                val words = raw.removePrefix("Mihomo").trim().removePrefix("Meta").trim().split(Regex("\\s+"))
                InfoRow("版本", shortVersion(raw).ifBlank { "未知" })
                val with = words.indexOf("with")
                if (with > 1) InfoRow("平台", words.subList(1, with).joinToString(" "))
                if (with >= 0 && with + 1 < words.size) InfoRow("构建", words.subList(with + 1, words.size).joinToString(" "))
            }
        }
        val installed = info?.boolean("installed") == true
        val latest = state.latest
        if (installed && latest != null) group("更新") {
            val newest = latest.string("latest")
            InfoRow("最新版本", newest.ifBlank { "无法识别" },
                valueColor = if (latest.boolean("update_available")) Tone.warning else Tone.success)
            Caption(if (latest.boolean("update_available")) "有新版本，更新后重启服务即可使用" else "当前已是最新版本")
        }
        item(key = "actions") {
            val ready = toolsIdle && !state.settingsDirty
            ButtonRow {
                when {
                    // 未安装：直接下载
                    !installed -> ActionButton("下载并安装", primary = true, enabled = ready) { state.download() }
                    // 还没检查：先检查，不下载
                    latest == null -> ActionButton("检查更新", primary = true, enabled = ready) { state.check() }
                    latest.boolean("update_available") -> {
                        ActionButton("重新检查", enabled = ready) { state.check() }
                        ActionButton("更新", primary = true, enabled = ready) { state.download() }
                    }
                    else -> {
                        ActionButton("重新检查", enabled = ready) { state.check() }
                        ActionButton("重新安装", enabled = ready) { state.download(force = true) }
                    }
                }
                if (info?.boolean("can_rollback") == true) ActionButton("回滚", enabled = toolsIdle) { confirmRollback = true }
            }
        }
        group("下载来源") {
            ArrowRow("GitHub 仓库", value = state.repo.ifBlank { toolsDefaultRepo }, enabled = toolsIdle) { editing = "repo" }
            ArrowRow("版本标签", "留空使用最新版本", value = state.tag.ifBlank { "最新" }, enabled = toolsIdle) { editing = "tag" }
            ArrowRow("下载镜像", "国内网络建议填写，如 https://ghfast.top/", value = state.mirror.ifBlank { "直连" }, enabled = toolsIdle) { editing = "mirror" }
        }
        if (state.settingsDirty) item(key = "save") {
            ButtonRow {
                ActionButton("撤销", enabled = toolsIdle) {
                    state.repo = state.savedSettings[0]; state.tag = state.savedSettings[1]; state.mirror = state.savedSettings[2]
                }
                ActionButton("保存来源", primary = true, enabled = toolsIdle && state.settingsLoaded) { state.saveSettings() }
            }
        }
    }
    val field = editing
    EditDialog(show = field != null, title = when (field) { "repo" -> "GitHub 仓库"; "tag" -> "版本标签"; else -> "下载镜像" },
        initial = when (field) { "repo" -> state.repo; "tag" -> state.tag; else -> state.mirror },
        summary = when (field) { "repo" -> "格式 owner/repo"; "tag" -> "例如 Prerelease-Alpha；留空取最新"; else -> "留空直连 GitHub" },
        onDismiss = { editing = null }) { text ->
        val value = text.trim()
        when (field) {
            "repo" -> if (value.isNotEmpty() && !Regex("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+").matches(value)) return@EditDialog "格式须为 owner/repo" else state.repo = value
            "tag" -> state.tag = value
            else -> {
                try { toolsHttpUrl(value, "镜像", allowEmpty = true) } catch (failure: IllegalArgumentException) { return@EditDialog failure.message }
                state.mirror = value
            }
        }
        editing = null
        null
    }
    ConfirmDialog(show = confirmRollback, title = "回滚到上一版本？", summary = "回滚后需重启服务才会生效。", confirm = "回滚",
        onDismiss = { confirmRollback = false }) {
        confirmRollback = false
        state.work.run("回滚内核中…") {
            request("coreRollback")
            state.latest = null
            state.info = request("coreInfo")
            status = "已回滚，重启服务后生效"
        }
    }
}

@Composable
fun LogsPage(onBack: () -> Unit) {
    val state = ToolsLogs
    var level by remember { mutableStateOf<LogLevel?>(null) }
    var query by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { if (!state.attempted) state.refresh() }
    val entries = remember(state.content) {
        state.content.orEmpty().trimEnd().lines().filter { it.isNotBlank() }.asReversed().map { parseLog(it) }
    }
    val counts = remember(entries) { entries.groupingBy { if (it.level == LogLevel.OTHER) LogLevel.INFO else it.level }.eachCount() }
    val shown = remember(entries, level, query) {
        entries.filter { entry ->
            (level == null || entry.level == level || (level == LogLevel.INFO && entry.level == LogLevel.OTHER)) &&
                (query.isBlank() || entry.message.contains(query.trim(), ignoreCase = true))
        }
    }
    Page(title = "日志", subtitle = "最近 300 行，最新的在上", fullWidth = true, navigationIcon = { BackIcon(onBack) }, actions = {
        BarAction(MiuixIcons.Regular.Report, "诊断信息", enabled = toolsIdle) { state.collect() }
        BarAction(MiuixIcons.Regular.Refresh, "刷新", enabled = toolsIdle) { state.refresh() }
    }) {
        if (toolsActiveWork === state.work) banner(state.work.status, BannerKind.Progress, "work")
        banner(state.work.error, BannerKind.Error, "error")
        val content = state.content
        if (content != null && entries.isEmpty()) item(key = "empty") { EmptyState(MiuixIcons.Regular.Notes, "暂无日志") }
        if (entries.isNotEmpty()) {
            item(key = "filter") {
                Column {
                    LogLevelChips(level, counts) { level = it }
                    NativeField("搜索日志", query, Modifier.padding(horizontal = 12.dp).padding(bottom = 8.dp)) { query = it }
                }
            }
            if (shown.isEmpty()) item(key = "none") { EmptyState(MiuixIcons.Regular.Notes, "没有匹配的日志") }
            items(shown.size) { index -> LogLine(shown[index]) }
        }
    }
    val report = state.diagnostics
    Sheet(show = report != null, title = "诊断信息", onDismissRequest = { state.diagnostics = null }) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("包含设备、Root、模块与内核版本、网络状态和最近日志。订阅链接、密钥、UUID 与公网地址已隐去，反馈问题时整段粘贴即可。",
                fontSize = 13.sp, lineHeight = 18.sp, color = Tone.muted)
            androidx.compose.foundation.text.selection.SelectionContainer {
                Text(report.orEmpty(), fontSize = 11.sp, lineHeight = 15.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                    color = MiuixTheme.colorScheme.onSurface,
                    modifier = Modifier.fillMaxWidth().heightIn(max = 360.dp)
                        .clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp))
                        .background(MiuixTheme.colorScheme.secondaryContainer)
                        .verticalScroll(androidx.compose.foundation.rememberScrollState()).padding(12.dp))
            }
            if (state.copied.isNotEmpty()) Text(state.copied, fontSize = 13.sp, color = Tone.success)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton("关闭", onClick = { state.diagnostics = null }, modifier = Modifier.weight(1f))
                TextButton("复制全部", modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                    state.copied = if (copyText(report.orEmpty())) "已复制到剪贴板" else "复制失败，请长按文字手动选择"
                })
            }
        }
    }
}

@OptIn(kotlin.js.ExperimentalWasmJsInterop::class)
@JsFun("() => setTimeout(() => location.reload(), 300)")
private external fun reloadPage()

/** 模块自身的检查更新与一键升级（module-update.sh）。 */
private object ToolsModule {
    val work = ToolsWork()
    var current by mutableStateOf<JsonObject?>(null)
    var latest by mutableStateOf<JsonObject?>(null)

    fun refresh() = work.run("读取模块版本中…") {
        current = request("moduleCurrent")
        status = ""
    }

    fun check() = work.run("检查更新中…") {
        val result = request("moduleCheck")
        latest = result
        status = if (result.boolean("update_available")) "有新版本 ${result.string("latest")}" else "已是最新版本（${result.string("latest")}）"
    }

    /** 下载并交给 root 管理器安装；能立即生效时等新版本换上后刷新页面。 */
    fun upgrade(force: Boolean = false) = work.run("下载并安装新版本中…", download = true) {
        val result = request("moduleUpgrade", json("force" to force))
        val version = result.string("version")
        if (result.boolean("unchanged")) {
            status = "已是最新版本（$version）"
            return@run
        }
        if (!result.boolean("live")) {
            status = "已安装 $version，重启设备后生效"
            return@run
        }
        status = "已安装 $version，正在切换到新版本…"
        val wanted = latest?.string("latest_code")?.toLongOrNull()
        // 新版本换上后后台进程会重启，网页管理服务也可能短暂断开：出错时继续等
        repeat(60) {
            delay(2000)
            val now = try { request("moduleCurrent") } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }
            if (now != null && (now.string("current") == version || (wanted != null && now.string("current_code").toLongOrNull() == wanted))) {
                status = "已升级到 $version，正在重新加载页面…"
                reloadPage()
                return@run
            }
        }
        status = "已安装 $version；如页面未更新，请重新打开模块网页"
    }
}

@Composable
fun ModuleUpdatePage(onBack: () -> Unit) {
    val state = ToolsModule
    LaunchedEffect(Unit) { if (state.current == null) state.refresh() }
    Page(title = "模块更新", navigationIcon = { BackIcon(onBack) }) {
        workBanner(state.work)
        if (toolsActiveWork === state.work && state.work.longDownload) item(key = "progress") {
            LinearProgressIndicator(modifier = Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth())
        }
        val latest = state.latest
        group("版本") {
            InfoRow("当前版本", state.current?.string("current")?.ifBlank { "未知" } ?: "—")
            if (latest != null) {
                InfoRow("最新版本", latest.string("latest").ifBlank { "未知" },
                    valueColor = if (latest.boolean("update_available")) Tone.warning else Tone.success)
            }
            Caption("升级后立即生效，不用重启手机；代理不会中断")
        }
        item(key = "actions") {
            ButtonRow {
                when {
                    latest == null -> ActionButton("检查更新", primary = true, enabled = toolsIdle) { state.check() }
                    latest.boolean("update_available") -> {
                        ActionButton("重新检查", enabled = toolsIdle) { state.check() }
                        ActionButton("升级", primary = true, enabled = toolsIdle) { state.upgrade() }
                    }
                    else -> {
                        ActionButton("重新检查", enabled = toolsIdle) { state.check() }
                        ActionButton("重新安装", enabled = toolsIdle) { state.upgrade(force = true) }
                    }
                }
            }
        }
    }
}
