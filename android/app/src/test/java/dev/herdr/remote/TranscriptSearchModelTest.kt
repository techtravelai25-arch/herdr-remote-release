package dev.herdr.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptSearchModelTest {
    @Test fun proseMatchesVisibleTextWithoutMarkdownSyntax() {
        val segments = transcriptSearchSegments(listOf(TerminalBlock("**Build** passed", false)))

        assertEquals(listOf("Build passed"), segments.map { it.text })
        assertEquals(listOf(TranscriptSearchMatch(0, 0, 0, 5)), transcriptSearchMatches(listOf(TerminalBlock("**Build** passed", false)), "build"))
    }

    @Test fun repeatedMatchesInOneSegmentAndCodeAreAllAddressable() {
        val occurrences = transcriptSearchMatches(listOf(
            TerminalBlock("build and BUILD", false),
            TerminalBlock("No match here", false),
            TerminalBlock("```kotlin\nbuild()\nbuild()\n```", false)
        ), "build")

        assertEquals(listOf(0, 10, 0, 8), occurrences.map { it.start })
        assertEquals(listOf(0, 0, 2, 2), occurrences.map { it.blockIndex })
        assertEquals(listOf(0, 0, 0, 0), occurrences.map { it.segmentIndex })
        assertTrue(occurrences.all { it.end - it.start == 5 })
    }

    @Test fun userAndToolTextAreSearchableAndBlankQueriesAreEmpty() {
        val segments = transcriptSearchSegments(listOf(
            TerminalBlock("  user build  ", true),
            TerminalBlock("  tool build  ", false, isActivity = true)
        ))

        assertEquals(listOf("user build", "tool build"), segments.map { it.text })
        assertEquals(2, transcriptSearchMatches(listOf(
            TerminalBlock("  user build  ", true),
            TerminalBlock("  tool build  ", false, isActivity = true)
        ), "build").size)
        assertTrue(transcriptSearchMatches(listOf(TerminalBlock("text", false)), " ").isEmpty())
    }

    @Test fun selectedIndexClampsWhenOutputShrinks() {
        assertEquals(0, clampTranscriptSearchIndex(4, 0))
        assertEquals(2, clampTranscriptSearchIndex(4, 3))
        assertEquals(0, clampTranscriptSearchIndex(-1, 3))
    }
}
