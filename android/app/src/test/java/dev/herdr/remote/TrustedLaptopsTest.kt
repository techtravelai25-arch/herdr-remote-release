package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class TrustedLaptopsTest {
    private val credentials = Credentials(TEST_PORTAL_ORIGIN, "private-token", "phone", relayLaptopId = "laptop", relayPublicKey = "local-qr-key")
    @Test fun accountlessQrPairingRemainsIndependentOfEmail() {
        assertEquals(credentials, validateTrustedLaptop(TrustedLaptop(credentials), null, 100))
    }
    @Test fun claimedQrCannotBeUsedAfterSignOutAccountSwitchOrExpiry() {
        val entry = TrustedLaptop(credentials, accountEmail = "owner@example.com")
        assertThrows(PortalSignInRequired::class.java) { validateTrustedLaptop(entry, null, 100) }
        assertThrows(PortalSignInRequired::class.java) { validateTrustedLaptop(entry, AccountSession("b", "other@example.com", 200), 100) }
        assertThrows(PortalSignInRequired::class.java) { validateTrustedLaptop(entry, AccountSession("a", "owner@example.com", 100), 100) }
        assertEquals(credentials, validateTrustedLaptop(entry, AccountSession("a", "OWNER@example.com", 200), 100))
    }
    @Test fun pendingClaimDoesNotAllowAnotherAccountToInheritTheLaptop() {
        val entry = TrustedLaptop(credentials, "claim", "owner@example.com")
        assertThrows(PortalSignInRequired::class.java) { validateTrustedLaptop(entry, AccountSession("b", "other@example.com", 200), 100) }
    }
}
