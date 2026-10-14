package dev.herdr.remote

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class NotificationSettingsUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun pauseSwitchReportsChangeWithoutTouchingDeliveryModes() {
        val state = mutableStateOf(RemoteState(cloudPushEnabled = true, cloudPushStatus = "Cloud push is on"))
        val pauses = mutableListOf<Boolean>()
        val cloud = mutableListOf<Boolean>()
        compose.setContent { HerdrTheme {
            NotificationSettingsDialog(state.value, denied = false,
                onCloudChange = { cloud += it },
                onPauseChange = { pauses += it; state.value = state.value.copy(alertsPaused = it) },
                onMonitoring = {}, onDismiss = {})
        } }
        val pause = isToggleable() and hasText("Pause phone alerts", substring = true)
        compose.onNode(pause).assertIsOff().performClick()
        compose.onNode(pause).assertIsOn().performClick()
        compose.onNode(pause).assertIsOff()
        compose.runOnIdle {
            assertEquals(listOf(true, false), pauses)
            assertEquals(emptyList<Boolean>(), cloud)
        }
    }
}
