package dev.herdr.remote

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class NewSessionUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun pendingCreationAndFailureStayVisibleWithoutRetrying() {
        val creation = mutableStateOf(DeliveryState("request", "sending", "Starting agent…"))
        var creates = 0
        var cancels = 0
        compose.setContent { HerdrTheme {
            NewSessionDialog("claude", {}, true, false, "/tmp/qa", true, false, {},
                "qa-claude", {}, true, creation.value.status != "sending", { creates++ }, { cancels++ }, creation.value)
        } }
        compose.onNodeWithText("Starting agent…").assertIsDisplayed()
        compose.onNodeWithText("Start agent").assertIsNotEnabled()
        val message = "Session creation is uncertain. Check the dashboard before retrying."
        compose.runOnIdle { creation.value = DeliveryState("request", "uncertain", message) }
        compose.onNodeWithText(message).assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { assertEquals(0, creates); assertEquals(1, cancels) }
    }
}
