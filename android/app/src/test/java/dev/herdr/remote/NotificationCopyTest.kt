package dev.herdr.remote

import kotlin.random.Random
import org.junit.Assert.*
import org.junit.Test

class NotificationCopyTest {
    @Test fun eachStateHasTwentyDistinctVariantsWithAnUnambiguousTitle() {
        for ((kind, title) in listOf("done" to "Reply ready", "needs_input" to "Your input is needed")) {
            val copies = (0 until NotificationCopy.VARIANT_COUNT).map { NotificationCopy.copy(kind, it) }
            assertEquals(20, copies.size)
            assertEquals(20, copies.map { it.body }.toSet().size)
            assertTrue(copies.all { it.title == title && it.body.isNotBlank() })
        }
        val replies = (0 until 20).map { NotificationCopy.copy("done", it).body }.toSet()
        val inputs = (0 until 20).map { NotificationCopy.copy("needs_input", it).body }.toSet()
        assertTrue(replies.intersect(inputs).isEmpty())
    }

    @Test fun shuffledCyclesExhaustTheBankAndNeverRepeatAcrossRestarts() {
        var serialized = ""
        var persistedLast: Int? = null
        repeat(10) { cycle ->
            val seen = mutableSetOf<Int>()
            repeat(20) { offset ->
                // Reconstruct from only persisted values, like a fresh process every delivery.
                val draw = NotificationCopy.draw(serialized.split(',').mapNotNull(String::toIntOrNull), persistedLast, Random(cycle * 20 + offset))
                assertNotEquals(persistedLast, draw.index)
                assertTrue(seen.add(draw.index))
                serialized = draw.remaining.joinToString(",")
                persistedLast = draw.index
            }
            assertEquals((0 until 20).toSet(), seen)
        }
    }

    @Test fun freshCyclesAreRandomized() {
        val choices = (0 until 20).map { NotificationCopy.draw(emptyList(), null, Random(it)).index }
        assertTrue(choices.toSet().size > 1)
    }

    @Test fun corruptStoredValuesCannotProduceAnInvalidOrRepeatedChoice() {
        val draw = NotificationCopy.draw(listOf(-1, 30, 3, 3, 7, 7), 3, Random(1))
        assertEquals(7, draw.index)
        assertTrue(draw.remaining.isEmpty())
        val refill = NotificationCopy.draw(listOf(3, -1, 30), 3, Random(2))
        assertNotEquals(3, refill.index)
        assertEquals((0 until 20).toSet(), (refill.remaining + refill.index).toSet())
    }

    @Test fun tiboVariantIsOnlyUsedForKnownCodexReplies() {
        for (provider in listOf(null, "claude", "claude-code", "opencode", "terminal")) {
            for (kind in listOf("done", "needs_input")) {
                assertTrue((0 until 20).none { NotificationCopy.copy(kind, it, provider).body.contains("Tibo") })
            }
        }
        assertTrue(NotificationCopy.copy("done", 19, "codex").body.contains("check if Tibo"))
        assertFalse(NotificationCopy.copy("needs_input", 19, "codex").body.contains("Tibo"))
    }

    @Test fun errorsAndUnknownStatesAlwaysUseFactualFallback() {
        for (kind in listOf("error", "unknown", "", "working")) {
            for (index in 0 until 20) {
                val copy = NotificationCopy.copy(kind, index, "codex")
                assertEquals("An agent needs attention", copy.title)
                assertEquals("Open the conversation to review what happened.", copy.body)
            }
        }
    }
}
