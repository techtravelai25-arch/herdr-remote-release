package dev.herdr.remote

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class PortalTest {
    @Test fun accountDeletionDoesNotTreatLostResponseOrExpiredSessionAsSuccess() {
        assertTrue(accountDeletionOutcomeUnknown(PortalSignInRequired()))
        assertTrue(accountDeletionOutcomeUnknown(java.io.IOException("connection lost")))
        assertTrue(accountDeletionOutcomeUnknown(BridgeHttpException(503, "temporarily unavailable")))
        assertFalse(accountDeletionOutcomeUnknown(BridgeHttpException(400, "invalid request")))
    }
    @Test fun grantsAreBoundToSelectedDeviceAndShortExpiry() {
        val grant = DeviceGrant("short-lived-device-token", 1300, "https://laptop.example.test", "laptop")
        val credentials = grant.credentials("laptop", 1000)
        assertEquals("laptop", credentials.portalDeviceId)
        assertEquals(1300L, credentials.expiresAt)
        assertEquals("short-lived-device-token", credentials.token)
        assertThrows(IllegalArgumentException::class.java) { grant.credentials("other-laptop", 1000) }
        assertThrows(IllegalArgumentException::class.java) { grant.copy(expiresAt = 1060).credentials("laptop", 1000) }
        assertThrows(IllegalArgumentException::class.java) { grant.copy(expiresAt = 10000).credentials("laptop", 1000) }
        assertThrows(IllegalArgumentException::class.java) { grant.copy(token = "").credentials("laptop", 1000) }
    }

    @Test fun grantDestinationMustBeHttpsOriginWithoutCredentialsOrPaths() {
        listOf("http://laptop.example.test", "https://user:pass@laptop.example.test", "https://laptop.example.test/path", "https://laptop.example.test?q=secret").forEach { url ->
            assertThrows(IllegalArgumentException::class.java) { DeviceGrant("grant", 1300, url, "laptop").credentials("laptop", 1000) }
        }
    }

    @Test fun existingQrCredentialsRemainReadable() {
        val credentials = Json.decodeFromString<Credentials>("""{"url":"https://old.trycloudflare.com","token":"saved-token","deviceId":"phone"}""")
        assertNull(credentials.portalDeviceId)
        assertNull(credentials.expiresAt)
        assertEquals("saved-token", credentials.token)
    }

}
