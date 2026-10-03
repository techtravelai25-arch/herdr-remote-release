package dev.herdr.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import org.junit.Assert.*
import org.junit.Test

class CompletionAlertLedgerTest {
    private val t = 1_000_000L
    private val a = "11111111-1111-4111-8111-111111111111"
    private val b = "22222222-2222-4222-8222-222222222222"
    private val slot = "push:laptop:pane"

    @Test fun delayedClearDoesNotRemoveNewerCompletion() {
        val first = CompletionAlertLedger().show(slot, "laptop", a, t).first
        val newer = first.show(slot, "laptop", b, t + 1).first
        val (cleared, cancel) = newer.clear(slot, "laptop", a, t + 2)
        assertFalse(cancel)
        assertEquals(b, cleared.current[slot])
        assertFalse(cleared.show(slot, "laptop", a, t + 3).second)
    }

    @Test fun clearBeforeShowSurvivesSerializationAndPermissionIndependentState() {
        val (cleared, cancel) = CompletionAlertLedger().clear(slot, "laptop", a, t)
        assertFalse(cancel)
        val restored = Bridge.json.decodeFromString<CompletionAlertLedger>(Bridge.json.encodeToString(cleared))
        assertFalse(restored.show(slot, "laptop", a, t + 1000).second)
        assertTrue(restored.show(slot, "laptop", b, t + 1000).second)
    }

    @Test fun laptopAndPaneScopeAreIndependent() {
        val otherLaptop = "push:other:pane"
        val otherPane = "push:laptop:other-pane"
        val initial = CompletionAlertLedger().show(slot, "laptop", a, t).first
            .show(otherLaptop, "other", a, t).first.show(otherPane, "laptop", a, t).first
        val result = initial.clear(slot, "laptop", a, t + 1).first
        assertNull(result.current[slot])
        assertEquals(a, result.current[otherLaptop])
        assertEquals(a, result.current[otherPane])
    }

    @Test fun tombstonesRemainForSeventyTwoHours() {
        val state = CompletionAlertLedger().clear(slot, "laptop", a, t).first
        assertFalse(state.show(slot, "laptop", a, t + 48L * 60 * 60 * 1000).second)
        assertTrue(state.show(slot, "laptop", a, t + CompletionAlertLedger.RETENTION_MS + 1).second)
    }
    @Test fun snapshotBaselineDoesNotEmitAndAcknowledgementClearsExactTarget() {
        val historical = Snapshot(herdrOnline = true, panes = listOf(Pane("pane", "workspace", kind = "codex",
            status = "done", completionEventId = a)))
        val (baseline, baselineCancel) = CompletionAlertLedger().reconcile(historical, "local", "laptop", t)
        assertTrue(baseline.current.isEmpty())
        assertTrue(baselineCancel.isEmpty())
        val newer = baseline.show(slot, "laptop", b, t + 1).first
        val acknowledgedOld = historical.copy(panes = historical.panes.map { it.copy(completionAcknowledged = true) })
        val (afterOldAck, wrongCancel) = newer.reconcile(acknowledgedOld, "local", "laptop", t + 2)
        assertTrue(wrongCancel.isEmpty())
        assertEquals(b, afterOldAck.current[slot])
        val acknowledgedNew = acknowledgedOld.copy(panes = acknowledgedOld.panes.map { it.copy(completionEventId = b) })
        val (afterNewAck, cancelled) = afterOldAck.reconcile(acknowledgedNew, "local", "laptop", t + 3)
        assertEquals(listOf(slot), cancelled)
        assertNull(afterNewAck.current[slot])
    }

    @Test fun staleAndOfflineSnapshotsNeverDismiss() {
        val state = CompletionAlertLedger().show(slot, "laptop", a, t).first
        val pane = Pane("pane", "workspace", kind = "codex", completionEventId = a, completionAcknowledged = true)
        for (snapshot in listOf(Snapshot(herdrOnline = true, stale = true, panes = listOf(pane)),
            Snapshot(herdrOnline = false, panes = listOf(pane)))) {
            val (result, cancelled) = state.reconcile(snapshot, "local", "laptop", t + 1)
            assertTrue(cancelled.isEmpty())
            assertEquals(a, result.current[slot])
        }
    }

    @Test fun repeatedAcknowledgedSnapshotIsIdempotent() {
        val acknowledged = Snapshot(herdrOnline = true, panes = listOf(Pane("pane", "workspace",
            completionEventId = a, completionAcknowledged = true)))
        val first = CompletionAlertLedger().reconcile(acknowledged, "local", "laptop", t).first
        val second = first.reconcile(acknowledged, "local", "laptop", t + 1000)
        assertEquals(first, second.first)
        assertTrue(second.second.isEmpty())
    }

    @Test fun reconnectHistoryClearsOldCompletionButRetainsNewerOne() {
        val initial = CompletionAlertLedger().show(slot, "laptop", a, t).first
        val reconnect = Snapshot(herdrOnline = true, panes = listOf(Pane("pane", "workspace",
            kind = "codex", status = "done", completionEventId = b,
            acknowledgedCompletionEventIds = listOf(a))))
        val (after, cancelled) = initial.reconcile(reconnect, "local", "laptop", t + 1)
        assertEquals(listOf(slot), cancelled)
        assertNull(after.current[slot])
        assertFalse(after.show(slot, "laptop", a, t + 2).second)
        assertTrue(after.show(slot, "laptop", b, t + 2).second)
    }

}
