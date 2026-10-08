package dev.herdr.remote

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class CodexModelMenuTest {
    @Test fun olderBridgeOmitsCapabilityAndMenu() {
        assertFalse(Bridge.json.decodeFromString<Snapshot>("{}").codexModelSelectionEnabled)
        assertNull(Bridge.json.decodeFromString<Output>("{}").codexModelMenu)
        assertNull(Bridge.json.decodeFromString<Output>("{}").currentModel)
        assertEquals("gpt-5.4", Bridge.json.decodeFromString<Output>("""{"currentModel":"gpt-5.4"}""").currentModel)
    }
    @Test fun genericCapabilitiesAreProviderSpecific() {
        val snapshot = Snapshot(agentModelSelectionEnabled = true, modelSelectionAgents = listOf("codex", "claude", "opencode"))
        for (kind in listOf("codex", "claude", "opencode")) assertTrue(supportsModelSelection(snapshot, Pane("p", "w", kind = kind)))
        assertFalse(supportsModelSelection(snapshot, Pane("p", "w", kind = "terminal")))
        assertFalse(supportsModelSelection(snapshot.copy(modelSelectionAgents = listOf("codex")), Pane("p", "w", kind = "claude")))
        assertTrue(CodexModelMenu("m", "Select model", listOf("GLM-5.3", "GPT-5.6 Luna"),
            selectedIndex = 1, provider = "opencode").isValid())
        val terminalMenu = CodexModelMenu("m", "Select model", emptyList(), -1, provider = "opencode", mode = "terminal", ansi = "\u001b[1mNative selection\u001b[0m")
        assertTrue(terminalMenu.isValid())
        assertFalse(terminalMenu.copy(ansi = "", text = "").isValid())
        assertFalse(terminalMenu.copy(provider = "claude").isValid())
    }
    @Test fun nativeChoicesAndReasoningArePreserved() {
        val menu = Bridge.json.decodeFromString<Output>("""{"codexModelMenu":{"id":"native-1","title":"Select reasoning effort","stage":"reasoning","selectedIndex":1,"options":["Low","High (current)"]}}""").codexModelMenu!!
        assertTrue(menu.isValid())
        assertEquals("High (current)", menu.options[1])
        assertFalse(menu.copy(stage = "approval").isValid())
        assertFalse(menu.copy(selectedIndex = 9).isValid())
        assertFalse(menu.copy(options = emptyList()).isValid())
    }
    @Test fun changeModelRequiresReadyCodexAndSupportedLiveConnection() {
        val pane = Pane("p", "w", kind = "codex", status = "idle")
        val state = RemoteState(online = true, selectedId = "p", terminalAttachmentId = "current-pane",
            snapshot = Snapshot(herdrOnline = true, codexModelSelectionEnabled = true))
        assertTrue(canChangeAgentModel(state, pane))
        assertFalse(canChangeAgentModel(state, pane.copy(status = "working")))
        assertFalse(canChangeAgentModel(state, pane.copy(status = "unknown")))
        assertFalse(canChangeAgentModel(state, pane.copy(status = "blocked")))
        assertFalse(canChangeAgentModel(state, pane.copy(kind = "claude")))
        assertFalse(canChangeAgentModel(state.copy(busy = true), pane))
        assertFalse(canChangeAgentModel(state.copy(online = false), pane))
        assertFalse(canChangeAgentModel(state.copy(snapshot = state.snapshot.copy(stale = true)), pane))
        assertFalse(canChangeAgentModel(state.copy(snapshot = state.snapshot.copy(codexModelSelectionEnabled = false)), pane))
        assertFalse(canChangeAgentModel(state.copy(question = BridgeQuestion("q", "Approve?", listOf("Yes"))), pane))
        assertFalse(canChangeAgentModel(state.copy(questionReviewAvailable = true), pane))
        assertFalse(canChangeAgentModel(state.copy(questionPending = true), pane))
        assertFalse(canChangeAgentModel(state.copy(terminalAttachmentId = null), pane))
        assertFalse(canChangeAgentModel(state.copy(outputReady = false), pane))
        assertFalse(canChangeAgentModel(state.copy(selectedId = "another-pane"), pane))
    }
    @Test fun claudePaddedModelRowsSplitIntoNameAndDescription() {
        assertEquals("Opus 5.5" to "For complex work and everyday tasks", modelOptionParts("claude", "Opus 5.5               For complex work and everyday tasks"))
        assertEquals("Sonnet 5.5 ✔" to "Most efficient for simpler tasks", modelOptionParts("claude", "Sonnet 5.5 ✔           Most efficient for simpler tasks"))
        assertEquals("Default (recommended)" to "Sonnet 5.5 · Efficient for routine tasks", modelOptionParts("claude", "Default (recommended)  Sonnet 5.5 · Efficient for routine tasks"))
        assertEquals("Haiku 4.5" to null, modelOptionParts("claude", "Haiku 4.5"))
        // Other providers keep their own wording untouched.
        assertEquals("GPT 5.6   Luna" to null, modelOptionParts("codex", "GPT 5.6   Luna"))
    }
    @Test fun claudeSwitchConfirmationIsAValidSecondStageWithItsExplanation() {
        val menu = Bridge.json.decodeFromString<Output>("""{"agentModelMenu":{"id":"c1","title":"Switch model?","stage":"confirm","provider":"claude","note":"Your next response will be slower.\nThe history is re-read.","selectedIndex":0,"options":["Yes, switch to Haiku 4.5","No, go back"]}}""").agentModelMenu!!
        assertTrue(menu.isValid())
        assertEquals("Your next response will be slower.\nThe history is re-read.", menu.note)
        assertFalse(menu.copy(stage = "approval").isValid())
        assertNull(Bridge.json.decodeFromString<Output>("""{"codexModelMenu":{"id":"m","title":"Select model","options":["A"]}}""").codexModelMenu!!.note)
    }
}
