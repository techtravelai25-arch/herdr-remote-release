package dev.herdr.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PcSetupUrlTest {
    @Test fun setupLinkUsesTheConfiguredHttpsOrigin() {
        assertEquals("$TEST_PORTAL_ORIGIN/setup", pcSetupUrl(TEST_PORTAL_ORIGIN))
        assertEquals("https://selfhost.example/setup", pcSetupUrl("https://selfhost.example/"))
        assertEquals("https://selfhost.example:8443/setup", pcSetupUrl("https://selfhost.example:8443"))
    }

    @Test fun missingOrUnsafeOriginCannotBecomeASetupLink() {
        assertNull(pcSetupUrl())
        listOf(
            "", "   ", "http://selfhost.example", "https://user@selfhost.example",
            "https://user:secret@selfhost.example", "https://selfhost.example/path",
            "https://selfhost.example/?token=secret", "https://selfhost.example/#fragment",
            "selfhost.example", "not a URL",
        ).forEach { origin -> assertNull("Unexpected setup link for $origin", pcSetupUrl(origin)) }
    }
}
