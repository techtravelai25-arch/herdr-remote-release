package dev.herdr.remote

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

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

}
