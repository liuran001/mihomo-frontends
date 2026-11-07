package mihomo

// config.yaml 编辑器的实时校验（输入停顿后检查）；编辑器与语法高亮见 CodeEditor.kt。

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

internal data class YamlProblem(val line: Int, val col: Int, val message: String, val error: Boolean)

/** 输入停顿 0.6 秒后校验；返回最近一次的问题列表（null 表示尚未校验）。 */
@Composable
internal fun rememberYamlLint(content: String, enabled: Boolean): List<YamlProblem>? {
    var problems by remember { mutableStateOf<List<YamlProblem>?>(null) }
    LaunchedEffect(content, enabled) {
        if (!enabled) return@LaunchedEffect
        delay(600)
        problems = try {
            request("yamlLint", json("content" to content)).objects("problems").map {
                YamlProblem((it["line"] as? JsonPrimitive)?.intOrNull ?: 0, (it["col"] as? JsonPrimitive)?.intOrNull ?: 0,
                    it.string("message"), it.string("level") != "warning")
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            null
        }
    }
    return problems
}
