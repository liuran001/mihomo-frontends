package mihomo

// 共享与数据面：把散落在「内核配置 › eBPF」里与数据面、共享设备有关的选项集中到一页，
// 与内核配置页共用 ProfileState 的草稿与保存流程（patch » 校验 » 写入）。

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.theme.MiuixTheme

private const val LISTENER = "@listener"

private val localFields = listOf("local.data-plane", "fakeip-icmp", "local.ipv6", "local.bypass-private-address", "local.bypass-exclude")
private val sharedFields = listOf("shared.data-plane", "shared.dns-mode", "shared.ipv6", "shared.bypass-private-address",
    "shared.bypass-exclude", "shared.bypass-port",
    "shared.exclude-mac-address", "shared.include-mac-address", "shared.exclude-source-cidr")

/** "5.10.198-android12" » 5.10 是否 ≥ 5.7。 */
private fun kernelSupportsAssign(release: String): Boolean? {
    val parts = Regex("^(\\d+)\\.(\\d+)").find(release)?.groupValues ?: return null
    val major = parts[1].toInt()
    val minor = parts[2].toInt()
    return major > 5 || (major == 5 && minor >= 7)
}

@Composable
fun NetworkPage(onBack: () -> Unit, onNavigate: (String) -> Unit) {
    val state = ProfileState
    var editing by remember { mutableStateOf<ConfigField?>(null) }
    var confirmSave by remember { mutableStateOf(false) }
    var kernel by remember { mutableStateOf("") }
    var tethering by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(Unit) {
        state.load()
        try {
            kernel = request("hostProbe").string("kernel")
            tethering = request("policyGet").boolean("tethering")
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
        }
    }
    val fields = state.sections.firstOrNull { it.id == "ebpf" }
    val byId = fields?.fields.orEmpty().associateBy { it.id.removePrefix("$LISTENER.") }
    Box(Modifier.fillMaxSize()) {
        Page(title = "共享高级设置", navigationIcon = { BackIcon(onBack) }, bottomPadding = if (state.dirty) 88.dp else 0.dp) {
            banner(state.busy, BannerKind.Progress, "busy")
            banner(state.error, BannerKind.Error, "error")
            banner(state.notice, BannerKind.Success, "notice")
            if (state.source == null) return@Page
            if (fields == null || !fields.available) {
                item(key = "missing") { Caption("当前配置还没有开启透明代理，请先在「设置 › 重新运行向导」里完成本机优化。", Tone.warning) }
                return@Page
            }
            val assign = kernelSupportsAssign(kernel)
            if (kernel.isNotEmpty()) {
                group(null, "kernel") {
                    InfoRow("本机内核", kernel.substringBefore('-'),
                        summary = when (assign) {
                            true -> "两种接管方式都能用"
                            false -> "低于 5.7，只能用推荐的默认方式"
                            null -> null
                        }, valueColor = if (assign == false) Tone.warning else Tone.muted)
                }
            }
            group("本机", "local") {
                for (id in localFields) byId[id]?.let { field -> ConfigFieldRow(field, state.value(field)) { editing = field } }
            }
            group("热点 / USB 共享的设备", "shared") {
                ArrowRow("共享给其它设备", "开关与共享网卡在「设置 › 共享代理」",
                    value = when (tethering) { true -> "已开启"; false -> "已关闭"; null -> "" }) { onNavigate("settings") }
                for (id in sharedFields) byId[id]?.let { field -> ConfigFieldRow(field, state.value(field)) { editing = field } }
            }
            item(key = "note") {
                Caption("这里的选项一般不用改。遇到问题时：热点能上网却不走代理，把共享设备接管方式换成 socket_assign；ping 域名不通，把本机接管方式换成 tc。")
            }
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
    SaveDialog(confirmSave, onDismiss = { confirmSave = false }) { restart -> confirmSave = false; state.save(restart) }
}
