package dev.herdr.remote

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class UncertainDeliveryUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun uncertainReceiptBlocksControlsUntilExplicitlyAcknowledged() {
        val pane = Pane("pane", "workspace", kind = "codex", status = "idle")
        val receipt = DeliveryState("first-id", "uncertain", "Delivery is uncertain", "Repeat prompt")
        var screen by mutableStateOf(RemoteState(
            online = true,
            selectedId = pane.id,
            snapshot = Snapshot(herdrOnline = true, panes = listOf(pane), terminalInputEnabled = true,
                canControl = true, agentModelSelectionEnabled = true, modelSelectionAgents = listOf("codex")),
            terminalAttachmentId = "fresh-attachment",
            outputReady = true,
            drafts = mapOf(pane.id to "Repeat prompt"),
            deliveries = mapOf(pane.id to receipt),
        ))
        var prompts = 0
        var keys = 0
        var inserts = 0
        var modelActions = 0
        var acknowledgements = 0
        compose.setContent {
            HerdrTheme {
                TerminalLiveView(screen, pane,
                    onDraft = {}, onInsert = { inserts++ }, onPrompt = { prompts++ }, onKey = { keys++ },
                    onRefresh = {}, onAttach = {}, onRemoveAttachment = {}, onManageAttachments = {},
                    onBrowseFiles = {}, onCheckDelivery = {}, onChangeModel = { modelActions++ },
                    onAcknowledgeDelivery = { id ->
                        acknowledgements++
                        screen = screen.acknowledgeUncertainDelivery(id)
                    })
            }
        }

        compose.onNodeWithContentDescription("Show terminal keys").performClick()
        compose.onNodeWithContentDescription("Send prompt").assertIsNotEnabled()
        compose.onNodeWithText("Insert text").assertIsNotEnabled()
        compose.onNodeWithText("Enter").assertIsNotEnabled()
        compose.onNodeWithText("Model").assertIsNotEnabled()

        compose.onNodeWithText("I checked the laptop").performClick()
        compose.onNodeWithText("Keep waiting").performClick()
        compose.runOnIdle { assertEquals(0, acknowledgements) }
        compose.onNodeWithText("I checked the laptop").performClick()
        compose.runOnIdle { screen = screen.copy(busy = true) }
        compose.onNodeWithText("I checked; continue").assertIsNotEnabled()
        compose.runOnIdle { screen = screen.copy(busy = false) }
        compose.onNodeWithText("I checked; continue").performClick()
        compose.runOnIdle {
            assertEquals(1, acknowledgements)
            assertEquals("first-id", screen.deliveries[pane.id]?.id)
            assertEquals(0, prompts + keys + inserts + modelActions)
        }

        compose.onNodeWithContentDescription("Send prompt").assertIsEnabled()
        compose.onNodeWithText("Insert text").assertIsEnabled()
        compose.onNodeWithText("Enter").assertIsEnabled()
        compose.onNodeWithText("Model").assertIsEnabled()
        compose.onNodeWithContentDescription("Send prompt").performClick()
        compose.runOnIdle { assertEquals(1, prompts) }
    }
}
