package mihomo

// 内核配置：由配置引擎（bridge/config.js）给出字段清单，界面按 Miuix 设置页样式生成。
// 修改先累积为补丁，保存时一次性 patch » 校验 » 写入，并可选择重启服务。

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.background
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
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Add
import top.yukonga.miuix.kmp.icon.extended.Tune
import top.yukonga.miuix.kmp.icon.extended.Settings
import top.yukonga.miuix.kmp.icon.extended.Layers
import top.yukonga.miuix.kmp.icon.extended.Search
import top.yukonga.miuix.kmp.icon.extended.Link
import top.yukonga.miuix.kmp.theme.MiuixTheme

/** 内核配置主页的目录：子页 id、标题、说明。按「流量怎么走」的顺序排列。 */
private val PROFILE_LISTS = listOf(
    Triple("rules", "分流规则", "按域名、IP、应用等条件决定流量走哪个策略组"),
    Triple("groups", "策略组", "手动选择、Smart 智能择优、自动测速等出站分组"),
    Triple("providers", "订阅", "机场提供的订阅链接，节点自动更新"),
    Triple("nodes", "单个节点", "粘贴分享链接或手动填写的节点"),
    Triple("ruleProviders", "规则集", "规则里引用的在线域名、IP 列表"),
)

internal data class ConfigField(
    val id: String,
    val path: List<String>,
    val label: String,
    val type: String,
    val summary: String,
    val placeholder: String,
    val required: Boolean,
    val options: List<Pair<String, String>>,
    val choices: List<String>,
    val value: JsonElement,
    val default: JsonElement,
)

internal data class ConfigSection(val id: String, val title: String, val summary: String, val available: Boolean, val fields: List<ConfigField>)
internal data class ConfigItem(val name: String, val type: String, val editable: Boolean, val used: Boolean, val fields: List<ConfigField>)

internal fun JsonObject.field(): ConfigField = ConfigField(
    id = string("id"),
    path = (this["path"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty(),
    label = string("label"),
    type = string("type"),
    summary = string("summary"),
    placeholder = string("placeholder"),
    required = boolean("required"),
    options = objects("options").map { it.string("id") to it.string("title") },
    choices = (this["choices"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty(),
    value = this["value"] ?: JsonNull,
    default = this["def"] ?: JsonNull,
)

private fun JsonObject.item(): ConfigItem = ConfigItem(string("name"), string("type"), boolean("editable"), boolean("used"), objects("fields").map { it.field() })

/** 字段的展示文本。 */
internal fun fieldDisplay(field: ConfigField, value: JsonElement): String {
    val effective = if (value == JsonNull) field.default else value
    return when {
        effective == JsonNull -> if (field.placeholder.isNotEmpty()) "默认 ${field.placeholder}" else "未设置"
        field.type == "secret" -> "已设置"
        field.type == "enum" -> {
            val id = (effective as? JsonPrimitive)?.contentOrNull.orEmpty()
            field.options.firstOrNull { it.first == id }?.second ?: id
        }
        effective is JsonArray -> if (effective.isEmpty()) "无" else "${effective.size} 项"
        effective is JsonPrimitive -> effective.contentOrNull.orEmpty()
        else -> effective.toString()
    }
}

internal fun fieldText(value: JsonElement): String = when (value) {
    is JsonArray -> value.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.joinToString("\n")
    is JsonPrimitive -> value.contentOrNull.orEmpty()
    else -> ""
}

internal object ProfileState {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    var source by mutableStateOf<String?>(null)
    var sections by mutableStateOf<List<ConfigSection>>(emptyList())
    var providers by mutableStateOf<List<ConfigItem>>(emptyList())
    var ruleProviders by mutableStateOf<List<ConfigItem>>(emptyList())
    /** 订阅、规则集列表显示暂存修改后的结果；撤销时回到原配置里的列表。 */
    private var baseProviders = emptyList<ConfigItem>()
    private var baseRuleProviders = emptyList<ConfigItem>()
    var providerTemplate by mutableStateOf<List<ConfigField>>(emptyList())
    var ruleProviderTemplate by mutableStateOf<List<ConfigField>>(emptyList())
    var summary by mutableStateOf<JsonObject?>(null)
    /** 单个节点：显示的是暂存修改后的结果；撤销时回到 baseNodes。 */
    var nodes by mutableStateOf(NodeView())
    private var baseNodes = NodeView()
    /** 策略组：同样显示暂存修改后的结果。 */
    var groups by mutableStateOf(GroupView())
    private var baseGroups = GroupView()
    /** 分流规则：rules 为配置里的原样，ruleRows 为编辑中的列表（保存时生成一次 rules.set）。 */
    var rules by mutableStateOf(RuleView())
    var ruleRows by mutableStateOf<List<RuleRow>>(emptyList())
    private var baseRuleExtras = RuleView()
    /** 待保存的修改：字段 id » 新值，以及集合操作。 */
    var edits by mutableStateOf<Map<String, JsonElement>>(emptyMap())
    var collectionOps by mutableStateOf<List<JsonObject>>(emptyList())
    var busy by mutableStateOf("")
    var error by mutableStateOf("")
    var notice by mutableStateOf("")
    var loadedOnce = false

    val rulesDirty: Boolean
        get() = ruleRows.size != rules.list.size || ruleRows.withIndex().any { (index, row) -> row.k != index || row.v != rules.list[index] }
    val dirty: Boolean get() = edits.isNotEmpty() || collectionOps.isNotEmpty() || rulesDirty

    fun value(field: ConfigField): JsonElement = edits[field.id] ?: field.value

    fun load(force: Boolean = false) {
        if (busy.isNotEmpty() || (loadedOnce && !force)) return
        busy = "读取配置…"
        error = ""
        scope.launch {
            try {
                val content = request("configRead").string("content")
                parse(content)
                edits = emptyMap()
                collectionOps = emptyList()
                loadedOnce = true
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                error = failure.message ?: "读取失败"
            } finally {
                busy = ""
            }
        }
    }

    private suspend fun parse(content: String) {
        val schema = request("configSchema", json("content" to content))
        source = content
        sections = schema.objects("sections").map { section ->
            ConfigSection(section.string("id"), section.string("title"), section.string("summary"), section.boolean("available"),
                section.objects("fields").map { it.field() })
        }
        providers = schema.objects("providers").map { it.item() }
        ruleProviders = schema.objects("ruleProviders").map { it.item() }
        baseProviders = providers
        baseRuleProviders = ruleProviders
        providerTemplate = schema.objects("providerFields").map { it.field() }
        ruleProviderTemplate = schema.objects("ruleProviderFields").map { it.field() }
        summary = schema["summary"] as? JsonObject
        nodes = nodeView(schema["nodes"])
        baseNodes = nodes
        groups = groupView(schema["groups"])
        baseGroups = groups
        rules = ruleView(schema["rules"])
        baseRuleExtras = rules
        ruleRows = rules.list.mapIndexed { index, rule -> RuleRow(index, rule) }
    }

    /** 暂存一项节点或策略组修改：先在本地连同已暂存的修改试算一遍，失败时抛出原因，成功后刷新节点列表。 */
    suspend fun stage(op: JsonObject) {
        val content = source ?: error("还没有配置")
        val patched = request("configPatch", JsonObject(mapOf("content" to JsonPrimitive(content), "ops" to JsonArray(ops() + op)))).string("content")
        val schema = request("configSchema", json("content" to patched))
        nodes = nodeView(schema["nodes"])
        groups = groupView(schema["groups"])
        // 新增或改名的策略组也能在规则里选；规则列表本身仍以原配置为准
        ruleView(schema["rules"]).let { rules = rules.copy(policies = it.policies, ruleSets = it.ruleSets) }
        collectionOps = collectionOps + op
        notice = ""
    }

    fun set(field: ConfigField, value: JsonElement) {
        val same = value == field.value || (value == JsonNull && field.value == JsonNull)
        edits = if (same) edits - field.id else edits + (field.id to value)
        notice = ""
    }

    fun collection(op: String, name: String, values: Map<String, JsonElement> = emptyMap()) {
        collectionOps = collectionOps + JsonObject(mapOf("op" to JsonPrimitive(op), "name" to JsonPrimitive(name),
            "values" to JsonObject(values)))
        notice = ""
        refreshItems()
    }

    /** 暂存的订阅、规则集增删改立即反映到列表：在本地按暂存修改试算一遍配置，取出新的列表。 */
    private fun refreshItems() {
        val content = source ?: return
        val pending = ops()
        scope.launch {
            try {
                val patched = request("configPatch", JsonObject(mapOf("content" to JsonPrimitive(content), "ops" to pending))).string("content")
                val schema = request("configSchema", json("content" to patched))
                // 期间又有新的暂存或已保存、撤销时，以后来的为准
                if (source != content || ops() != pending) return@launch
                providers = schema.objects("providers").map { it.item() }
                ruleProviders = schema.objects("ruleProviders").map { it.item() }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                error = failure.message ?: "暂存失败"
            }
        }
    }

    fun discard() {
        edits = emptyMap()
        collectionOps = emptyList()
        providers = baseProviders
        ruleProviders = baseRuleProviders
        nodes = baseNodes
        groups = baseGroups
        rules = baseRuleExtras
        ruleRows = rules.list.mapIndexed { index, rule -> RuleRow(index, rule) }
        error = ""
    }

    private fun ops(): JsonArray {
        val byId = sections.flatMap { it.fields }.associateBy { it.id }
        val sets = edits.mapNotNull { (id, value) ->
            val field = byId[id] ?: return@mapNotNull null
            JsonObject(mapOf("op" to JsonPrimitive("set"), "path" to JsonArray(field.path.map { JsonPrimitive(it) }), "value" to value))
        }
        // 规则先改（按原下标引用），之后的节点、策略组改名会同步到改过的规则里
        val ruleOp = if (rulesDirty) listOf(JsonObject(mapOf("op" to JsonPrimitive("rules.set"), "items" to JsonArray(ruleRows.map { row ->
            val unchanged = row.k != null && rules.list.getOrNull(row.k) == row.v
            JsonObject(buildMap {
                if (row.k != null) put("k", JsonPrimitive(row.k))
                if (!unchanged) put("v", JsonPrimitive(row.v))
            })
        })))) else emptyList()
        return JsonArray(sets + ruleOp + collectionOps)
    }

    /** 预检：在本地应用补丁并刷新界面，返回失败原因。 */
    fun save(restart: Boolean) {
        val content = source ?: return
        if (!dirty || busy.isNotEmpty()) return
        busy = "生成配置…"
        error = ""
        notice = ""
        scope.launch {
            try {
                val patched = request("configPatch", JsonObject(mapOf("content" to JsonPrimitive(content), "ops" to ops()))).string("content")
                if (request("coreInfo").boolean("installed")) {
                    busy = "校验配置…"
                    request("validate", json("content" to patched))
                }
                busy = "写入配置…"
                markToolsConfigChanged()
                val result = request("apply", json("content" to patched, "restart" to restart))
                parse(patched)
                edits = emptyMap()
                collectionOps = emptyList()
                notice = when {
                    result.boolean("paused") -> "已保存；服务因 Wi-Fi 条件暂停"
                    restart -> "已保存并重启服务"
                    else -> "已保存，重启服务后生效"
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                error = failure.message ?: "保存失败"
            } finally {
                busy = ""
            }
        }
    }

    /** 外部（向导、配置原文、备份恢复）改动配置后调用，下次进入时重新读取。 */
    fun invalidate() {
        if (!dirty) loadedOnce = false
    }
}

@Composable
fun ProfilePage(onBack: () -> Unit) {
    val state = ProfileState
    var opened by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<ConfigField?>(null) }
    var item by remember { mutableStateOf<Pair<String, ConfigItem?>?>(null) }
    var node by remember { mutableStateOf<NodeTarget?>(null) }
    var groupTarget by remember { mutableStateOf<GroupTarget?>(null) }
    var ruleTarget by remember { mutableStateOf<RuleTarget?>(null) }
    var ruleSorting by remember { mutableStateOf(false) }
    var ruleQuery by remember { mutableStateOf("") }
    var paste by remember { mutableStateOf(false) }
    var confirmSave by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { state.load() }
    val section = state.sections.firstOrNull { it.id == opened }
    // 订阅、节点、策略组、规则、规则集各自是一个子页，主页只做目录
    val listTitle = PROFILE_LISTS.firstOrNull { it.first == opened }?.second
    BackHandler(enabled = opened != null) { opened = null }
    Box(Modifier.fillMaxSize()) {
        Page(title = section?.title ?: listTitle ?: "内核配置", subtitle = section?.summary.orEmpty(),
            navigationIcon = { BackIcon(if (opened != null) ({ opened = null }) else onBack) },
            bottomPadding = if (state.dirty) 88.dp else 0.dp) {
            banner(state.busy, BannerKind.Progress, "busy")
            banner(state.error, BannerKind.Error, "error")
            banner(state.notice, BannerKind.Success, "notice")
            if (state.source == null) {
                if (state.busy.isEmpty()) item(key = "empty") {
                    Column {
                        EmptyState(MiuixIcons.Regular.Tune, "还没有配置，请先运行向导")
                        ButtonRow { ActionButton("重新读取", primary = true) { state.load(force = true) } }
                    }
                }
                return@Page
            }
            when (opened) {
                "rules" -> { rulesContent(ruleQuery, { ruleQuery = it }, { ruleSorting = true }) { ruleTarget = it }; return@Page }
                "providers" -> {
                    group(null, "providers") {
                        Caption("机场提供的订阅链接，节点会定期自动更新。策略组通过「订阅」选项引用它们。")
                        for (provider in state.providers) {
                            val url = provider.fields.firstOrNull { it.id == "url" }?.let { fieldText(it.value) }.orEmpty()
                            ArrowRow(provider.name, url.ifEmpty { provider.type }, enabled = provider.editable) { item = "provider" to provider }
                        }
                        ArrowRow("添加订阅", "填入机场提供的订阅链接", startIcon = MiuixIcons.Regular.Add) { item = "provider" to null }
                    }
                    return@Page
                }
                "nodes" -> { group(null, "nodes") { NodeRows(onOpen = { node = NodeTarget(it) }, onPaste = { paste = true }) }; return@Page }
                "groups" -> { group(null, "groups") { GroupRows(onOpen = { groupTarget = GroupTarget(it) }) }; return@Page }
                "ruleProviders" -> {
                    group(null, "ruleProviders") {
                        Caption("从网上引用的一组域名或 IP，在规则里用「RULE-SET」类型引用，会定期自动更新。")
                        for (ruleSet in state.ruleProviders) {
                            val behavior = ruleSet.fields.firstOrNull { it.id == "behavior" }
                            ArrowRow(ruleSet.name, behavior?.let { fieldDisplay(it, it.value) }, enabled = ruleSet.editable) { item = "ruleProvider" to ruleSet }
                        }
                        ArrowRow("添加规则集", "从网上引用一组域名或 IP 规则", startIcon = MiuixIcons.Regular.Add) { item = "ruleProvider" to null }
                    }
                    return@Page
                }
            }
            if (section != null) {
                group(null, "section:${section.id}") {
                    if (!section.available) Caption("当前配置还没有开启透明代理，请先在「设置 › 重新运行向导」里完成本机优化。", Tone.warning)
                    else for (field in section.fields) ConfigFieldRow(field, state.value(field)) { editing = field }
                }
                return@Page
            }
            state.summary?.let { summary ->
                if (summary.boolean("tun")) banner("配置里开启了 TUN，会和透明代理冲突，建议在向导里执行本机优化关闭它。", BannerKind.Error, "tun")
            }
            group("代理与分流", "lists") {
                Caption("流量的去向：规则决定走哪个策略组，策略组从订阅和单个节点里挑出实际使用的节点。")
                val nodes = state.nodes.list.count { it.type != "dns" }
                val counts = mapOf(
                    "providers" to "${state.providers.size} 个",
                    "nodes" to "$nodes 个",
                    "groups" to "${state.groups.list.size} 个",
                    "rules" to "${state.ruleRows.size} 条" + if (state.rulesDirty) " · 已修改" else "",
                    "ruleProviders" to "${state.ruleProviders.size} 个",
                )
                for ((id, title, summary) in PROFILE_LISTS.map { Triple(it.first, it.second, it.third) }) {
                    ArrowRow(title, summary, value = counts[id]) { opened = id }
                }
            }
            group("高级设置", "sections") {
                for (s in state.sections) {
                    val icon = when (s.id) {
                        "basic" -> MiuixIcons.Regular.Settings
                        "controller" -> MiuixIcons.Regular.Layers
                        "dns" -> MiuixIcons.Regular.Search
                        else -> MiuixIcons.Regular.Link
                    }
                    ArrowRow(s.title, s.summary, startIcon = icon) { opened = s.id }
                }
            }
            item(key = "hint") { Caption("改动会先暂存，点底部「保存」后才写入配置。") }
        }
        if (state.dirty) {
            Row(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(MiuixTheme.colorScheme.surface)
                    .padding(horizontal = 12.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                TextButton("撤销", onClick = { state.discard() }, enabled = state.busy.isEmpty(), modifier = Modifier.weight(1f))
                TextButton("保存", onClick = { confirmSave = true }, enabled = state.busy.isEmpty(), modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.textButtonColorsPrimary())
            }
        }
    }
    FieldEditor(editing, onDismiss = { editing = null }) { field, value -> state.set(field, value); editing = null }
    ItemSheet(item, onDismiss = { item = null })
    NodeSheet(node, onDismiss = { node = null })
    NodePasteSheet(paste, onDismiss = { paste = false })
    GroupSheet(groupTarget, onDismiss = { groupTarget = null })
    RuleSheet(ruleTarget) { ruleTarget = it }
    RuleOrderSheet(ruleSorting) { ruleSorting = false }
    SaveDialog(confirmSave, onDismiss = { confirmSave = false }) { restart -> confirmSave = false; state.save(restart) }
}

@Composable
internal fun SaveDialog(show: Boolean, onDismiss: () -> Unit, onSave: (Boolean) -> Unit) {
    Dialog(show = show, title = "保存配置", summary = "保存前会先校验配置，失败时不会写入。",
        onDismissRequest = onDismiss) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton("保存并重启服务", onClick = { onSave(true) }, modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.textButtonColorsPrimary())
            TextButton("仅保存", onClick = { onSave(false) }, modifier = Modifier.fillMaxWidth())
            TextButton("取消", onClick = onDismiss, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
internal fun ConfigFieldRow(field: ConfigField, value: JsonElement, onEdit: () -> Unit) {
    val state = ProfileState
    val edited = field.id in state.edits
    val title = if (edited) "${field.label} ·" else field.label
    when (field.type) {
        "bool" -> {
            val checked = ((value as? JsonPrimitive)?.booleanOrNull) ?: ((field.default as? JsonPrimitive)?.booleanOrNull ?: false)
            SwitchRow(title, checked, field.summary.ifEmpty { null }, enabled = state.busy.isEmpty()) { state.set(field, JsonPrimitive(it)) }
        }
        "enum" -> {
            val current = (value as? JsonPrimitive)?.contentOrNull ?: (field.default as? JsonPrimitive)?.contentOrNull
            val index = field.options.indexOfFirst { it.first == current }
            val labels = field.options.map { it.second } + if (index < 0 && current != null) listOf(current) else emptyList()
            DropdownRow(title, labels, if (index >= 0) index else labels.lastIndex, field.summary.ifEmpty { null },
                enabled = state.busy.isEmpty()) { picked ->
                if (picked < field.options.size) state.set(field, JsonPrimitive(field.options[picked].first))
            }
        }
        else -> ArrowRow(title, field.summary.ifEmpty { null }, value = fieldDisplay(field, value), enabled = state.busy.isEmpty(), onClick = onEdit)
    }
}

/** 文本/数值/列表字段的编辑弹窗。列表字段一行一个。 */
@Composable
internal fun FieldEditor(field: ConfigField?, onDismiss: () -> Unit, onSave: (ConfigField, JsonElement) -> Unit) {
    val current = field?.let { ProfileState.edits[it.id] ?: it.value } ?: JsonNull
    val multiline = field?.type == "list"
    val hint = when {
        field == null -> null
        field.type == "list" && field.choices.isNotEmpty() -> "一行一个，可选：${field.choices.joinToString("、")}"
        field.type == "list" -> "一行一个；留空表示删除"
        field.placeholder.isNotEmpty() -> "留空使用默认值 ${field.placeholder}"
        else -> field.summary.ifEmpty { null }
    }
    EditDialog(show = field != null, title = field?.label.orEmpty(), initial = fieldText(current), summary = hint, multiline = multiline,
        onDismiss = onDismiss) { text ->
        val target = field ?: return@EditDialog null
        val trimmed = text.trim()
        val value: JsonElement = when {
            trimmed.isEmpty() -> JsonNull
            target.type == "int" -> JsonPrimitive(trimmed.toLongOrNull() ?: return@EditDialog "请输入整数")
            target.type == "list" -> JsonArray(trimmed.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.map { JsonPrimitive(it) })
            else -> JsonPrimitive(trimmed)
        }
        if (value == JsonNull && target.required) return@EditDialog "${target.label} 不能为空"
        onSave(target, value)
        null
    }
}

/** 订阅 / 规则集的新增与编辑。 */
@Composable
private fun ItemSheet(target: Pair<String, ConfigItem?>?, onDismiss: () -> Unit) {
    val state = ProfileState
    val kind = target?.first
    val existing = target?.second
    val template = if (kind == "provider") state.providerTemplate else state.ruleProviderTemplate
    val fields = existing?.fields ?: template
    var name by remember(target) { mutableStateOf(existing?.name.orEmpty()) }
    var values by remember(target) { mutableStateOf<Map<String, JsonElement>>(emptyMap()) }
    var editing by remember(target) { mutableStateOf<ConfigField?>(null) }
    var error by remember(target) { mutableStateOf("") }
    var confirmDelete by remember(target) { mutableStateOf(false) }
    Sheet(show = target != null, title = when {
        existing != null -> existing.name
        kind == "provider" -> "添加订阅"
        else -> "添加规则集"
    }, onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            if (existing == null) InputField("名称", name) { name = it; error = "" }
            top.yukonga.miuix.kmp.basic.Card(Modifier.padding(top = 12.dp),
                colors = top.yukonga.miuix.kmp.basic.CardDefaults.defaultColors(color = MiuixTheme.colorScheme.secondaryContainer)) {
                for (field in fields) {
                    val value = values[field.id] ?: field.value
                    when (field.type) {
                        "bool" -> SwitchRow(field.label, (value as? JsonPrimitive)?.booleanOrNull
                            ?: ((field.default as? JsonPrimitive)?.booleanOrNull ?: false)) { values = values + (field.id to JsonPrimitive(it)) }
                        "enum", "policy" -> {
                            val options = if (field.type == "policy") field.choices.map { it to it } else field.options
                            val currentId = (value as? JsonPrimitive)?.contentOrNull ?: (field.default as? JsonPrimitive)?.contentOrNull
                            DropdownRow(field.label, options.map { it.second }, options.indexOfFirst { it.first == currentId }.coerceAtLeast(0)) {
                                values = values + (field.id to JsonPrimitive(options[it].first))
                            }
                        }
                        else -> ArrowRow(field.label, value = if (field.type == "url") fieldText(value).ifEmpty { "未设置" } else fieldDisplay(field, value)) {
                            editing = field
                        }
                    }
                }
            }
            if (existing?.used == true) Caption("规则正在引用这个规则集，不能删除", Tone.muted)
            if (error.isNotEmpty()) Caption(error, Tone.danger)
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (existing != null) TextButton("删除", onClick = { confirmDelete = true }, enabled = !existing.used,
                    modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColors(textColor = MiuixTheme.colorScheme.error))
                TextButton("完成", modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                    val itemName = existing?.name ?: name.trim()
                    when {
                        itemName.isEmpty() -> error = "请填写名称"
                        existing == null && (if (kind == "provider") state.providers else state.ruleProviders).any { it.name == itemName } -> error = "名称已存在"
                        existing == null && (values["url"] as? JsonPrimitive)?.contentOrNull.isNullOrBlank() -> error = "请填写链接"
                        else -> {
                            if (values.isNotEmpty() || existing == null) state.collection("$kind.${if (existing == null) "add" else "set"}", itemName, values)
                            onDismiss()
                        }
                    }
                })
            }
        }
    }
    EditDialog(show = editing != null, title = editing?.label.orEmpty(),
        initial = editing?.let { fieldText(values[it.id] ?: it.value) }.orEmpty(),
        summary = editing?.placeholder?.ifEmpty { null }?.let { "留空使用默认值 $it" },
        onDismiss = { editing = null }) { text ->
        val field = editing ?: return@EditDialog null
        val trimmed = text.trim()
        val value: JsonElement = when {
            trimmed.isEmpty() -> JsonNull
            field.type == "int" -> JsonPrimitive(trimmed.toLongOrNull() ?: return@EditDialog "请输入整数")
            else -> JsonPrimitive(trimmed)
        }
        if (field.type == "url" && trimmed.isNotEmpty() && !trimmed.matches(Regex("^https?://\\S+$"))) return@EditDialog "请输入 http(s) 链接"
        values = values + (field.id to value)
        editing = null
        null
    }
    ConfirmDialog(show = confirmDelete, title = "删除 ${existing?.name.orEmpty()}", summary = "保存后生效。", confirm = "删除", danger = true,
        onDismiss = { confirmDelete = false }) {
        confirmDelete = false
        existing?.let { state.collection("$kind.delete", it.name) }
        onDismiss()
    }
}
