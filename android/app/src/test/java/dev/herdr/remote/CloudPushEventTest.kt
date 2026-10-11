package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class CloudPushEventTest {
    private val now = 1_000_000L
    private val base = mapOf("eventId" to "event", "deviceId" to "laptop", "paneId" to "pane", "kind" to "done")

    @Test fun freshShowsRequireAuthenticatedCreationAndExpiryTimes() {
        val fresh = base + mapOf("createdAt" to now.toString(), "expiresAt" to (now + 90).toString())
        assertEquals("event", CloudPushEvent.parse(fresh, now)?.eventId)
        assertNull(CloudPushEvent.parse(base, now))
        for (data in listOf(
            fresh + ("expiresAt" to (now - 1).toString()),
            fresh + ("expiresAt" to (now + 601).toString()),
            fresh + ("createdAt" to (now - 601).toString()),
            fresh + ("createdAt" to (now + 61).toString()),
            fresh + ("createdAt" to "bad"),
        )) assertNull(CloudPushEvent.parse(data, now))
    }

    @Test fun lateOrLegacyClearStillCarriesExactTombstoneTarget() {
        val clear = base + mapOf("kind" to "clear", "targetEventId" to "old-event")
        assertEquals("old-event", CloudPushEvent.parse(clear, now)?.targetEventId)
        assertEquals("old-event", CloudPushEvent.parse(clear + mapOf("createdAt" to "1", "expiresAt" to "2"), now)?.targetEventId)
        assertNull(CloudPushEvent.parse(clear + ("targetEventId" to "event"), now))
    }
}
