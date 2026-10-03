package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class CloudUpdatesTest {
    @Test fun metadataAndApkUseOnlyTheFixedCloudOrigin() {
        listOf("/v1/app-update", "/v1/app-update/apk").forEach { path ->
            val request = CloudUpdates.request(path, TEST_UPDATE_ORIGIN)
            assertEquals("$TEST_UPDATE_ORIGIN$path", request.url.toString())
            assertEquals("GET", request.method)
        }
    }

    @Test fun cloudUpdatesDoNotCarryAccountOrLaptopCredentials() {
        listOf("/v1/app-update", "/v1/app-update/apk").forEach { path ->
            val request = CloudUpdates.request(path, TEST_UPDATE_ORIGIN)
            assertNull(request.header("Authorization"))
            assertNull(request.header("Cookie"))
            assertNull(request.url.query)
            assertTrue(request.url.username.isEmpty())
            assertTrue(request.url.password.isEmpty())
        }
    }

    @Test fun updateRequestCannotBeRedirectedByAnUntrustedPath() {
        listOf("https://evil.example/app.apk", "//evil.example/app.apk", "/v1/app-update/apk?token=secret", "/v1/../app.apk", "/v1/devices").forEach { path ->
            assertThrows(IllegalArgumentException::class.java) { CloudUpdates.request(path) }
        }
    }
}
