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
    @Test fun pcAcknowledgementClearsUnreadCompletionAndDoesNotReaddItOnIdle() {
        val tracker = AttentionTracker()
        val pane = Pane("p", "w", kind = "codex", status = "working")
        fun s(p: Pane) = Snapshot(herdrOnline = true, panes = listOf(p))
        tracker.accept(s(pane), null)
        val completed = pane.copy(status = "done", completionEventId = "completion-a")
        assertEquals(setOf("p"), tracker.accept(s(completed), null))
        val acknowledged = completed.copy(completionAcknowledged = true)
        assertTrue(tracker.accept(s(acknowledged), null).isEmpty())
        assertTrue(tracker.accept(s(acknowledged.copy(status = "idle")), null).isEmpty())
    }
    @Test fun delayedAcknowledgementOnlyClearsMatchingUnreadCompletion() {
        val tracker = AttentionTracker()
        val pane = Pane("p", "w", kind = "codex", status = "working")
        fun s(p: Pane) = Snapshot(herdrOnline = true, panes = listOf(p))
        tracker.accept(s(pane), null)
        val a = pane.copy(status = "done", completionEventId = "completion-a")
        assertEquals(setOf("p"), tracker.accept(s(a), null))
        val b = a.copy(completionEventId = "completion-b")
        assertEquals(setOf("p"), tracker.accept(s(b), null))
        assertEquals(setOf("p"), tracker.accept(s(b.copy(acknowledgedCompletionEventIds = listOf("completion-a"))), null))
        assertTrue(tracker.accept(s(b.copy(completionAcknowledged = true)), null).isEmpty())
    }
    @Test fun completionAcknowledgementPreservesUnreadBlockerAndOtherPane() {
        val tracker = AttentionTracker()
        val pane = Pane("p", "w", kind = "codex", status = "working")
        val other = pane.copy(id = "other")
        fun s(p: Pane, o: Pane) = Snapshot(herdrOnline = true, panes = listOf(p, o))
        tracker.accept(s(pane, other), null)
        val completed = pane.copy(status = "done", completionEventId = "completion-a")
        val otherCompleted = other.copy(status = "done", completionEventId = "other-completion")
        assertEquals(setOf("p", "other"), tracker.accept(s(completed, otherCompleted), null))
        val blocked = completed.copy(status = "blocked")
        tracker.accept(s(blocked, otherCompleted), null)
        assertEquals(setOf("p", "other"), tracker.accept(s(blocked.copy(completionAcknowledged = true), otherCompleted), null))
    }
    @Test fun staleAcknowledgementAndNewCompletionDoNotChangeUnreadBaseline() {
        val tracker = AttentionTracker()
        val pane = Pane("p", "w", kind = "codex", status = "working")
        fun s(p: Pane) = Snapshot(herdrOnline = true, panes = listOf(p))
        tracker.accept(s(pane), null)
        val a = pane.copy(status = "done", completionEventId = "completion-a")
        assertEquals(setOf("p"), tracker.accept(s(a), null))
        assertEquals(setOf("p"), tracker.accept(s(a.copy(completionAcknowledged = true)).copy(stale = true), null))
        val b = a.copy(completionEventId = "completion-b", acknowledgedCompletionEventIds = listOf("completion-a"))
        assertEquals(setOf("p"), tracker.accept(s(b).copy(stale = true), null))
        assertEquals(setOf("p"), tracker.accept(s(b), null))
        assertTrue(tracker.accept(s(b.copy(completionAcknowledged = true)), null).isEmpty())
    }
    @Test fun reconnectHistoryClearsCompletionAndFirstSnapshotNeverReplaysUnread() {
        val pane = Pane("p", "w", kind = "codex", status = "done", completionEventId = "completion-a")
        fun s(p: Pane) = Snapshot(herdrOnline = true, panes = listOf(p))
        assertTrue(AttentionTracker().accept(s(pane), null).isEmpty())
        assertTrue(AttentionTracker().accept(s(pane.copy(completionAcknowledged = true)), null).isEmpty())
        val tracker = AttentionTracker()
        tracker.accept(s(pane.copy(status = "working", completionEventId = null)), null)
        assertEquals(setOf("p"), tracker.accept(s(pane), null))
        assertEquals(setOf("p"), tracker.accept(Snapshot(), null))
        assertTrue(tracker.accept(s(pane.copy(status = "working", completionEventId = "completion-b",
            acknowledgedCompletionEventIds = listOf("completion-a"))), null).isEmpty())
    }
    @Test fun pcAttentionAcknowledgementClearsUnreadAndDashboardAttention() {
        val tracker = AttentionTracker()
        val working = Pane("p", "w", kind = "codex", status = "working")
        fun s(p: Pane) = Snapshot(herdrOnline = true, panes = listOf(p))
        tracker.accept(s(working), null)
        val waiting = working.copy(status = "needs_input", attentionEventId = "attention-a")
        assertEquals(setOf("p"), tracker.accept(s(waiting), null))
        assertTrue(waiting.hasUnacknowledgedAttention())
        val acknowledged = waiting.copy(attentionAcknowledged = true)
        assertFalse(acknowledged.hasUnacknowledgedAttention())
        assertEquals(setOf("p"), tracker.accept(s(acknowledged).copy(stale = true), null))
        assertTrue(tracker.accept(s(acknowledged), null).isEmpty())
        assertTrue(tracker.accept(s(acknowledged.copy(status = "error")), null).isEmpty())
    }
    @Test fun newerAttentionAndCompletionSurviveOldAttentionAcknowledgement() {
        val tracker = AttentionTracker()
        val working = Pane("p", "w", kind = "codex", status = "working")
        fun s(p: Pane) = Snapshot(herdrOnline = true, panes = listOf(p))
        tracker.accept(s(working), null)
        val a = working.copy(status = "blocked", attentionEventId = "attention-a")
        tracker.accept(s(a), null)
        val b = a.copy(attentionEventId = "attention-b", acknowledgedAttentionEventIds = listOf("attention-a"))
        assertEquals(setOf("p"), tracker.accept(s(b), null))
        assertEquals(setOf("p"), tracker.accept(s(b), null))
        assertTrue(tracker.accept(s(b.copy(attentionAcknowledged = true)), null).isEmpty())
        val completed = b.copy(status = "done", completionEventId = "completion-a", attentionAcknowledged = true)
        assertEquals(setOf("p"), tracker.accept(s(completed), null))
        assertEquals(setOf("p"), tracker.accept(s(completed), null))
    }
    @Test fun legacyAttentionUnreadNeedsConfirmedResumeAndUnknownPreservesIt() {
        assertTrue(Pane("legacy", "w", kind = "codex", status = "needs_input",
            attentionAcknowledged = true).hasUnacknowledgedAttention())
        for (resume in listOf("working", "idle", "done")) {
            val tracker = AttentionTracker()
            val pane = Pane("p", "w", kind = "codex", status = "working")
            fun s(p: Pane) = Snapshot(herdrOnline = true, panes = listOf(p))
            tracker.accept(s(pane), null)
            val waiting = pane.copy(status = "error")
            assertEquals(setOf("p"), tracker.accept(s(waiting), null))
            assertEquals(setOf("p"), tracker.accept(s(waiting.copy(status = "unknown")), null))
            assertEquals(setOf("p"), tracker.accept(s(waiting.copy(status = resume)).copy(stale = true), null))
            assertTrue(tracker.accept(s(waiting.copy(status = resume)), null).isEmpty())
        }
    }
    @Test fun inputAttentionEventsDetectNewIdentityAndSuppressAcknowledgedOrStaleState() {
        val tracker = InputAttentionTracker()
        val pane = Pane("p", "w", kind = "codex", status = "working")
        fun s(p: Pane) = Snapshot(herdrOnline = true, panes = listOf(p))
        assertTrue(tracker.accept(s(pane)).isEmpty())
        val a = pane.copy(status = "needs_input", attentionEventId = "attention-a")
        assertEquals(1, tracker.accept(s(a)).size)
        assertTrue(tracker.accept(s(a)).isEmpty())
        val b = a.copy(attentionEventId = "attention-b")
        assertTrue(tracker.accept(s(b).copy(stale = true)).isEmpty())
        assertEquals(1, tracker.accept(s(b)).size)
        assertTrue(tracker.accept(s(b.copy(status = "error", attentionAcknowledged = true))).isEmpty())
        assertFalse(b.copy(acknowledgedAttentionEventIds = listOf("attention-b")).hasUnacknowledgedAttention())
    }
    @Test fun sameAttentionIdentityCannotRecreateReadUnreadOrPopupAcrossUnknownAndAliases() {
        val unread = AttentionTracker()
        val popup = InputAttentionTracker()
        val pane = Pane("p", "w", kind = "codex", status = "working")
        fun s(p: Pane) = Snapshot(herdrOnline = true, panes = listOf(p))
        unread.accept(s(pane), null)
        popup.accept(s(pane))
        val waiting = pane.copy(status = "blocked", attentionEventId = "attention-a")
        assertEquals(setOf("p"), unread.accept(s(waiting), null))
        assertEquals(1, popup.accept(s(waiting)).size)
        unread.read("p")
        for (status in listOf("unknown", "needs_input", "blocked", "error")) {
            assertTrue(unread.accept(s(waiting.copy(status = status)), null).isEmpty())
            assertTrue(popup.accept(s(waiting.copy(status = status))).isEmpty())
        }
    }
}
