package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class ConversationHistoryTest {
    @Test fun conversationShowsSavedUserTurnsAndKeepsLiveOutputOptional() {
        val history = StructuredHistory(listOf(
            HistoryMessage("1", "user", "Message sent from phone"),
            HistoryMessage("2", "assistant", "Reply from Codex"),
            HistoryMessage("3", "tool", "Ran a command")
        ), "codex", true)
        val live = listOf(TerminalBlock("Current terminal output", false))
        assertEquals(listOf(
            TerminalBlock("Message sent from phone", true),
            TerminalBlock("Reply from Codex", false)
        ), conversationTranscriptBlocks(history, emptyList()))
        assertEquals(3, conversationTranscriptBlocks(history, live).size)
        assertEquals(2, conversationTranscriptBlocks(history, emptyList(), listOf("Message sent from phone")).size)
        assertEquals(3, conversationTranscriptBlocks(history, emptyList(), listOf("New phone message")).size)
        assertEquals(live, conversationTranscriptBlocks(null, live))
        assertEquals(live, conversationTranscriptBlocks(history.copy(available = false), live))
        assertEquals(live + TerminalBlock("Message sent from phone", true),
            conversationTranscriptBlocks(null, live, listOf("Message sent from phone")))
        assertEquals(listOf(TerminalBlock("Message sent from phone", true)),
            conversationTranscriptBlocks(null, listOf(TerminalBlock("Message sent from phone", true)), listOf("Message sent from phone")))
    }

    @Test fun unmatchedRecentPhoneMessageStaysAfterOlderTerminalOutput() {
        val olderReply = TerminalBlock("Earlier assistant reply", false)
        assertEquals(listOf(olderReply, TerminalBlock("ok", true)),
            conversationTranscriptBlocks(null, listOf(olderReply), listOf("ok")))

        val raw = "Earlier assistant reply\n\n› ok\n\n• Sounds good.\n"
        val display = terminalPresentation(raw, "codex")
        assertEquals(raw, display.blocks.single().text)
        assertNull(display.question)

    }

    @Test fun olderPagesPrependInOrderWithoutDuplicatingOverlappingMessages() {
        val older = StructuredHistory(listOf(HistoryMessage("1", "user", "first"), HistoryMessage("2", "assistant", "second")), "claude", true, true, "older-cursor")
        val current = StructuredHistory(listOf(HistoryMessage("2", "assistant", "second"), HistoryMessage("3", "user", "third")), "claude", true)
        val result = prependHistory(older, current)
        assertEquals(listOf("1", "2", "3"), result.messages.map { it.id })
        assertEquals("older-cursor", result.nextCursor)
        assertTrue(result.hasMore)
    }
}
