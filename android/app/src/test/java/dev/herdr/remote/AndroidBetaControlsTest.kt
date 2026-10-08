package dev.herdr.remote

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class AndroidBetaControlsTest {
    @Test fun dashboardPromotesOnlyFreshUnreadUnacknowledgedCompletionsAfterAttention() {
        val terminal = Pane(id = "terminal", workspaceId = "w", kind = "terminal", status = "done")
        val ordinary = Pane(id = "ordinary", workspaceId = "w", kind = "agent", status = "working")
        val completed = Pane(id = "completed", workspaceId = "w", kind = "agent", status = "done", completionEventId = "event-1")

        assertNull(featuredDashboardPane(listOf(terminal, ordinary, completed), emptySet(), setOf("completed"), freshSnapshot = true))
        assertEquals(completed, featuredDashboardPane(listOf(terminal, completed), emptySet(), setOf("completed"), freshSnapshot = true))
        assertNull(featuredDashboardPane(listOf(completed.copy(status = "idle")), emptySet(), setOf("completed"), freshSnapshot = true))
        assertNull(featuredDashboardPane(listOf(completed), emptySet(), setOf("completed"), freshSnapshot = false))
        assertNull(featuredDashboardPane(listOf(completed), emptySet(), emptySet(), freshSnapshot = true))
        assertNull(featuredDashboardPane(listOf(completed.copy(completionAcknowledged = true)), emptySet(), setOf("completed"), freshSnapshot = true))
        assertNull(featuredDashboardPane(listOf(completed.copy(acknowledgedCompletionEventIds = listOf("event-1"))), emptySet(), setOf("completed"), freshSnapshot = true))
        assertNull(featuredDashboardPane(listOf(completed.copy(completionEventId = null)), emptySet(), setOf("completed"), freshSnapshot = true))
        assertNull(featuredDashboardPane(listOf(terminal), emptySet(), setOf("terminal"), freshSnapshot = true))

        val blocked = Pane(id = "blocked", workspaceId = "w", kind = "agent", status = "blocked")
        assertEquals(blocked, featuredDashboardPane(listOf(completed, blocked), setOf("blocked"), setOf("completed"), freshSnapshot = true))
        assertNull(featuredDashboardPane(listOf(ordinary, blocked), setOf("blocked"), emptySet(), freshSnapshot = true))
        assertNull(featuredDashboardPane(listOf(completed, completed.copy(id = "idle", status = "idle")),
            setOf("idle"), emptySet(), freshSnapshot = true))
    }

    @Test fun dashboardPromotesTheNewestEligibleSessionWithinEachPriority() {
        val olderAttention = Pane(id = "older-attention", workspaceId = "w", status = "blocked", lastActivity = "2026-01-01T00:00:00Z")
        val newerAttention = Pane(id = "newer-attention", workspaceId = "w", status = "blocked", lastActivity = "2026-01-03T00:00:00Z")
        val olderCompletion = Pane(id = "older-completion", workspaceId = "w", kind = "agent", status = "done",
            lastActivity = "2026-01-02T00:00:00Z", completionEventId = "event-1")
        val newerCompletion = Pane(id = "newer-completion", workspaceId = "w", kind = "agent", status = "done",
            lastActivity = "2026-01-04T00:00:00Z", completionEventId = "event-2")
        val panes = listOf(olderAttention, olderCompletion, newerAttention, newerCompletion)

        assertEquals(newerAttention, featuredDashboardPane(panes, setOf("older-attention", "newer-attention"),
            setOf("older-completion", "newer-completion"), freshSnapshot = true))
        assertEquals(newerCompletion, featuredDashboardPane(panes, emptySet(),
            setOf("older-completion", "newer-completion"), freshSnapshot = true))
    }

    @Test fun existingBridgesRetainControlWhileObserverSnapshotDisablesIt() {
        val older = Json.decodeFromString<Snapshot>("""{"herdrOnline":true}""")
        assertTrue(older.canControl)
        assertEquals("normal", older.permissionMode)
        val observer = Json.decodeFromString<Snapshot>("""{"herdrOnline":true,"permissionMode":"observer","canControl":false}""")
        assertFalse(observer.canControl)
        assertEquals("observer", observer.permissionMode)
    }

    @Test fun guideIsOnlyAutomaticForFreshInstallsWithoutNotificationOpening() {
        assertTrue(shouldShowFirstRunGuide(false, 1000, 1000, false))
        assertFalse(shouldShowFirstRunGuide(true, 1000, 1000, false))
        assertFalse(shouldShowFirstRunGuide(false, 1000, 20000, false))
        assertFalse(shouldShowFirstRunGuide(false, 1000, 1000, true))
    }

    @Test fun previewsNeverRenderActiveDocumentTypes() {
        assertTrue(isInertTextPreview("text/plain"))
        assertTrue(isInertTextPreview("application/json"))
        assertFalse(isInertTextPreview("text/html"))
        assertFalse(isInertTextPreview("image/svg+xml"))
        assertFalse(isInertTextPreview(null))
    }
}
