package dev.herdr.remote

import android.net.Uri
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.IOException
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class HtmlPreviewUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val id = "0123456789abcdef0123456789abcdef"
    private val page = """<!doctype html><link rel="stylesheet" href="style.css"><img src="image.svg"><p id="result">before</p><script src="app.js"></script>"""
    private val resources = mapOf(
        "index.html" to ("text/html" to page.toByteArray()),
        "style.css" to ("text/css" to "#result { color: rgb(1, 2, 3) }".toByteArray()),
        "app.js" to ("text/javascript" to "document.getElementById('result').textContent='rendered';".toByteArray()),
        "image.svg" to ("image/svg+xml" to "<svg xmlns='http://www.w3.org/2000/svg' width='2' height='2'></svg>".toByteArray()),
    )

    private fun fakeSource(current: () -> Boolean = { true }, requests: MutableList<String> = mutableListOf()): HtmlPreviewSource =
        HtmlPreviewSource(HtmlPreviewTransport { path, query ->
            if (path.last() == "preview") {
                assertEquals("/tmp/site/index.html", query["target"])
                buildJsonObject {
                    put("id", id); put("title", "Site preview"); put("entryPath", "index.html"); put("source", "file")
                }
            } else {
                val relative = query.getValue("path")
                requests += relative
                val (mime, bytes) = resources[relative] ?: throw IOException("Missing asset")
                val offset = query.getValue("offset").toInt()
                val chunk = bytes.copyOfRange(offset, bytes.size)
                buildJsonObject {
                    put("data", Base64.encodeToString(chunk, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
                    put("contentType", mime); put("size", bytes.size); put("offset", offset); put("eof", true)
                }
            }
        }, "pane-1", stillCurrent = current)

    @Test fun htmlCssImageAndJavascriptRenderInsidePreviewAndBackCloses() {
        val requests = Collections.synchronizedList(mutableListOf<String>())
        val source = fakeSource(requests = requests)
        var closed = false
        compose.setContent {
            HtmlPreviewScreen(source, target = "/tmp/site/index.html") { closed = true }
        }
        compose.waitUntil(10000) { findWebView(compose.activity.window.decorView) != null }
        val view = findWebView(compose.activity.window.decorView)!!
        compose.waitUntil(10000) { requests.containsAll(listOf("index.html", "style.css", "app.js", "image.svg")) }
        compose.waitUntil(10000) { evaluate(view, "document.getElementById('result')?.textContent") == "\"rendered\"" }
        assertEquals("\"rendered\"", evaluate(view, "document.getElementById('result').textContent"))
        assertEquals("\"rgb(1, 2, 3)\"", evaluate(view, "getComputedStyle(document.getElementById('result')).color"))
        assertEquals("true", evaluate(view, "document.querySelector('img').complete"))
        compose.onNodeWithContentDescription("Back").performClick()
        compose.runOnIdle { assertTrue(closed) }
    }

    @Test fun blocksOutsideOriginTraversalAndStaleSessions(): Unit = runBlocking {
        var current = true
        val requests = mutableListOf<String>()
        val source = fakeSource({ current }, requests)
        val session = source.open(target = "/tmp/site/index.html")
        val client = HtmlPreviewWebClient(source, session, onPageError = {})
        val good = client.shouldInterceptRequest(null, request("https://$id.preview.invalid/style.css"))
        assertEquals(200, good.statusCode)
        assertTrue(good.data.readBytes().isNotEmpty())
        for (url in listOf("https://example.com/file", "file:///tmp/site/index.html", "https://$id.preview.invalid/../secret", "https://$id.preview.invalid/%2e%2e/secret", "https://$id.preview.invalid/a%2fb")) {
            assertEquals(403, client.shouldInterceptRequest(null, request(url)).statusCode)
            assertTrue(client.shouldOverrideUrlLoading(null, request(url)))
        }
        assertEquals(listOf("style.css"), requests)
        assertFalse(safePreviewContentType("text/html\r\nSet-Cookie: stolen=1"))
        current = false
        assertThrows(IOException::class.java) { runBlocking { source.resource(session, "index.html") } }
    }

    @Test fun rejectsTruncatedMismatchedAndOversizedChunks() {
        for (badChunk in listOf(
            chunk("a".toByteArray(), size = 2, offset = 0, eof = true),
            chunk("a".toByteArray(), size = 1, offset = 1, eof = true),
            chunk(ByteArray(128 * 1024 + 1), size = 128 * 1024 + 1, offset = 0, eof = true),
        )) {
            val source = HtmlPreviewSource(HtmlPreviewTransport { path, _ ->
                if (path.last() == "preview") sessionJson() else badChunk
            }, "pane-1") { true }
            val session = runBlocking { source.open(target = "/tmp/site/index.html") }
            assertThrows(IllegalArgumentException::class.java) {
                runBlocking { source.resource(session, "index.html") }
            }
        }
    }

    @Test fun rejectsResponsesAfterTheSelectedPaneChanges() {
        val current = AtomicBoolean(true)
        val source = HtmlPreviewSource(HtmlPreviewTransport { path, _ ->
            if (path.last() == "preview") sessionJson()
            else chunk("ok".toByteArray(), size = 2, offset = 0, eof = true).also { current.set(false) }
        }, "pane-1") { current.get() }
        val session = runBlocking { source.open(target = "/tmp/site/index.html") }
        assertThrows(IOException::class.java) { runBlocking { source.resource(session, "index.html") } }
    }

    @Test fun previewPacingLimitsBytesAndRequestsAcrossAssets(): Unit = runBlocking {
        var now = 0L
        val pacer = HtmlPreviewPacer(nowMillis = { now }, sleepMillis = { wait -> now += wait })
        repeat(4) { pacer.acquire() }
        assertEquals(0L, now)
        pacer.acquire()
        assertTrue("The fifth full chunk should wait for byte credit", now >= 938L)

        var requestClock = 0L
        val smallAssetPacer = HtmlPreviewPacer(nowMillis = { requestClock }, sleepMillis = { wait -> requestClock += wait })
        repeat(12) {
            smallAssetPacer.acquire()
            smallAssetPacer.refund(128 * 1024)
        }
        assertEquals(0L, requestClock)
        smallAssetPacer.acquire()
        assertTrue("Small assets must still respect a shared request budget", requestClock >= 500L)
    }

    @Test fun distinguishesOldCompanionFromMissingPreviewTarget() {
        for ((code, upgraded) in listOf("not_found" to true, "preview_target_missing" to false)) {
            val source = HtmlPreviewSource(HtmlPreviewTransport { _, _ ->
                throw BridgeHttpException(404, "Preview missing", code)
            }, "pane-1") { true }
            val error = assertThrows(IOException::class.java) {
                runBlocking { source.open(target = "/tmp/site/index.html") }
            }
            if (upgraded) assertEquals("Update the laptop companion to open HTML previews.", error.message)
            else assertEquals("Preview missing", error.message)
        }
    }

    private fun sessionJson() = buildJsonObject {
        put("id", id); put("title", "Site preview"); put("entryPath", "index.html"); put("source", "file")
    }

    private fun chunk(bytes: ByteArray, size: Int, offset: Int, eof: Boolean) = buildJsonObject {
        put("data", Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
        put("contentType", "text/html"); put("size", size); put("offset", offset); put("eof", eof)
    }

    private fun request(url: String) = object : WebResourceRequest {
        override fun getUrl() = Uri.parse(url)
        override fun isForMainFrame() = true
        override fun isRedirect() = false
        override fun hasGesture() = true
        override fun getMethod() = "GET"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    private fun findWebView(root: View): WebView? {
        if (root is WebView) return root
        if (root is ViewGroup) for (index in 0 until root.childCount) findWebView(root.getChildAt(index))?.let { return it }
        return null
    }

    private fun evaluate(view: WebView, script: String): String {
        val signal = CountDownLatch(1)
        var result = ""
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            view.evaluateJavascript(script) { value -> result = value; signal.countDown() }
        }
        assertTrue("WebView script did not finish", signal.await(5, TimeUnit.SECONDS))
        return result
    }
}
