package mihomo

// 分流规则：列表、搜索、编辑、排序与增删。与 LuCI 规则页一致，保存时生成一次 rules.set（bridge/config.js），
// 未改动的规则按原下标引用，原有注释随规则一起保留。

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.delay
import androidx.compose.ui.unit.dp
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
import top.yukonga.miuix.kmp.icon.extended.Sort
import top.yukonga.miuix.kmp.theme.MiuixTheme

internal data class RuleView(
    val list: List<String> = emptyList(),
    val policies: List<String> = emptyList(),
    val ruleSets: List<String> = emptyList(),
    val unsupported: String = "",
)

/** 规则行：k 为配置里的原下标（新加的为 null），v 为规则文本。 */
internal data class RuleRow(val k: Int?, val v: String)

/** 规则弹窗的目标：pos 为 null 表示新增。 */
internal data class RuleTarget(val pos: Int?)

private fun JsonObject.texts(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

internal fun ruleView(value: JsonElement?): RuleView {
    val obj = value as? JsonObject ?: return RuleView()
    return RuleView(obj.texts("list"), obj.texts("policies"), obj.texts("ruleSets"), obj.string("unsupported"))
}

/** 规则类型与说明（顺序同 LuCI 规则页）；第三项为内容示例。 */
internal val RULE_TYPES = listOf(
    Triple("DOMAIN-SUFFIX", "域名及其子域名", "google.com"),
    Triple("DOMAIN", "完整域名", "www.google.com"),
    Triple("DOMAIN-KEYWORD", "域名包含关键字", "google"),
    Triple("DOMAIN-WILDCARD", "通配符域名", "*.google.com"),
    Triple("DOMAIN-REGEX", "域名正则", "^ads?\\."),
    Triple("GEOSITE", "域名分类（geosite）", "cn"),
    Triple("IP-CIDR", "目标 IPv4 网段", "1.1.1.0/24"),
    Triple("IP-CIDR6", "目标 IPv6 网段", "2001:db8::/32"),
    Triple("IP-SUFFIX", "目标 IP 后缀", "8.8.8.8/24"),
    Triple("IP-ASN", "目标 IP 所属网络（ASN）", "13335"),
    Triple("GEOIP", "目标 IP 所属地区", "CN"),
    Triple("SRC-IP-CIDR", "来源 IP 网段", "192.168.1.0/24"),
    Triple("SRC-IP-SUFFIX", "来源 IP 后缀", "192.168.1.1/24"),
    Triple("SRC-IP-ASN", "来源 IP 所属网络（ASN）", "13335"),
    Triple("SRC-GEOIP", "来源 IP 所属地区", "CN"),
    Triple("DST-PORT", "目标端口", "443 或 8000-9000"),
    Triple("SRC-PORT", "来源端口", "7777"),
    Triple("IN-PORT", "入站端口", "7890"),
    Triple("IN-TYPE", "入站类型", "HTTP/SOCKS/TPROXY"),
    Triple("IN-USER", "入站用户名", "user"),
    Triple("IN-NAME", "入站名称", "ebpf-in"),
    Triple("PROCESS-NAME", "应用包名或进程名", "com.android.chrome"),
    Triple("PROCESS-PATH", "进程路径", "/system/bin/app"),
    Triple("PROCESS-NAME-REGEX", "进程名正则", "(?i)chrome"),
    Triple("PROCESS-PATH-REGEX", "进程路径正则", "^/data/app/"),
    Triple("UID", "应用 UID", "10123"),
    Triple("NETWORK", "网络协议", "tcp 或 udp"),
    Triple("DSCP", "DSCP 标记", "4"),
    Triple("RULE-SET", "规则集", ""),
    Triple("MATCH", "兜底：其余所有流量", ""),
)
private val RULE_LOGIC = listOf("AND", "OR", "NOT", "SUB-RULE")
private val RULE_OPTS = listOf("no-resolve" to "不为匹配而解析域名", "src" to "按来源 IP 匹配")
private val IP_TYPES = listOf("IP-CIDR", "IP-CIDR6", "IP-SUFFIX", "IP-ASN", "GEOIP", "RULE-SET")

internal data class ParsedRule(val type: String, val value: String, val policy: String, val opts: List<String>, val raw: String) {
    val logic: Boolean get() = type in RULE_LOGIC
}

/** 按最外层的逗号切分（逻辑规则的括号里也有逗号）。 */
internal fun splitTop(text: String): List<String> {
    val out = mutableListOf<String>()
    var depth = 0
    val current = StringBuilder()
    for (c in text) {
        if (c == '(') depth++ else if (c == ')') depth = (depth - 1).coerceAtLeast(0)
        if (c == ',' && depth == 0) { out += current.toString().trim(); current.clear() } else current.append(c)
    }
    out += current.toString().trim()
    return out
}

internal fun parseRule(text: String): ParsedRule {
    val parts = splitTop(text)
    val type = parts.getOrElse(0) { "" }.uppercase()
    return if (type == "MATCH") ParsedRule(type, "", parts.getOrElse(1) { "" }, parts.drop(2), text)
    else ParsedRule(type, parts.getOrElse(1) { "" }, parts.getOrElse(2) { "" }, parts.drop(3), text)
}

internal fun buildRule(type: String, value: String, policy: String, opts: List<String>): String =
    (if (type == "MATCH") listOf("MATCH", policy) else listOf(type, value, policy)).plus(opts).joinToString(",")

/** 能拆成「类型、内容、策略、参数」并原样拼回的规则用表单编辑，其余直接编辑文本。 */
private fun formEditable(rule: ParsedRule): Boolean =
    RULE_TYPES.any { it.first == rule.type } && rule.opts.all { opt -> RULE_OPTS.any { it.first == opt } } &&
        buildRule(rule.type, rule.value, rule.policy, rule.opts) == splitTop(rule.raw).joinToString(",")

private fun ruleTitle(rule: ParsedRule): String = when {
    rule.type == "MATCH" -> "其余所有流量"
    rule.logic -> "${rule.type} 组合规则"
    else -> rule.value.ifEmpty { "-" }
}

private fun ruleSummary(rule: ParsedRule): String {
    val label = RULE_TYPES.firstOrNull { it.first == rule.type }?.second
    val kind = if (rule.logic) rule.value else listOfNotNull(rule.type, label).joinToString(" · ")
    return "$kind → ${rule.policy.ifEmpty { "?" }}" + if (rule.opts.isNotEmpty()) " · ${rule.opts.joinToString(",")}" else ""
}

private const val RULE_CHUNK = 40

/** 规则子页的列表内容。修改只改 ProfileState.ruleRows，保存时一起写入。 */
internal fun LazyListScope.rulesContent(query: String, onQuery: (String) -> Unit, onSort: () -> Unit, onEdit: (RuleTarget) -> Unit) {
    val state = ProfileState
    val view = state.rules
    if (view.unsupported.isNotEmpty()) {
        item(key = "rules-unsupported") { Caption(view.unsupported, Tone.warning) }
        return
    }
    group(null, "rules-head") {
        Caption("从上往下逐条匹配，命中第一条就按它的策略走，所以越具体的规则应排得越靠前；最后一条 MATCH 兜底其余所有流量。")
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) { InputField("搜索规则（类型、内容或策略）", query) { onQuery(it) } }
        ArrowRow("新增规则", "按域名、IP、应用等条件指定走哪个策略", startIcon = MiuixIcons.Regular.Add,
            enabled = state.busy.isEmpty()) { onEdit(RuleTarget(null)) }
        if (state.ruleRows.size > 1) ArrowRow("调整顺序", "按住拖动，直接调整规则的先后", startIcon = MiuixIcons.Regular.Sort,
            enabled = state.busy.isEmpty()) { onSort() }
    }
    val rows = state.ruleRows.withIndex().filter { (_, row) -> query.isBlank() || row.v.contains(query.trim(), ignoreCase = true) }
    item(key = "rules-count") {
        Caption(if (query.isBlank()) "共 ${rows.size} 条" else "找到 ${rows.size} / ${state.ruleRows.size} 条")
    }
    // 规则可能有上千条：按块放进懒加载列表
    rows.chunked(RULE_CHUNK).forEachIndexed { chunk, part ->
        group(null, "rules-$chunk") {
            for ((pos, row) in part) {
                val rule = parseRule(row.v)
                val mark = when {
                    row.k == null -> "（新）"
                    row.v != state.rules.list.getOrNull(row.k) -> "（已改）"
                    else -> ""
                }
                BasicComponent(title = "${pos + 1}. ${ruleTitle(rule)}$mark", summary = ruleSummary(rule),
                    onClick = if (state.busy.isEmpty()) ({ onEdit(RuleTarget(pos)) }) else null)
            }
        }
    }
}

/** 拖动排序：按住右侧把手上下拖动，拖到列表边缘时自动滚动；「完成」后一次写回 ruleRows，保存时与其它修改一起写入。 */
@Composable
internal fun RuleOrderSheet(show: Boolean, onDismiss: () -> Unit) {
    val state = ProfileState
    // IndexedValue.index 是打开时的位置，作为拖动期间稳定的 key
    var order by remember(show) { mutableStateOf(state.ruleRows.withIndex().toList()) }
    var dragging by remember(show) { mutableStateOf<Int?>(null) }
    var offset by remember(show) { mutableStateOf(0f) }
    val list = rememberLazyListState()
    val changed = order.withIndex().any { (pos, item) -> pos != item.index }

    // 被拖动的一行越过相邻行的中线就交换，偏移量随之扣掉位移，手指下的行保持不动
    fun reorder() {
        val id = dragging ?: return
        val visible = list.layoutInfo.visibleItemsInfo
        val current = visible.firstOrNull { it.key == id } ?: return
        val center = current.offset + current.size / 2f + offset
        val target = visible.firstOrNull { it.key != id && it.key is Int && center >= it.offset && center <= it.offset + it.size } ?: return
        val from = order.indexOfFirst { it.index == id }
        val to = order.indexOfFirst { it.index == target.key }
        if (from < 0 || to < 0) return
        // 列表默认按 key 锚定滚动位置：被拖的行换到第一行时会把它推出可视区，所以按下标保持当前位置
        val anchor = list.firstVisibleItemIndex to list.firstVisibleItemScrollOffset
        order = order.toMutableList().apply { add(to, removeAt(from)) }
        list.requestScrollToItem(anchor.first, anchor.second)
        offset += (current.offset - target.offset).toFloat()
    }

    LaunchedEffect(dragging) {
        // 拖到可视区上下边缘时持续滚动
        while (dragging != null) {
            val info = list.layoutInfo
            val current = info.visibleItemsInfo.firstOrNull { it.key == dragging }
            if (current != null) {
                val top = current.offset + offset
                val bottom = top + current.size
                val edge = 56f
                val step = when {
                    top < info.viewportStartOffset + edge -> -18f
                    bottom > info.viewportEndOffset - edge -> 18f
                    else -> 0f
                }
                if (step != 0f) {
                    val moved = list.scrollBy(step)
                    offset += moved
                    reorder()
                }
            }
            delay(16)
        }
    }

    Sheet(show = show, title = "调整规则顺序", onDismissRequest = onDismiss) {
        Caption("按住右侧把手上下拖动。越靠前越先匹配；MATCH 兜底规则一般放在最后。")
        LazyColumn(state = list, modifier = Modifier.fillMaxWidth().heightIn(max = 560.dp).padding(top = 8.dp)) {
            itemsIndexed(order, key = { _, item -> item.index }) { pos, item ->
                val active = dragging == item.index
                val rule = remember(item.value.v) { parseRule(item.value.v) }
                Row(
                    Modifier.fillMaxWidth()
                        .zIndex(if (active) 1f else 0f)
                        .graphicsLayer { translationY = if (active) offset else 0f }
                        .background(if (active) MiuixTheme.colorScheme.secondaryContainer else Color.Transparent, RoundedCornerShape(12.dp))
                        .padding(start = 12.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("${pos + 1}. ${ruleTitle(rule)}", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(ruleSummary(rule), fontSize = 13.sp, color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Box(
                        Modifier.size(48.dp).pointerInput(item.index) {
                            detectDragGestures(
                                onDragStart = { dragging = item.index; offset = 0f },
                                onDragEnd = { dragging = null; offset = 0f },
                                onDragCancel = { dragging = null; offset = 0f },
                                onDrag = { change, amount ->
                                    change.consume()
                                    offset += amount.y
                                    reorder()
                                },
                            )
                        },
                        contentAlignment = Alignment.Center,
                    ) {
                        // 拖动把手：三道横线
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            repeat(3) {
                                Box(Modifier.size(width = 18.dp, height = 2.dp)
                                    .background(MiuixTheme.colorScheme.onSurfaceVariantSummary, RoundedCornerShape(1.dp)))
                            }
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton("取消", onClick = onDismiss, modifier = Modifier.weight(1f))
            TextButton("完成", enabled = changed, modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                state.ruleRows = order.map { it.value }
                onDismiss()
            })
        }
    }
}

/** 规则编辑：类型下拉 + 内容 + 策略 + 参数；逻辑规则等直接编辑文本。 */
@Composable
internal fun RuleSheet(target: RuleTarget?, onTarget: (RuleTarget?) -> Unit) {
    val state = ProfileState
    val pos = target?.pos
    val original = remember(target) {
        if (pos != null) parseRule(state.ruleRows[pos].v)
        else parseRule("DOMAIN-SUFFIX,," + (state.rules.policies.firstOrNull { it !in listOf("DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE") } ?: "DIRECT"))
    }
    val simple = remember(target) { formEditable(original) }
    var type by remember(target) { mutableStateOf(if (simple) original.type else "") }
    var value by remember(target) { mutableStateOf(original.value) }
    var policy by remember(target) { mutableStateOf(original.policy) }
    var opts by remember(target) { mutableStateOf(original.opts.toSet()) }
    var raw by remember(target) { mutableStateOf(original.raw) }
    var atEnd by remember(target) { mutableStateOf(true) }
    var error by remember(target) { mutableStateOf("") }
    val sets = state.rules.ruleSets
    val policies = state.rules.policies.let { if (policy.isNotEmpty() && policy !in it) it + policy else it }
    fun text(): String = if (type.isEmpty()) raw.trim()
        else buildRule(type, if (type == "RULE-SET") value.ifEmpty { sets.firstOrNull().orEmpty() } else value.trim(), policy,
            RULE_OPTS.map { it.first }.filter { it in opts && type in IP_TYPES })
    fun move(to: Int) {
        val from = pos ?: return
        val rows = state.ruleRows.toMutableList()
        rows.add(to, rows.removeAt(from))
        state.ruleRows = rows
        onTarget(RuleTarget(to))
    }
    Sheet(show = target != null, title = if (pos == null) "新增规则" else "第 ${pos + 1} 条规则", onDismissRequest = { onTarget(null) }) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                SheetCard {
                    val labels = RULE_TYPES.map { "${it.first} · ${it.second}" } + "组合规则 / 其他（直接编辑文本）"
                    val index = RULE_TYPES.indexOfFirst { it.first == type }.let { if (it < 0) labels.lastIndex else it }
                    DropdownRow("匹配条件", labels, index, if (RULE_TYPES.getOrNull(index) == null) "AND / OR / NOT 等组合规则直接写完整的规则文本" else null) {
                        val picked = RULE_TYPES.getOrNull(it)?.first.orEmpty()
                        if (picked.isEmpty()) raw = text()
                        else if (type.isEmpty()) {
                            // 从文本切回表单：尽量沿用文本里的策略
                            parseRule(raw).policy.takeIf { it.isNotEmpty() }?.let { p -> policy = p }
                        }
                        if (picked == "RULE-SET" && value !in sets) value = sets.firstOrNull().orEmpty()
                        type = picked
                        error = ""
                    }
                    when {
                        type.isEmpty() -> Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                            InputField("规则文本，例如 AND,((DOMAIN-SUFFIX,a.com),(NETWORK,udp)),REJECT", raw, singleLine = false, minLines = 3) { raw = it; error = "" }
                        }
                        type == "RULE-SET" -> if (sets.isEmpty()) Caption("还没有规则集，请先在「内核配置 › 规则集」里添加。", Tone.warning)
                            else DropdownRow("规则集", sets, sets.indexOf(value).coerceAtLeast(0)) { value = sets[it] }
                        type != "MATCH" -> Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                            val example = RULE_TYPES.first { it.first == type }.third
                            InputField(if (example.isNotEmpty()) "内容，例如 $example" else "内容", value) { value = it; error = "" }
                        }
                    }
                    if (type.isNotEmpty()) DropdownRow("走哪个策略", policies, policies.indexOf(policy).coerceAtLeast(0),
                        "DIRECT 直连，REJECT 拦截，其余为策略组或节点") { policy = policies[it] }
                    if (type in IP_TYPES) for ((opt, help) in RULE_OPTS) {
                        SwitchRow(opt, opt in opts, help) { opts = if (it) opts + opt else opts - opt }
                    }
                    if (pos == null) DropdownRow("放在哪里", listOf("最前面（优先匹配）", "最后（MATCH 之前）"), if (atEnd) 1 else 0) { atEnd = it == 1 }
                }
                Caption("预览：${text()}")
                if (pos != null) Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton("移到最前", onClick = { move(0) }, enabled = pos > 0, modifier = Modifier.weight(1f))
                    TextButton("上移", onClick = { move(pos - 1) }, enabled = pos > 0, modifier = Modifier.weight(1f))
                    TextButton("下移", onClick = { move(pos + 1) }, enabled = pos < state.ruleRows.lastIndex, modifier = Modifier.weight(1f))
                }
            }
            if (error.isNotEmpty()) Caption(error, Tone.danger)
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (pos != null) TextButton("删除", onClick = {
                    state.ruleRows = state.ruleRows.toMutableList().also { it.removeAt(pos) }
                    onTarget(null)
                }, modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColors(textColor = MiuixTheme.colorScheme.error))
                TextButton("完成", modifier = Modifier.weight(1f), colors = ButtonDefaults.textButtonColorsPrimary(), onClick = {
                    val built = text()
                    val parsed = parseRule(built)
                    val problem = when {
                        built.isEmpty() || !built.contains(',') -> "规则至少需要「类型,策略」两段"
                        built.contains('\n') -> "规则不能换行"
                        type.isNotEmpty() && type != "MATCH" && parsed.value.isEmpty() -> "请填写内容"
                        parsed.policy.isEmpty() -> "请选择策略"
                        else -> null
                    }
                    if (problem != null) {
                        error = problem
                        return@TextButton
                    }
                    val rows = state.ruleRows.toMutableList()
                    if (pos == null) {
                        var at = 0
                        if (atEnd) {
                            at = rows.size
                            if (at > 0 && parseRule(rows[at - 1].v).type == "MATCH") at--
                        }
                        rows.add(at, RuleRow(null, built))
                    } else rows[pos] = rows[pos].copy(v = built)
                    state.ruleRows = rows
                    onTarget(null)
                })
            }
        }
    }
}
