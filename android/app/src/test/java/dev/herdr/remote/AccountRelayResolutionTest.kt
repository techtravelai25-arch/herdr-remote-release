package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class AccountRelayResolutionTest {
    private val legacy = Credentials(TEST_PORTAL_ORIGIN, "control-secret", "phone", relayLaptopId = "laptop", relayPublicKey = "pinned-key")
    private val renewed = legacy.copy(relayVersion = 3, relayRoutingToken = "n".repeat(43), relayRoutingExpires = 0)
    @Test fun staleBridgeResolvesLatestRoutingCapabilityWithoutAnonymousDowngrade() {
        val stored = TrustedLaptop(renewed)
        for (old in listOf(legacy, renewed.copy(relayRoutingToken = "o".repeat(43)))) {
            val resolved = resolveTrustedRelayCredentials(old, stored, null, 100)
            assertEquals(3, resolved.relayVersion)
            assertEquals("n".repeat(43), relayRoutingToken(resolved, 100))
            assertEquals(old.token, resolved.token)
            assertEquals(old.relayPublicKey, resolved.relayPublicKey)
        }
    }
    @Test fun renewalPreservesSelectedDirectoryScopeButNeverBypassesOwnership() {
        val account = AccountSession("account-a", "a@example.com", 200)
        val entry = TrustedLaptop(renewed, accountEmail = account.email)
        val original = legacy.copy(portalDeviceId = "laptop")
        assertEquals("laptop", resolveTrustedRelayCredentials(original, entry, account, 100).portalDeviceId)
        assertThrows(PortalSignInRequired::class.java) { resolveTrustedRelayCredentials(original, entry, null, 100) }
        assertThrows(PortalSignInRequired::class.java) { resolveTrustedRelayCredentials(original, entry, account.copy(email = "b@example.com"), 100) }
        assertThrows(PortalSignInRequired::class.java) { resolveTrustedRelayCredentials(original, entry, account, 200) }
    }
    @Test fun aDifferentPairingCannotSilentlyReplacePinnedIdentityOrControlToken() {
        listOf(renewed.copy(token = "different-control"), renewed.copy(relayPublicKey = "different-key"),
            renewed.copy(deviceId = "other-phone"), renewed.copy(relayLaptopId = "other-laptop")).forEach { changed ->
            assertThrows(IllegalArgumentException::class.java) { resolveTrustedRelayCredentials(legacy, TrustedLaptop(changed), null, 100) }
        }
    }
}
