package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class AdaptivePollingTest {
    @Test fun unchangedIdleConversationReducesRequestsByAtLeastSeventyPercent() {
        val cadence = PollCadence()
        var time = 0L; var polls = 0
        while (time < 60000) { polls++; time += cadence.next(changed = polls == 1, active = false) }
        // Both snapshot and output use this cadence; previously 20 + 40 RPC/minute.
        assertTrue("$polls per stream", polls * 2 <= 18)
    }
    @Test fun workingAndPendingActionsStayResponsive() {
        val cadence = PollCadence()
        repeat(10) { cadence.next(false, false) }
        repeat(20) { assertEquals(1500L, cadence.next(false, true)) }
        assertEquals(1500L, cadence.next(true, false))
    }
    @Test fun resetRestoresFastObservation() {
        val cadence = PollCadence()
        repeat(10) { cadence.next(false, false) }
        cadence.reset()
        assertEquals(1500L, cadence.next(true, false))
    }
    @Test fun changingOnlySnapshotTimestampDoesNotDefeatIdleBackoff() {
        val snapshot = Snapshot(herdrOnline = true, panes = listOf(Pane("p", "w", status = "idle")), lastUpdatedAt = "one")
        assertEquals(snapshotPollFingerprint(snapshot), snapshotPollFingerprint(snapshot.copy(lastUpdatedAt = "two")))
        val working = snapshot.copy(panes = snapshot.panes.map { it.copy(status = "working") })
        assertNotEquals(snapshotPollFingerprint(snapshot), snapshotPollFingerprint(working))
        assertTrue(snapshotHasWork(working)); assertFalse(snapshotHasWork(snapshot))
        assertTrue(snapshotHasWork(snapshot.copy(panes = snapshot.panes.map { it.copy(status = "needs_input") })))
    }
}
