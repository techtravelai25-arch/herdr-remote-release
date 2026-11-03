package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class TerminalPresentationTest {
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

    @Test fun readableTextCollapsesRulesAndMapsMissingGlyphs() {
        val wide = "Title\n${"─".repeat(160)}\n  ⏵⏵ auto mode  ⎿ done  ⏸"
        assertEquals("Title\n${"─".repeat(24)}\n  ▶▶ auto mode  └ done  ‖", readableTerminalText(wide, collapseRules = true))
        assertEquals("Title\n${"─".repeat(160)}\n  ▶▶ auto mode  └ done  ‖", readableTerminalText(wide, collapseRules = false))
        assertEquals("plain ascii", readableTerminalText("plain ascii", collapseRules = true))
        assertEquals("❯ /model\n  └ Kept", readableTerminalText("❯ /model" + " ".repeat(150) + "\n  ⎿ Kept   ", collapseRules = false))
        // Short decorative lines inside content are not rules.
        assertEquals("a ─── b", readableTerminalText("a ─── b", collapseRules = true))
    }

    @Test fun boxDrawnTablesAreFoundByLine() {
        val text = "intro\n  ┌───┬───┐\n  │ a │ b │\n  └───┴───┘\nafter │ not a table\n│ lone"
        val ranges = boxTableRanges(text)
        assertEquals(1, ranges.size)
        assertEquals("  ┌───┬───┐\n  │ a │ b │\n  └───┴───┘", text.substring(ranges[0].first, ranges[0].last + 1))
        assertTrue(boxTableRanges("no boxes here").isEmpty())
    }
}
