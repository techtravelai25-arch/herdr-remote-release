package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class TerminalPresentationTest {
    @Test fun trailingIdleInputAreaIsHiddenWithoutDependingOnItsWording() {
        val examples = listOf(
            "Answer one.\n\n› Ask Codex to do anything\n\n  model · Context 90% left",
            "Answer two.\n\n❯ Type a new request\n\n  arbitrary status row",
            "Answer three.\n\n⠁    ⢀    ⠈\n› A different placeholder\n  another footer"
        )
        for ((index, example) in examples.withIndex()) {
            val result = conversationTerminalText(example, if (index == 1) "claude" else "codex", "done")
            assertTrue(result.footerHidden)
            assertEquals(example.substringBefore(".\n\n") + ".", result.text)
        }
    }

    @Test fun liveQuestionsAndUncertainOutputRemainFullyVisible() {
        val questions = listOf(
            "Reply above.\n\n› Choose a recovery path\n  1. Refresh\n  2. Restart",
            "Reply above.\n\n› Choose a recovery path\n  \u001b[32m1. Refresh\u001b[0m\n  \u001b[31m2. Restart\u001b[0m",
            "Folder access\n/path/to/project\n\nTrust this folder?\n\n› 1. Trust and continue\n  2. Back to Agent Command Center\n\n  enter continue · esc back"
        )
        for (question in questions) for (status in listOf("blocked", "needs_input", "unknown", "idle", "done", "working")) {
            assertEquals(ConversationTerminalText(question, false), conversationTerminalText(question, "codex", status))
            assertEquals(ConversationTerminalText(question, false), conversationTerminalText(question, "terminal", status))
        }
    }

    @Test fun quotedPromptAndFencedExampleAreNotCropped() {
        val quoted = "The output was:\n\n› quoted prompt\n"
        assertEquals(ConversationTerminalText(quoted, false), conversationTerminalText(quoted, "codex", "done"))
        val prose = "Explanation:\n\n› quoted prompt\nThis is part of the answer."
        assertEquals(ConversationTerminalText(prose, false), conversationTerminalText(prose, "codex", "done"))
        val fenced = "Example:\n```text\n\n› prompt\n  status\n"
        assertEquals(ConversationTerminalText(fenced, false), conversationTerminalText(fenced, "codex", "done"))
    }

    @Test fun capturedAnimatedIdleTailLeavesTheCompletedReply() {
        val captured = requireNotNull(javaClass.getResource("/codex-idle-braille.txt")).readText()
        assertEquals(ConversationTerminalText("Completed task.", true),
            conversationTerminalText(captured, "codex", "done"))
    }

    @Test fun vendorUiChangesDoNotRemoveOrClassifyTerminalText() {
        val captures = listOf(
            "╭ Select model ╮\n› 1. Old choice\nenter approve",
            "\u001b[31mDifferent heading\u001b[0m\n3. New order\nEsc closes",
            "• Queued follow-up inputs\nWhich option?\n› 1. First\n2. Other\nenter submit",
            "gpt-6-astra high · Context 90% left\n› Ask Codex to do anything"
        )
        for (kind in listOf("codex", "claude", "opencode", "terminal")) {
            for (capture in captures) {
                val display = terminalPresentation(capture, kind)
                assertNull(display.metadata)
                assertNull(display.question)
                assertEquals(listOf(TerminalBlock(capture, false)), display.blocks)
            }
        }
    }

    @Test fun unicodeLongLinesAndLiteralHtmlRemainDisplayText() {
        val raw = "हिन्दी 😀\n" + "x".repeat(1200) + "\n<script>do not execute</script>"
        val display = terminalPresentation(raw, "codex")
        assertEquals(raw, display.blocks.single().text)
        assertFalse(display.blocks.single().isUser)
        assertFalse(display.blocks.single().isActivity)
    }

    @Test fun emptySnapshotHasNoBlocks() {
        assertEquals(TerminalPresentation(null, emptyList()), terminalPresentation("", "codex"))
    }
}
