package dev.herdr.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationNavigationTest {
    private val target = Pane("reply-pane", "workspace")

    @Test fun coldLaunchWaitsForLiveMembership() {
        assertEquals(NotificationPaneResolution.WAIT, notificationPaneResolution(target.id, false, Snapshot()))
        assertEquals(NotificationPaneResolution.WAIT,
            notificationPaneResolution(target.id, true, Snapshot(herdrOnline = false)))
    }

    @Test fun staleMembershipCannotOpenOrDismissTheTarget() {
        for (panes in listOf(emptyList(), listOf(target))) {
            assertEquals(NotificationPaneResolution.WAIT,
                notificationPaneResolution(target.id, true, Snapshot(herdrOnline = true, stale = true, panes = panes)))
        }
    }

    @Test fun disconnectedCachedMembershipDoesNotResolveTheTarget() {
        assertEquals(NotificationPaneResolution.WAIT,
            notificationPaneResolution(target.id, false, Snapshot(herdrOnline = true, panes = listOf(target))))
    }

    @Test fun currentMembershipOpensOnlyTheRequestedConversation() {
        assertEquals(NotificationPaneResolution.OPEN,
            notificationPaneResolution(target.id, true, Snapshot(herdrOnline = true, panes = listOf(target))))
        assertEquals(NotificationPaneResolution.CLOSED,
            notificationPaneResolution(target.id, true, Snapshot(herdrOnline = true, panes = listOf(Pane("other", "workspace")))))
    }
}
