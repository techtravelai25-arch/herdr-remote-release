package dev.herdr.remote

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class NativeModelPickerUiTest {
    @get:Rule val compose = createComposeRule()

    private fun state(pane: Pane, supported: Boolean = true, pending: Boolean = false) = RemoteState(
        online = true, selectedId = pane.id, modelMenuPending = pending,
        snapshot = Snapshot(herdrOnline = true, panes = listOf(pane),
            terminalInputEnabled = true, canControl = true,
            agentModelSelectionEnabled = supported,
            modelSelectionAgents = if (supported) listOf(pane.kind) else emptyList()),
        terminalAttachmentId = "test-attachment", outputReady = true,
        output = "Review complete.\n\n› Ask Codex to do anything\n\n  model · Context 90% left",
    )

    private fun show(pane: Pane, state: RemoteState, onChangeModel: () -> Unit) {
        compose.setContent { HerdrTheme {
            TerminalLiveView(state, pane, {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
                onChangeModel = onChangeModel)
        } }
    }

    @Test fun modelButtonOpensAppPickerWithoutExposingSlashCommand() {
        val pane = Pane("pane-1", "workspace", kind = "codex", status = "idle")
        var opens = 0
        show(pane, state(pane)) { opens++ }
        compose.onNodeWithText("Insert text").assertIsDisplayed()
        compose.onNodeWithText("Model").performClick()
        compose.runOnIdle { assertEquals(1, opens) }
        compose.onNodeWithText("/model").assertDoesNotExist()
        compose.onNodeWithText("Native model picker").assertDoesNotExist()
        compose.onNodeWithText("Ask Codex", substring = true).assertDoesNotExist()
    }

    @Test fun unavailableModelPickerCannotDispatch() {
        val pane = Pane("pane-2", "workspace", kind = "claude", status = "idle")
        var opens = 0
        show(pane, state(pane, supported = false)) { opens++ }
        compose.onNodeWithText("Model").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, opens) }
    }

    @Test fun workingPaneExplainsWhenModelCanChangeWithoutDispatching() {
        val pane = Pane("pane-working", "workspace", kind = "codex", status = "working")
        var opens = 0
        show(pane, state(pane)) { opens++ }
        compose.onNodeWithText("Model").assertIsEnabled().performClick()
        compose.onNodeWithText("Wait until the current response finishes, then change the model.").assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, opens) }
    }

    @Test fun pendingMenuCannotBeOpenedTwice() {
        val pane = Pane("pane-2", "workspace", kind = "codex", status = "idle")
        var opens = 0
        show(pane, state(pane, pending = true)) { opens++ }
        compose.onNodeWithText("Model").assertIsNotEnabled()
        compose.onNodeWithText("Opening model choices…").assertExists()
        compose.runOnIdle { assertEquals(0, opens) }
    }

    @Test fun displayedModelChoiceSendsOnlyItsIndex() {
        val chosen = mutableListOf<Int>()
        var cancelled = 0
        val menu = CodexModelMenu("menu-1", "Choose a model", listOf("Fast · GPT 6 Luna", "Balanced · GPT 6 Sol"))
        compose.setContent { HerdrTheme {
            CodexModelDialog(menu, enabled = true, busy = false,
                onSelect = { chosen += it }, onCancel = { cancelled++ }, onDismiss = {})
        } }
        compose.onNodeWithText("Balanced · GPT 6 Sol").performClick()
        compose.runOnIdle {
            assertEquals(listOf(1), chosen)
            assertEquals(0, cancelled)
        }
        compose.onNodeWithText("Cancel selection").performClick()
        compose.runOnIdle { assertEquals(1, cancelled) }
    }

    @Test fun openCodeShowsObservedChoicesAndBrowsesItsNativeMenu() {
        val selected = mutableListOf<Int>()
        val keys = mutableListOf<String>()
        val menu = CodexModelMenu("menu-open", "Select model",
            listOf("Recent · GPT-5.6 Luna OpenCode Go", "OpenCode Zen · MiMo-V2.6-Flash · Free"),
            selectedIndex = 0, provider = "opencode")
        compose.setContent { HerdrTheme {
            CodexModelDialog(menu, enabled = true, busy = false,
                onSelect = { selected += it }, onCancel = {}, onDismiss = {}, onKey = { keys += it })
        } }
        compose.onNodeWithText("More models").performClick()
        compose.onNodeWithText("OpenCode Zen · MiMo-V2.6-Flash · Free").performClick()
        compose.runOnIdle {
            assertEquals(listOf("down"), keys)
            assertEquals(listOf(1), selected)
        }
    }

    @Test fun plainTerminalHasNoModelControl() {
        val pane = Pane("pane-3", "workspace", kind = "terminal", status = "idle")
        show(pane, state(pane)) {}
        compose.onNodeWithText("Model").assertDoesNotExist()
    }
}
