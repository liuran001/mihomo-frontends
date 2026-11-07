package mihomo

// 策略组：列表、排序与编辑表单。字段说明来自 shared/proxylink.js（与 LuCI 策略组页一致），
// 写入规则见 bridge/config.js 的 group.*。修改与节点一样先暂存，并立即在本地试算一遍。

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import top.yukonga.miuix.kmp.basic.BasicComponent
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Add
import top.yukonga.miuix.kmp.preference.CheckboxPreference
import top.yukonga.miuix.kmp.theme.MiuixTheme

internal data class GroupEntry(
    val name: String, val type: String, val lock: String, val summary: String, val data: JsonObject, val values: JsonObject,
    val inherited: List<String>, val heirs: List<String>, val refs: List<String>, val memberOf: List<String>,
)

internal data class GroupType(val id: String, val title: String, val help: String)

internal data class GroupView(
    val list: List<GroupEntry> = emptyList(),
    val proxies: List<String> = emptyList(),
    val builtin: List<String> = emptyList(),
    val providers: List<String> = emptyList(),
    val types: List<GroupType> = emptyList(),
    val fields: List<NodeField> = emptyList(),
    val defaults: JsonObject = JsonObject(emptyMap()),
    val unsupported: String = "",
)

/** 策略组弹窗的目标：group 为 null 表示新增。 */
internal data class GroupTarget(val group: GroupEntry?)

private fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

internal fun groupView(value: JsonElement?): GroupView {
    val obj = value as? JsonObject ?: return GroupView()
    return GroupView(
        list = obj.objects("list").map {
            GroupEntry(it.string("name"), it.string("type"), it.string("lock"), it.string("summary"),
                it["data"] as? JsonObject ?: JsonObject(emptyMap()), it["values"] as? JsonObject ?: JsonObject(emptyMap()),
                it.strings("inherited"), it.strings("heirs"), it.strings("refs"), it.strings("memberOf"))
        },
        proxies = obj.strings("proxies"), builtin = obj.strings("builtin"), providers = obj.strings("providers"),
        types = obj.objects("types").map { GroupType(it.string("id"), it.string("title"), it.string("help")) },
        fields = obj.objects("fields").map { it.nodeField() },
        defaults = obj["defaults"] as? JsonObject ?: JsonObject(emptyMap()),
        unsupported = obj.string("unsupported"),
    )
}

/** 谁在用这个组（列表摘要与删除提示共用）。 */
internal fun groupUsage(group: GroupEntry): String {
    val rules = group.refs.count { it.startsWith("规则第") }
    val parts = mutableListOf<String>()
    if (rules > 0) parts += "$rules 条规则"
    parts += group.refs.filter { !it.startsWith("规则第") }
    // 被很多组引用时（如总开关）只给数量，免得摘要过长
    if (group.memberOf.size > 3) parts += "${group.memberOf.size} 个策略组的成员"
    else if (group.memberOf.isNotEmpty()) parts += "策略组 ${group.memberOf.joinToString("、")} 的成员"
    return if (parts.isEmpty()) "" else "被 " + parts.joinToString("，") + " 使用"
}

private fun deleteBlock(group: GroupEntry): String? = when {
    group.heirs.isNotEmpty() -> "${group.heirs.joinToString("、")} 通过锚点继承了它，需要在配置原文中修改"
    group.refs.isNotEmpty() -> "正在被 ${group.refs.joinToString("、")} 使用，请先改成别的出站"
    else -> null
}

/** 「策略组」分组的内容。 */
@Composable
internal fun GroupRows(onOpen: (GroupEntry?) -> Unit) {
    val state = ProfileState
    val view = state.groups
    if (view.unsupported.isNotEmpty()) {
        Caption(view.unsupported, Tone.warning)
        return
    }
    Caption("规则把流量交给策略组，策略组再从成员里挑出实际使用的节点。排在前面的组在面板里也排在前面。")
    for (group in view.list) {
        val usage = groupUsage(group)
        val summary = listOf(group.lock.ifEmpty { group.summary }, usage).filter { it.isNotEmpty() }.joinToString(" · ")
        // 配置里的图标，与「代理」页一致；没有或加载失败时显示名称首字
        val icon = (group.data["icon"] as? JsonPrimitive)?.contentOrNull.orEmpty()
        ArrowRow(group.name, summary, enabled = group.lock.isEmpty() && state.busy.isEmpty(),
            startContent = { Box(Modifier.padding(end = 16.dp)) { GroupIcon(icon, group.name, 32.dp) } }) { onOpen(group) }
    }
    ArrowRow("新增策略组", "例如按地区自动选择，或给某类网站单独选出口", startIcon = MiuixIcons.Regular.Add,
        enabled = state.busy.isEmpty() && view.fields.isNotEmpty()) { onOpen(null) }
}

/** 小号文字按钮（成员列表里的上移、移除）。 */
@Composable
private fun MiniAction(text: String, enabled: Boolean = true, danger: Boolean = false, onClick: () -> Unit) {
    val color = when {
        !enabled -> Tone.muted.copy(alpha = 0.4f)
        danger -> MiuixTheme.colorScheme.error
        else -> MiuixTheme.colorScheme.primary
    }
    Text(text, fontSize = 13.sp, color = color,
        modifier = Modifier.clickable(enabled = enabled, onClick = onClick).padding(horizontal = 8.dp, vertical = 6.dp))
}

/** 有序的成员列表：可上移、移除，从下拉里添加。 */
@Composable
private fun MembersEditor(field: NodeField, members: List<String>, self: String?, onChange: (List<String>) -> Unit) {
    val state = ProfileState
    val groups = state.groups.list.map { it.name }.filter { it != self }
    Text(field.label, fontSize = 16.sp, color = MiuixTheme.colorScheme.onSurface,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp))
    Caption(field.help)
    if (members.isEmpty()) Caption("还没有成员（使用订阅或「包含全部」时可以不填）")
    members.forEachIndexed { index, name ->
        val kind = when (name) {
            in state.groups.builtin -> "内置"
            in groups -> "策略组"
            else -> "节点"
        }
        BasicComponent(title = "${index + 1}. $name", summary = kind, endActions = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                MiniAction("上移", enabled = index > 0) {
                    onChange(members.toMutableList().also { it.add(index - 1, it.removeAt(index)) })
                }
                MiniAction("移除", danger = true) { onChange(members - name) }
            }
        })
    }
    val choices = (state.groups.builtin.filter { it != "COMPATIBLE" } + groups + state.groups.proxies).filter { it !in members }
    if (choices.isNotEmpty()) {
        DropdownRow("添加成员", listOf("选择…") + choices.map { name ->
            when (name) {
                in state.groups.builtin -> "$name（内置）"
                in groups -> "$name（策略组）"
                else -> name
            }
        }, 0) { picked -> if (picked > 0) onChange(members + choices[picked - 1]) }
    }
}

@Composable
private fun ProvidersEditor(field: NodeField, selected: List<String>, onChange: (List<String>) -> Unit) {
    val providers = ProfileState.groups.providers
    if (providers.isEmpty() && selected.isEmpty()) return
    Text(field.label, fontSize = 16.sp, color = MiuixTheme.colorScheme.onSurface,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp))
    Caption(listOf(field.help, field.key).filter { it.isNotEmpty() }.joinToString(" · "))
    for (name in (providers + selected).distinct()) {
        CheckboxPreference(checked = name in selected, title = name, summary = if (name in providers) null else "订阅不存在",
            onCheckedChange = { onChange(if (it) selected + name else selected - name) })
    }
}

private fun JsonElement?.stringList(): List<String> = (this as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

@Composable
private fun GroupFieldRow(field: NodeField, values: Map<String, JsonElement>, self: String?, inherited: Boolean, onChange: (JsonElement) -> Unit) {
    val state = ProfileState
    when (field.kind) {
        "members" -> MembersEditor(field, values[field.key].stringList(), self) { list -> onChange(JsonArray(list.map { JsonPrimitive(it) })) }
        "providers" -> ProvidersEditor(field, values[field.key].stringList()) { list -> onChange(JsonArray(list.map { JsonPrimitive(it) })) }
        else -> {
            // 组为空时只能退回节点或内置出站，不能是策略组
            val policies = state.groups.builtin + state.groups.proxies
            val shown = if (inherited) field.copy(help = listOf("继承自锚点", field.help).filter { it.isNotEmpty() }.joinToString("；")) else field
            NodeFieldRow(shown, values[field.key], policies, self, onChange)
        }
    }
}

/** 策略组表单：新增（target.group 为 null）或编辑。 */
@Composable
internal fun GroupSheet(target: GroupTarget?, onDismiss: () -> Unit) {
    val state = ProfileState
    val scope = rememberCoroutineScope()
    val existing = target?.group
    val view = state.groups
    var values by remember(target) {
        val start = (existing?.values ?: view.defaults).toMutableMap()
        if (existing == null) start["type"] = JsonPrimitive("select")
        mutableStateOf<Map<String, JsonElement>>(start)
    }
    val position = existing?.let { group -> view.list.indexOfFirst { it.name == group.name } } ?: -1
    var moveTo by remember(target) { mutableStateOf(position) }
    var advanced by remember(target) { mutableStateOf(false) }
    var error by remember(target) { mutableStateOf("") }
    var working by remember(target) { mutableStateOf(false) }
    var confirmDelete by remember(target) { mutableStateOf(false) }
    val self = existing?.name
    val type = (values["type"] as? JsonPrimitive)?.contentOrNull.orEmpty()
    Sheet(show = target != null, title = existing?.name ?: "新增策略组", onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                val shown = view.fields.filter { visible(it, values) }
                val inherited = existing?.inherited.orEmpty()
                SheetCard {
                    for (field in shown.filter { !it.adv }) {
                        if (field.key == "type") {
                            val index = view.types.indexOfFirst { it.id == type }
                            DropdownRow(if (field.key in inherited) "类型（继承自锚点）" else "类型 *", view.types.map { it.title }, index.coerceAtLeast(0),
                                view.types.getOrNull(index)?.help) { values = values + ("type" to JsonPrimitive(view.types[it].id)) }
                        } else GroupFieldRow(field, values, self, field.key in inherited) { values = values + (field.key to it) }
                    }
                }
                val adv = shown.filter { it.adv }
                if (adv.isNotEmpty()) SheetCard {
                    SwitchRow("高级选项", advanced, "测速细节、排除节点、隐藏等，一般保持默认") { advanced = it }
                    if (advanced) for (field in adv) GroupFieldRow(field, values, self, field.key in inherited) { values = values + (field.key to it) }
                }
                if (existing != null && view.list.size > 1) SheetCard {
                    DropdownRow("排列位置", view.list.indices.map { "第 ${it + 1} 个" + if (it == position) "（当前）" else "" }, moveTo,
                        "决定在面板里的顺序") { moveTo = it }
                }
                if (existing != null) {
                    val usage = groupUsage(existing)
                    if (usage.isNotEmpty()) Caption(usage)
                    if (inherited.isNotEmpty()) Caption("${inherited.joinToString("、")} 继承自锚点（<<），可以在这里覆盖，但不能删除。")
                }
            }
            if (error.isNotEmpty()) Caption(error, Tone.danger)
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (existing != null) TextButton("删除", onClick = {
                    val block = deleteBlock(existing)
                    if (block != null) error = "不能删除：$block" else confirmDelete = true
                }, enabled = !working, modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColors(textColor = MiuixTheme.colorScheme.error))
                TextButton("完成", modifier = Modifier.weight(1f), enabled = !working && view.fields.isNotEmpty(),
                    colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                        val name = (values["name"] as? JsonPrimitive)?.contentOrNull.orEmpty().trim()
                        if (name != self && (view.list.any { it.name == name } || name in view.proxies || name in view.builtin)) {
                            error = "名称已被占用：$name"
                            return@TextButton
                        }
                        working = true
                        scope.launch {
                            try {
                                val base = existing?.data ?: JsonObject(emptyMap())
                                val built = request("groupBuild", json("base" to base, "values" to JsonObject(values)))
                                val group = built["group"] as JsonObject
                                if (existing == null) state.stage(json("op" to "group.add", "data" to group))
                                else {
                                    if (group != existing.data) state.stage(json("op" to "group.set", "name" to existing.name, "data" to group))
                                    if (moveTo != position) state.stage(json("op" to "group.move", "name" to name, "to" to moveTo))
                                }
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
    ConfirmDialog(show = confirmDelete, title = "删除 ${existing?.name.orEmpty()}",
        summary = if (existing?.memberOf?.isNotEmpty() == true) "同时从 ${existing.memberOf.joinToString("、")} 的成员里移除。保存后生效。" else "保存后生效。",
        confirm = "删除", danger = true, onDismiss = { confirmDelete = false }) {
        confirmDelete = false
        val name = existing?.name ?: return@ConfirmDialog
        scope.launch {
            try {
                state.stage(json("op" to "group.delete", "name" to name))
                onDismiss()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                error = failure.message ?: "删除失败"
            }
        }
    }
}
