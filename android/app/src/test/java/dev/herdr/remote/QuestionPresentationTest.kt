package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class QuestionPresentationTest {
    private val question = BridgeQuestion("a".repeat(64), "Which preview should this test use?",
        listOf("Keep current preview", "Use compact preview", "Other"), 0, freeText = true)

    @Test fun oldBridgeDoesNotEnableQuestionActions() {
        assertFalse(Bridge.json.decodeFromString<Snapshot>("{}").questionSelectionEnabled)
        val output = Bridge.json.decodeFromString<Output>("{}")
        assertFalse(output.questionReviewAvailable)
        assertFalse(output.questionAwaitingTransition)
        assertNull(output.question)
    }

    @Test fun liveQuestionMetadataPreservesActualChoicesAndCursor() {
        val output = Bridge.json.decodeFromString<Output>("""{"question":{"id":"${question.id}","prompt":"Which preview should this test use?","options":["Keep current preview","Use compact preview","Other"],"selectedIndex":1,"freeText":true,"stage":"choices"}}""")
        assertTrue(output.question!!.isValid())
        assertEquals(question.options, output.question.options)
        assertEquals(1, output.question.selectedIndex)
    }

    @Test fun incompleteOrUnknownChoiceMenusAreNotActionable() {
        assertFalse(question.copy(id = "archived-question").isValid())
        assertFalse(question.copy(prompt = "").isValid())
        assertFalse(question.copy(options = emptyList()).isValid())
        assertFalse(question.copy(selectedIndex = null).isValid())
        assertFalse(question.copy(selectedIndex = 3).isValid())
        assertFalse(question.copy(stage = "approval").isValid())
        // Codex permits 32 model-authored choices plus its own Other field.
        assertTrue(question.copy(options = List(33) { "Choice $it" }, selectedIndex = 32).isValid())
        assertFalse(question.copy(options = List(34) { "Choice $it" }).isValid())
    }

    @Test fun completeLongLabelsRemainValidWithoutTruncation() {
        assertTrue(question.copy(prompt = "A long review question ".repeat(100),
            options = listOf("A long observed option ".repeat(100)), selectedIndex = 0).isValid())
        assertFalse(question.copy(prompt = "x".repeat(16001)).isValid())
        assertFalse(question.copy(options = listOf("x".repeat(4001))).isValid())
    }

    @Test fun terminalControlCharactersAreRejected() {
        assertFalse(question.copy(prompt = "Question\u001b[2J").isValid())
        assertFalse(question.copy(options = listOf("Choice\u0000")).isValid())
        assertTrue(question.copy(prompt = "Question\ncontinued", options = listOf("Choice\ncontinued")).isValid())
    }

    @Test fun textStageRequiresExplicitEmptyEditorMetadata() {
        val text = question.copy(options = emptyList(), selectedIndex = null, stage = "text")
        assertTrue(text.isValid())
        assertFalse(text.copy(freeText = false).isValid())
        assertFalse(text.copy(options = listOf("Existing native draft")).isValid())
        assertFalse(text.copy(selectedIndex = 0).isValid())
    }

    @Test fun customAnswersAreBoundedSingleLinePlainText() {
        assertTrue(validQuestionAnswer(" A custom answer "))
        assertTrue(validQuestionAnswer("x".repeat(500)))
        assertFalse(validQuestionAnswer("x".repeat(501)))
        assertFalse(validQuestionAnswer("   "))
        assertFalse(validQuestionAnswer("first\nsecond"))
        assertFalse(validQuestionAnswer("answer\u001b[2J"))
    }

    @Test fun claudeMultiAndReviewPreserveNativeSelectionAndSubmissionStages() {
        val multi = question.copy(stage = "multi", multiSelect = true, selectedOptions = listOf(0, 1), cancelAvailable = true)
        assertTrue(multi.isValid())
        assertFalse(multi.copy(multiSelect = false).isValid())
        assertFalse(multi.copy(selectedOptions = listOf(0, 0)).isValid())
        assertFalse(multi.copy(selectedOptions = listOf(3)).isValid())
        assertFalse(multi.copy(stage = "choices").isValid())
        assertTrue(question.copy(stage = "review", options = listOf("Submit answers"), selectedIndex = 0).isValid())
        val decoded = Bridge.json.decodeFromString<BridgeQuestion>("""{"id":"${question.id}","prompt":"Which readers?","options":["PDF","Scans","Submit"],"selectedIndex":1,"stage":"multi","multiSelect":true,"selectedOptions":[0,1],"cancelAvailable":true}""")
        assertTrue(decoded.isValid())
        assertEquals(listOf(0, 1), decoded.selectedOptions)
        assertTrue(decoded.cancelAvailable)
    }

    @Test fun claudeFolderTrustRequiresTheObservedTwoChoicesAndWarning() {
        val prompt = """Accessing workspace:
/tmp/example-claude-project

Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
project, or work from your team). If not, take a moment to review what's in this folder first.

Claude Code'll be able to read, edit, and execute files here.

Security guide"""
        val trust = question.copy(prompt = prompt, options = listOf("No, exit", "Yes, I trust this folder"),
            selectedIndex = 0, freeText = false, kind = "claude_trust")
        assertTrue(trust.isValid())
        assertTrue(trust.copy(selectedIndex = 1).isValid())
        assertFalse(trust.copy(options = trust.options.reversed()).isValid())
        assertFalse(trust.copy(options = listOf("Yes", "No")).isValid())
        assertFalse(trust.copy(prompt = "Accessing workspace: /tmp/project").isValid())
        assertFalse(trust.copy(cancelAvailable = true).isValid())
        assertFalse(trust.copy(freeText = true).isValid())
        assertFalse(trust.copy(stage = "text").isValid())
    }

    @Test fun panePreflightRejectsChangedControlCapabilitiesAndAttachment() {
        val pane = Pane("p", "w", kind = "codex", status = "working")
        val state = RemoteState(online = true, selectedId = pane.id, terminalAttachmentId = "fresh",
            snapshot = Snapshot(herdrOnline = true, panes = listOf(pane), terminalInputEnabled = true, questionSelectionEnabled = true))
        assertTrue(questionPaneReady(state, pane.id))
        assertTrue(questionPaneReady(state.copy(snapshot = state.snapshot.copy(
            panes = listOf(pane.copy(kind = "claude")))), pane.id))
        assertFalse(questionPaneReady(state.copy(snapshot = state.snapshot.copy(
            panes = listOf(pane.copy(kind = "opencode")))), pane.id))
        assertFalse(questionPaneReady(state.copy(online = false), pane.id))
        assertFalse(questionPaneReady(state.copy(snapshot = state.snapshot.copy(stale = true)), pane.id))
        assertFalse(questionPaneReady(state.copy(snapshot = state.snapshot.copy(canControl = false)), pane.id))
        assertFalse(questionPaneReady(state.copy(snapshot = state.snapshot.copy(questionSelectionEnabled = false)), pane.id))
        assertFalse(questionPaneReady(state.copy(snapshot = state.snapshot.copy(panes = listOf(pane.copy(kind = "terminal")))), pane.id))
        assertFalse(questionPaneReady(state.copy(selectedId = "other"), pane.id))
        assertFalse(questionPaneReady(state.copy(terminalAttachmentId = null), pane.id))
        assertFalse(questionPaneReady(state.copy(questionPending = true), pane.id))
    }
}
