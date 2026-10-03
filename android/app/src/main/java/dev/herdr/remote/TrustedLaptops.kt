package dev.herdr.remote

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable data class TrustedLaptop(val credentials: Credentials, val claimToken: String? = null, val accountEmail: String? = null, val label: String? = null)

/** Account discovery never replaces the laptop key established by a local QR scan. */
class TrustedLaptops(context: Context) {
    private val storage = EncryptedStorage(context, "trusted_laptops", "herdr.remote.laptops.v1")
    fun all(): List<TrustedLaptop> = synchronized(CredentialStorageLock.monitor) {
        storage.load()?.let { runCatching { Json.decodeFromString<List<TrustedLaptop>>(it) }.getOrNull() } ?: emptyList()
    }
    fun find(id: String, account: AccountSession?): TrustedLaptop? = accessibleLaptops(all(), account).lastOrNull { Deployment.isPortalOrigin(it.credentials.url) && it.credentials.relayLaptopId == id }
    fun findCredentials(credentials: Credentials): TrustedLaptop? = all().find { it.credentials.url == credentials.url && it.credentials.deviceId == credentials.deviceId && it.credentials.relayLaptopId == credentials.relayLaptopId }
    fun findDevice(id: String): TrustedLaptop? = all().find { it.credentials.deviceId == id }
    fun save(value: TrustedLaptop) = synchronized(CredentialStorageLock.monitor) {
        require(value.credentials.relayLaptopId != null && value.credentials.relayPublicKey != null)
        storage.save(Json.encodeToString(upsertTrustedLaptop(all(), value)))
    }
    fun remove(id: String) = synchronized(CredentialStorageLock.monitor) { storage.save(Json.encodeToString(all().filterNot { it.credentials.deviceId == id })) }
}

internal fun validateTrustedLaptop(entry: TrustedLaptop, account: AccountSession?, now: Long = System.currentTimeMillis() / 1000): Credentials {
    if (entry.accountEmail != null && (account == null || !entry.accountEmail.equals(account.email, true) || account.expiresAt <= now)) throw PortalSignInRequired()
    return entry.credentials
}

internal fun validAccount(account: AccountSession?, now: Long = System.currentTimeMillis() / 1000): AccountSession? = account?.takeIf { it.expiresAt > now }

/** Never downgrade a previously stored credential when creating a fresh QR pairing. */
internal fun upsertTrustedLaptop(entries: List<TrustedLaptop>, value: TrustedLaptop): List<TrustedLaptop> {
    require(entries.none { it.credentials.deviceId == value.credentials.deviceId && it.credentials.url != value.credentials.url }) {
        "This phone pairing ID is already used by another server. Scan a new QR code."
    }
    val old = entries.find { it.credentials.url == value.credentials.url && it.credentials.deviceId == value.credentials.deviceId && it.credentials.relayLaptopId == value.credentials.relayLaptopId }
    require(old?.accountEmail == null || old.accountEmail.equals(value.accountEmail, true)) { "This pairing belongs to another account. Generate a fresh laptop QR." }
    return (entries.filterNot { it.credentials.url == value.credentials.url && it.credentials.deviceId == value.credentials.deviceId && it.credentials.relayLaptopId == value.credentials.relayLaptopId } + value).takeLast(30)
}
internal fun accessibleLaptops(entries: List<TrustedLaptop>, account: AccountSession?, now: Long = System.currentTimeMillis() / 1000): List<TrustedLaptop> =
    entries.filter { it.accountEmail == null || (validAccount(account, now)?.email?.equals(it.accountEmail, true) == true) }
        .groupBy { it.credentials.url to it.credentials.relayLaptopId }.values.map { group -> group.lastOrNull { it.accountEmail != null } ?: group.last() }

internal fun pairingOwner(started: AccountSession?, current: AccountSession?, now: Long = System.currentTimeMillis() / 1000): String? {
    check(started == current) { "Your account changed while pairing. Scan a fresh QR." }
    // A session that expires in flight must not acquire a new account-bound credential.
    return validAccount(current, now)?.email
}
internal fun pairingOwnerForRelay(origin: String, started: AccountSession?, current: AccountSession?, now: Long = System.currentTimeMillis() / 1000): String? =
    pairingOwner(started, current, now).takeIf { Deployment.isPortalOrigin(origin) }
internal fun localLaptopLabel(entry: TrustedLaptop): String = entry.label?.takeIf { it.isNotBlank() } ?: "Laptop ${entry.credentials.relayLaptopId.orEmpty().takeLast(6)}"
internal fun normalizeLaptopLabel(value: String): String = value.trim().also {
    require(it.isNotEmpty() && it.length <= 80 && it.none { char -> char.isISOControl() }) { "Use a laptop name between 1 and 80 characters." }
}
data class SavedLaptopChoice(val deviceId: String, val laptopId: String, val label: String, val current: Boolean, val accountLinked: Boolean)

internal fun selectTrustedLaptop(entries: List<TrustedLaptop>, deviceId: String, account: AccountSession?, now: Long = System.currentTimeMillis() / 1000): TrustedLaptop {
    val entry = entries.find { it.credentials.deviceId == deviceId } ?: error("That pairing was forgotten. Scan a fresh laptop QR.")
    validateTrustedLaptop(entry, account, now)
    return entry
}
