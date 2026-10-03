package dev.herdr.remote

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class AgentActionsUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun readOnlyTerminalCannotStopButCanClose() {
        val actions = mutableListOf<String>()
        compose.setContent { HerdrTheme {
            AgentActions(enabled = true, onControl = { actions += it }, terminal = true, canStop = false)
        } }
        compose.onNodeWithContentDescription("Terminal actions").performClick()
        compose.onNodeWithText("Stop pane").assertIsNotEnabled()
        compose.onNodeWithText("Start fresh").assertDoesNotExist()
        compose.onNodeWithText("Close pane").assertIsEnabled().performClick()
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions) }
        compose.onNodeWithContentDescription("Terminal actions").performClick()
        compose.onNodeWithText("Close pane").performClick()
        compose.onNodeWithText("Close", substring = false).performClick()
        compose.runOnIdle { assertEquals(listOf("close"), actions) }
    }

    @Test fun stopPermissionRevokedWhileConfirmingCannotDispatch() {
        val canStop = mutableStateOf(true)
        val actions = mutableListOf<String>()
        compose.setContent { HerdrTheme {
            AgentActions(enabled = true, onControl = { actions += it }, terminal = true, canStop = canStop.value)
        } }
        compose.onNodeWithContentDescription("Terminal actions").performClick()
        compose.onNodeWithText("Stop pane").performClick()
        compose.onNodeWithText("Stop", substring = false).assertIsEnabled()
        compose.runOnIdle { canStop.value = false }
        compose.onNodeWithText("Stop", substring = false).assertIsNotEnabled()
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions) }
    }
}
