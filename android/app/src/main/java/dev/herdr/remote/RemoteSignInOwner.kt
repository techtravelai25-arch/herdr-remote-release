package dev.herdr.remote

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Owns the account email sign-in flow and claiming laptops paired before sign-in. */
internal class RemoteSignInOwner(
    private val scope: CoroutineScope,
    private val state: MutableStateFlow<RemoteState>,
    private val portal: Portal,
    private val accountStore: AccountStore,
    private val trustedLaptops: TrustedLaptops,
    private val accountLinkedConnection: () -> Boolean,
    private val clearDevice: () -> Unit,
) {
    private var loginJob: Job? = null
    fun startEmailSignIn(rawEmail: String) {
        if (state.value.signingIn || state.value.busy) return
        val email = rawEmail.trim()
        if (email.length > 254 || !email.matches(Regex("[^\\s@]+@[^\\s@]+\\.[^\\s@]+"))) {
            state.update { it.copy(loginError = "Enter a valid email address.") }; return
        }
        state.update { it.copy(signingIn = true, loginError = null) }
        loginJob = scope.launch {
            try {
                val challenge = portal.startEmail(email)
                val now = System.currentTimeMillis() / 1000
                state.update { it.copy(emailLogin = PendingEmailLogin(email, challenge.challengeId, now + challenge.expiresIn, now + challenge.resendAfter)) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { state.update { it.copy(loginError = e.message ?: "Could not send your code. Try again.") } }
            finally { state.update { it.copy(signingIn = false) } }
        }
    }
    fun verifyEmailSignIn(code: String) {
        val pending = state.value.emailLogin ?: return
        if (state.value.signingIn) return
        if (!code.matches(Regex("[0-9]{6}"))) { state.update { it.copy(loginError = "Enter the six-digit code from your email.") }; return }
        state.update { it.copy(signingIn = true, loginError = null) }
        loginJob = scope.launch {
            try {
                val session = portal.verifyEmail(pending.challengeId, code)
                if (accountLinkedConnection()) { clearDevice(); state.update { it.copy(signingIn = true) } }
                withContext(Dispatchers.IO) { accountStore.save(session) }
                state.update { it.copy(accountEmail = session.email, signInRequired = false, emailLogin = null,
                    chooseDevice = true, devices = emptyList()) }
                claimPendingLaptops(session.email)
                val devices = portal.devices()
                state.update { it.copy(devices = devices, trustedLaptopIds = accessibleLaptops(trustedLaptops.all(), accountStore.load()).mapNotNull { entry -> entry.credentials.relayLaptopId }.toSet()) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { state.update { it.copy(loginError = e.message ?: "Could not verify this code. Try again.",
                message = if (it.accountEmail != null && !it.signInRequired) "Signed in. Could not refresh laptops; tap Refresh laptops to try again." else it.message) } }
            finally { state.update { it.copy(signingIn = false) } }
        }
    }
    suspend fun claimPendingLaptops(email: String) {
        val session = validAccount(accountStore.load())?.takeIf { it.email.equals(email, true) } ?: return
        for (entry in trustedLaptops.all()) {
            if (!Deployment.isPortalOrigin(entry.credentials.url)) continue
            val claim = entry.claimToken ?: continue
            if (entry.accountEmail != null && !entry.accountEmail.equals(email, true)) continue
            try {
                check(accountStore.load() == session) { "Your account changed. Refresh laptops." }
                portal.claim(entry.credentials.relayLaptopId!!, claim)
                synchronized(CredentialStorageLock.monitor) {
                    check(validAccount(accountStore.load()) == session) { "Your account changed. Refresh laptops." }
                    trustedLaptops.save(entry.copy(claimToken = null, accountEmail = email))
                }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { state.update { it.copy(message = "Laptop connected privately. Account linking is pending; refresh laptops to try again.") } }
        }
    }
    fun cancelSignIn() { loginJob?.cancel(); loginJob = null; state.update { it.copy(signingIn = false, emailLogin = null, loginError = null) } }
}
