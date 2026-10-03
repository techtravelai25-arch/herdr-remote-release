package dev.herdr.remote

import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteDeliveryOwnerTest {
    @Test fun promptRequestReadByLocalPeerThenConnectionClosedKeepsReceiptAndBlocksResendAfterRestore() = runBlocking {
        val pane = "pane"
        val server = ServerSocket(0, 2, InetAddress.getByName("127.0.0.1"))
        val url = "http://${server.inetAddress.hostAddress}:${server.localPort}"
        val scopeKey = conversationScope(url, "phone")
        val stored = AtomicReference<String?>()
        val storage = DraftRecovery({ stored.get() }, { stored.set(it) })
        val state = MutableStateFlow(RemoteState(
            online = true, selectedId = pane, outputReady = true, terminalAttachmentId = "terminal-view",
            snapshot = Snapshot(herdrOnline = true, panes = listOf(Pane(pane, "workspace"))),
            drafts = mapOf(pane to "first prompt")))
        val recovery = RemoteRecoveryOwner(storage, this, { state.value }, { error(it) })
        recovery.load(scopeKey)
        val received = CountDownLatch(1)
        val serverFailure = AtomicReference<Throwable?>()
        val receivedReceipts = mutableListOf<String?>()
        val peer = Thread {
            try {
                while (!server.isClosed) {
                    server.accept().use { socket ->
                        socket.soTimeout = 5000
                        val reader = socket.getInputStream().bufferedReader()
                        val headers = mutableListOf<String>()
                        while (true) {
                            val line = reader.readLine() ?: throw IOException("Request ended before headers")
                            if (line.isEmpty()) break
                            headers += line
                        }
                        val length = headers.first { it.startsWith("Content-Length:", ignoreCase = true) }
                            .substringAfter(':').trim().toInt()
                        val body = CharArray(length)
                        var offset = 0
                        while (offset < length) {
                            val read = reader.read(body, offset, length - offset)
                            if (read < 0) throw IOException("Request body ended early")
                            offset += read
                        }
                        assertTrue(headers.first().startsWith("POST /v1/panes/pane/prompt "))
                        assertTrue(String(body).contains("first prompt"))
                        val receipt = headers.first { it.startsWith("X-Operation-Id:", ignoreCase = true) }
                            .substringAfter(':').trim()
                        receivedReceipts += receipt
                        val committed = decodeRecovery(stored.get()!!, System.currentTimeMillis()).entries.single().delivery
                        assertEquals(receipt, committed?.id)
                        assertEquals("sending", committed?.status)
                        received.countDown()
                        // A complete mutation request reached this peer; it closes without an HTTP response.
                    }
                }
            } catch (error: SocketException) { if (!server.isClosed) serverFailure.set(error) }
            catch (error: Throwable) { serverFailure.set(error); received.countDown() }
        }
        peer.start()
        val api = Bridge(Credentials(url, "token", "phone"))
        val owner = RemoteDeliveryOwner(state, recovery, { api }, { 0L }, PaneSelectionLifecycle(), {})
        val body = buildJsonObject { put("text", "first prompt"); put("attachmentId", "terminal-view") }
        val firstReceipt = owner.operationId()

        try {
            assertThrows(IOException::class.java) {
                runBlocking { owner.dispatchPrompt(pane, firstReceipt, "first prompt", "terminal-view", body, api, 0L) }
            }
            assertTrue(received.await(5, TimeUnit.SECONDS))
            assertNull(serverFailure.get())
            assertEquals(listOf(firstReceipt), receivedReceipts)
            assertEquals("uncertain", state.value.deliveries[pane]?.status)
            assertEquals("first prompt", state.value.drafts[pane])

            recovery.flushAndWait()
            val restoredArchive = DraftRecovery({ stored.get() }, { stored.set(it) }).load()
            val restored = restoredArchive.entries.single()
            assertEquals(firstReceipt, restored.delivery?.id)
            assertEquals("uncertain", restored.delivery?.status)
            assertEquals("first prompt", restored.draft)
            val restoredState = MutableStateFlow(state.value.copy(deliveries = mapOf(pane to restored.delivery!!),
                drafts = mapOf(pane to restored.draft)))
            val restoredRecovery = RemoteRecoveryOwner(DraftRecovery({ stored.get() }, { stored.set(it) }), this,
                { restoredState.value }, { error(it) })
            restoredRecovery.load(scopeKey)
            val restoredOwner = RemoteDeliveryOwner(restoredState, restoredRecovery, { api }, { 0L }, PaneSelectionLifecycle(), {})
            val secondReceipt = restoredOwner.operationId()
            assertThrows(IllegalStateException::class.java) {
                runBlocking { restoredOwner.dispatchPrompt(pane, secondReceipt, "second prompt", "terminal-view", body, api, 0L) }
            }
            assertEquals(listOf(firstReceipt), receivedReceipts)
            assertEquals(firstReceipt, restoredState.value.deliveries[pane]?.id)
        } finally {
            server.close()
            peer.join(5000)
        }
    }
}
