package dev.herdr.remote

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class ReconnectionTest {
    @Test fun outageRetriesIndefinitelyWithCappedBackoff() = runBlocking {
        val waits = mutableListOf<Long>()
        var attempts = 0
        var disconnects = 0
        try {
            reconnectContinuously(
                disconnected = { disconnects++ },
                pause = { waits += it; if (waits.size == 8) throw CancellationException() },
            ) { attempts++; throw IOException("Laptop asleep") }
        } catch (_: CancellationException) { }
        assertEquals(8, attempts)
        assertEquals(8, disconnects)
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 16000L, 16000L, 16000L), waits)
    }

    @Test fun successfulReconnectResetsBackoffAndCleanClosureRetries() = runBlocking {
        val waits = mutableListOf<Long>()
        var attempts = 0
        var disconnects = 0
        try {
            reconnectContinuously(
                disconnected = { disconnects++ },
                pause = { waits += it; if (waits.size == 4) throw CancellationException() },
            ) { connected ->
                attempts++
                if (attempts < 3) throw IOException("Offline")
                connected() // A live stream can close normally, too.
            }
        } catch (_: CancellationException) { }
        assertEquals(4, attempts)
        assertEquals(4, disconnects)
        assertEquals(listOf(1000L, 2000L, 1000L, 1000L), waits)
    }

    @Test fun backgroundOrForgetCancellationDoesNotRetry() = runBlocking {
        val cancellation = CancellationException("Leaving foreground")
        var disconnects = 0
        var waits = 0
        var attempts = 0
        try {
            reconnectContinuously(disconnected = { disconnects++ }, pause = { waits++ }) {
                attempts++
                throw cancellation
            }
        } catch (caught: CancellationException) { assertSame(cancellation, caught) }
        assertEquals(1, attempts)
        assertEquals(0, disconnects)
        assertEquals(0, waits)
    }
    @Test fun unavailableCachedPaneRefreshesBeforeAllowingControl() = runBlocking {
        val pane = Pane("pane-1", "workspace-1")
        var refreshes = 0
        requireAvailablePane("pane-1", online = false, Snapshot(herdrOnline = false, panes = listOf(pane))) {
            refreshes++
            Snapshot(herdrOnline = true, panes = listOf(pane))
        }
        assertEquals(1, refreshes)
    }

    @Test fun restartedHerdrCanRestoreTheSamePaneIdentity() = runBlocking {
        var refreshes = 0
        requireAvailablePane("pane-1", online = true, Snapshot(herdrOnline = false)) {
            refreshes++
            Snapshot(herdrOnline = true, panes = listOf(Pane("pane-1", "workspace-1")))
        }
        assertEquals(1, refreshes)
    }

    @Test fun replacementPaneNeverReceivesControlsIntendedForClosedPane() = runBlocking {
        val replacement = Snapshot(herdrOnline = true, panes = listOf(Pane("pane-2", "workspace-1")))
        try {
            requireAvailablePane("pane-1", online = true, replacement) { replacement }
            org.junit.Assert.fail("The closed pane must stay unavailable")
        } catch (error: IllegalArgumentException) {
            assertEquals("This pane has closed. Select the reopened pane from the dashboard.", error.message)
        }
    }

    @Test fun currentLivePaneDoesNotNeedAnExtraSnapshotRequest() = runBlocking {
        requireAvailablePane("pane-1", online = true,
            Snapshot(herdrOnline = true, panes = listOf(Pane("pane-1", "workspace-1")))) {
            error("A current live pane needs no recovery")
        }
    }

    @Test fun stillOfflineSnapshotCannotEnableControl() = runBlocking {
        try {
            requireAvailablePane("pane-1", online = false, Snapshot()) {
                Snapshot(herdrOnline = false, panes = listOf(Pane("pane-1", "workspace-1")), error = "Laptop offline")
            }
            org.junit.Assert.fail("Cached panes must not enable controls while Herdr is offline")
        } catch (error: IllegalArgumentException) {
            assertEquals("Laptop offline", error.message)
        }
    }

    @Test fun staleSnapshotMustRefreshEvenIfItClaimsHerdrIsOnline() = runBlocking {
        val stale = Snapshot(herdrOnline = true, stale = true, panes = listOf(Pane("pane-1", "workspace")))
        var refreshed = false
        requireAvailablePane("pane-1", true, stale) { refreshed = true; stale.copy(stale = false) }
        assertEquals(true, refreshed)
    }

    @Test fun acknowledgedReplacementWaitsThroughOldAndOfflineSnapshots() {
        val navigation = PaneSelectionLifecycle()
        navigation.acknowledge(navigation.generation, "new")
        val old = Snapshot(herdrOnline = true, panes = listOf(Pane("old", "workspace")))
        assertEquals(null, navigation.consume(old))
        assertEquals(null, navigation.consume(old.copy(herdrOnline = false)))
        val replacement = old.copy(panes = listOf(Pane("new", "workspace")))
        assertEquals("new", navigation.consume(replacement))
        assertEquals(null, navigation.consume(replacement))
    }

    @Test fun navigationOrConnectionChangeCancelsPendingAndInFlightRestartSelection() {
        val navigation = PaneSelectionLifecycle()
        val startedAt = navigation.generation
        navigation.cancel()
        navigation.acknowledge(startedAt, "new")
        val replacement = Snapshot(herdrOnline = true, panes = listOf(Pane("new", "workspace")))
        assertEquals(null, navigation.consume(replacement))
        navigation.acknowledge(navigation.generation, "new")
        navigation.cancel()
        assertEquals(null, navigation.consume(replacement))
    }

    @Test fun paneLookupRaceRetriesWithoutNeedingAnotherSnapshotEvent() = runBlocking {
        val unchanged = Snapshot(herdrOnline = true, panes = listOf(Pane("pane", "workspace")))
        var reads = 0
        var output = ""
        // The observer retains the same snapshot throughout this recovery.
        while (output.isEmpty()) {
            try {
                reads++
                if (reads == 1) throw BridgeHttpException(409, "Pane closed", "pane_not_found")
                output = "Reopened output"
            } catch (error: BridgeHttpException) {
                if (!shouldRetryPaneOutput(error, "pane", unchanged)) throw error
            }
        }
        assertEquals(2, reads)
        assertEquals("Reopened output", output)
    }

    @Test fun permanentOutputErrorsAndConfirmedClosedPanesDoNotRetry() {
        val live = Snapshot(herdrOnline = true, panes = listOf(Pane("pane", "workspace")))
        assertEquals(false, shouldRetryPaneOutput(BridgeHttpException(409, "Denied", "permission_denied"), "pane", live))
        assertEquals(false, shouldRetryPaneOutput(BridgeHttpException(401, "Sign in"), "pane", live))
        assertEquals(false, shouldRetryPaneOutput(BridgeHttpException(409, "Closed", "pane_not_found"), "pane", live.copy(panes = emptyList())))
    }


    @Test fun liveSelectionSurvivesEmptyOutageButClosesWhenFreshMembershipRemovesIt() {
        val lifecycle = PaneSelectionLifecycle()
        val old = Snapshot(herdrOnline = true, panes = listOf(Pane("old", "workspace")))
        val replacement = old.copy(panes = listOf(Pane("new", "workspace")))
        lifecycle.selected()
        assertEquals("old", lifecycle.reconcile("old", Snapshot()))
        assertEquals(null, lifecycle.reconcile("old", replacement))
        lifecycle.selected() // An absent session cannot be reopened from local recovery data.
        assertEquals(null, lifecycle.reconcile("old", replacement))
    }

    @Test fun successfulReceiptRecoversRestartAfterAutomaticCloseAndEmptyOutage() {
        val lifecycle = PaneSelectionLifecycle()
        val old = Snapshot(herdrOnline = true, panes = listOf(Pane("old", "workspace")))
        val replacement = old.copy(panes = listOf(Pane("new", "workspace")))
        lifecycle.selected()
        lifecycle.started("operation", "old")
        assertEquals(null, lifecycle.reconcile("old", old.copy(panes = emptyList())))
        assertEquals(true, lifecycle.canRecover("operation", "old"))
        lifecycle.acknowledgeReceipt("operation", "old", "new")
        assertEquals(null, lifecycle.reconcile(null, Snapshot()))
        assertEquals(null, lifecycle.reconcile(null, old))
        assertEquals("new", lifecycle.reconcile(null, replacement))
    }

    @Test fun explicitNavigationCancelsReceiptRecoveryAfterAutomaticClose() {
        val lifecycle = PaneSelectionLifecycle()
        val old = Snapshot(herdrOnline = true, panes = listOf(Pane("old", "workspace")))
        val replacement = old.copy(panes = listOf(Pane("new", "workspace")))
        lifecycle.selected()
        lifecycle.started("operation", "old")
        assertEquals(null, lifecycle.reconcile("old", old.copy(panes = emptyList())))
        lifecycle.selected()
        assertEquals(false, lifecycle.canRecover("operation", "old"))
        lifecycle.acknowledgeReceipt("operation", "old", "new")
        assertEquals(null, lifecycle.reconcile(null, replacement))
    }
}
