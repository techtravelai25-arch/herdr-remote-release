package dev.herdr.remote

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class ProviderUsageTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val now = Instant.parse("2026-09-20T10:00:00Z")
    private val available = ProviderUsage("codex", "Codex", "available", listOf(UsageWindow("primary", "5 hours", 72.5)), updatedAt = now.toString())

    @Test fun oldBridgeStillParsesAndShowsUnavailableCodex() {
        val snapshot = json.decodeFromString<Snapshot>("""{"herdrOnline":true}""")
        assertTrue(snapshot.usage.isEmpty())
        val provider = dashboardUsage(snapshot.usage).single()
        assertEquals("Codex", provider.name)
        assertEquals("Unavailable", usageStatus(provider, offline = false, stale = false))
        assertFalse(provider.hasMeasurements())
    }

    @Test fun parsesMultipleProvidersAndWindowsWithoutAssumingKnownProviderIds() {
        val snapshot = json.decodeFromString<Snapshot>("""{"usage":[
            {"id":"codex","name":"Codex","status":"available","updatedAt":"2026-09-20T10:00:00Z","windows":[
                {"id":"primary","label":"5 hours","remainingPercent":72.5,"resetsAt":"2026-09-20T15:00:00Z"},
                {"id":"secondary","label":"Weekly","remainingPercent":0}]},
            {"id":"future-agent","name":"Future agent","status":"available","windows":[
                {"id":"monthly","label":"Monthly","remainingPercent":100}],"futureField":true}
        ]}""")
        assertEquals(2, dashboardUsage(snapshot.usage).size)
        assertEquals(72.5, snapshot.usage[0].windows[0].validRemainingPercent()!!, 0.0)
        assertEquals(0.0, snapshot.usage[0].windows[1].validRemainingPercent()!!, 0.0)
        assertEquals(100.0, snapshot.usage[1].windows[0].validRemainingPercent()!!, 0.0)
        assertNotNull(usageTimestamp(snapshot.usage[0].windows[0].resetsAt))
    }

    @Test fun staleAndOfflineValuesAreNeverPresentedAsCurrent() {
        assertEquals("Available", usageStatus(available, false, false, now))
        assertEquals("Last known · offline", usageStatus(available, true, false))
        assertEquals("Last known · updating", usageStatus(available, false, true))
        assertEquals("Last known · updating", usageStatus(available.copy(status = "stale"), false, false))
        assertEquals("Unavailable", usageStatus(available.copy(status = "future-status"), false, false))
        assertFalse(available.copy(status = "unavailable").hasMeasurements())
    }

    @Test fun missingFutureOldOrExpiredTimestampsAreLastKnown() {
        listOf(null, "invalid", now.plusSeconds(120).toString(), now.minusSeconds(301).toString()).forEach {
            assertEquals("Last known · updating", usageStatus(available.copy(updatedAt = it), false, false, now))
        }
        val expired = available.copy(windows = listOf(UsageWindow("primary", "5 hours", 72.5, now.toString())))
        assertEquals("Last known · updating", usageStatus(expired, false, false, now))
    }

    @Test fun invalidOrMissingMeasurementsAndTimestampsAreNotFabricated() {
        listOf(null, -1.0, 100.1, Double.NaN, Double.POSITIVE_INFINITY).forEach {
            assertNull(UsageWindow("primary", "5 hours", it).validRemainingPercent())
        }
        assertFalse(available.copy(windows = emptyList()).hasMeasurements())
        assertNull(usageTimestamp(null))
        assertNull(usageTimestamp("invalid"))
    }
}
