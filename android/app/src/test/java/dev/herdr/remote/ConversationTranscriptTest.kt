package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class ConversationTranscriptTest {
    private fun history(vararg messages: HistoryMessage) = StructuredHistory(messages.toList(), "claude", true)

    @Test fun userAndReplyAreSeparateTurnsAndToolRunsCollapse() {
        val items = transcriptItems(history(
            HistoryMessage("1", "user", "Fix the bug"),
            HistoryMessage("2", "tool", "ls", toolName = "Bash"),
            HistoryMessage("3", "tool", "a.js"),
            HistoryMessage("4", "tool", "/repo/a.js", toolName = "Read"),
            HistoryMessage("5", "assistant", "Done."),
            HistoryMessage("6", "system", "Interrupted.")))
        assertEquals(listOf("1", "steps:2", "5", "6"), items.map { it.key })
        assertTrue((items[0] as TranscriptItem.Turn).fromUser)
        assertFalse((items[2] as TranscriptItem.Turn).fromUser)
        assertEquals(3, (items[1] as TranscriptItem.Steps).steps.size)
        assertTrue(items[3] is TranscriptItem.Notice)
    }

    @Test fun justSentPromptShowsUntilTheTranscriptContainsIt() {
        val base = history(HistoryMessage("1", "user", "Earlier"), HistoryMessage("2", "assistant", "Reply"))
        val sent = listOf("New request")
        val pending = transcriptItems(base, sent, sentAtMs = 1_000, nowMs = 5_000)
        assertEquals("New request", (pending.last() as TranscriptItem.Turn).text)
        assertTrue((pending.last() as TranscriptItem.Turn).fromUser)

        val saved = base.copy(messages = base.messages + HistoryMessage("3", "user", "New  request\n"))
        assertEquals(3, transcriptItems(saved, sent, sentAtMs = 1_000, nowMs = 5_000).size)
        // A prompt the transcript never records must not stay attached to the newest message forever.
        assertEquals(3, transcriptItems(base, sent, sentAtMs = 1_000, nowMs = 91_000).size)
        assertEquals(2, transcriptItems(base, sent, sentAtMs = 1_000, nowMs = 91_001).size)
        assertEquals(2, transcriptItems(base, sent, sentAtMs = 1_000, nowMs = 1_000 + 120_000).size)
        assertEquals(2, transcriptItems(base, sent, sentAtMs = null).size)
    }

    @Test fun olderUnsavedPromptDoesNotReappearAfterNewerSend() {
        val old = "I cannot see the question"
        val newest = "Open the new HTML preview"
        val sent = listOf(old, newest)
        val base = history(HistoryMessage("1", "user", "Earlier request"))

        // The old pending bubble expired before the next send. A new send must
        // not renew it just because both prompts share lastPromptAt in state.
        assertEquals(listOf("Earlier request"),
            transcriptItems(base, listOf(old), sentAtMs = 1_000, nowMs = 92_000)
                .filterIsInstance<TranscriptItem.Turn>().map { it.text })
        assertEquals(listOf("Earlier request", newest),
            transcriptItems(base, sent, sentAtMs = 100_000, nowMs = 100_001)
                .filterIsInstance<TranscriptItem.Turn>().map { it.text })

        // The newer request and response are saved, while the older text was
        // never recorded. It must not appear as a fresh untimestamped turn.
        val saved = history(
            HistoryMessage("1", "user", "Earlier request"),
            HistoryMessage("2", "user", newest, "2026-10-08T06:00:00Z"),
            HistoryMessage("3", "assistant", "Preview is ready", "2026-10-08T06:01:00Z"))
        assertEquals(listOf("Earlier request", newest, "Preview is ready"),
            transcriptItems(saved, sent, sentAtMs = 100_000, nowMs = 100_001)
                .filterIsInstance<TranscriptItem.Turn>().map { it.text })
    }

    @Test fun newestPageJoinsLoadedEarlierPagesWithoutDuplicates() {
        val loaded = StructuredHistory(listOf(HistoryMessage("a", "user", "a"), HistoryMessage("b", "assistant", "b"), HistoryMessage("c", "user", "c")),
            "claude", true, hasMore = true, nextCursor = "older", revision = "r1")
        val latest = StructuredHistory(listOf(HistoryMessage("b", "assistant", "b"), HistoryMessage("c", "user", "c"), HistoryMessage("d", "assistant", "d")),
            "claude", true, hasMore = true, nextCursor = "newer-cursor", revision = "r2")
        val merged = mergeLatestHistory(loaded, latest)
        assertEquals(listOf("a", "b", "c", "d"), merged.messages.map { it.id })
        assertEquals("older", merged.nextCursor)
        assertEquals("r2", merged.revision)
        // No overlap means the pages do not join; keep only the newest.
        val far = StructuredHistory(listOf(HistoryMessage("x", "user", "x")), "claude", true, revision = "r3")
        assertEquals(listOf("x"), mergeLatestHistory(loaded, far).messages.map { it.id })
        assertSame(latest, mergeLatestHistory(null, latest))
    }
}
