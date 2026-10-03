package dev.herdr.remote

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class SessionsDeliveryUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun dashboardReordersRowsAfterActivityAndKeepsTheirSelectionIdentity() {
        val old = Pane("old", "work", title = "Older session", cwd = "/test",
            lastActivity = "2026-01-01T00:00:00Z")
        val recent = Pane("recent", "work", title = "Recent session", cwd = "/test",
            lastActivity = "2026-01-02T00:00:00Z")
        val state = mutableStateOf(RemoteState(online = true,
            snapshot = Snapshot(herdrOnline = true, panes = listOf(old, recent))))
        var selected: String? = null
        compose.setContent { HerdrTheme {
            SessionsScreen(state.value, { selected = it }, {}, {}, {}, {})
        } }
        fun top(title: String) = compose.onNodeWithText(title).fetchSemanticsNode().boundsInRoot.top
        assertTrue(top("Recent session") < top("Older session"))
        compose.runOnIdle {
            state.value = state.value.copy(snapshot = state.value.snapshot.copy(
                panes = listOf(old.copy(lastActivity = "2026-01-03T00:00:00Z"), recent)))
        }
        assertTrue(top("Older session") < top("Recent session"))
        compose.onNodeWithText("Older session").performClick()
        compose.runOnIdle { assertEquals("old", selected) }
    }

    @Test fun uncertainCreationRequiresConfirmationAndNeverRetries() {
        var checks = 0
        var acknowledgements = 0
        val state = RemoteState(online = true, deliveries = mapOf(
            "__create__" to DeliveryState("first", "uncertain", "Inspect the sessions.", operation = "agent.create")))
        compose.setContent { HerdrTheme {
            SessionsScreen(state, {}, {}, {}, {}, { checks++ }, onAcknowledgeCreate = { acknowledgements++ })
        } }
        compose.onNodeWithText("Check delivery").performClick()
        compose.runOnIdle { assertEquals(1, checks); assertEquals(0, acknowledgements) }
        compose.onNodeWithText("I've checked the sessions").performClick()
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { assertEquals(0, acknowledgements) }
        compose.onNodeWithText("I've checked the sessions").performClick()
        compose.onNodeWithText("I've checked · Continue").performClick()
        compose.runOnIdle { assertEquals(1, checks); assertEquals(1, acknowledgements) }
    }

    @Test fun confirmationCannotAcknowledgeAStillRunningCreation() {
        val state = mutableStateOf(RemoteState(online = true, deliveries = mapOf(
            "__create__" to DeliveryState("first", "uncertain", "Inspect the sessions.", operation = "agent.create"))))
        var acknowledgements = 0
        compose.setContent { HerdrTheme {
            SessionsScreen(state.value, {}, {}, {}, {}, {}, onAcknowledgeCreate = { acknowledgements++ })
        } }
        compose.onNodeWithText("I've checked the sessions").performClick()
        compose.runOnIdle {
            state.value = state.value.copy(deliveries = mapOf(
                "__create__" to DeliveryState("first", "running", "Still running.", operation = "agent.create")))
        }
        compose.onNodeWithText("I've checked · Continue").assertDoesNotExist()
        compose.onNodeWithText("I've checked the sessions").assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, acknowledgements) }
    }
}
