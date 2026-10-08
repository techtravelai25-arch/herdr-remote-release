package dev.herdr.remote

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody
import okio.BufferedSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Records which thread reads the body so tests can prove decoding left the caller's dispatcher. */
internal class ThreadRecordingBody(text: String, private val threads: MutableList<String>) : ResponseBody() {
    private val delegate = text.toResponseBody("application/json".toMediaType())
    override fun contentType() = delegate.contentType()
    override fun contentLength() = delegate.contentLength()
    override fun source(): BufferedSource { threads += Thread.currentThread().name; return delegate.source() }
}

class BridgeHttpDispatchTest {
    private fun client(responses: MutableList<Int>, calls: MutableList<String>) = OkHttpClient.Builder()
        .addInterceptor(Interceptor { chain ->
            calls += chain.request().method
            val code = responses.removeAt(0)
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code)
                .message(if (code == 200) "OK" else "Unauthorized")
                .body((if (code == 200) "{}" else "{\"error\":{\"message\":\"expired\"}}" ).toResponseBody())
                .build()
        }).build()

    @Test fun staleGrantRefreshesObservationOnce() = runBlocking {
        val calls = mutableListOf<String>(); var refreshes = 0
        val bridge = Bridge(Credentials("https://laptop.example", "old", "phone", "laptop"),
            resolveCredentials = { it }, refreshCredentials = { refreshes++; it.copy(token = "new") },
            injectedClient = client(mutableListOf(401, 200), calls))
        bridge.call(listOf("v1", "snapshot"))
        assertEquals(listOf("GET", "GET"), calls); assertEquals(1, refreshes)
    }

    @Test fun mutationIsNeverReplayedAfterAuthFailure() = runBlocking {
        val calls = mutableListOf<String>(); var refreshes = 0
        val bridge = Bridge(Credentials("https://laptop.example", "old", "phone", "laptop"),
            resolveCredentials = { it }, refreshCredentials = { refreshes++; it },
            injectedClient = client(mutableListOf(401, 200), calls))
        assertThrows(BridgeHttpException::class.java) {
            runBlocking { bridge.call(listOf("v1", "panes", "p", "prompt"), "POST", buildJsonObject {}) }
        }
        assertEquals(listOf("POST"), calls); assertEquals(0, refreshes)
    }
    @Test fun refreshUsesTheRejectedResolvedGrantAndStopsAfterOneRetry() = runBlocking {
        val calls = mutableListOf<String>()
        val original = Credentials("https://laptop.example", "initial", "phone", "laptop")
        var rejectedToken: String? = null
        val bridge = Bridge(original,
            resolveCredentials = { it.copy(token = "cached-newer") },
            refreshCredentials = { rejectedToken = it.token; it.copy(token = "refreshed") },
            injectedClient = client(mutableListOf(401, 401), calls))
        assertThrows(BridgeHttpException::class.java) { runBlocking { bridge.snapshot() } }
        assertEquals("cached-newer", rejectedToken)
        assertEquals(listOf("GET", "GET"), calls)
    }

    @Test fun deletionIsNeverReplayedAfterAuthFailure() = runBlocking {
        val calls = mutableListOf<String>()
        val bridge = Bridge(Credentials("https://laptop.example", "old", "phone", "laptop"),
            refreshCredentials = { error("Delete must not refresh or replay") },
            injectedClient = client(mutableListOf(401), calls))
        assertThrows(BridgeHttpException::class.java) {
            runBlocking { bridge.call(listOf("v1", "panes", "p"), "DELETE") }
        }
        assertEquals(listOf("DELETE"), calls)
    }

    private fun bridgeReturning(code: Int, body: ResponseBody) = Bridge(Credentials("https://laptop.example", "token", "phone"),
        injectedClient = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("Reply").body(body).build()
        }).build())

    @Test fun directBodyReadAndSnapshotDecodeLeaveTheCallerThread() = runBlocking {
        val threads = mutableListOf<String>()
        val caller = Thread.currentThread().name
        val snapshot = bridgeReturning(200, ThreadRecordingBody("{\"herdrOnline\":true,\"hostname\":\"Desk\"}", threads)).snapshot()
        assertEquals("Desk", snapshot.hostname)
        // The body is read once and closed once (ResponseBody.close() also opens its source).
        assertTrue(threads.isNotEmpty())
        threads.forEach { assertNotEquals(caller, it); assertTrue(it, it.startsWith("DefaultDispatcher-worker")) }
    }

    @Test fun nonJsonSuccessIsAnErrorNotAnEmptyObject() {
        val observation = assertThrows(java.io.IOException::class.java) {
            runBlocking { bridgeReturning(200, "<html>captive portal</html>".toResponseBody()).call(listOf("v1", "snapshot")) }
        }
        assertTrue(observation.message!!.contains("not JSON"))
        assertTrue(observation !is BridgeHttpException)
        val mutation = assertThrows(java.io.IOException::class.java) {
            runBlocking { bridgeReturning(200, "".toResponseBody()).call(listOf("v1", "panes", "p", "prompt"), "POST") }
        }
        assertTrue(mutation.message!!.contains("may have completed"))
        assertThrows(java.io.IOException::class.java) {
            runBlocking { bridgeReturning(200, "[1,2]".toResponseBody()).call(listOf("v1", "snapshot")) }
        }
    }

    @Test fun directBodiesAreCapped() {
        val oversized = "{\"text\":\"" + "x".repeat(BRIDGE_RESPONSE_LIMIT) + "\"}"
        val error = assertThrows(java.io.IOException::class.java) {
            runBlocking { bridgeReturning(200, oversized.toResponseBody()).call(listOf("v1", "snapshot")) }
        }
        assertTrue(error.message!!.contains("too large"))
        val http = assertThrows(BridgeHttpException::class.java) {
            runBlocking { bridgeReturning(500, oversized.toResponseBody()).call(listOf("v1", "snapshot")) }
        }
        assertEquals(500, http.statusCode)
        assertEquals(3, readBoundedBody("abc".toResponseBody(), 3)!!.size)
        assertEquals(null, readBoundedBody("abcd".toResponseBody(), 3))
    }

}
