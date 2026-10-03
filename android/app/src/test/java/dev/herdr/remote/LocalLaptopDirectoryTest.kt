package dev.herdr.remote

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class LocalLaptopDirectoryTest {
    private fun entry(id: String, phone: String = id, owner: String? = null, label: String? = null) = TrustedLaptop(
        Credentials(TEST_PORTAL_ORIGIN, "token-$phone", phone, relayLaptopId = id, relayPublicKey = "key-$id"), accountEmail = owner, label = label)
    private val owner = AccountSession("session-a", "a@example.com", 200)
    @Test fun expiredAccountFreshPairingIsIndependentWithoutUnlockingStoredPairing() {
        val expired = owner.copy(expiresAt = 100)
        val bound = entry("laptop", "old-phone", owner.email)
        assertNull(pairingOwner(expired, expired, 100))
        val fresh = entry("laptop", "fresh-phone", pairingOwner(expired, expired, 100))
        val stored = upsertTrustedLaptop(listOf(bound), fresh)
        assertEquals(owner.email, stored.first().accountEmail)
        assertEquals(listOf(fresh), accessibleLaptops(stored, expired, 100))
        assertThrows(PortalSignInRequired::class.java) { validateTrustedLaptop(bound, expired, 100) }
    }
    @Test fun existingCredentialCannotBeDowngradedOrMovedToAnotherAccount() {
        val bound = entry("laptop", owner = owner.email)
        assertThrows(IllegalArgumentException::class.java) { upsertTrustedLaptop(listOf(bound), bound.copy(accountEmail = null)) }
        assertThrows(IllegalArgumentException::class.java) { upsertTrustedLaptop(listOf(bound), bound.copy(accountEmail = "b@example.com")) }
    }
    @Test fun accountChangesDuringPairingAreRejected() {
        assertThrows(IllegalStateException::class.java) { pairingOwner(owner, null, 100) }
        assertThrows(IllegalStateException::class.java) { pairingOwner(owner, owner.copy(token = "new-account", email = "b@example.com"), 100) }
        assertThrows(IllegalStateException::class.java) { pairingOwner(null, owner, 100) }
        assertNull(pairingOwner(owner, owner, 200))
        assertEquals(owner.email, pairingOwner(owner, owner, 100))
    }
    @Test fun hostedAccountDoesNotOwnSelfHostedPairing() {
        assertNull(pairingOwnerForRelay(TEST_PORTAL_ORIGIN, owner, owner, 100))
        assertNull(pairingOwnerForRelay("https://selfhost.example", owner, owner, 100))
        assertThrows(IllegalStateException::class.java) { pairingOwnerForRelay("https://selfhost.example", owner, null, 100) }
    }
    @Test fun twoQrOnlyLaptopsCanBeSelectedWithoutAccountOrDirectory() {
        val a = entry("a"); val b = entry("b")
        val all = upsertTrustedLaptop(upsertTrustedLaptop(emptyList(), a), b)
        assertEquals(listOf("a", "b"), accessibleLaptops(all, null, 100).map { it.credentials.relayLaptopId })
        listOf(a, b, a).forEach { assertEquals(it.credentials, validateTrustedLaptop(it, null, 100)) }
    }
    @Test fun laptopIdsFromDifferentRelayOriginsRemainSeparate() {
        val hosted = entry("same", "hosted-phone")
        val selfHosted = entry("same", "self-hosted-phone").let { it.copy(credentials = it.credentials.copy(url = "https://selfhost.example")) }
        val all = upsertTrustedLaptop(listOf(hosted), selfHosted)
        assertEquals(2, accessibleLaptops(all, null, 100).size)
        assertEquals(setOf(TEST_PORTAL_ORIGIN, "https://selfhost.example"), accessibleLaptops(all, null, 100).map { it.credentials.url }.toSet())
        val collision = selfHosted.copy(credentials = selfHosted.credentials.copy(deviceId = hosted.credentials.deviceId))
        assertThrows(IllegalArgumentException::class.java) { upsertTrustedLaptop(listOf(hosted), collision) }
    }
    @Test fun listMergesByLaptopAndNeverExposesOtherAccountLabels() {
        val anonymous = entry("same", "anonymous")
        val a = entry("same", "a-phone", owner.email, "Private A")
        val b = entry("b", "b-phone", "b@example.com", "Private B")
        val all = listOf(anonymous, a, b)
        assertEquals(listOf(a), accessibleLaptops(all, owner, 100))
        assertEquals(listOf(anonymous), accessibleLaptops(all, null, 100))
        assertEquals(listOf(anonymous), accessibleLaptops(all, owner, 200))
    }
    @Test fun renamingDoesNotChangeTrustAndOldSerializedEntriesStillLoad() {
        val original = entry("laptop")
        val renamed = original.copy(label = normalizeLaptopLabel("  My laptop  "))
        assertEquals(original.credentials, renamed.credentials)
        assertEquals("My laptop", localLaptopLabel(renamed))
        val old = """{"credentials":{"url":"$TEST_PORTAL_ORIGIN","token":"t","deviceId":"d","relayLaptopId":"laptop","relayPublicKey":"key"}}"""
        assertEquals("Laptop laptop", localLaptopLabel(Json.decodeFromString<TrustedLaptop>(old)))
        listOf("", " ", "bad\nlabel", "x".repeat(81)).forEach { invalid -> assertThrows(IllegalArgumentException::class.java) { normalizeLaptopLabel(invalid) } }
    }
    @Test fun forgottenCredentialsCannotBeSelectedAndBoundRecordIsPreserved() {
        val bound = entry("same", "bound", owner.email)
        val fresh = entry("same", "fresh")
        val remaining = listOf(bound, fresh).filterNot { it.credentials.deviceId == fresh.credentials.deviceId }
        assertThrows(IllegalStateException::class.java) { selectTrustedLaptop(remaining, "fresh", null, 100) }
        assertThrows(PortalSignInRequired::class.java) { selectTrustedLaptop(remaining, "bound", null, 100) }
        assertTrue(accessibleLaptops(remaining, null, 100).isEmpty())
        assertEquals(listOf(bound), accessibleLaptops(remaining, owner, 100))
    }
}
