package dev.herdr.remote

import android.content.Context
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

internal val PORTAL_ORIGIN get() = Deployment.requireOrigin(BuildConfig.PORTAL_ORIGIN)

@Serializable data class AccountSession(val token: String, val email: String, val expiresAt: Long)
@Serializable data class RemoteDevice(val id: String, val label: String, val url: String, val transport: String? = null)
@Serializable data class EmailChallenge(val challengeId: String, val expiresIn: Long, val resendAfter: Long)
data class PendingEmailLogin(val email: String, val challengeId: String, val expiresAt: Long, val resendAt: Long)
@Serializable internal data class DeviceGrant(val token: String, val expiresAt: Long, val url: String, val deviceId: String) {
    fun credentials(selected: String, now: Long = System.currentTimeMillis() / 1000): Credentials {
        require(deviceId == selected && token.isNotBlank() && expiresAt > now + 60 && expiresAt <= now + 600) { "The laptop authorization is invalid. Try again." }
        return Credentials(Bridge.normalizeUrl(url), token, deviceId, portalDeviceId = selected, expiresAt = expiresAt)
    }
}
class PortalSignInRequired : IOException("Your sign-in has expired or was revoked. Sign in with email again.")

/** A lost response or expired session cannot prove whether deletion completed. */
internal fun accountDeletionOutcomeUnknown(error: Exception): Boolean = when (error) {
    is PortalSignInRequired -> true
    is BridgeHttpException -> error.statusCode == 408 || error.statusCode >= 500 ||
        error.errorCode == "operation_uncertain" || error.operationStatus == "uncertain"
    is IOException -> true
    else -> false
}

class AccountStore(context: Context) {
    private val storage = EncryptedStorage(context, "portal_account", "herdr.remote.portal.v1")
    fun save(value: AccountSession) = storage.save(Json.encodeToString(value))
    fun load(): AccountSession? = storage.load()?.let { raw -> runCatching { Json.decodeFromString<AccountSession>(raw) }.getOrNull() }
    fun clear() = storage.clear()
}

/** The account token is only ever sent to the pinned portal origin, never a laptop. */
class Portal(private val store: AccountStore) {
    private fun api(token: String = "") = Bridge(Credentials(PORTAL_ORIGIN, token, ""))
    suspend fun startEmail(email: String): EmailChallenge = Bridge.json.decodeFromJsonElement<EmailChallenge>(
        api().call(listOf("v1", "auth", "email", "start"), "POST", buildJsonObject { put("email", email) })
    ).also { require(it.challengeId.isNotBlank() && it.expiresIn in 1..1800 && it.resendAfter in 0..1800) { "Invalid sign-in response. Try again." } }
    suspend fun verifyEmail(challengeId: String, code: String): AccountSession = Bridge.json.decodeFromJsonElement<AccountSession>(
        api().call(listOf("v1", "auth", "email", "verify"), "POST", buildJsonObject { put("challengeId", challengeId); put("code", code) })
    ).also { require(it.token.isNotBlank() && it.email.isNotBlank() && it.expiresAt > System.currentTimeMillis() / 1000) { "Invalid sign-in response. Try again." } }
    suspend fun claim(deviceId: String, claimToken: String) { authenticated(listOf("v1", "devices", "claim"), "POST", buildJsonObject { put("deviceId", deviceId); put("claimToken", claimToken) }) }
    internal suspend fun authenticated(path: List<String>, method: String = "GET", body: JsonObject = buildJsonObject {}): JsonObject {
        val session = withContext(Dispatchers.IO) { store.load() } ?: throw PortalSignInRequired()
        if (session.expiresAt <= System.currentTimeMillis() / 1000) throw PortalSignInRequired()
        try { return api(session.token).call(path, method, body) }
        catch (e: BridgeHttpException) {
            if (e.statusCode == 401 || e.statusCode == 403) throw PortalSignInRequired()
            throw e
        }
    }
    suspend fun devices(): List<RemoteDevice> = authenticated(listOf("v1", "devices")).getValue("devices").jsonArray.map {
        Bridge.json.decodeFromJsonElement<RemoteDevice>(it).also { device ->
            require(device.id.matches(Regex("[a-zA-Z0-9_-]{1,80}")) && device.label.isNotBlank()) { "The device list is invalid." }
            Bridge.normalizeUrl(device.url)
        }
    }
    suspend fun grant(deviceId: String): Credentials = Bridge.json.decodeFromJsonElement<DeviceGrant>(
        authenticated(listOf("v1", "devices", deviceId, "grant"), "POST")
    ).credentials(deviceId)
    suspend fun signOut() { authenticated(listOf("v1", "auth", "session"), "DELETE") }
    suspend fun deleteAccount(): JsonObject = authenticated(listOf("v1", "account"), "DELETE")
}

/** Refresh grants under one lock shared by the UI and reply alerts. */
class AccountConnection(context: Context) {
    private val accounts = AccountStore(context)
    private val devices = CredentialStore(context)
    private val trusted = TrustedLaptops(context)
    private val portal = Portal(accounts)
    companion object { private val lock = Mutex() }
    suspend fun resolve(original: Credentials): Credentials {
        if (original.relayLaptopId != null) {
            val entry = withContext(Dispatchers.IO) { trusted.findCredentials(original) } ?: error("Scan your laptop QR code again to reconnect.")
            return resolveTrustedRelayCredentials(original, entry, withContext(Dispatchers.IO) { accounts.load() })
        }
        val id = original.portalDeviceId ?: return original
        return lock.withLock {
            val session = withContext(Dispatchers.IO) { accounts.load() } ?: throw PortalSignInRequired()
            if (session.expiresAt <= System.currentTimeMillis() / 1000) throw PortalSignInRequired()
            val saved = withContext(Dispatchers.IO) { devices.load() }
            require(saved?.portalDeviceId == id) { "The selected laptop changed. Reconnect before trying again." }
            if ((saved!!.expiresAt ?: 0) > System.currentTimeMillis() / 1000 + 60) return@withLock saved
            refreshLocked(id, session, saved)
        }
    }
    /** Refresh an otherwise unexpired grant after an observation request gets 401. */
    suspend fun forceRefresh(original: Credentials): Credentials {
        if (original.relayLaptopId != null) {
            val entry = withContext(Dispatchers.IO) { trusted.findCredentials(original) } ?: error("Scan your laptop QR code again to reconnect.")
            return resolveTrustedRelayCredentials(original, entry, withContext(Dispatchers.IO) { accounts.load() })
        }
        val id = original.portalDeviceId ?: return original
        return lock.withLock {
            val session = withContext(Dispatchers.IO) { accounts.load() } ?: throw PortalSignInRequired()
            if (session.expiresAt <= System.currentTimeMillis() / 1000) throw PortalSignInRequired()
            val saved = withContext(Dispatchers.IO) { devices.load() }
            require(saved?.portalDeviceId == id) { "The selected laptop changed. Reconnect before trying again." }
            // Another request may have refreshed this grant while this one
            // was waiting for the portal lock. Reuse the newer token instead
            // of creating needless grants or rotating credentials again.
            if (saved!!.token != original.token) return@withLock saved
            refreshLocked(id, session, saved)
        }
    }
    private suspend fun refreshLocked(id: String, session: AccountSession, saved: Credentials): Credentials {
        val fresh = portal.grant(id)
        withContext(Dispatchers.IO) {
            // A request finishing after sign-out/device switching must not restore old credentials.
            synchronized(CredentialStorageLock.monitor) {
                require(devices.load() == saved && accounts.load()?.token == session.token) { "Your sign-in or selected laptop changed." }
                devices.save(fresh)
            }
        }
        return fresh
    }
}

/** Routing renewal replaces admission credentials, never the QR-established laptop/control identity. */
internal fun resolveTrustedRelayCredentials(original: Credentials, entry: TrustedLaptop, account: AccountSession?, now: Long = System.currentTimeMillis() / 1000): Credentials {
    val latest = validateTrustedLaptop(entry, account, now)
    require(latest.deviceId == original.deviceId && latest.relayLaptopId == original.relayLaptopId &&
        latest.relayPublicKey == original.relayPublicKey && latest.token == original.token) { "Your laptop pairing changed. Reconnect before trying again." }
    return latest.copy(portalDeviceId = original.portalDeviceId ?: latest.portalDeviceId)
}
