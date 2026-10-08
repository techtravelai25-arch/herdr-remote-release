package dev.herdr.remote

import android.content.Context
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.test.platform.app.InstrumentationRegistry
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

    @Test fun dashboardKeepsActiveRowsAboveIdleAcrossProjectGroupsWithoutDroppingRows() {
        val preferences = InstrumentationRegistry.getInstrumentation().targetContext
            .getSharedPreferences("session_browsing", Context.MODE_PRIVATE)
        val originalGrouping = preferences.getString("grouping", null)
        preferences.edit().putString("grouping", "PROJECT").commit()
        try {
            val listState = LazyListState()
            val panes = listOf(
                Pane("idle-a", "one", title = "Idle Alpha", cwd = "/alpha", projectId = "alpha",
                    projectLabel = "Alpha", status = "idle", lastActivity = "2026-01-05T00:00:00Z"),
                Pane("working-b", "two", title = "Working Beta", cwd = "/beta", projectId = "beta",
                    projectLabel = "Beta", status = "working", lastActivity = "2026-01-02T00:00:00Z"),
                Pane("waiting-a", "one", title = "Waiting Alpha", cwd = "/alpha", projectId = "alpha",
                    projectLabel = "Alpha", status = "needs_input", lastActivity = "2026-01-01T00:00:00Z"),
            )
            val state = RemoteState(online = true, snapshot = Snapshot(herdrOnline = true, panes = panes))
            compose.setContent { HerdrTheme {
                SessionsScreen(state, {}, {}, {}, {}, {}, listState = listState)
            } }

            val expected = listOf(
                3 to "group:0:project:beta", 4 to "pane:working-b",
                5 to "group:0:project:alpha", 6 to "pane:waiting-a",
                7 to "group:2:project:alpha", 8 to "pane:idle-a",
            )
            for ((index, key) in expected) {
                compose.onNode(hasScrollToIndexAction()).performScrollToIndex(index)
                compose.runOnIdle {
                    assertEquals(10, listState.layoutInfo.totalItemsCount)
                    assertEquals(key, listState.layoutInfo.visibleItemsInfo.first { it.index == index }.key)
                }
            }
            compose.onNodeWithText("Idle Alpha").assertExists()
        } finally {
            preferences.edit().apply {
                if (originalGrouping == null) remove("grouping") else putString("grouping", originalGrouping)
            }.commit()
        }
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
