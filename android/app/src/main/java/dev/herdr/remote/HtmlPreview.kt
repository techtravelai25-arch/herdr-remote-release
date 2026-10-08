package dev.herdr.remote

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.ceil
import kotlin.math.max

internal data class HtmlPreviewSession(val id: String, val title: String, val entryPath: String, val source: String, val fragment: String? = null) {
    val origin: String get() = "https://$id.preview.invalid"
    val entryUrl: String get() = "$origin/${entryPath.split('/').joinToString("/") { Uri.encode(it) }}" +
        (fragment?.let { "#${Uri.encode(it)}" } ?: "")
}

internal data class HtmlPreviewResource(val bytes: ByteArray, val contentType: String)

internal fun interface HtmlPreviewTransport {
    suspend fun get(path: List<String>, query: Map<String, String>): JsonObject
}

/** Shared across a preview's assets; accounts for both relay bytes and bridge requests.
 * A full 20 MiB resource may take several minutes so ordinary bridge polling still has capacity.
 */
internal class HtmlPreviewPacer(
    private val nowMillis: () -> Long = { SystemClock.elapsedRealtime() },
    private val sleepMillis: suspend (Long) -> Unit = { delay(it) },
) {
    private val mutex = Mutex()
    private var lastMillis = nowMillis()
    private var byteTokens = BYTE_BURST.toDouble()
    private var requestTokens = REQUEST_BURST.toDouble()

    suspend fun acquire(estimatedBytes: Int = CHUNK_BYTES) {
        require(estimatedBytes in 1..CHUNK_BYTES)
        while (true) {
            val wait = mutex.withLock {
                replenish()
                if (byteTokens >= estimatedBytes && requestTokens >= 1.0) {
                    byteTokens -= estimatedBytes
                    requestTokens -= 1.0
                    0L
                } else {
                    val byteWait = max(0.0, (estimatedBytes - byteTokens) / BYTES_PER_MS)
                    val requestWait = max(0.0, (1.0 - requestTokens) / REQUESTS_PER_MS)
                    max(1L, ceil(max(byteWait, requestWait)).toLong())
                }
            }
            if (wait == 0L) return
            sleepMillis(wait)
        }
    }

    suspend fun refund(unusedBytes: Int) {
        require(unusedBytes in 0..CHUNK_BYTES)
        mutex.withLock {
            replenish()
            byteTokens = minOf(BYTE_BURST.toDouble(), byteTokens + unusedBytes)
        }
    }

    private fun replenish() {
        val current = nowMillis()
        val elapsed = max(0L, current - lastMillis)
        lastMillis = current
        byteTokens = minOf(BYTE_BURST.toDouble(), byteTokens + elapsed * BYTES_PER_MS)
        requestTokens = minOf(REQUEST_BURST.toDouble(), requestTokens + elapsed * REQUESTS_PER_MS)
    }

    private companion object {
        const val CHUNK_BYTES = 128 * 1024
        const val BYTE_BURST = 512 * 1024
        const val REQUEST_BURST = 12
        const val BYTES_PER_MS = 8.0 * 1024 * 1024 / 60_000
        const val REQUESTS_PER_MS = 120.0 / 60_000
    }
}

/** Reads only through the paired laptop bridge. No preview content is saved on the phone. */
internal class HtmlPreviewSource(
    private val transport: HtmlPreviewTransport,
    private val paneId: String,
    private val pacer: HtmlPreviewPacer = HtmlPreviewPacer(),
    private val stillCurrent: () -> Boolean,
) {
    private val transferSlots = Semaphore(2)
    private val reservedBytes = mutableMapOf<String, Int>()
    @Volatile private var activeId: String? = null
    constructor(api: Bridge, paneId: String, stillCurrent: () -> Boolean) : this(
        HtmlPreviewTransport { path, query -> api.call(path, query = query) }, paneId, HtmlPreviewPacer(), stillCurrent
    )

    private fun checkCurrent() {
        if (!stillCurrent()) throw IOException("This laptop session has changed. Open the preview again.")
    }

    suspend fun open(target: String? = null, artifactId: String? = null): HtmlPreviewSession {
        require((target == null) != (artifactId == null)) { "Choose one preview target." }
        checkCurrent()
        val query = if (target != null) mapOf("target" to target) else mapOf("artifactId" to artifactId!!)
        val json = try { transport.get(listOf("v1", "panes", paneId, "preview"), query) }
        catch (failure: BridgeHttpException) {
            if (failure.statusCode == 404 && failure.errorCode == "not_found")
                throw IOException("Update the laptop companion to open HTML previews.", failure)
            throw failure
        }
        checkCurrent()
        val id = json.getValue("id").jsonPrimitive.content
        val title = json.getValue("title").jsonPrimitive.content
        val entryPath = json.getValue("entryPath").jsonPrimitive.content
        val source = json.getValue("source").jsonPrimitive.content
        require(id.matches(Regex("[0-9a-f]{32}"))) { "Invalid preview session." }
        require(source == "file" || source == "localhost") { "Invalid preview source." }
        require(safePreviewPath(entryPath) && !entryPath.contains('/')) { "Invalid preview entry." }
        synchronized(reservedBytes) { reservedBytes.clear(); activeId = id }
        return HtmlPreviewSession(id, title.take(200), entryPath, source, target?.substringAfter('#', "")?.takeIf { it.isNotEmpty() })
    }

    suspend fun resource(session: HtmlPreviewSession, path: String): HtmlPreviewResource {
        require(safePreviewPath(path)) { "Invalid preview path." }
        transferSlots.acquire()
        try {
            checkSession(session)
            var offset = 0
            var declaredSize: Int? = null
            var contentType: String? = null
            val output = ByteArrayOutputStream()
            while (true) {
                checkSession(session)
                pacer.acquire(CHUNK_BYTES)
                checkSession(session)
                val json = transport.get(
                    listOf("v1", "panes", paneId, "preview", session.id),
                    mapOf("path" to path, "offset" to offset.toString()),
                )
                checkSession(session)
                val responseOffset = json.getValue("offset").jsonPrimitive.int
                val size = json.getValue("size").jsonPrimitive.int
                val mime = json.getValue("contentType").jsonPrimitive.content
                val eof = json.getValue("eof").jsonPrimitive.content.toBooleanStrict()
                require(responseOffset == offset && size in 0..MAX_RESOURCE_BYTES) { "Invalid preview response." }
                require(declaredSize == null || declaredSize == size) { "Preview file changed while loading." }
                require(contentType == null || contentType == mime) { "Preview file changed while loading." }
                require(safePreviewContentType(mime)) { "Unsupported preview file type." }
                declaredSize = size
                contentType = mime
                if (offset == 0) synchronized(reservedBytes) {
                    if (path !in reservedBytes) {
                        require(reservedBytes.values.sum() + size <= MAX_SESSION_BYTES) { "Preview is too large for the phone." }
                        reservedBytes[path] = size
                    } else {
                        require(reservedBytes[path] == size) { "Preview file changed while loading." }
                    }
                }
                val encoded = json.getValue("data").jsonPrimitive.content
                require(encoded.length <= MAX_ENCODED_CHUNK_LENGTH) { "Preview chunk is too large." }
                val bytes = Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                require(bytes.size <= CHUNK_BYTES && offset + bytes.size <= size) { "Invalid preview chunk." }
                require(bytes.isNotEmpty() || eof) { "Preview transfer stopped." }
                pacer.refund(CHUNK_BYTES - bytes.size)
                output.write(bytes)
                offset += bytes.size
                if (eof) {
                    require(offset == size) { "Preview file is incomplete." }
                    checkSession(session)
                    return HtmlPreviewResource(output.toByteArray(), mime)
                }
            }
        } finally {
            transferSlots.release()
        }
    }

    private fun checkSession(session: HtmlPreviewSession) {
        checkCurrent()
        if (session.id != activeId) throw IOException("This preview has changed. Refresh it to continue.")
    }

    private companion object {
        const val CHUNK_BYTES = 128 * 1024
        const val MAX_RESOURCE_BYTES = 20 * 1024 * 1024
        const val MAX_SESSION_BYTES = 40 * 1024 * 1024
        const val MAX_ENCODED_CHUNK_LENGTH = 175_000
    }
}

internal fun safePreviewPath(path: String): Boolean =
    path.isNotEmpty() && path.length <= 2048 && path.split('/').all { segment ->
        segment.isNotEmpty() && segment != "." && segment != ".." &&
            segment.none { it == '\\' || it == '\u0000' || it.isISOControl() }
    }

internal fun safePreviewContentType(contentType: String): Boolean {
    if (contentType.length > 100 || !contentType.matches(Regex("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+(?:; ?charset=[A-Za-z0-9_-]+)?"))) return false
    val mime = contentType.substringBefore(';').lowercase()
    return mime in setOf(
        "text/html", "text/plain", "text/css", "text/javascript", "text/xml",
        "application/javascript", "application/json", "application/xml", "application/wasm",
        "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp", "image/x-icon",
        "font/woff", "font/woff2", "font/ttf", "font/otf", "application/font-woff",
        "audio/mpeg", "audio/ogg", "audio/wav", "video/mp4", "video/webm",
    )
}

/** Visible page content is isolated to one synthetic origin and served by Bridge.call. */
internal class HtmlPreviewWebClient(
    private val source: HtmlPreviewSource,
    private val session: HtmlPreviewSession,
    private val onPageError: (String) -> Unit,
    private val onLoadingChanged: (Boolean) -> Unit = {},
) : WebViewClient() {
    override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
        onLoadingChanged(true)
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        onLoadingChanged(false)
    }

    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean =
        request.method != "GET" || !isAllowedPreviewUrl(session, request.url)

    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse {
        val uri = request.url
        val path = previewPath(session, uri)
        if (request.method != "GET" || path == null) return deniedResponse()
        return try {
            val resource = runBlocking(Dispatchers.IO) { source.resource(session, path) }
            val mime = resource.contentType.substringBefore(';').ifBlank { "application/octet-stream" }
            val charset = resource.contentType.substringAfter("charset=", "utf-8").substringBefore(';')
            WebResourceResponse(mime, charset, 200, "OK", previewHeaders(), ByteArrayInputStream(resource.bytes))
        } catch (error: Exception) {
            if (request.isForMainFrame) Handler(Looper.getMainLooper()).post {
                onPageError(error.message ?: "Could not load this preview.")
            }
            deniedResponse()
        }
    }

    override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
        if (request?.isForMainFrame == true) onPageError(error?.description?.toString() ?: "Could not load this preview.")
    }
}

internal fun isAllowedPreviewUrl(session: HtmlPreviewSession, uri: Uri): Boolean = previewPath(session, uri) != null

internal fun previewPath(session: HtmlPreviewSession, uri: Uri): String? {
    if (uri.scheme != "https" || uri.host != "${session.id}.preview.invalid" || uri.port != -1 ||
        uri.userInfo != null) return null
    val encodedPath = uri.encodedPath ?: return null
    val path = if (encodedPath == "/") session.entryPath else {
        if (!encodedPath.startsWith('/')) return null
        val encodedSegments = encodedPath.drop(1).split('/')
        if (encodedSegments.any { it.isEmpty() || it.contains("%2f", true) || it.contains("%5c", true) }) return null
        encodedSegments.map { Uri.decode(it) }.also { segments ->
            if (segments.any { it.contains('%') }) return null
        }.joinToString("/")
    }
    return path.takeIf(::safePreviewPath)
}

private fun previewHeaders(): Map<String, String> = mapOf(
    "Content-Security-Policy" to "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'self'; object-src 'none'",
    "X-Content-Type-Options" to "nosniff",
    "Cache-Control" to "no-store",
)

private fun deniedResponse() = WebResourceResponse(
    "text/plain", "utf-8", 403, "Blocked", mapOf("Cache-Control" to "no-store"),
    ByteArrayInputStream("This request is outside the preview.".toByteArray()),
)

@SuppressLint("SetJavaScriptEnabled")
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HtmlPreviewScreen(
    source: HtmlPreviewSource,
    target: String? = null,
    artifactId: String? = null,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    var refresh by remember(source, target, artifactId) { mutableIntStateOf(0) }
    var session by remember(source, target, artifactId, refresh) { mutableStateOf<HtmlPreviewSession?>(null) }
    var error by remember(source, target, artifactId, refresh) { mutableStateOf<String?>(null) }
    BackHandler(onBack = onClose)
    DisposableEffect(Unit) {
        val manager = CookieManager.getInstance()
        val previouslyAllowed = manager.acceptCookie()
        manager.setAcceptCookie(false)
        onDispose { manager.setAcceptCookie(previouslyAllowed) }
    }
    LaunchedEffect(source, target, artifactId, refresh) {
        try { session = withContext(Dispatchers.IO) { source.open(target, artifactId) } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.message ?: "Could not open this preview." }
    }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text(session?.title ?: "HTML preview", maxLines = 1) },
            navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            actions = { IconButton(onClick = { refresh++ }) { Icon(Icons.Default.Refresh, "Refresh preview") } },
        )
        when {
            error != null -> Column(Modifier.fillMaxSize()) {
                Text(error!!, Modifier.padding(16.dp))
                TextButton(onClick = { refresh++ }) { Text("Retry") }
            }
            session == null -> LinearProgressIndicator(Modifier.fillMaxWidth())
            else -> {
                val currentSession = session!!
                val alive = remember(currentSession, refresh) { AtomicBoolean(true) }
                var rendering by remember(currentSession, refresh) { mutableStateOf(true) }
                val webView = remember(currentSession, refresh) {
                    WebView(context).apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = false
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        settings.allowFileAccessFromFileURLs = false
                        settings.allowUniversalAccessFromFileURLs = false
                        settings.blockNetworkLoads = true
                        settings.cacheMode = WebSettings.LOAD_NO_CACHE
                        settings.useWideViewPort = true
                        settings.loadWithOverviewMode = true
                        settings.builtInZoomControls = true
                        settings.displayZoomControls = false
                        settings.setSupportMultipleWindows(false)
                        settings.javaScriptCanOpenWindowsAutomatically = false
                        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
                        webViewClient = HtmlPreviewWebClient(
                            source, currentSession,
                            onPageError = { message -> if (alive.get()) error = message },
                            onLoadingChanged = { loading -> if (alive.get()) rendering = loading },
                        )
                        loadUrl(currentSession.entryUrl)
                    }
                }
                DisposableEffect(webView) {
                    onDispose {
                        alive.set(false)
                        webView.stopLoading()
                        webView.loadUrl("about:blank")
                        webView.clearHistory()
                        webView.clearCache(true)
                        webView.removeAllViews()
                        webView.destroy()
                    }
                }
                Box(Modifier.fillMaxSize()) {
                    AndroidView(factory = { webView }, modifier = Modifier.fillMaxSize())
                    if (rendering) LinearProgressIndicator(Modifier.fillMaxWidth())
                }
            }
        }
    }
}
