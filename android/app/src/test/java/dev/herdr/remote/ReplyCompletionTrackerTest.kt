package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class ReplyCompletionTrackerTest {
    private fun pane(status: String, id: String = "one", kind: String = "codex") = Pane(id, "workspace", kind = kind, status = status)
    private fun snapshot(vararg panes: Pane) = Snapshot(herdrOnline = true, panes = panes.toList())
    @Test fun historicalRepliesDoNotAlert() {
        val tracker = ReplyCompletionTracker()
        assertTrue(tracker.accept(snapshot(pane("done"), pane("idle", "two"))).isEmpty())
    }
    @Test fun completionAlertsOnlyOnceAndNewTurnsAlertAgain() {
        val tracker = ReplyCompletionTracker()
        tracker.accept(snapshot(pane("working")))
        assertEquals(listOf("one"), tracker.accept(snapshot(pane("done"))).map { it.id })
        assertTrue(tracker.accept(snapshot(pane("idle"))).isEmpty())
        tracker.accept(snapshot(pane("working")))
        assertEquals(1, tracker.accept(snapshot(pane("done"))).size)
    }
    @Test fun idleAfterObservedClaudeWorkNeverAlertsOrCarriesIntoLaterDone() {
        for (eventId in listOf<String?>(null, "already-seen")) {
            val tracker = ReplyCompletionTracker()
            tracker.accept(snapshot(pane("working", kind = "claude")))
            val idle = pane("idle", kind = "claude").copy(completionEventId = eventId,
                completionAcknowledged = eventId != null)
            assertTrue(tracker.accept(snapshot(idle)).isEmpty())
            assertTrue(tracker.accept(snapshot(idle.copy(status = "done"))).isEmpty())
        }
    }
    @Test fun acknowledgedDoneDoesNotAlertButNextUnacknowledgedTurnDoes() {
        val tracker = ReplyCompletionTracker()
        tracker.accept(snapshot(pane("working", kind = "claude")))
        val done = pane("done", kind = "claude").copy(completionEventId = "seen")
        assertTrue(tracker.accept(snapshot(done.copy(completionAcknowledged = true))).isEmpty())
        tracker.accept(snapshot(pane("working", kind = "claude")))
        assertTrue(tracker.accept(snapshot(done.copy(acknowledgedCompletionEventIds = listOf("seen")))).isEmpty())
        tracker.accept(snapshot(pane("working", kind = "claude")))
        assertEquals(listOf("one"), tracker.accept(snapshot(done.copy(completionEventId = "new"))).map { it.id })
    }
    @Test fun blockedUnknownAndTerminalsAreNotReplies() {
        for (status in listOf("blocked", "needs_input", "unknown")) {
            val tracker = ReplyCompletionTracker()
            tracker.accept(snapshot(pane("working")))
            assertTrue(tracker.accept(snapshot(pane(status))).isEmpty())
            assertTrue(tracker.accept(snapshot(pane("idle"))).isEmpty())
        }
        val tracker = ReplyCompletionTracker()
        tracker.accept(snapshot(pane("working", kind = "terminal")))
        assertTrue(tracker.accept(snapshot(pane("done", kind = "terminal"))).isEmpty())
    }
    @Test fun offlineRetainsObservedWorkButNeverAlertsNewCompletedPanes() {
        val tracker = ReplyCompletionTracker()
        tracker.accept(snapshot(pane("working")))
        tracker.accept(Snapshot())
        assertEquals(listOf("one"), tracker.accept(snapshot(pane("done"), pane("done", "new"))).map { it.id })
    }
    @Test fun closedOrChangedAgentsDoNotCompleteOldWork() {
        val tracker = ReplyCompletionTracker()
        tracker.accept(snapshot(pane("working")))
        tracker.accept(snapshot())
        assertTrue(tracker.accept(snapshot(pane("done"))).isEmpty())
        tracker.accept(snapshot(pane("working")))
        assertTrue(tracker.accept(snapshot(pane("done", kind = "claude"))).isEmpty())
    }
    @Test fun explicitResetForgetsOldWork() {
        val tracker = ReplyCompletionTracker()
        tracker.accept(snapshot(pane("working")))
        tracker.reset()
        assertTrue(tracker.accept(snapshot(pane("done"))).isEmpty())
    }
}
