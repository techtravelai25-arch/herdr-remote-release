package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class OpenCodePresentationTest {
    @Test fun capturedOpenCodeChromeAndDialogRemainVisible() {
        val raw = requireNotNull(javaClass.getResource("/opencode-conversation.txt")).readText()
        assertEquals(listOf(TerminalBlock(raw, false)), openCodePresentation(raw).blocks)
        assertNull(openCodePresentation(raw).metadata)
    }

    @Test fun changedFooterDoesNotChangeClassification() {
        val raw = "┃ Keep this desktop draft\n17.9K (2%) ctrl+p commands · changed footer"
        assertEquals(listOf(TerminalBlock(raw, false)), openCodePresentation(raw).blocks)
    }
}
