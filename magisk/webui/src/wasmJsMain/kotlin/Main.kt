@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package mihomo

import androidx.compose.foundation.Image
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.layout.layout
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.platform.LocalFontFamilyResolver
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.platform.Font
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.ComposeViewport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import mihomo.resources.Res
import top.yukonga.miuix.kmp.basic.CircularProgressIndicator
import top.yukonga.miuix.kmp.basic.NavigationBar
import top.yukonga.miuix.kmp.basic.NavigationBarItem
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Home
import top.yukonga.miuix.kmp.icon.extended.Settings
import top.yukonga.miuix.kmp.icon.extended.Tune
import top.yukonga.miuix.kmp.theme.MiuixTheme
import top.yukonga.miuix.kmp.theme.darkColorScheme
import top.yukonga.miuix.kmp.theme.defaultTextStyles
import top.yukonga.miuix.kmp.theme.lightColorScheme
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.io.encoding.Base64

// ---------------- 后台桥接 ----------------

@JsFun("""(operation, payload, success, failure) => {
    Promise.resolve().then(() => window.mihomoBridge.request(operation, payload))
        .then(success, error => failure(String(error && error.message || error)));
}""")
private external fun bridgeRequest(operation: String, payload: String, success: (String) -> Unit, failure: (String) -> Unit)

@JsFun("() => { if (window.mihomoReady) window.mihomoReady(); }")
private external fun ready()

@JsFun("() => location.hash === '#enhanced' ? 'enhanced' : 'home'")
private external fun initialRoute(): String

@JsFun("() => { location.href = '/login?next=%2F%23enhanced'; }")
internal external fun enhancedLogin()

@JsFun("() => document.visibilityState !== 'hidden'")
internal external fun webuiVisible(): Boolean

@JsFun("(done) => { if (document.visibilityState !== 'hidden') { done(); return () => {}; } const listener = () => { if (document.visibilityState !== 'hidden') { document.removeEventListener('visibilitychange', listener); done(); } }; document.addEventListener('visibilitychange', listener); return () => document.removeEventListener('visibilitychange', listener); }")
private external fun onWebuiVisible(done: () -> Unit): () -> Unit

internal suspend fun awaitWebuiVisible() = suspendCancellableCoroutine<Unit> { continuation ->
    val cancel = onWebuiVisible { if (continuation.isActive) continuation.resume(Unit) }
    continuation.invokeOnCancellation { cancel() }
}

@JsFun("(message) => { const text = document.getElementById('loading-message'); if (text) text.textContent = message; const retry = document.getElementById('reload'); if (retry) retry.hidden = false; }")
private external fun fontFailure(message: String)

suspend fun request(operation: String, payload: JsonObject = json()): JsonObject {
    val response = suspendCancellableCoroutine<String> { continuation ->
        bridgeRequest(operation, payload.toString(),
            { value -> if (continuation.isActive) continuation.resume(value) },
            { error -> if (continuation.isActive) continuation.resumeWithException(IllegalStateException(error)) })
    }
    val result = Json.parseToJsonElement(response) as? JsonObject
        ?: error("后台响应格式无效")
    check(result.boolean("ok")) { result.string("error", "操作失败") }
    return result
}

private fun jsonValue(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is Boolean -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is String -> JsonPrimitive(value)
    is List<*> -> JsonArray(value.map(::jsonValue))
    else -> error("不支持的 JSON 参数类型")
}

fun json(vararg values: Pair<String, Any?>): JsonObject = JsonObject(values.associate { (key, value) -> key to jsonValue(value) })
fun JsonObject.string(key: String, default: String = ""): String = (this[key] as? JsonPrimitive)?.contentOrNull ?: default
fun JsonObject.boolean(key: String, default: Boolean = false): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull ?: default
fun JsonObject.objects(key: String): List<JsonObject> = (this[key] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()

// ---------------- 应用图标（按需加载，最多并发 2 个，LRU 64） ----------------

private class AppIconState {
    var bitmap by mutableStateOf<ImageBitmap?>(null)
    var loaded = false
}

private val icons = linkedMapOf<String, AppIconState>()
private val iconLoads = Semaphore(2)

@Composable
fun AppIcon(packageName: String, label: String, modifier: Modifier = Modifier, load: Boolean = true) {
    val state = remember(packageName) {
        icons.remove(packageName)?.also { icons[packageName] = it } ?: AppIconState().also {
            icons[packageName] = it
            if (icons.size > 64) icons.remove(icons.keys.first())
        }
    }
    LaunchedEffect(packageName, load) {
        if (load && !state.loaded) {
            iconLoads.withPermit {
                try {
                    val uri = request("appIcon", json("packageName" to packageName)).string("icon")
                    state.bitmap = if (uri.startsWith("data:image/") && uri.contains(";base64,")) {
                        org.jetbrains.skia.Image.makeFromEncoded(Base64.decode(uri.substringAfter(";base64,"))).toComposeImageBitmap()
                    } else null
                    state.loaded = true
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    state.loaded = true
                }
            }
        }
    }
    val bitmap = state.bitmap
    if (bitmap != null) {
        Image(bitmap, label, modifier.size(40.dp).clip(RoundedCornerShape(10.dp)))
    } else {
        Box(modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(MiuixTheme.colorScheme.secondaryContainer),
            contentAlignment = Alignment.Center) {
            Text(label.take(1).ifEmpty { "?" }, color = MiuixTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
        }
    }
}

// ---------------- 导航 ----------------

/** 主标签页。 */
private val tabs = listOf("home" to "首页", "proxies" to "代理", "settings" to "设置")

/** 子页面（压栈显示，带返回）。 */
private val subPages = setOf("connections", "profile", "core", "config", "config-edit", "backups", "logs", "setup", "tailscale", "webui", "network", "substore", "enhanced", "module")

private class Navigator {
    var tab by mutableStateOf("home")
    val stack = mutableStateListOf<String>()
    val current: String get() = stack.lastOrNull() ?: tab

    init {
        if (initialRoute() == "enhanced") stack.add("enhanced")
    }

    fun go(route: String) {
        when {
            route in tabs.map { it.first } -> { stack.clear(); tab = route }
            route in subPages && stack.lastOrNull() != route -> stack.add(route)
        }
    }

    /** 返回：先出栈，再回到首页；已在首页时不处理。 */
    fun back(): Boolean = when {
        stack.isNotEmpty() -> { stack.removeAt(stack.lastIndex); true }
        tab != "home" -> { tab = "home"; true }
        else -> false
    }
}

@Composable
private fun MihomoApp() {
    var phase by remember { mutableStateOf("checking") } // checking | wizard | app | error
    var startupError by remember { mutableStateOf("") }
    var attempt by remember { mutableStateOf(0) }
    val navigator = remember { Navigator() }
    LaunchedEffect(attempt) {
        startupError = ""
        try {
            val state = request("onboardingState")
            val hasConfig = (state["has_config"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull
            val completed = (state["completed"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull
            check(hasConfig != null && completed != null) { "初始配置状态无效" }
            phase = if (!hasConfig && !completed) "wizard" else "app"
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            startupError = failure.message ?: "无法检查初始配置"
            phase = "error"
        }
    }
    LaunchedEffect(Unit) { ready() }
    LaunchedEffect(Unit) { BackDispatcher.install() }
    BackSync()
    // 子页面或非首页标签时，返回键先回上一级；在首页且无弹窗时交给 WebUI 关闭。
    val levels = navigator.stack.size + if (navigator.tab != "home") 1 else 0
    BackHandler(enabled = phase == "app" && levels > 0, levels = levels) { navigator.back() }
    Box(Modifier.fillMaxSize().background(MiuixTheme.colorScheme.surface)) {
        when (phase) {
            "checking" -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(size = 28.dp, strokeWidth = 3.dp)
            }
            "error" -> Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally) {
                Text("无法连接后台", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = MiuixTheme.colorScheme.onSurface)
                Text(startupError, fontSize = 14.sp, color = Tone.muted)
                TextButton("重试", onClick = { phase = "checking"; attempt++ }, modifier = Modifier.fillMaxWidth())
                TextButton("直接进入", onClick = { phase = "app" }, modifier = Modifier.fillMaxWidth())
            }
            "wizard" -> SetupWizard(firstRun = true) { phase = "app"; navigator.go("home"); LiveOverview.invalidate() }
            else -> AppShell(navigator)
        }
    }
}

@Composable
private fun AppShell(navigator: Navigator) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= 1000.dp
        val contentWidth = if (wide) (maxWidth - 216.dp).coerceAtMost(1240.dp) else maxWidth.coerceAtMost(720.dp)
        CompositionLocalProvider(LocalWideLayout provides wide, LocalPageWidth provides contentWidth) {
            // 首页的网速、出口、eBPF、订阅在 WebUI 打开期间一直在后台更新，切回首页直接显示，历史曲线不丢
            LaunchedEffect(Unit) { LiveHome.run() }
            Row(Modifier.fillMaxSize()) {
                if (wide) DesktopNavigation(navigator)
                Box(Modifier.weight(1f).fillMaxHeight()) { AppContent(navigator, wide) }
            }
        }
    }
}

@Composable
private fun DesktopNavigation(navigator: Navigator) {
    val links = tabs + listOf("connections" to "连接", "logs" to "日志", "tailscale" to "Tailscale", "webui" to "网页管理", "enhanced" to "设备控制")
    Column(Modifier.width(216.dp).fillMaxHeight().background(MiuixTheme.colorScheme.surfaceContainer).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("mihomo", fontWeight = FontWeight.Bold, fontSize = 26.sp, color = MiuixTheme.colorScheme.primary,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 24.dp))
        for ((route, title) in links) {
            val selected = navigator.current == route
            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                .background(if (selected) MiuixTheme.colorScheme.primary.copy(alpha = 0.12f) else androidx.compose.ui.graphics.Color.Transparent)
                .clickable(role = androidx.compose.ui.semantics.Role.Button) { navigator.go(route) }
                .padding(horizontal = 16.dp, vertical = 14.dp)) {
                Text(title, fontSize = 15.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (selected) MiuixTheme.colorScheme.primary else MiuixTheme.colorScheme.onSurface)
            }
        }
        Spacer(Modifier.weight(1f))
        Text("本机 · 局域网 · Tailnet", fontSize = 12.sp, color = Tone.muted, modifier = Modifier.padding(12.dp))
    }
}

/** 主标签页内容：按序号。 */
@Composable
private fun TabPage(index: Int, navigator: Navigator) {
    when (tabs[index].first) {
        "home" -> HomePage(navigator::go)
        "proxies" -> ProxiesPage(onBack = null)
        else -> SettingsPage(navigator::go)
    }
}

/** 不测量、不放置：内容保留在组合里（状态、滚动位置都在），但不绘制、不响应点击。 */
private val HiddenLayout = Modifier.layout { _, constraints -> layout(constraints.maxWidth, constraints.maxHeight) {} }

@Composable
private fun AppContent(navigator: Navigator, wide: Boolean) {
    // 窄屏：三个主标签放在横向分页器里，可左右滑动切换；访问过的标签常驻，切换时不再重建整页。
    // 子页面盖在上面显示，返回时主标签原样还在（滚动位置、已读数据都保留）。
    val pager = rememberPagerState(initialPage = tabs.indexOfFirst { it.first == navigator.tab }.coerceAtLeast(0)) { tabs.size }
    val visited = remember { mutableStateMapOf<Int, Boolean>() }
    if (!wide) {
        LaunchedEffect(navigator.tab) {
            val target = tabs.indexOfFirst { it.first == navigator.tab }
            if (target >= 0 && target != pager.targetPage) pager.animateScrollToPage(target)
        }
        LaunchedEffect(pager) {
            snapshotFlow { pager.settledPage }.collect { page ->
                if (navigator.tab != tabs[page].first) navigator.tab = tabs[page].first
            }
        }
    }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            val route = navigator.current
            val back: () -> Unit = { navigator.back() }
            val inTab = navigator.stack.isEmpty()
            if (!wide) {
                Box(Modifier.fillMaxSize().then(if (inTab) Modifier else HiddenLayout)) {
                    HorizontalPager(state = pager, modifier = Modifier.fillMaxSize(), beyondViewportPageCount = tabs.size - 1,
                        userScrollEnabled = inTab, key = { tabs[it].first }) { index ->
                        val near = index == pager.currentPage || index == pager.targetPage
                        LaunchedEffect(near) { if (near) visited[index] = true }
                        if (near || visited[index] == true) {
                            CompositionLocalProvider(LocalPageActive provides (inTab && pager.settledPage == index)) { TabPage(index, navigator) }
                        } else {
                            Box(Modifier.fillMaxSize().background(MiuixTheme.colorScheme.surface))
                        }
                    }
                }
            }
            if (wide || !inTab) key(route) {
                when (route) {
                    "home" -> HomePage(navigator::go)
                    "proxies" -> ProxiesPage(onBack = if (navigator.stack.isEmpty()) null else back)
                    "settings" -> SettingsPage(navigator::go)
                    "connections" -> ConnectionsPage(onBack = back)
                    "profile" -> ProfilePage(onBack = back)
                    "core" -> CorePage(onBack = back)
                    "module" -> ModuleUpdatePage(onBack = back)
                    "config" -> ConfigPage(onBack = back, onNavigate = navigator::go)
                    "config-edit" -> ConfigEditorPage(onBack = back)
                    "backups" -> BackupsPage(onBack = back)
                    "logs" -> LogsPage(onBack = back)
                    "tailscale" -> TailscalePage(onBack = back)
                    "substore" -> SubStorePage(onBack = back)
                    "webui" -> WebUiPage(onBack = back, onNavigate = navigator::go)
                    "network" -> NetworkPage(onBack = back, onNavigate = navigator::go)
                    "enhanced" -> EnhancedPage(onBack = back, onNavigate = navigator::go)
                    "setup" -> SetupWizard(firstRun = false) { navigator.back(); LiveOverview.invalidate(); ProfileState.invalidate() }
                }
            }
        }
        if (!wide && navigator.stack.isEmpty()) {
            NavigationBar(defaultWindowInsetsPadding = false) {
                val icons = listOf(MiuixIcons.Regular.Home, MiuixIcons.Regular.Tune, MiuixIcons.Regular.Settings)
                tabs.forEachIndexed { index, (route, title) ->
                    NavigationBarItem(selected = navigator.tab == route, onClick = { navigator.go(route) }, icon = icons[index], label = title)
                }
            }
        }
    }
}

fun main() {
    ComposeViewport("composeApp") {
        val resolver = LocalFontFamilyResolver.current
        var family by remember { mutableStateOf<FontFamily?>(null) }
        LaunchedEffect(resolver) {
            try {
                val bytes = Res.readBytes("font/noto_sans_sc.otf")
                val local = FontFamily(Font(identity = "mihomo-offline-sc", getData = { bytes }))
                resolver.preload(local)
                family = local
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                fontFailure("离线字体加载失败，请重新安装完整模块后重试。")
            }
        }
        family?.let { loaded ->
            val dark = isSystemInDarkTheme()
            val colors = remember(dark) { if (dark) darkColorScheme() else lightColorScheme() }
            // 文字颜色要跟随主题：输入框直接使用 textStyles 的颜色，不给颜色时深色模式下是黑字
            val styles = remember(loaded, colors) {
                val defaults = defaultTextStyles()
                val ink = colors.onBackground
                defaults.copy(
                    main = defaults.main.copy(fontFamily = loaded, color = ink),
                    paragraph = defaults.paragraph.copy(fontFamily = loaded, color = ink),
                    body1 = defaults.body1.copy(fontFamily = loaded, color = ink),
                    body2 = defaults.body2.copy(fontFamily = loaded, color = ink),
                    // 按钮文字颜色由按钮按底色决定（主按钮白字），这里只换字体
                    button = defaults.button.copy(fontFamily = loaded),
                    footnote1 = defaults.footnote1.copy(fontFamily = loaded, color = ink),
                    footnote2 = defaults.footnote2.copy(fontFamily = loaded, color = ink),
                    headline1 = defaults.headline1.copy(fontFamily = loaded, color = ink),
                    headline2 = defaults.headline2.copy(fontFamily = loaded, color = ink),
                    subtitle = defaults.subtitle.copy(fontFamily = loaded, color = ink),
                    title1 = defaults.title1.copy(fontFamily = loaded, color = ink),
                    title2 = defaults.title2.copy(fontFamily = loaded, color = ink),
                    title3 = defaults.title3.copy(fontFamily = loaded, color = ink),
                    title4 = defaults.title4.copy(fontFamily = loaded, color = ink),
                )
            }
            MiuixTheme(colors = colors, textStyles = styles) {
                CompositionLocalProvider {
                    MihomoApp()
                }
            }
        }
    }
}
