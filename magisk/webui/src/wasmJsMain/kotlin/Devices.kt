package mihomo

// 共享设备：像 VPN 热点那样列出热点 / USB / 蓝牙共享出去的设备，逐台决定走不走代理，并显示每台设备经代理的速率与流量。
// 写的是 eBPF 入站的 shared.include-* / exclude-*（白名单 / 黑名单，MAC 与来源 IP 任一命中即算），
// 判断在内核的 eBPF 程序里完成：不走代理的设备连接直接放行，不进 mihomo（所以也统计不到它们的流量）。
// 名单与内核配置页共用 ProfileState 的草稿；只改了名单时拨动开关后自动保存并热重载内核。
// 设备标签页与首页的「共享设备」卡片共用 SharedDevices。

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Switch
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Refresh
import top.yukonga.miuix.kmp.theme.MiuixTheme

private const val DEVICE_LISTENER = "@listener"
private const val INC_MAC = "shared.include-mac-address"
private const val EXC_MAC = "shared.exclude-mac-address"
private const val INC_IP = "shared.include-source-cidr"
private const val EXC_IP = "shared.exclude-source-cidr"
private const val DNS_MODE = "shared.dns-mode"
private val deviceKeys = setOf(INC_MAC, EXC_MAC, INC_IP, EXC_IP, DNS_MODE)
private val deviceMacPattern = Regex("^([0-9a-f]{2}:){5}[0-9a-f]{2}$")
private val DeviceDown = Color(0xFF3482FF)
internal val SHARE_TYPES = listOf("wifi" to "Wi-Fi 热点", "usb" to "USB 网络共享", "bluetooth" to "蓝牙网络共享")

internal data class SharedClient(
    val mac: String,
    val name: String,
    val ipv4: String,
    val ipv6: List<String>,
    val iface: String,
    val state: String,
) {
    val title: String get() = name.ifEmpty { ipv4.ifEmpty { mac } }
    val addresses: List<String> get() = listOfNotNull(ipv4.ifEmpty { null }) + ipv6
}

/** 一台设备（或一条 IP 名单）经代理的流量：累计与最近两次采样之间的速率。 */
internal data class DeviceTraffic(val up: Double, val down: Double, val upRate: Double, val downRate: Double)

/** "AA-BB-CC-DD-EE-FF" / "aabb.ccdd.eeff" / "AABBCCDDEEFF" » "aa:bb:cc:dd:ee:ff"；格式不对返回 null。 */
internal fun normalizeMac(raw: String): String? {
    val hex = raw.trim().lowercase().filter { it.isLetterOrDigit() }
    if (hex.length != 12 || hex.any { it !in "0123456789abcdef" }) return null
    val mac = hex.chunked(2).joinToString(":")
    return mac.takeIf { deviceMacPattern.matches(it) && it != "00:00:00:00:00:00" }
}

// ---------------- IP / 网段 ----------------

private fun parseIpv4(text: String): ByteArray? {
    val parts = text.split('.')
    if (parts.size != 4) return null
    return ByteArray(4) { index ->
        val part = parts[index]
        if (part.isEmpty() || part.length > 3 || part.any { !it.isDigit() }) return null
        val value = part.toInt()
        if (value > 255) return null
        value.toByte()
    }
}

private fun parseIpv6(text: String): ByteArray? {
    if (text.count { it == ':' } < 2) return null
    val halves = text.split("::")
    if (halves.size > 2) return null
    fun groups(part: String) = if (part.isEmpty()) emptyList() else part.split(':')
    val head = groups(halves[0])
    val tail = if (halves.size == 2) groups(halves[1]) else emptyList()
    val all = head + tail
    if (all.any { group -> group.isEmpty() || group.length > 4 || group.any { it !in "0123456789abcdef" } }) return null
    val missing = 8 - all.size
    if ((halves.size == 1 && missing != 0) || (halves.size == 2 && missing < 1)) return null
    val words = head + List(if (halves.size == 2) missing else 0) { "0" } + tail
    val bytes = ByteArray(16)
    words.forEachIndexed { index, word ->
        val value = word.toInt(16)
        bytes[index * 2] = (value shr 8).toByte()
        bytes[index * 2 + 1] = value.toByte()
    }
    return bytes
}

private fun parseIp(text: String): ByteArray? = text.trim().lowercase().substringBefore('%').let { parseIpv4(it) ?: parseIpv6(it) }

/** "192.168.43.20" » "192.168.43.20/32"，"fd00::5" » "fd00::5/128"，网段保持原样；格式不对返回 null。 */
internal fun normalizeIpEntry(raw: String): String? {
    val text = raw.trim().lowercase()
    val address = text.substringBefore('/')
    val bytes = parseIp(address) ?: return null
    val bits = bytes.size * 8
    val prefix = if ('/' in text) text.substringAfter('/').toIntOrNull()?.takeIf { it in 0..bits } ?: return null else bits
    return "$address/$prefix"
}

internal fun cidrContains(cidr: String, ip: String): Boolean {
    val network = parseIp(cidr.substringBefore('/')) ?: return false
    val address = parseIp(ip) ?: return false
    if (network.size != address.size) return false
    val prefix = cidr.substringAfter('/', "").toIntOrNull() ?: (network.size * 8)
    for (bit in 0 until prefix.coerceAtMost(network.size * 8)) {
        val mask = 0x80 shr (bit % 8)
        if ((network[bit / 8].toInt() and mask) != (address[bit / 8].toInt() and mask)) return false
    }
    return true
}

private fun JsonElement.textList(): List<String> =
    (this as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty) }.orEmpty()

private fun listJson(list: List<String>): JsonElement = if (list.isEmpty()) JsonNull else JsonArray(list.map { JsonPrimitive(it) })

@JsFun("() => Date.now()")
private external fun deviceNow(): Double

// ---------------- 状态 ----------------

internal object SharedDevices {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    var clients by mutableStateOf<List<SharedClient>>(emptyList())
    var tethering by mutableStateOf<Boolean?>(null)
    var loading by mutableStateOf(false)
    var clientError by mutableStateOf("")
    var localError by mutableStateOf("")
    /** 拨动开关后等待自动保存（合并连续几次拨动）。 */
    var pending by mutableStateOf(false)
    /** 用户选了白名单但还没勾设备时，配置里的列表都为空，单靠配置分不出模式。 */
    var whitelistDraft by mutableStateOf<Boolean?>(null)

    /** 每个来源 IP 经代理的流量。 */
    var traffic by mutableStateOf<Map<String, DeviceTraffic>>(emptyMap())
    /** 内核没有按来源统计的接口（旧内核）。 */
    var trafficUnsupported by mutableStateOf(false)
    var trafficError by mutableStateOf("")
    private var sourcesUnsupported = false
    private var lastSample: Pair<Double, Map<String, Pair<Double, Double>>>? = null
    private var applyJob: Job? = null

    /** 系统网络共享（Wi-Fi 热点、USB、蓝牙）的状态，来自设备控制桥接。 */
    var share by mutableStateOf<JsonObject?>(null)
    var shareError by mutableStateOf("")
    /** 正在开关的共享类型。 */
    var shareBusy by mutableStateOf("")

    suspend fun readShare() {
        try {
            share = request("tetherStatus")
            shareError = ""
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            shareError = "读取网络共享状态失败：${failure.message ?: "未知错误"}"
        }
    }

    fun shareItem(type: String): JsonObject? = share?.get(type) as? JsonObject

    fun shareIfaces(type: String): List<String> =
        (shareItem(type)?.get("ifaces") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

    /** 正在共享、却没被接管的网卡（仅所选模式里没选、排除模式里被排除）：这些网卡上的设备不会走代理。 */
    fun missingIfaces(): List<String> {
        if (TetherPolicy.enabled != true) return emptyList()
        return SHARE_TYPES.flatMap { shareIfaces(it.first) }.distinct().filter { !TetherPolicy.covers(it) }
    }

    /** 开关一种网络共享；仅所选模式下开启后把新出现的共享网卡加入，保证这些设备也走代理（排除模式不自动改动用户的排除）。 */
    fun setShare(type: String, enabled: Boolean) {
        if (shareBusy.isNotEmpty()) return
        shareBusy = type
        shareError = ""
        scope.launch {
            try {
                share = request("tetherSet", json("type" to type, "enabled" to enabled))
                if (enabled && TetherPolicy.mode == "only") missingIfaces().takeIf { it.isNotEmpty() }?.let { TetherPolicy.addInterfaces(it) }
                readClients()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                shareError = failure.message ?: "操作失败"
                readShare()
            } finally {
                shareBusy = ""
            }
        }
    }

    // ---------- 读取 ----------

    suspend fun readClients() {
        loading = true
        try {
            val response = request("discoveryClients")
            tethering = response.boolean("tethering")
            clients = response.objects("clients").mapNotNull { item ->
                val mac = normalizeMac(item.string("mac")) ?: return@mapNotNull null
                SharedClient(mac, item.string("name"), item.string("ipv4"),
                    (item["ipv6"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty(),
                    item.string("iface"), item.string("state"))
            }
            clientError = ""
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            clientError = "读取已连接设备失败：${failure.message ?: "未知错误"}"
        } finally {
            loading = false
        }
    }

    private suspend fun controller(path: String): JsonObject =
        request("controller", json("path" to path, "method" to "GET"))["data"] as? JsonObject ?: error("控制器响应为空")

    private fun JsonObject.number(key: String): Double = (this[key] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull() ?: 0.0

    /**
     * 读每个来源 IP 的累计流量（内核 /connections/sources，只读计数器），与上一次采样相减得出速率。
     * 旧内核没有这个接口时不退回每 2 秒拉取全部连接（那样耗电），只提示更新内核。
     */
    suspend fun readTraffic() {
        if (sourcesUnsupported) return
        val totals = mutableMapOf<String, Pair<Double, Double>>()
        try {
            for (item in controller("/connections/sources").objects("sources")) {
                val key = item.string("source").lowercase()
                if (key.isNotEmpty()) totals[key] = item.number("upload") to item.number("download")
            }
            trafficError = ""
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            if (failure.message.orEmpty().let { "404" in it || "405" in it }) {
                sourcesUnsupported = true
                trafficUnsupported = true
            } else {
                trafficError = "读取设备流量失败：${failure.message ?: "未知错误"}"
            }
            return
        }
        val now = deviceNow()
        val previous = lastSample
        lastSample = now to totals
        val seconds = previous?.let { (now - it.first) / 1000 }?.takeIf { it > 0.2 }
        traffic = totals.mapValues { (key, value) ->
            val before = previous?.second?.get(key)
            val upRate = if (seconds != null && before != null) ((value.first - before.first) / seconds).coerceAtLeast(0.0) else 0.0
            val downRate = if (seconds != null && before != null) ((value.second - before.second) / seconds).coerceAtLeast(0.0) else 0.0
            DeviceTraffic(value.first, value.second, upRate, downRate)
        }
    }

    /**
     * 页面在前台且 WebUI 可见时运行，离开即停。耗电考虑：
     * 流量每 2 秒读一次（页面直接请求控制器，不起进程，内核只读计数器）；
     * 已连接设备要起 shell 读邻居表，设备页每 8 秒、首页卡片每 20 秒一次；
     * 网络共享状态要启动 app_process，只在进入设备页时读一次，之后每 60 秒一次（开关后会立即刷新）。
     */
    suspend fun poll(share: Boolean = true) {
        ProfileState.load()
        TetherPolicy.load()
        var lastClients = 0.0
        var lastShare = 0.0
        val clientsEvery = if (share) 8_000 else 20_000
        while (true) {
            awaitWebuiVisible()
            val now = deviceNow()
            if (now - lastClients >= clientsEvery) {
                lastClients = now
                readClients()
            }
            if (share && shareBusy.isEmpty() && now - lastShare >= 60_000) {
                lastShare = now
                readShare()
            }
            if (LiveOverview.running == true) readTraffic()
            delay(2000)
        }
    }

    fun trafficOf(addresses: List<String>): DeviceTraffic? {
        val matched = addresses.mapNotNull { traffic[it.lowercase()] }
        if (matched.isEmpty()) return null
        return DeviceTraffic(matched.sumOf { it.up }, matched.sumOf { it.down }, matched.sumOf { it.upRate },
            matched.sumOf { it.downRate })
    }

    /** 正在传输的排前面，其次按累计流量。 */
    fun sortedClients(): List<SharedClient> = clients.sortedWith(compareByDescending<SharedClient> { client ->
        trafficOf(client.addresses)?.let { it.downRate + it.upRate } ?: -1.0
    }.thenByDescending { client -> trafficOf(client.addresses)?.let { it.up + it.down } ?: -1.0 })

    fun trafficOfEntry(cidr: String): DeviceTraffic? = trafficOf(traffic.keys.filter { cidrContains(cidr, it) })

    // ---------- 名单 ----------

    private fun fields(): Map<String, ConfigField>? {
        val section = ProfileState.sections.firstOrNull { it.id == "ebpf" }?.takeIf { it.available } ?: return null
        return section.fields.associateBy { it.id.removePrefix("$DEVICE_LISTENER.") }.takeIf { INC_MAC in it && EXC_MAC in it }
    }

    val ready: Boolean get() = ProfileState.source != null && fields() != null

    private fun list(key: String): List<String> {
        val field = fields()?.get(key) ?: return emptyList()
        val values = ProfileState.value(field).textList()
        return if (key == INC_MAC || key == EXC_MAC) values.mapNotNull(::normalizeMac).distinct() else values.distinct()
    }

    val includeMac: List<String> get() = list(INC_MAC)
    val excludeMac: List<String> get() = list(EXC_MAC)
    val includeIp: List<String> get() = list(INC_IP)
    val excludeIp: List<String> get() = list(EXC_IP)
    val whitelist: Boolean get() = whitelistDraft ?: (includeMac.isNotEmpty() || includeIp.isNotEmpty())
    val ipSupported: Boolean get() = fields()?.let { INC_IP in it && EXC_IP in it } == true

    /** 命中当前模式 IP 名单的那一条（决定了这台设备的去向，开关不能单独改）。 */
    fun ipRule(client: SharedClient): String? {
        val entries = if (whitelist) includeIp else excludeIp
        return entries.firstOrNull { entry -> client.addresses.any { cidrContains(entry, it) } }
    }

    fun proxied(client: SharedClient): Boolean =
        if (whitelist) client.mac in includeMac || ipRule(client) != null
        else client.mac !in excludeMac && ipRule(client) == null

    fun proxiedMac(mac: String): Boolean = if (whitelist) mac in includeMac else mac !in excludeMac

    /** 写入名单；有名单时共享设备的 DNS 改为按名单（不代理的设备 DNS 也不进 mihomo），名单清空时恢复默认的接管。 */
    private fun write(incMac: List<String>, incIp: List<String>, excMac: List<String>, excIp: List<String>) {
        val byId = fields() ?: return
        val state = ProfileState
        val savedHasList = listOf(INC_MAC, EXC_MAC, INC_IP, EXC_IP).any { key -> byId[key]?.value?.textList().orEmpty().isNotEmpty() }
        byId[INC_MAC]?.let { state.set(it, listJson(incMac)) }
        byId[EXC_MAC]?.let { state.set(it, listJson(excMac)) }
        byId[INC_IP]?.let { state.set(it, listJson(incIp)) }
        byId[EXC_IP]?.let { state.set(it, listJson(excIp)) }
        byId[DNS_MODE]?.let { dns ->
            val current = (state.value(dns) as? JsonPrimitive)?.contentOrNull
            val active = (incMac + incIp + excMac + excIp).isNotEmpty()
            when {
                active -> if (current == null || current == "hijack") state.set(dns, JsonPrimitive("respect_policy"))
                savedHasList && current == "respect_policy" -> state.set(dns, JsonNull)
                !savedHasList -> state.set(dns, dns.value)
            }
        }
        localError = ""
        scheduleApply()
    }

    fun toggle(mac: String, proxy: Boolean) {
        if (whitelist) write(if (proxy) (includeMac + mac).distinct() else includeMac - mac, includeIp, emptyList(), emptyList())
        else write(emptyList(), emptyList(), if (proxy) excludeMac - mac else (excludeMac + mac).distinct(), excludeIp)
    }

    fun toggleIp(entry: String, proxy: Boolean) {
        if (whitelist) write(includeMac, if (proxy) (includeIp + entry).distinct() else includeIp - entry, emptyList(), emptyList())
        else write(emptyList(), emptyList(), excludeMac, if (proxy) excludeIp - entry else (excludeIp + entry).distinct())
    }

    /** 手动添加：MAC 或 IP / 网段，添加后按当前模式走代理（白名单）或不走代理（黑名单）。返回错误说明。 */
    fun add(text: String): String? {
        val mac = normalizeMac(text)
        if (mac != null) {
            if (whitelist) write((includeMac + mac).distinct(), includeIp, emptyList(), emptyList())
            else write(emptyList(), emptyList(), (excludeMac + mac).distinct(), excludeIp)
            return null
        }
        if (!ipSupported) return "MAC 地址格式不对"
        val ip = normalizeIpEntry(text) ?: return "请填写 MAC 地址，或 IP / 网段（例如 192.168.43.20、192.168.43.0/28）"
        if (whitelist) write(includeMac, (includeIp + ip).distinct(), emptyList(), emptyList())
        else write(emptyList(), emptyList(), excludeMac, (excludeIp + ip).distinct())
        return null
    }

    /** 换模式时保留每台已知设备现在走不走代理（按 MAC）；IP 名单在两种模式间无法等价换算，换模式时去掉。 */
    fun switchMode(toWhitelist: Boolean) {
        if (toWhitelist == whitelist) return
        val known = (clients.map { it.mac } + includeMac + excludeMac).distinct()
        val proxiedNow = known.filter { mac -> clients.firstOrNull { it.mac == mac }?.let(::proxied) ?: proxiedMac(mac) }
        whitelistDraft = toWhitelist
        if (toWhitelist) write(proxiedNow, emptyList(), emptyList(), emptyList())
        else write(emptyList(), emptyList(), known - proxiedNow.toSet(), emptyList())
    }

    /** 草稿里只有名单（与随之调整的 DNS）时才自动保存；还有别处未保存的修改时交给保存栏，免得顺带保存了别的。 */
    private fun onlyDeviceEdits(): Boolean = ProfileState.collectionOps.isEmpty() && !ProfileState.rulesDirty &&
        ProfileState.edits.keys.all { it.removePrefix("$DEVICE_LISTENER.") in deviceKeys }

    private fun blocked(): String? =
        if (whitelist && includeMac.isEmpty() && includeIp.isEmpty()) "白名单模式至少要选一台走代理的设备；一台都不代理时请在「设置 › 共享代理」里关闭共享。" else null

    private fun scheduleApply() {
        applyJob?.cancel()
        pending = false
        if (!ProfileState.dirty || !onlyDeviceEdits() || blocked() != null) return
        pending = true
        applyJob = scope.launch {
            delay(1200)
            while (ProfileState.busy.isNotEmpty()) delay(200)
            pending = false
            if (ProfileState.dirty && onlyDeviceEdits()) save()
        }
    }

    fun save() {
        applyJob?.cancel()
        pending = false
        blocked()?.let { localError = it; return }
        whitelistDraft = null
        ProfileState.save(ApplyMode.RELOAD)
    }

    fun discard() {
        applyJob?.cancel()
        pending = false
        whitelistDraft = null
        localError = ""
        ProfileState.discard()
    }

    /** 开关是否可拨：保存进行中时不可拨（保存结束会用新配置覆盖草稿）。 */
    val editable: Boolean get() = ProfileState.busy.isEmpty()

    /** 设备行的第二行：速率与累计流量，或为什么没有。 */
    fun trafficLine(traffic: DeviceTraffic?, proxied: Boolean): String = when {
        !proxied -> "直连，不经过 mihomo"
        LiveOverview.running != true -> "服务未运行"
        trafficUnsupported -> "走代理 · 更新内核后显示流量"
        traffic == null -> "暂无经代理的流量"
        else -> "↓ ${formatRate(traffic.downRate)}  ↑ ${formatRate(traffic.upRate)} · 共 " + formatBytes(traffic.up + traffic.down)
    }
}

// ---------------- 界面 ----------------

private fun ifaceLabel(name: String): String = when {
    name.startsWith("rndis") || name.startsWith("usb") || name.startsWith("ncm") -> "USB"
    name.startsWith("bt-pan") || name.startsWith("bnep") -> "蓝牙"
    else -> "热点"
}

/** 设备行：名称、地址、速率 / 流量，右侧开关「走代理」。首页卡片与设备页共用。 */
@Composable
internal fun DeviceRow(
    title: String,
    detail: String,
    trafficLine: String,
    active: Boolean,
    checked: Boolean,
    enabled: Boolean,
    compact: Boolean = false,
    onClick: (() -> Unit)? = null,
    onChange: (Boolean) -> Unit,
) {
    Row(Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
        .padding(horizontal = if (compact) 0.dp else 16.dp, vertical = if (compact) 8.dp else 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = MiuixTheme.colorScheme.onSurface,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (detail.isNotEmpty()) Text(detail, fontSize = 12.sp, color = Tone.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(trafficLine, fontSize = 12.sp, color = if (active) DeviceDown else Tone.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}

internal fun clientDetail(client: SharedClient, ipRule: String?): String = listOfNotNull(
    client.mac.takeIf { client.title != it },
    client.ipv4.takeIf { it.isNotEmpty() && client.title != it },
    client.iface.takeIf { it.isNotEmpty() }?.let(::ifaceLabel),
    ipRule?.let { "按 IP 名单 $it" },
).joinToString(" · ")

@Composable
internal fun ClientRow(client: SharedClient, compact: Boolean = false) {
    val devices = SharedDevices
    val proxied = devices.proxied(client)
    val rule = devices.ipRule(client)
    val traffic = devices.trafficOf(client.addresses)
    DeviceRow(client.title, clientDetail(client, rule), devices.trafficLine(traffic, proxied),
        active = proxied && (traffic?.let { it.downRate + it.upRate > 0 } == true),
        checked = proxied, enabled = devices.editable && devices.ready && rule == null, compact = compact) { devices.toggle(client.mac, it) }
}

@Composable
fun DevicesPage(onBack: (() -> Unit)?, onNavigate: (String) -> Unit) {
    val state = ProfileState
    val devices = SharedDevices
    val active = LocalPageActive.current
    var adding by remember { mutableStateOf(false) }
    var confirmOff by remember { mutableStateOf<String?>(null) }
    var confirmProxyOff by remember { mutableStateOf(false) }

    LaunchedEffect(active) { if (active) devices.poll() }

    val showBar = state.dirty && !devices.pending
    Box(Modifier.fillMaxSize()) {
        Page(title = "设备", navigationIcon = { onBack?.let { BackIcon(it) } }, bottomPadding = if (showBar) 88.dp else 0.dp, actions = {
            BarAction(MiuixIcons.Regular.Refresh, "刷新设备", enabled = !devices.loading) {
                TetherPolicy.reload()
                liveScope.launch { devices.readShare(); devices.readClients(); if (LiveOverview.running == true) devices.readTraffic() }
            }
        }) {
            banner(state.busy, BannerKind.Progress, "busy")
            banner(if (devices.pending) "稍后自动保存并热重载…" else "", BannerKind.Progress, "pending")
            banner(state.error, BannerKind.Error, "error")
            banner(devices.localError, BannerKind.Error, "local")
            banner(state.notice, BannerKind.Success, "notice")
            banner(devices.clientError, BannerKind.Error, "clients")
            banner(devices.trafficError, BannerKind.Error, "traffic")
            banner(devices.shareError, BannerKind.Error, "share")
            banner(TetherPolicy.error.orEmpty(), BannerKind.Error, "policy")
            banner(if (TetherPolicy.busy) "正在保存共享设置…" else "", BannerKind.Progress, "policy-busy")
            group("网络共享", "share") {
                for ((type, label) in SHARE_TYPES) {
                    val item = devices.shareItem(type)
                    if (item != null && !item.boolean("supported", true)) continue
                    val on = item?.boolean("active") == true
                    val ifaces = devices.shareIfaces(type)
                    val count = devices.clients.count { it.iface in ifaces }
                    val summary = when {
                        devices.shareBusy == type -> if (on) "正在关闭…" else "正在开启…"
                        item == null -> if (devices.shareError.isEmpty()) "读取中…" else "状态未知"
                        on && ifaces.isEmpty() -> when (type) {
                            "usb" -> "已开启，等待数据线连接电脑"
                            "bluetooth" -> "已开启，等待设备通过蓝牙连接"
                            else -> "正在启动…"
                        }
                        on -> "已开启 · ${ifaces.joinToString("、")}" + (if (count > 0) " · $count 台设备" else "")
                        type == "usb" -> "用数据线把网络共享给电脑"
                        type == "bluetooth" -> if (item.boolean("radio", true)) "通过蓝牙把网络共享给其它设备" else "蓝牙未打开，开启共享时会自动打开蓝牙"
                        else -> "开启系统热点"
                    }
                    SwitchRow(label, on, summary, enabled = item != null && devices.shareBusy.isEmpty()) { value ->
                        if (value) devices.setShare(type, true) else confirmOff = type
                    }
                }
                SwitchRow("共享设备走代理", TetherPolicy.enabled == true,
                    when (TetherPolicy.enabled) {
                        true -> "通过以上方式连入的设备经 mihomo 代理，可在下面逐台选择"
                        false -> "已关闭：共享出去的设备全部直连"
                        null -> "读取中…"
                    }, enabled = TetherPolicy.loaded && !TetherPolicy.busy) { value ->
                    if (value) TetherPolicy.setEnabled(true) else confirmProxyOff = true
                }
                if (TetherPolicy.enabled == true) {
                    ArrowRow("共享网卡", when (TetherPolicy.mode) {
                        "all" -> "所有共享网卡上的设备都走代理"
                        "exclude" -> "除排除的网卡外，其余共享网卡上的设备都走代理"
                        else -> "只有经这些网卡连入的设备走代理"
                    }, value = TetherPolicy.summary, enabled = !TetherPolicy.busy) { TetherPolicy.openInterfaces() }
                    val missing = devices.missingIfaces()
                    if (missing.isNotEmpty()) {
                        val excluded = TetherPolicy.mode == "exclude"
                        ArrowRow("${missing.joinToString("、")} ${if (excluded) "已被排除" else "不在共享网卡里"}",
                            "经它连入的设备现在不走代理，点此${if (excluded) "取消排除" else "加入"}", value = if (excluded) "取消排除" else "加入",
                            enabled = !TetherPolicy.busy) { TetherPolicy.addInterfaces(missing) }
                    }
                }
                ArrowRow("热点名称与密码", "在「设备控制」里修改系统热点设置") { onNavigate("enhanced") }
            }
            if (state.source == null) return@Page
            if (!devices.ready) {
                item(key = "missing") { Caption("当前配置还没有开启透明代理，请先在「设置 › 重新运行向导」里完成本机优化。", Tone.warning) }
                return@Page
            }
            val whitelist = devices.whitelist
            group("模式", "mode") {
                DropdownRow("名单模式", listOf("黑名单", "白名单"), if (whitelist) 1 else 0,
                    summary = if (whitelist) "只有打开开关的设备走代理，其余直接上网" else "默认都走代理，关掉开关的设备直接上网",
                    enabled = devices.editable) { devices.switchMode(it == 1) }
            }
            val clients = devices.sortedClients()
            group(if (clients.isEmpty()) "已连接的设备" else "已连接的设备（${clients.size}）", "online") {
                if (clients.isEmpty()) Caption(if (devices.loading) "正在读取…" else "现在没有设备通过热点、USB 或蓝牙连到本机。")
                for (client in clients) ClientRow(client)
            }
            val online = devices.clients.map { it.mac }.toSet()
            val listedMacs = (if (whitelist) devices.includeMac else devices.excludeMac).filter { it !in online }
            val listedIps = if (whitelist) devices.includeIp else devices.excludeIp
            if (listedMacs.isNotEmpty() || listedIps.isNotEmpty()) {
                group("名单里的其它条目", "listed") {
                    for (mac in listedMacs) {
                        DeviceRow(mac, "当前未连接", "把开关拨回默认即从名单移除", active = false,
                            checked = devices.proxiedMac(mac), enabled = devices.editable) { devices.toggle(mac, it) }
                    }
                    for (entry in listedIps) {
                        val proxy = whitelist
                        val traffic = devices.trafficOfEntry(entry)
                        DeviceRow(entry, "按 IP / 网段", devices.trafficLine(traffic, proxy),
                            active = proxy && traffic?.let { it.downRate + it.upRate > 0 } == true,
                            checked = proxy, enabled = devices.editable) { devices.toggleIp(entry, it) }
                    }
                }
            }
            group(null, "add") {
                ArrowRow("手动添加", if (devices.ipSupported) "按 MAC 地址或 IP / 网段添加" else "按 MAC 地址添加还没连上的设备",
                    enabled = devices.editable) { adding = true }
                ArrowRow("共享高级设置", "接管方式、共享设备的 DNS 等") { onNavigate("network") }
            }
            item(key = "note") {
                Caption("名单在内核的 eBPF 程序里按设备的 MAC 或来源 IP 判断（任一命中即算）：不走代理的设备连接直接放行，DNS 也不经过 mihomo，" +
                    "所以只能统计走代理设备的速率与流量。拨动开关后自动保存并热重载内核，共享设备已有的连接会断开重连一次。" +
                    "按 MAC 最可靠；部分手机连热点时使用随机 MAC，请在该设备上对本热点关闭随机 MAC。" +
                    (if (devices.trafficUnsupported) "当前内核不支持按设备统计流量，更新内核后显示每台设备的速率与流量。" else ""))
            }
        }
        if (showBar) {
            Row(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(MiuixTheme.colorScheme.surface)
                    .padding(horizontal = 12.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                TextButton("撤销", onClick = { devices.discard() }, enabled = state.busy.isEmpty(), modifier = Modifier.weight(1f))
                TextButton("保存并生效", onClick = { devices.save() }, enabled = state.busy.isEmpty(), modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.textButtonColorsPrimary())
            }
        }
    }
    TetherPolicy.Sheet()
    val offType = confirmOff
    ConfirmDialog(offType != null, "关闭${SHARE_TYPES.firstOrNull { it.first == offType }?.second ?: "网络共享"}",
        "经它连入的设备会断网。如果你正通过它打开这个页面，关闭后页面也会断开。", confirm = "关闭", danger = true,
        onDismiss = { confirmOff = null }) { offType?.let { devices.setShare(it, false) }; confirmOff = null }
    ConfirmDialog(confirmProxyOff, "共享设备不走代理", "关闭后热点、USB、蓝牙共享出去的设备全部直连，名单暂不起作用。", confirm = "关闭",
        onDismiss = { confirmProxyOff = false }) { TetherPolicy.setEnabled(false); confirmProxyOff = false }
    val whitelist = devices.whitelist
    EditDialog(show = adding, title = "手动添加",
        initial = "", summary = (if (devices.ipSupported) "填 MAC 地址（aa:bb:cc:dd:ee:ff）或 IP / 网段（192.168.43.20、192.168.43.0/28）。"
        else "填 MAC 地址，例如 aa:bb:cc:dd:ee:ff。") + (if (whitelist) "添加后走代理。" else "添加后不走代理。"),
        onDismiss = { adding = false }) { text ->
        devices.add(text)?.let { return@EditDialog it }
        adding = false
        null
    }
}
