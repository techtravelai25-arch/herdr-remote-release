package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class DraftRecoveryTest {
    @Test fun unreadableArchiveIsNotOverwrittenByMigrationOrBackgroundPersistence() {
        val raw = """{"entries":[{"scope":"a","draft":"recoverable bytes","paneId":null}]}"""
        var stored = raw
        val recovery = DraftRecovery({ stored }, { stored = it })
        assertTrue(recovery.load().entries.isEmpty())
        assertTrue(recovery.cleanupFailed)
        assertTrue(recovery.failureMessage.orEmpty().contains("Forget the connection"))
        assertEquals(raw, stored)
        assertThrows(IllegalStateException::class.java) { recovery.save(RecoveryArchive()) }
        assertEquals(raw, stored)
        recovery.clear()
        assertFalse(recovery.cleanupFailed)
        assertNull(recovery.failureMessage)
        assertTrue(recovery.load().entries.isEmpty())
        assertNotEquals(raw, stored)
    }
    @Test fun processRestartKeepsReceiptIdButDoesNotPretendSendIsStillRunning() {
        val archive = RecoveryArchive(entries = listOf(RecoveryEntry("a", "p", draft = "hello", delivery = DeliveryState("stable-id", "sending", "Sending", "hello"))))
        val recovered = recoverDeliveries(archive).entries.single()
        assertEquals("stable-id", recovered.delivery?.id)
        assertEquals("uncertain", recovered.delivery?.status)
        assertEquals("hello", recovered.draft)
    }
    @Test fun scopeSeparatesAccountsAndLaptops() {
        assertNotEquals(conversationScope("https://a", "phone", "one"), conversationScope("https://a", "phone", "two"))
        assertNotEquals(conversationScope("https://a", "phone"), conversationScope("https://b", "phone"))
        assertEquals(conversationScope("https://a", "phone"), conversationScope("https://a", "phone"))
    }
    @Test fun upgradeRemovesOutputInEveryScopeButPreservesDraftsAndReceipts() {
        val now = 900000000L
        val raw = """{
          "historyEnabled": true,
          "entries": [
            {"scope":"a","paneId":"draft","draft":"unfinished prompt","text":"private output a","savedAt":900000000,"touchedAt":900000000,"truncated":true},
            {"scope":"b","paneId":"receipt","text":"private output b","touchedAt":900000000,"delivery":{"id":"operation","status":"sending","message":"Sending","draft":"pending prompt"}},
            {"scope":"b","paneId":"output-only","text":"private output c","touchedAt":900000000}
          ]
        }"""
        val archive = decodeRecovery(raw, now)
        assertEquals(listOf("draft", "receipt"), archive.entries.map { it.paneId })
        assertEquals("unfinished prompt", archive.entries.first().draft)
        assertEquals("operation", archive.entries.last().delivery?.id)
        assertEquals("pending prompt", archive.entries.last().delivery?.draft)
        val rewritten = Json.encodeToString(archive)
        assertFalse(rewritten.contains("private output"))
        assertFalse(rewritten.contains("historyEnabled"))
        assertFalse(rewritten.contains("savedAt"))
        assertFalse(rewritten.contains("truncated"))
        assertEquals(archive, decodeRecovery(rewritten, now))
        assertEquals("uncertain", recoverDeliveries(archive).entries.last().delivery?.status)
    }
    @Test fun recoveryDataIsBoundedAndExpires() {
        val now = 900000000L
        val archive = boundRecovery(RecoveryArchive((1..60).map {
            RecoveryEntry("a", "$it", "d".repeat(20000), now)
        }), now)
        assertEquals(30, archive.entries.size)
        assertTrue(archive.entries.all { it.draft.length == 16000 })
        assertTrue(boundRecovery(archive, now + 7 * 86400000L).entries.isEmpty())
        val hugeReceipt = RecoveryEntry("a", "large", touchedAt = now,
            delivery = DeliveryState("r", "uncertain", "Check", "x".repeat(1024 * 1024 + 1)))
        assertTrue(boundRecovery(RecoveryArchive(listOf(hugeReceipt)), now).entries.isEmpty())
    }
    @Test fun attentionBaselineReconnectReadAndClosedPanes() {
        val tracker = AttentionTracker()
        fun s(status: String) = Snapshot(herdrOnline = true, panes = listOf(Pane("p", "w", kind = "codex", status = status)))
        assertTrue(tracker.accept(s("idle"), null).isEmpty())
        tracker.accept(s("working"), null)
        assertEquals(setOf("p"), tracker.accept(s("blocked"), null))
        assertEquals(setOf("p"), tracker.accept(Snapshot(), null))
        assertTrue(tracker.accept(s("blocked"), "p").isEmpty())
        assertTrue(tracker.accept(Snapshot(herdrOnline = true), null).isEmpty())
    }
    @Test fun inputAlertsRequireNewObservedState() {
        val tracker = InputAttentionTracker()
        fun s(status: String) = Snapshot(herdrOnline = true, panes = listOf(Pane("p", "w", kind = "codex", status = status)))
        assertTrue(tracker.accept(s("blocked")).isEmpty())
        tracker.accept(s("working"))
        assertEquals(1, tracker.accept(s("blocked")).size)
        assertTrue(tracker.accept(s("blocked")).isEmpty())
    }
}
