package mihomo

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Backup
import top.yukonga.miuix.kmp.icon.extended.Update

/** 更新页的在线数据更新：面板、GEO 数据、订阅、规则集。离开页面也继续跑完，回来能看到结果。 */
private object DataUpdates {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    var running by mutableStateOf("")
        private set
    var result by mutableStateOf("")
        private set
    var failed by mutableStateOf(false)
        private set

    private suspend fun providers(kind: String, label: String): String {
        val response = request("providersUpdate", json("kind" to kind))
        val total = (response["total"] as? JsonPrimitive)?.intOrNull ?: 0
        val bad = (response["failed"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
        return when {
            total == 0 -> "没有在线$label"
            bad.isEmpty() -> "${label}已全部更新（$total 个）"
            else -> "${label}部分更新失败：${bad.joinToString("、")}"
        }
    }

    private suspend fun step(key: String): String = when (key) {
        "dashboard" -> { request("dashboardUpgrade"); "面板已更新，浏览器里刷新一下即可" }
        "geo" -> { request("geoUpdate"); "GEO 数据已更新" }
        "proxies" -> providers("proxies", "订阅")
        else -> providers("rules", "规则集")
    }

    private val labels = mapOf("dashboard" to "面板", "geo" to "GEO 数据", "proxies" to "订阅", "rules" to "规则集")

    /** [keys] 依次更新（不并发，免得同时下载占满带宽）；全部更新时面板没配置就跳过。 */
    fun run(keys: List<String>) {
        if (running.isNotEmpty()) return
        running = if (keys.size > 1) "all" else keys.first()
        result = ""
        failed = false
        scope.launch {
            val lines = mutableListOf<String>()
            for (key in keys) {
                try {
                    lines += step(key).also { if ("失败" in it) failed = true }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    val message = failure.message ?: "未知错误"
                    if (keys.size > 1 && key == "dashboard" && "external-ui" in message) lines += "未配置面板，已跳过"
                    else { lines += "${labels[key]}更新失败：$message"; failed = true }
                }
            }
            result = lines.joinToString("\n")
            running = ""
        }
    }
}

/** 更新：模块、内核与 Sub-Store 的入口，以及面板、GEO 数据、订阅和规则集的在线更新。 */
@Composable
fun UpdatesPage(onBack: () -> Unit, onNavigate: (String) -> Unit) {
    val data = DataUpdates
    val idle = data.running.isEmpty()
    val serviceOn = LiveOverview.running == true
    fun busyText(key: String, text: String) = if (data.running == key || data.running == "all") "更新中…" else text
    Page(title = "更新", navigationIcon = { BackIcon(onBack) }) {
        banner(if (data.running.isNotEmpty()) "正在更新…" else "", BannerKind.Progress, "busy")
        banner(data.result, if (data.failed) BannerKind.Error else BannerKind.Success, "result")
        group("程序") {
            ArrowRow("模块", "检查并升级本模块，升级后立即生效", startIcon = MiuixIcons.Regular.Update) { onNavigate("module") }
            ArrowRow("mihomo 内核", "下载、更新或回滚内核", startIcon = MiuixIcons.Regular.Update) { onNavigate("core") }
            ArrowRow("Sub-Store", "后端与网页前端的安装和更新", startIcon = MiuixIcons.Regular.Backup) { onNavigate("substore") }
        }
        group("面板与数据") {
            if (!serviceOn) Caption("以下更新由运行中的内核下载，请先启动服务。", Tone.warning)
            val enabled = idle && serviceOn
            ArrowRow("面板", "按配置里的面板下载地址重新下载（默认 zashboard）", value = busyText("dashboard", "更新"),
                enabled = enabled) { data.run(listOf("dashboard")) }
            ArrowRow("GEO 数据", "GeoIP、GeoSite、MMDB，下载地址在内核配置里", value = busyText("geo", "更新"),
                enabled = enabled) { data.run(listOf("geo")) }
            ArrowRow("订阅", "所有在线订阅（HTTP 类型的代理集合）", value = busyText("proxies", "更新"),
                enabled = enabled) { data.run(listOf("proxies")) }
            ArrowRow("规则集", "所有在线规则集（HTTP 类型的规则集合）", value = busyText("rules", "更新"),
                enabled = enabled) { data.run(listOf("rules")) }
            ButtonRow {
                ActionButton(if (data.running == "all") "更新中…" else "全部更新", primary = true, enabled = enabled) {
                    data.run(listOf("geo", "proxies", "rules", "dashboard"))
                }
            }
        }
    }
}
