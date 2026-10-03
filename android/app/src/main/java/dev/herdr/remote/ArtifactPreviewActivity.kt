package dev.herdr.remote

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Read-only local preview. File contents never enter a WebView or saved-instance state. */
class ArtifactPreviewActivity : ComponentActivity() {
    companion object {
        private const val MAX_PREVIEW_CHARS = 200_000
        internal fun supports(extension: String, mimeType: String): Boolean = mimeType.startsWith("text/") ||
            extension.lowercase() in setOf("txt", "md", "markdown", "json", "jsonl", "log", "csv", "tsv", "yaml", "yml", "xml", "html", "htm", "css", "js", "ts", "jsx", "tsx", "kt", "java", "py", "rs", "go", "sh", "toml", "ini", "conf", "sql")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent.data
        setContent {
            var contents by remember { mutableStateOf<String?>(null) }
            var error by remember { mutableStateOf<String?>(null) }
            var truncated by remember { mutableStateOf(false) }
            LaunchedEffect(uri) {
                try {
                    require(uri?.scheme == "content" && uri.authority == "$packageName.updates" &&
                        uri.path?.startsWith("/review_files/") == true) { "This file is unavailable. Open it again from the laptop." }
                    val text = withContext(Dispatchers.IO) {
                        val stream = contentResolver.openInputStream(requireNotNull(uri))
                            ?: error("This file is unavailable. Open it again from the laptop.")
                        stream.bufferedReader(Charsets.UTF_8).use { reader ->
                            val buffer = CharArray(MAX_PREVIEW_CHARS + 1)
                            var count = 0
                            while (count < buffer.size) {
                                val read = reader.read(buffer, count, buffer.size - count)
                                if (read < 0) break
                                count += read
                            }
                            String(buffer, 0, count)
                        }
                    }
                    truncated = text.length > MAX_PREVIEW_CHARS
                    contents = text.take(MAX_PREVIEW_CHARS)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { error = "This file is unavailable. Open it again from the laptop." }
            }
            HerdrTheme(preference = rememberThemePreference()) {
                Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("File preview", style = MaterialTheme.typography.titleLarge)
                            TextButton(onClick = { finish() }) { Text("Close") }
                        }
                        if (truncated) Text("Preview limited to 200,000 characters. Save the file to read all of it.",
                            style = MaterialTheme.typography.bodySmall)
                        when {
                            error != null -> Text(error!!)
                            contents == null -> LinearProgressIndicator(Modifier.fillMaxWidth())
                            contents!!.isEmpty() -> Text("This file is empty.")
                            else -> SelectionContainer(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                                Text(contents!!, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
        }
    }
}
