package mihomo

// 单个节点：粘贴分享链接或按表单填写；字段与解析来自 shared/proxylink.js，写入规则与 LuCI 一致（bridge/config.js 的 proxy.*）。
// 修改与订阅/规则集一样先暂存，但会立即在本地试算一遍，出错时直接在弹窗里提示。

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.CardDefaults
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.preference.CheckboxPreference
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Add
import top.yukonga.miuix.kmp.icon.extended.Link
import top.yukonga.miuix.kmp.theme.MiuixTheme

internal data class NodeEntry(
    val name: String, val type: String, val server: String, val port: String, val lock: String,
    val groups: List<String>, val data: JsonObject?,
)

/** 节点弹窗的目标：node 为 null 表示新增。 */
internal data class NodeTarget(val node: NodeEntry?)

internal data class NodeGroup(val name: String, val type: String, val auto: Boolean, val editable: Boolean)

internal data class NodeView(
    val list: List<NodeEntry> = emptyList(),
    val groups: List<NodeGroup> = emptyList(),
    val policies: List<String> = emptyList(),
    val unsupported: String = "",
)

internal data class NodeField(
    val key: String, val label: String, val kind: String, val required: Boolean, val adv: Boolean, val help: String,
    val placeholder: String, val options: List<Pair<String, String>>, val whenKey: String?, val whenIn: List<String>,
)

private fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

internal fun nodeView(value: JsonElement?): NodeView {
    val obj = value as? JsonObject ?: return NodeView()
    return NodeView(
        list = obj.objects("list").map {
            NodeEntry(it.string("name"), it.string("type"), it.string("server"), it.string("port"), it.string("lock"),
                it.strings("groups"), it["data"] as? JsonObject)
        },
        groups = obj.objects("groups").map { NodeGroup(it.string("name"), it.string("type"), it.boolean("auto"), it.boolean("editable")) },
        policies = obj.strings("policies"),
        unsupported = obj.string("unsupported"),
    )
}

internal fun JsonObject.nodeField(): NodeField {
    val condition = this["when"] as? JsonObject
    return NodeField(string("key"), string("label"), string("kind"), boolean("required"), boolean("adv"), string("help"),
        string("placeholder"), objects("options").map { it.string("id") to it.string("title") },
        condition?.string("key"), condition?.strings("in").orEmpty())
}

/** 与 proxylink.js 的 visible() 一致：未填或关闭视为空值，空值等同于 TCP / 默认。 */
internal fun visible(field: NodeField, values: Map<String, JsonElement>): Boolean {
    val key = field.whenKey ?: return true
    val raw = (values[key] as? JsonPrimitive)?.contentOrNull.orEmpty().trim()
    val value = if (raw == "false") "" else raw
    return field.whenIn.any { option ->
        when {
            option == "true" -> value == "true"
            value.isEmpty() -> option == "" || option == "tcp"
            else -> value == option
        }
    }
}

internal val TYPE_LABELS = mapOf("select" to "手动选择", "smart" to "Smart 智能择优", "url-test" to "自动测速", "fallback" to "故障转移", "load-balance" to "负载均衡", "relay" to "链式")

/** 节点所在策略组的说明。 */
internal fun nodeGroupsText(node: NodeEntry, groups: List<NodeGroup>): String {
    val auto = groups.filter { it.auto }.map { it.name }
    return when {
        node.groups.isNotEmpty() -> "在 " + node.groups.joinToString("、") + if (auto.isNotEmpty()) "（另自动包含于 ${auto.size} 个组）" else ""
        auto.isNotEmpty() -> "自动包含于 " + auto.joinToString("、")
        else -> "未加入任何策略组"
    }
}

internal fun nodeSummary(node: NodeEntry): String {
    val host = if (node.server.contains(':')) "[${node.server}]" else node.server
    return listOf(node.type.ifEmpty { "?" }, if (node.server.isNotEmpty()) "$host:${node.port}" else "").filter { it.isNotEmpty() }.joinToString(" · ")
}

/** 「单个节点」分组的内容。 */
@Composable
internal fun NodeRows(onOpen: (NodeEntry?) -> Unit, onPaste: () -> Unit) {
    val state = ProfileState
    val view = state.nodes
    if (view.unsupported.isNotEmpty()) {
        Caption(view.unsupported, Tone.warning)
        return
    }
    Caption("直接写在配置里的节点，不随订阅更新。适合自建服务器或机场单独给的链接。")
    for (node in view.list) {
        val summary = if (node.lock.isNotEmpty()) "${nodeSummary(node)} · ${node.lock}" else "${nodeSummary(node)} · ${nodeGroupsText(node, view.groups)}"
        ArrowRow(node.name, summary, enabled = node.lock.isEmpty() && state.busy.isEmpty()) { onOpen(node) }
    }
    ArrowRow("粘贴分享链接", "支持 ss / vmess / vless / trojan / hysteria2 / tuic 等链接，一行一个", startIcon = MiuixIcons.Regular.Link,
        enabled = state.busy.isEmpty()) { onPaste() }
    ArrowRow("手动添加节点", "按表单逐项填写服务器信息", startIcon = MiuixIcons.Regular.Add,
        enabled = state.busy.isEmpty()) { onOpen(null) }
}

/** 选择要加入的策略组。自动包含全部节点的组和继承自锚点的组不能勾选。 */
@Composable
private fun GroupPicker(groups: List<NodeGroup>, selected: Set<String>, onChange: (Set<String>) -> Unit) {
    if (groups.isEmpty()) {
        Caption("配置里还没有策略组")
        return
    }
    // 能勾选的排在前面；继承自锚点的组合并成一句说明，免得列表太长
    for (group in groups.filter { it.auto || it.editable }.sortedBy { if (it.auto) 1 else 0 }) {
        val type = TYPE_LABELS[group.type] ?: group.type
        CheckboxPreference(checked = group.auto || group.name in selected, title = group.name,
            summary = if (group.auto) "$type · 自动包含全部节点" else type, enabled = !group.auto,
            onCheckedChange = { onChange(if (it) selected + group.name else selected - group.name) })
    }
    val locked = groups.filter { !it.auto && !it.editable }.map { it.name }
    if (locked.isNotEmpty()) Caption("${locked.joinToString("、")} 的成员继承自锚点（<<），需要在配置原文中修改。")
}

private fun pickedGroups(groups: List<NodeGroup>, selected: Set<String>): JsonArray =
    JsonArray(groups.filter { !it.auto && it.editable && it.name in selected }.map { JsonPrimitive(it.name) })

@Composable
internal fun SheetCard(content: @Composable () -> Unit) {
    Card(Modifier.padding(top = 12.dp), colors = CardDefaults.defaultColors(color = MiuixTheme.colorScheme.secondaryContainer)) {
        CompositionLocalProvider(LocalFieldBackground provides MiuixTheme.colorScheme.surfaceContainer) { content() }
    }
}

/** 粘贴分享链接：解析预览 → 选择策略组 → 暂存。 */
@Composable
internal fun NodePasteSheet(show: Boolean, onDismiss: () -> Unit) {
    val state = ProfileState
    val scope = rememberCoroutineScope()
    var text by remember(show) { mutableStateOf("") }
    var parsed by remember(show) { mutableStateOf<List<Pair<JsonObject, String>>>(emptyList()) }
    var errors by remember(show) { mutableStateOf<List<String>>(emptyList()) }
    var selected by remember(show) { mutableStateOf(state.nodes.groups.filter { it.type == "select" && it.editable && !it.auto }.take(1).map { it.name }.toSet()) }
    var error by remember(show) { mutableStateOf("") }
    var working by remember(show) { mutableStateOf(false) }
    LaunchedEffect(text) {
        if (text.isBlank()) { parsed = emptyList(); errors = emptyList(); return@LaunchedEffect }
        kotlinx.coroutines.delay(250)
        try {
            val taken = state.nodes.policies + state.providers.map { it.name }
            val result = request("nodeParse", json("text" to text, "taken" to taken))
            parsed = result.objects("nodes").mapNotNull { entry -> (entry["node"] as? JsonObject)?.let { it to entry.string("summary") } }
            errors = result.objects("errors").map { "第 ${it.string("line")} 行：${it.string("error")}（${it.string("text")}）" }
            error = ""
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            parsed = emptyList(); errors = emptyList(); error = failure.message ?: "解析失败"
        }
    }
    Sheet(show = show, title = "粘贴分享链接", onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                InputField("分享链接（一行一个，也可以粘贴 base64 订阅内容）", text, singleLine = false, minLines = 4) { text = it }
                if (parsed.isNotEmpty()) SheetCard {
                    for ((node, summary) in parsed) InfoRow((node["name"] as? JsonPrimitive)?.contentOrNull.orEmpty(), "", summary)
                }
                for (line in errors) Caption(line, Tone.danger)
                if (parsed.isNotEmpty()) {
                    Caption("加入哪些策略组（之后可以在节点里修改）")
                    SheetCard { GroupPicker(state.nodes.groups, selected) { selected = it } }
                }
            }
            if (error.isNotEmpty()) Caption(error, Tone.danger)
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton("取消", onClick = onDismiss, modifier = Modifier.weight(1f))
                TextButton(if (parsed.isEmpty()) "添加" else "添加 ${parsed.size} 个节点", modifier = Modifier.weight(1f),
                    enabled = parsed.isNotEmpty() && !working, colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                        working = true
                        scope.launch {
                            try {
                                state.stage(json("op" to "proxy.add", "nodes" to JsonArray(parsed.map { it.first }),
                                    "groups" to pickedGroups(state.nodes.groups, selected)))
                                onDismiss()
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (failure: Exception) {
                                error = failure.message ?: "添加失败"
                            } finally {
                                working = false
                            }
                        }
                    })
            }
        }
    }
}

/** 节点表单：新增（existing 为 null）或编辑。 */
@Composable
internal fun NodeSheet(target: NodeTarget?, onDismiss: () -> Unit) {
    val state = ProfileState
    val scope = rememberCoroutineScope()
    val existing = target?.node
    var type by remember(target) { mutableStateOf(existing?.type ?: "vless") }
    var types by remember(target) { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    var fields by remember(target) { mutableStateOf<List<NodeField>>(emptyList()) }
    var values by remember(target) { mutableStateOf<Map<String, JsonElement>>(emptyMap()) }
    var extra by remember(target) { mutableStateOf<List<String>>(emptyList()) }
    var advanced by remember(target) { mutableStateOf(false) }
    var selected by remember(target) {
        mutableStateOf(existing?.groups?.toSet() ?: state.nodes.groups.filter { it.type == "select" && it.editable && !it.auto }.take(1).map { it.name }.toSet())
    }
    var error by remember(target) { mutableStateOf("") }
    var working by remember(target) { mutableStateOf(false) }
    var confirmDelete by remember(target) { mutableStateOf(false) }
    // 换类型时只带上名称、服务器、端口
    LaunchedEffect(target, type) {
        if (target == null) return@LaunchedEffect
        try {
            val node = if (existing?.data != null && existing.type == type) existing.data
            else JsonObject(listOf("name", "server", "port").mapNotNull { key ->
                (values[key] ?: existing?.data?.get(key))?.let { key to it }
            }.toMap())
            val form = request("nodeForm", json("type" to type, "node" to node))
            types = form.objects("types").map { it.string("id") to it.string("title") }
            fields = form.objects("fields").map { it.nodeField() }
            val fresh = (form["values"] as? JsonObject).orEmpty()
            values = fresh + listOf("name", "server", "port").mapNotNull { key -> values[key]?.let { key to it } }
            extra = if (existing?.type == type) form.strings("extra") else emptyList()
            error = ""
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            error = failure.message ?: "读取表单失败"
        }
    }
    val self = existing?.name
    Sheet(show = target != null, title = existing?.name ?: "添加节点", onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                if (types.isNotEmpty()) SheetCard {
                    val index = types.indexOfFirst { it.first == type }
                    DropdownRow("协议", types.map { it.second }, if (index >= 0) index else 0, "与服务端一致；分享链接开头的协议名（type）") {
                        type = types[it].first
                    }
                }
                val shown = fields.filter { visible(it, values) }
                SheetCard { for (field in shown.filter { !it.adv }) NodeFieldRow(field, values[field.key], state.nodes.policies, self) { values = values + (field.key to it) } }
                val adv = shown.filter { it.adv }
                if (adv.isNotEmpty()) SheetCard {
                    SwitchRow("高级选项", advanced, "TLS 指纹、UDP、前置代理等，一般保持默认") { advanced = it }
                    if (advanced) for (field in adv) NodeFieldRow(field, values[field.key], state.nodes.policies, self) { values = values + (field.key to it) }
                }
                if (extra.isNotEmpty()) Caption("另有表单未覆盖的字段（${extra.joinToString("、")}），保存时原样保留。")
                Caption("加入哪些策略组")
                SheetCard { GroupPicker(state.nodes.groups, selected) { selected = it } }
            }
            if (error.isNotEmpty()) Caption(error, Tone.danger)
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (existing != null) TextButton("删除", onClick = { confirmDelete = true }, enabled = !working, modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.textButtonColors(textColor = MiuixTheme.colorScheme.error))
                TextButton("完成", modifier = Modifier.weight(1f), enabled = !working && fields.isNotEmpty(),
                    colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                        working = true
                        scope.launch {
                            try {
                                val base = existing?.data ?: JsonObject(emptyMap())
                                val built = request("nodeBuild", json("base" to base, "type" to type, "values" to JsonObject(values)))
                                val node = built["node"] as JsonObject
                                val groups = pickedGroups(state.nodes.groups, selected)
                                state.stage(if (existing == null) json("op" to "proxy.add", "nodes" to JsonArray(listOf(node)), "groups" to groups)
                                else json("op" to "proxy.set", "name" to existing.name, "data" to node, "groups" to groups))
                                onDismiss()
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (failure: Exception) {
                                error = failure.message ?: "保存失败"
                            } finally {
                                working = false
                            }
                        }
                    })
            }
        }
    }
    ConfirmDialog(show = confirmDelete, title = "删除 ${existing?.name.orEmpty()}", summary = "同时从策略组里移除。保存后生效。", confirm = "删除", danger = true,
        onDismiss = { confirmDelete = false }) {
        confirmDelete = false
        val name = existing?.name ?: return@ConfirmDialog
        scope.launch {
            try {
                state.stage(json("op" to "proxy.delete", "name" to name))
                onDismiss()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                error = failure.message ?: "删除失败"
            }
        }
    }
}

private fun JsonObject?.orEmpty(): Map<String, JsonElement> = this ?: emptyMap()

/** 单个字段：说明文字后附 mihomo 配置里的键名，方便对照原文。 */
@Composable
internal fun NodeFieldRow(field: NodeField, value: JsonElement?, policies: List<String>, self: String?, onChange: (JsonElement) -> Unit) {
    val label = if (field.required) "${field.label} *" else field.label
    val hint = listOf(field.help, field.key).filter { it.isNotEmpty() }.joinToString(" · ")
    val text = (value as? JsonPrimitive)?.contentOrNull.orEmpty()
    when (field.kind) {
        "bool" -> SwitchRow(label, (value as? JsonPrimitive)?.booleanOrNull == true, hint) { onChange(JsonPrimitive(it)) }
        "enum", "policy" -> {
            val options = if (field.kind == "policy") listOf("" to "不使用") + policies.filter { it != self }.map { it to it } else field.options
            val all = if (options.none { it.first == text }) options + (text to text) else options
            DropdownRow(label, all.map { it.second }, all.indexOfFirst { it.first == text }.coerceAtLeast(0), hint) { onChange(JsonPrimitive(all[it].first)) }
        }
        else -> {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                InputField(if (field.placeholder.isNotEmpty()) "$label（默认 ${field.placeholder}）" else label, text) { onChange(JsonPrimitive(it)) }
            }
            Caption(hint, modifier = Modifier.padding(top = 0.dp))
        }
    }
}
