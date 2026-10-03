package dev.herdr.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AppReleaseTest {
    private val valid = AppRelease(4, "0.3.0", "a".repeat(64), 1024, "/v1/app-update/apk")

    @Test fun acceptsValidMetadata() {
        assertEquals(valid, valid.validate())
        valid.copy(sha256 = "A".repeat(64)).validate()
    }

    @Test fun refusesExternalOrModifiedDownloadAddresses() {
        listOf("https://example.com/app.apk", "//example.com/app.apk", "/v1/app-update/apk?token=x", "/v1/../app.apk").forEach { path ->
            assertThrows(IllegalArgumentException::class.java) { valid.copy(apkPath = path).validate() }
        }
    }

    @Test fun rejectsInvalidAndUnboundedMetadata() {
        listOf(
            valid.copy(size = 0), valid.copy(size = 100L * 1024 * 1024 + 1),
            valid.copy(versionCode = 0), valid.copy(versionName = ""),
            valid.copy(sha256 = "a".repeat(63)), valid.copy(sha256 = "g".repeat(64)),
        ).forEach { release -> assertThrows(IllegalArgumentException::class.java) { release.validate() } }
    }
}
