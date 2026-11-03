package dev.herdr.remote

import android.annotation.SuppressLint
import android.content.res.AssetManager
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlin.coroutines.resume

private const val TERMINAL_ORIGIN = "https://terminal.invalid/"

/** The phone side of the bundled xterm.js page. Every call runs on the main thread. */
internal interface TerminalSurface {
    suspend fun reset(cols: Int, rows: Int)
    suspend fun write(base64: String, end: Long)
    /** The stream cursor up to which xterm has parsed bytes. Only this is acknowledged to the laptop. */
    suspend fun rendered(): Long
    /** The bytes a named key sends in the program's current keyboard mode. */
    suspend fun keyBytes(name: String): String
    suspend fun zoom(factor: Float)
}

/** Serves only the bundled terminal page; every other request gets an empty 404. */
private class TerminalAssetClient(private val assets: AssetManager, private val ready: CompletableDeferred<Unit>) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
        val url = request.url.toString()
        val name = url.removePrefix(TERMINAL_ORIGIN).substringBefore('?')
        val allowed = url.startsWith(TERMINAL_ORIGIN) && name in setOf("index.html", "xterm.js", "xterm.css", "herdr-terminal.js")
        if (!allowed) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())
        val type = when { name.endsWith(".html") -> "text/html"; name.endsWith(".css") -> "text/css"; else -> "application/javascript" }
        return WebResourceResponse(type, "utf-8", 200, "OK",
            mapOf("Content-Security-Policy" to "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'", "Cache-Control" to "no-store"),
            assets.open("terminal/$name"))
    }
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
    override fun onPageFinished(view: WebView, url: String) { if (url.startsWith(TERMINAL_ORIGIN)) ready.complete(Unit) }
}

private class WebTerminalSurface(private val view: WebView, private val ready: CompletableDeferred<Unit>) : TerminalSurface {
    private suspend fun eval(script: String): String = withContext(Dispatchers.Main) {
        ready.await()
        suspendCancellableCoroutine { continuation -> view.evaluateJavascript(script) { continuation.resume(it ?: "null") } }
    }
    override suspend fun reset(cols: Int, rows: Int) { eval("herdrTerminal.reset($cols,$rows)") }
    override suspend fun write(base64: String, end: Long) { eval("herdrTerminal.write(${JsonPrimitive(base64)},$end)") }
    override suspend fun rendered(): Long = eval("herdrTerminal.rendered()").toLongOrNull() ?: 0
    override suspend fun zoom(factor: Float) { eval("herdrTerminal.zoom($factor)") }
    override suspend fun keyBytes(name: String): String =
        eval("herdrTerminal.key(${JsonPrimitive(name)})").let { kotlinx.serialization.json.Json.decodeFromString<String>(it) }
}

/** A render-only xterm.js view of a laptop pane; `onSurface` receives the handle once the view exists. */
@SuppressLint("SetJavaScriptEnabled")
@Composable internal fun LiveTerminalView(modifier: Modifier, onSurface: (TerminalSurface?) -> Unit) {
    val ready = remember { CompletableDeferred<Unit>() }
    AndroidView(modifier = modifier, factory = { context ->
        WebView(context).apply {
            // AndroidView's default WRAP_CONTENT makes the page size to its content: `height:100%` becomes 0 and hides every row.
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.blockNetworkLoads = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.setSupportMultipleWindows(false)
            settings.setSupportZoom(false)
            isFocusable = false
            webViewClient = TerminalAssetClient(context.assets, ready)
            loadUrl(TERMINAL_ORIGIN + "index.html")
            onSurface(WebTerminalSurface(this, ready))
        }
    }, onRelease = { view -> onSurface(null); view.destroy() })
    DisposableEffect(Unit) { onDispose { onSurface(null) } }
}

/**
 * Feeds one pane's live bytes into the surface until cancelled. Relayed and
 * direct phones use the same long-poll; the laptop answers as soon as bytes arrive.
 */
internal suspend fun runLiveTerminalFeed(bridge: Bridge, paneId: String, attachmentId: String, surface: TerminalSurface,
                                         onNotice: (String?) -> Unit) {
    var epoch: String? = null
    var received = 0L
    var failures = 0
    while (currentCoroutineContext().isActive) {
        try {
            val chunk = bridge.streamPoll(paneId, attachmentId, epoch, received, minOf(surface.rendered(), received))
            failures = 0
            if (chunk.reset || chunk.epoch != epoch) { surface.reset(chunk.cols, chunk.rows); epoch = chunk.epoch }
            if (chunk.data.isNotEmpty()) surface.write(chunk.data, chunk.nextSeq)
            received = chunk.nextSeq
            onNotice(if (chunk.ended != null) "Reconnecting to the laptop terminal…" else null)
        } catch (error: CancellationException) { throw error }
        catch (error: BridgeHttpException) {
            // A changed pane needs a fresh attachment from the next output read; keep the last frame meanwhile.
            onNotice(error.message ?: "The live terminal is unavailable.")
            failures = (failures + 1).coerceAtMost(4)
            delay(1000L shl failures)
        } catch (error: Exception) {
            onNotice("Live terminal reconnecting…")
            failures = (failures + 1).coerceAtMost(4)
            delay(500L shl failures)
        }
    }
}

/**
 * One control session: typed bytes are batched, sent one request at a time with
 * consecutive sequence numbers, and retried with the same number and bytes after a
 * network failure, so the laptop never types a batch twice.
 */
internal class LiveControl(private val bridge: Bridge, private val paneId: String) {
    private val lock = Mutex()
    private val pending = StringBuilder()
    private var controlId: String? = null
    private var nextSeq = 1L
    val active: Boolean get() = controlId != null
    suspend fun start(attachmentId: String, takeover: Boolean) {
        val session = bridge.takeControl(paneId, attachmentId, takeover)
        lock.withLock { controlId = session.controlId; nextSeq = session.nextSeq; pending.clear() }
    }
    fun queue(bytes: String) { synchronized(pending) { pending.append(bytes) } }
    /** Sends what is queued. Returns an error message when control ended. */
    suspend fun flush(): String? = lock.withLock {
        val id = controlId ?: return@withLock null
        val batch = synchronized(pending) { if (pending.isEmpty()) return@withLock null; pending.toString().also { pending.clear() } }
        // Bytes are sent in pieces the laptop accepts (4 KiB), each with its own sequence number.
        for (piece in batch.chunked(1024)) {
            var attempt = 0
            while (true) {
                try { bridge.streamInput(paneId, id, nextSeq, piece); nextSeq++; break }
                catch (error: CancellationException) { throw error }
                catch (error: BridgeHttpException) { controlId = null; return@withLock error.message ?: "Control ended. Take control again." }
                catch (error: Exception) {
                    if (++attempt >= 3) { controlId = null; return@withLock "Input may not have arrived. Check the terminal, then take control again." }
                    delay(400L * attempt)
                }
            }
        }
        null
    }
    suspend fun stop() {
        val had = lock.withLock { val id = controlId; controlId = null; synchronized(pending) { pending.clear() }; id }
        if (had != null) runCatching { bridge.releaseControl(paneId) }
    }
}
