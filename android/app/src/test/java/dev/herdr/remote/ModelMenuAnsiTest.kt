package dev.herdr.remote

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import org.junit.Assert.*
import org.junit.Test

class ModelMenuAnsiTest {
    @Test fun preservesSelectionAndStripsTerminalControls() {
        val value = modelMenuAnsi("\u001b[2J\u001b]0;title\u0007Select model\n\u001b[1;38;2;240;240;240;48;2;50;60;80mCurrent model\u001b[0m\nOther\u0000")
        assertEquals("Select model\nCurrent model\nOther", value.text)
        val selected = value.spanStyles.first { it.item.fontWeight == FontWeight.Bold }
        assertEquals(Color(50,60,80), selected.item.background)
        assertEquals(Color(240,240,240), selected.item.color)
        assertFalse(value.text.any { it.isISOControl() && it != '\n' && it != '\t' })
    }
    @Test fun handlesIndexedColorInverseAndTruncatedEscapes() {
        val value = modelMenuAnsi("\u001b[38;5;196;48;5;16;7mSelected\u001b[0m\u001b[38;2")
        assertEquals("Selected", value.text)
        assertEquals(Color(0xFF000000), value.spanStyles.first().item.color)
        assertEquals(Color(0xFFFF0000), value.spanStyles.first().item.background)
        assertEquals("a", modelMenuAnsi("a\u001b]unterminated").text)
    }
}
