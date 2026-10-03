package dev.herdr.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceLevelHistoryTest {
    @Test fun silenceAndNoiseFloorStayStill() {
        val history = VoiceLevelHistory()
        listOf(0, -1, Int.MIN_VALUE, 100, 180).forEach { assertEquals(0f, history.sample(it).last(), 0f) }
    }

    @Test fun inputIsClampedAndHistoryBounded() {
        val history = VoiceLevelHistory()
        var levels = emptyList<Float>()
        repeat(100) { levels = history.sample(Int.MAX_VALUE) }
        assertEquals(20, levels.size)
        assertTrue(levels.all { it.isFinite() && it in 0f..1f })
        assertTrue(levels.last() > 0.99f)
    }

    @Test fun speechRisesThenDecaysToSilence() {
        val history = VoiceLevelHistory()
        val loud = history.sample(32767).last()
        val quiet = history.sample(0).last()
        assertTrue(loud > quiet && quiet > 0f)
        var levels = emptyList<Float>()
        repeat(30) { levels = history.sample(0) }
        assertEquals(0f, levels.last(), 0f)
    }

    @Test fun resetRemovesPreviousRecordingAndSmoothing() {
        val history = VoiceLevelHistory()
        repeat(20) { history.sample(32767) }
        history.reset()
        assertEquals(listOf(0f), history.sample(0))
        assertEquals(VoiceLevelHistory().sample(12000).last(), history.sample(12000).last())
    }
}
