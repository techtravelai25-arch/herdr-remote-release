package dev.herdr.remote

import android.app.Application
import android.os.Build
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import kotlin.random.Random

data class DraftAttachment(val uri: Uri, val name: String, val size: Long?, val uploadedId: String? = null)

data class RemoteState(
    val url: String = "", val paired: Boolean = false, val snapshot: Snapshot = Snapshot(),
    val accountEmail: String? = null, val signInRequired: Boolean = false, val accountDeletionUncertain: Boolean = false,
    val devices: List<RemoteDevice> = emptyList(), val login: PendingLogin? = null,
    val signingIn: Boolean = false, val chooseDevice: Boolean = false,
    val emailLogin: PendingEmailLogin? = null, val loginError: String? = null,
    val trustedLaptopIds: Set<String> = emptySet(), val savedLaptops: List<SavedLaptopChoice> = emptyList(),
    val portalDeviceId: String? = null,
    val openingNotification: Boolean = false,
    val loadingInitialConnection: Boolean = false,
    val notificationsEnabled: Boolean = false,
  val online: Boolean = false, val live: Boolean = false, val busy: Boolean = false,
  val connectionError: String? = null,
  val attachments: Map<String, List<DraftAttachment>> = emptyMap(), val sendingStatus: String? = null,
  val message: String? = null, val selectedId: String? = null, val output: String = "",
  val drafts: Map<String, String> = emptyMap(), val deliveries: Map<String, DeliveryState> = emptyMap(),
  val sentPrompts: Map<String, List<String>> = emptyMap(),
  val outputTruncated: Boolean = false, val outputRevision: Long = -1,
  val terminalAttachmentId: String? = null, val outputSource: String = "recent_unwrapped",
  val agentModelMenu: CodexModelMenu? = null, val modelMenuPending: Boolean = false, val currentModel: String? = null,
  val question: BridgeQuestion? = null, val questionReviewAvailable: Boolean = false,
  val questionPending: Boolean = false, val outputReady: Boolean = true,
  val attentionIds: Set<String> = emptySet(), val unreadIds: Set<String> = emptySet(),
  val diagnostics: JsonObject? = null, val diagnosticsLoading: Boolean = false,
  val attachmentStorage: JsonObject? = null, val attachmentsLoading: Boolean = false,
  val review: JsonObject? = null, val reviewLoading: Boolean = false,
  val structuredHistory: StructuredHistory? = null, val historyLoading: Boolean = false, val historyError: String? = null,
  val activity: ActivityTimeline? = null, val activityLoading: Boolean = false, val activityError: String? = null,
  val cloudPushEnabled: Boolean = false, val cloudPushStatus: String = "Cloud push is off",
  val directories: DirectoryListing? = null, val directoriesLoading: Boolean = false,
  val directoriesError: String? = null, val directoriesRequestedPath: String? = null, val directoriesRequestedCursor: String? = null,
  val projectFiles: ProjectDirectory? = null, val projectFilesLoading: Boolean = false,
  val projectFilesError: String? = null, val projectFilesRequestedPath: String? = null, val projectFilesRequestedCursor: String? = null,
)

class RemoteModel(app: Application): AndroidViewModel(app) {
    private val store = CredentialStore(app)
  private val accountStore = AccountStore(app)
  private val trustedLaptops = TrustedLaptops(app)
  private val portal = Portal(accountStore)
  @Volatile private var bridge: Bridge? = store.load()?.let { Bridge.saved(app, it) }
  @Volatile private var connectionGeneration = 0L
  private val attentionTracker = AttentionTracker()
  private val recovery: RemoteRecoveryOwner = RemoteRecoveryOwner(DraftRecovery(app), viewModelScope, { _state.value },
      { message -> _state.update { it.copy(message = message) } })
  private fun connectionScope(credentials: Credentials): String {
    val accountToken = if (credentials.portalDeviceId != null) accountStore.load()?.token else null
    return conversationScope(credentials.url, credentials.deviceId, accountToken)
  }
  private fun schedulePersist() = recovery.schedule()
  private fun flushPersist() = recovery.flush()
  private suspend fun flushPersistAndWait() = recovery.flushAndWait()
  private fun clearPrivateState(clearStore: Boolean = false) = recovery.clear(clearStore)
  private val _state: MutableStateFlow<RemoteState> = MutableStateFlow(run {
    val account = accountStore.load()
    val allowed = bridge?.credentials?.let { credentials ->
        if (credentials.relayLaptopId != null) trustedLaptops.findCredentials(credentials)?.let { runCatching { validateTrustedLaptop(it, account) }.isSuccess } == true
        else credentials.portalDeviceId == null || validAccount(account) != null
    } == true
    val scope = bridge?.takeIf { allowed }?.let { credentials -> conversationScope(credentials.credentials.url, credentials.credentials.deviceId, if (credentials.credentials.portalDeviceId != null) account?.token else null) }.orEmpty()
    val archive = recovery.load(scope)
    val scoped = archive.entries.filter { it.scope == scope }
    RemoteState(url = bridge?.credentials?.url.orEmpty(), paired = bridge != null,
        message = recovery.failureMessage,
        loadingInitialConnection = bridge != null && account?.expiresAt?.let { it <= System.currentTimeMillis() / 1000 } != true,
        portalDeviceId = bridge?.credentials?.portalDeviceId ?: bridge?.credentials?.takeIf { !allowed }?.relayLaptopId, accountEmail = account?.email,
            signInRequired = account?.expiresAt?.let { it <= System.currentTimeMillis() / 1000 } == true,
            notificationsEnabled = ReplyNotifications.enabled(app), drafts = scoped.associate { it.paneId to it.draft }.filterValues { it.isNotEmpty() },
            deliveries = scoped.mapNotNull { entry -> entry.delivery?.let { delivery -> entry.paneId to delivery } }.toMap(),
            cloudPushEnabled = CloudPush.enabled(app), cloudPushStatus = if (CloudPush.enabled(app)) "Cloud push is on" else "Cloud push is off")
  })
    val state = _state.asStateFlow()
    private val files = RemoteFilesOwner(app, viewModelScope, _state, { bridge }, { connectionGeneration },
        { accountStore.load()?.token })
    private var liveJob: Job? = null
    private var outputJob: Job? = null
    private var directoriesJob: Job? = null
    private val paneSelection = PaneSelectionLifecycle()
    private val delivery = RemoteDeliveryOwner(_state, recovery, { bridge }, { connectionGeneration },
        paneSelection, { applySnapshot(it) })
    private var loginJob: Job? = null
    private var foreground = false
    private var outputVisible = false
    private val snapshotPoller = AdaptivePoller()
    private val outputPoller = AdaptivePoller()
    private var modelMenuRequest: Pair<String, Long>? = null
    private var dismissedModelMenuId: String? = null
    private var questionRequest: Pair<String, Long>? = null
    private var dismissedQuestionId: String? = null
    fun outputVisible(visible: Boolean) {
        outputVisible = visible
        if (visible) {
            outputPoller.reset(); beginOutput()
            if (_state.value.online && _state.value.structuredHistory == null &&
                _state.value.snapshot.panes.any { it.id == _state.value.selectedId && it.kind != "terminal" }) loadHistory()
        }
        else { outputJob?.cancel(); outputJob = null }
    }
    private fun wakePolling() { snapshotPoller.reset(); outputPoller.reset() }
    private fun pendingAction(): Boolean = _state.value.busy || _state.value.deliveries.values.any { it.status == "sending" }
    private fun waitingForModelMenu(id: String?): Boolean = modelMenuRequest?.let { (paneId, startedAt) ->
        paneId == id && android.os.SystemClock.elapsedRealtime() - startedAt < 30_000
    } == true
    private fun waitingForQuestion(id: String?): Boolean = questionRequest?.let { (paneId, startedAt) ->
        paneId == id && android.os.SystemClock.elapsedRealtime() - startedAt < 30_000
    } == true

    private val connectivity = app.getSystemService(ConnectivityManager::class.java)
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) {
        viewModelScope.launch { if (foreground) reconnect() }
    }
    }
    init {
        connectivity.registerDefaultNetworkCallback(networkCallback)
        viewModelScope.launch {
            delay(20_000)
            dismissInitialConnectionLoading()
        }
    }
    fun dismissInitialConnectionLoading() {
        _state.update { it.copy(loadingInitialConnection = false) }
    }
    override fun onCleared() {
        connectivity.unregisterNetworkCallback(networkCallback)
        super.onCleared()
    }
    private var pendingNotificationPane: String? = null
    private var notificationJob: Job? = null

    fun cancelNotificationOpening() {
        notificationJob?.cancel(); notificationJob = null
        pendingNotificationPane = null
        _state.update { it.copy(openingNotification = false) }
    }

    fun openNotificationPane(id: String, deviceId: String? = null, localDeviceId: String? = null) {
        cancelNotificationOpening()
        if (id.isBlank() || id.length > 256 || id.any { it.code < 0x20 || it.code == 0x7f }) return
        if (localDeviceId != null && !localDeviceId.matches(Regex("[A-Za-z0-9_-]{1,80}"))) return
        if (deviceId != null && !deviceId.matches(Regex("[A-Za-z0-9_-]{1,80}"))) return
        _state.update { it.copy(openingNotification = true, loadingInitialConnection = false) }
        notificationJob = viewModelScope.launch {
            try {
                withTimeout(20_000) {
                    if (localDeviceId != null && localDeviceId != bridge?.credentials?.deviceId) {
                        val credentials = selectTrustedLaptop(trustedLaptops.all(), localDeviceId, accountStore.load()).credentials
                        withContext(Dispatchers.IO) { ensureActive(); store.save(credentials) }
                        useCredentials(credentials, openingNotification = true)
                    }
                    if (deviceId != null && deviceId != bridge?.credentials?.portalDeviceId) {
                        if (accountStore.load() == null) throw PortalSignInRequired()
                        val registry = portal.devices().also { devices -> _state.update { it.copy(devices = devices) } }
                        check(registry.any { it.id == deviceId }) { "That laptop is no longer available." }
                        val remote = registry.first { it.id == deviceId }
                        val credentials = if (remote.transport == "relay" || trustedLaptops.find(deviceId, accountStore.load()) != null) validateTrustedLaptop(
                            trustedLaptops.find(deviceId, accountStore.load()) ?: error("Scan this laptop’s QR code before opening its notifications."), accountStore.load()).copy(portalDeviceId = deviceId)
                            else portal.grant(deviceId)
                        withContext(Dispatchers.IO) {
                            ensureActive()
                            store.save(credentials)
                        }
                        currentCoroutineContext().ensureActive()
                        useCredentials(credentials, openingNotification = true)
                    }
                    check(bridge != null) { "Connect your laptop to open this conversation." }
                    if (_state.value.signInRequired && accountLinkedConnection()) throw PortalSignInRequired()
                    pendingNotificationPane = id
                    openPendingNotificationPane()
                    state.first { !it.openingNotification }
                }
            } catch (error: TimeoutCancellationException) {
                pendingNotificationPane = null
                _state.update { it.copy(openingNotification = false, message = "Could not open the conversation. Check your connection and try the notification again.") }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                pendingNotificationPane = null
                _state.update { it.copy(openingNotification = false,
                    signInRequired = it.signInRequired || error is PortalSignInRequired,
                    message = error.message ?: "That conversation could not be opened.") }
            }
        }
    }
    private fun openPendingNotificationPane() {
        val id = pendingNotificationPane ?: return
        when (notificationPaneResolution(id, _state.value.online, _state.value.snapshot)) {
            NotificationPaneResolution.WAIT -> return
            NotificationPaneResolution.OPEN -> select(id)
            NotificationPaneResolution.CLOSED -> _state.update { it.copy(message = "That reply pane has closed.") }
        }
        pendingNotificationPane = null
        _state.update { it.copy(openingNotification = false) }
    }
    fun clearMessage() { _state.update { it.copy(message = null) } }
    fun updateDraft(id: String, text: String) {
        if (id.isBlank() || text.length > 16000) return
        _state.update { current -> current.copy(drafts = current.drafts + (id to text)) }
        schedulePersist()
    }
    fun setCloudPushEnabled(enabled: Boolean) = action {
        val app = getApplication<Application>()
        if (enabled) {
            _state.update { it.copy(cloudPushStatus = "Cloud push is registering") }
            try {
                CloudPush.enable(app)
                ReplyNotifications.setEnabled(app, false)
                app.stopService(android.content.Intent(app, ReplyNotificationService::class.java))
                _state.update { it.copy(cloudPushEnabled = true, cloudPushStatus = "Cloud push is on", notificationsEnabled = false) }
            } catch (error: Exception) {
                CloudPush.disableLocally(app)
                _state.update { it.copy(cloudPushEnabled = false, cloudPushStatus = "Cloud push needs setup", message = error.message ?: "Cloud push could not be enabled.") }
                throw error
            }
        } else {
            runCatching { CloudPush.disable(app) }.getOrElse { CloudPush.disableLocally(app) }
            _state.update { it.copy(cloudPushEnabled = false, cloudPushStatus = "Cloud push is off") }
            if (foreground) refreshReplyNotifications()
        }
    }
    fun loadDiagnostics() = action {
        val api = requireBridge(); val generation = connectionGeneration
        _state.update { it.copy(diagnosticsLoading = true) }
        try {
            val value = api.call(listOf("v1", "diagnostics"))
            if (generation == connectionGeneration && api === bridge) _state.update { it.copy(diagnostics = value) }
        } finally { if (generation == connectionGeneration) _state.update { it.copy(diagnosticsLoading = false) } }
    }
    fun loadAttachmentStorage() = action {
        val api = requireBridge(); val generation = connectionGeneration
        _state.update { it.copy(attachmentsLoading = true) }
        try {
            val value = api.call(listOf("v1", "attachments"))
            if (generation == connectionGeneration && api === bridge) _state.update { it.copy(attachmentStorage = value) }
        } finally { if (generation == connectionGeneration) _state.update { it.copy(attachmentsLoading = false) } }
    }
    fun deleteStoredAttachment(id: String) = action {
        require(_state.value.snapshot.canControl && _state.value.online && !_state.value.snapshot.stale) { "Remote control is unavailable. Reconnect or change the laptop's observer mode before deleting files." }
        require(id.matches(Regex("[A-Za-z0-9-]{8,80}"))) { "Attachment ID is invalid." }
        val item = _state.value.attachmentStorage?.get("attachments")?.jsonArray?.firstOrNull { it.jsonObject["id"]?.jsonPrimitive?.contentOrNull == id }?.jsonObject
        val paneId = requireNotNull(item?.get("paneId")?.jsonPrimitive?.contentOrNull) { "Refresh uploaded files before deleting." }
        val api = requireBridge(); val generation = connectionGeneration
        val operationId = operationId()
        beginDelivery(paneId, operationId, "Removing attachment…", operation = "attachment.delete")
        try { flushPersistAndWait() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            setDelivery(paneId, operationId, "failed", "Not sent. ${error.message ?: "Could not save the receipt."}", operation = "attachment.delete")
            throw error
        }
        if (generation != connectionGeneration || api !== bridge) return@action
        try { api.call(listOf("v1", "panes", paneId, "attachments", id), "DELETE", operationId = operationId) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { if (generation != connectionGeneration || api !== bridge) return@action; setDelivery(paneId, operationId, if (isUncertain(error)) "uncertain" else "failed", if (isUncertain(error)) "Removal is uncertain. Check storage before retrying." else (error.message ?: "Attachment removal failed."), operation = "attachment.delete"); throw error }
        if (generation != connectionGeneration || api !== bridge) return@action
        setDelivery(paneId, operationId, "delivered", "Attachment removed.", operation = "attachment.delete")
        _state.update { current -> current.copy(attachments = current.attachments.mapValues { (_, files) -> files.filterNot { it.uploadedId == id } }) }
        _state.update { current ->
            val data = current.attachmentStorage
            current.copy(message = "Attachment deleted from laptop.", attachmentStorage = data?.let {
                JsonObject(it + ("attachments" to JsonArray(it["attachments"]?.jsonArray.orEmpty().filterNot { file -> file.jsonObject["id"]?.jsonPrimitive?.contentOrNull == id })))
            })
        }
        if (generation == connectionGeneration && api === bridge) loadAttachmentStorageNow(api)
    }
    fun loadReview(id: String) = action {
        val api = requireBridge(); val generation = connectionGeneration
        val selectionGeneration = paneSelection.generation
        fun current() = generation == connectionGeneration && api === bridge &&
            selectionGeneration == paneSelection.generation && _state.value.selectedId == id
        if (!current()) return@action
        // Clear the previous result before any refresh that can suspend or fail.
        _state.update { it.copy(review = null, reviewLoading = true) }
        try {
            requireActivePane(id)
            if (!current()) return@action
            val value = api.call(listOf("v1", "panes", id, "review"))
            if (current()) _state.update { it.copy(review = value) }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { if (current()) throw error }
        finally { if (current()) _state.update { it.copy(reviewLoading = false) } }
    }
    fun openArtifact(id: String) = action { files.openArtifact(id) }
    /** Bind the system document picker to the laptop, account and pane offering the file. */
    fun prepareArtifactSave(id: String, suggestedName: String): String? = files.prepareArtifactSave(id, suggestedName)
    fun completeArtifactSave(destination: Uri?) = files.completeArtifactSave(destination)
    private suspend fun loadAttachmentStorageNow(api: Bridge) {
        val generation = connectionGeneration; val value = api.call(listOf("v1", "attachments"))
        if (generation == connectionGeneration && api === bridge) _state.update { it.copy(attachmentStorage = value) }
    }
    fun setReplyNotifications(enabled: Boolean) {
        val app = getApplication<Application>()
        if (enabled && (!ReplyNotifications.hasPermission(app) || bridge == null)) {
            _state.update { it.copy(message = "Allow notifications and pair your laptop to enable reply alerts.") }
            return
        }
        if (enabled && CloudPush.enabled(app)) {
            CloudPush.disableLocally(app)
            _state.update { it.copy(cloudPushEnabled = false, cloudPushStatus = "Cloud push is off") }
            viewModelScope.launch { runCatching { CloudPush.disable(app) } }
        }
        try {
            ReplyNotifications.setEnabled(app, enabled)
            _state.update { it.copy(notificationsEnabled = enabled) }
        } catch (_: Exception) {
            ReplyNotifications.setEnabled(app, false)
            _state.update { it.copy(notificationsEnabled = false, message = "Could not start reply alerts. Reopen the app and try again.") }
        }
    }
    fun refreshReplyNotifications() {
        val app = getApplication<Application>()
        val enabled = ReplyNotifications.enabled(app) && ReplyNotifications.hasPermission(app) && bridge != null
        setReplyNotifications(enabled)
    }
    fun foreground(active: Boolean) {
        if (active && !CloudPush.enabled(getApplication())) refreshReplyNotifications()
        if (active && CloudPush.enabled(getApplication())) CloudPush.scheduleRegistration(getApplication())
        if (!active) flushPersist()
        foreground = active
        wakePolling()
        liveJob?.cancel(); liveJob = null
        outputJob?.cancel(); outputJob = null
        if (active && bridge != null) {
            liveJob = viewModelScope.launch {
                val generation = connectionGeneration; val localBridge = bridge
                reconnectContinuously(disconnected = { error ->
                    if (generation == connectionGeneration && localBridge === bridge) {
                        val notificationSignInFailed = error is PortalSignInRequired && _state.value.openingNotification
                        if (notificationSignInFailed) pendingNotificationPane = null
                        _state.update { it.copy(online = false, live = false, terminalAttachmentId = null, loadingInitialConnection = false,
                            openingNotification = it.openingNotification && !notificationSignInFailed,
                            message = if (notificationSignInFailed) error?.message ?: "Sign in again to open this conversation." else it.message,
                            connectionError = error?.message ?: "Connection lost. Retrying…",
                            signInRequired = it.signInRequired || error is PortalSignInRequired) }
                    }
                }) { connected ->
                    if (generation != connectionGeneration || localBridge !== bridge) return@reconnectContinuously
                    val api = localBridge ?: return@reconnectContinuously
                    val snapshot = api.snapshot()
                    if (generation != connectionGeneration || api !== bridge) return@reconnectContinuously
                    applySnapshot(snapshot, live = false)
                    api.events(snapshotPoller, ::pendingAction).collect { next -> if (generation == connectionGeneration && api === bridge) { connected(); applySnapshot(next, live = true) } }
                }
            }
            beginOutput()
        } else _state.update { it.copy(online = false, live = false, terminalAttachmentId = null) }
    }
    fun reconnect() {
        if (bridge == null) return
        _state.update { it.copy(online = false, live = false, terminalAttachmentId = null) }
        foreground(foreground)
    }
    private fun accountLinkedConnection(): Boolean {
        val credentials = bridge?.credentials ?: return false
        return credentials.portalDeviceId != null || credentials.relayLaptopId?.let { trustedLaptops.findCredentials(credentials)?.accountEmail } != null
    }
    fun startEmailSignIn(rawEmail: String) {
        if (_state.value.signingIn || _state.value.busy) return
        val email = rawEmail.trim()
        if (email.length > 254 || !email.matches(Regex("[^\\s@]+@[^\\s@]+\\.[^\\s@]+"))) {
            _state.update { it.copy(loginError = "Enter a valid email address.") }; return
        }
        _state.update { it.copy(signingIn = true, loginError = null) }
        loginJob = viewModelScope.launch {
            try {
                val challenge = portal.startEmail(email)
                val now = System.currentTimeMillis() / 1000
                _state.update { it.copy(emailLogin = PendingEmailLogin(email, challenge.challengeId, now + challenge.expiresIn, now + challenge.resendAfter)) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { _state.update { it.copy(loginError = e.message ?: "Could not send your code. Try again.") } }
            finally { _state.update { it.copy(signingIn = false) } }
        }
    }
    fun verifyEmailSignIn(code: String) {
        val pending = _state.value.emailLogin ?: return
        if (_state.value.signingIn) return
        if (!code.matches(Regex("[0-9]{6}"))) { _state.update { it.copy(loginError = "Enter the six-digit code from your email.") }; return }
        _state.update { it.copy(signingIn = true, loginError = null) }
        loginJob = viewModelScope.launch {
            try {
                val session = portal.verifyEmail(pending.challengeId, code)
                if (accountLinkedConnection()) { clearDevice(); _state.update { it.copy(signingIn = true) } }
                withContext(Dispatchers.IO) { accountStore.save(session) }
                _state.update { it.copy(accountEmail = session.email, signInRequired = false, emailLogin = null,
                    chooseDevice = true, devices = emptyList()) }
                claimPendingLaptops(session.email)
                val devices = portal.devices()
                _state.update { it.copy(devices = devices, trustedLaptopIds = accessibleLaptops(trustedLaptops.all(), accountStore.load()).mapNotNull { entry -> entry.credentials.relayLaptopId }.toSet()) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { _state.update { it.copy(loginError = e.message ?: "Could not verify this code. Try again.",
                message = if (it.accountEmail != null && !it.signInRequired) "Signed in. Could not refresh laptops; tap Refresh laptops to try again." else it.message) } }
            finally { _state.update { it.copy(signingIn = false) } }
        }
    }
    private suspend fun claimPendingLaptops(email: String) {
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
            catch (_: Exception) { _state.update { it.copy(message = "Laptop connected privately. Account linking is pending; refresh laptops to try again.") } }
        }
    }
    fun signIn(openBrowser: (String) -> Unit) {
        if (_state.value.signingIn || _state.value.busy) return
        _state.update { it.copy(signingIn = true, login = null) }
        loginJob = viewModelScope.launch {
            try {
                val challenge = portal.start()
                _state.update { it.copy(login = PendingLogin(challenge.userCode, challenge.verificationUrl)) }
                openBrowser(challenge.verificationUrl)
                val deadline = android.os.SystemClock.elapsedRealtime() + challenge.expiresIn * 1000
                while (isActive && android.os.SystemClock.elapsedRealtime() < deadline) {
                    delay(challenge.interval * 1000)
                    val session = try { portal.poll(challenge.deviceCode) }
                    catch (network: java.io.IOException) {
                        if (network is BridgeHttpException && network.statusCode !in listOf(408, 429) && network.statusCode < 500) throw network
                        continue
                    } ?: continue
                    // A fresh account sign-in must never inherit another session's bridge grant.
                    if (accountLinkedConnection()) {
                        clearDevice()
                        _state.update { it.copy(signingIn = true) }
                    }
                    withContext(Dispatchers.IO) { accountStore.save(session) }
                    _state.update { it.copy(accountEmail = session.email, signInRequired = false,
                        login = null, chooseDevice = true, devices = emptyList()) }
                    val devices = portal.devices()
                    _state.update { it.copy(devices = devices, message = "Signed in. Choose your laptop.") }
                    return@launch
                }
                _state.update { it.copy(message = "Sign-in expired. Start again to get a new code.") }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { _state.update { it.copy(message = error.message ?: "Could not sign in. Try again.", signInRequired = it.signInRequired || error is PortalSignInRequired) } }
            finally { _state.update { it.copy(signingIn = false, login = null, emailLogin = null, loginError = null) } }
        }
    }
    fun cancelSignIn() { loginJob?.cancel(); loginJob = null; _state.update { it.copy(signingIn = false, login = null, emailLogin = null, loginError = null) } }
    fun refreshSavedLaptops() {
        val account = accountStore.load()
        val entries = accessibleLaptops(trustedLaptops.all(), account)
        _state.update { state -> state.copy(
            trustedLaptopIds = entries.mapNotNull { it.credentials.relayLaptopId }.toSet(),
            savedLaptops = entries.map { SavedLaptopChoice(it.credentials.deviceId, it.credentials.relayLaptopId!!, localLaptopLabel(it),
                bridge?.credentials?.deviceId == it.credentials.deviceId, it.accountEmail != null) }) }
    }
    fun chooseSavedLaptop(deviceId: String, onSelected: () -> Unit) = action {
        val credentials = selectTrustedLaptop(trustedLaptops.all(), deviceId, accountStore.load()).credentials
        withContext(Dispatchers.IO) { store.save(credentials) }
        useCredentials(credentials)
        onSelected()
    }
    fun rotateSavedLaptopRouting(deviceId: String) = action {
        val entry = selectTrustedLaptop(trustedLaptops.all(), deviceId, accountStore.load())
        val account = accountStore.load()
        val result = Bridge.saved(getApplication(), entry.credentials).call(listOf("v1", "relay-capability", "rotate"), "POST")
        val updated = entry.credentials.copy(relayVersion = 3,
            relayRoutingToken = result["routingToken"]?.jsonPrimitive?.contentOrNull,
            relayRoutingExpires = result["routingExpires"]?.jsonPrimitive?.longOrNull)
        relayRoutingToken(updated)
        require(updated.relayRoutingExpires == 0L && updated.relayRoutingToken != entry.credentials.relayRoutingToken) { "The laptop did not issue new routing access." }
        withContext(Dispatchers.IO) { synchronized(CredentialStorageLock.monitor) {
            check(account == accountStore.load() && trustedLaptops.findDevice(deviceId) == entry) { "Your pairing changed during renewal. Scan a fresh laptop QR." }
            validateTrustedLaptop(entry, accountStore.load())
            trustedLaptops.save(entry.copy(credentials = updated))
            if (store.load()?.deviceId == deviceId) store.save(updated)
        } }
        if (bridge?.credentials?.deviceId == deviceId) useCredentials(updated)
        // The first use acknowledges that the new capability is durably stored.
        Bridge.saved(getApplication(), updated).snapshot()
        _state.update { it.copy(message = "Connection routing credential renewed.") }
    }
    fun renameSavedLaptop(deviceId: String, label: String) = action {
        val entry = trustedLaptops.findDevice(deviceId) ?: error("That pairing was forgotten.")
        validateTrustedLaptop(entry, accountStore.load())
        trustedLaptops.save(entry.copy(label = normalizeLaptopLabel(label)))
        refreshSavedLaptops()
    }
    fun forgetSavedLaptop(deviceId: String) = action {
        val entry = trustedLaptops.findDevice(deviceId) ?: return@action
        validateTrustedLaptop(entry, accountStore.load())
        trustedLaptops.remove(deviceId)
        if (bridge?.credentials?.deviceId == deviceId) clearDevice()
        refreshSavedLaptops()
        _state.update { it.copy(message = "Pairing forgotten on this phone. Laptop and cloud registration are unchanged.") }
    }
    fun refreshDevices() = action {
        validAccount(accountStore.load())?.email?.let { claimPendingLaptops(it) }
        val devices = portal.devices()
        _state.update { it.copy(devices = devices, trustedLaptopIds = accessibleLaptops(trustedLaptops.all(), accountStore.load()).mapNotNull { entry -> entry.credentials.relayLaptopId }.toSet()) }
    }
    fun chooseDevice(id: String, onSelected: () -> Unit) = action {
        val device = _state.value.devices.find { it.id == id } ?: error("Refresh the laptop list and try again.")
        val credentials = if (device.transport == "relay" || trustedLaptops.find(id, accountStore.load()) != null) {
            val trusted = trustedLaptops.find(id, accountStore.load()) ?: error("Scan this laptop’s QR code once to verify its identity.")
            require(Bridge.normalizeUrl(device.url) == PORTAL_ORIGIN) { "Invalid relay address." }
            validateTrustedLaptop(trusted, accountStore.load()).copy(portalDeviceId = id)
        } else portal.grant(id)
        withContext(Dispatchers.IO) { store.save(credentials) }
        useCredentials(credentials)
        onSelected()
    }
    fun signOut() = action {
        cancelSignIn()
        var revoked = true
        try { portal.signOut() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: PortalSignInRequired) { }
        catch (_: Exception) { revoked = false }
        clearAccountLocally(revoked, deleted = false)
    }
    fun deleteAccount() = action {
        val result = try { portal.deleteAccount() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            if (!accountDeletionOutcomeUnknown(error)) throw error
            _state.update { it.copy(accountDeletionUncertain = true,
                signInRequired = it.signInRequired || error is PortalSignInRequired,
                message = "Cloud deletion status is unknown. Your phone data is still here. Check the Account deletion page in Settings, or clear this phone's account data separately.") }
            return@action
        }
        require(result["cloudAccountDeleted"]?.jsonPrimitive?.booleanOrNull == true) { "Account deletion was not confirmed. Check your connection and try again." }
        clearAccountLocally(revoked = true, deleted = true)
    }
    private suspend fun clearAccountLocally(revoked: Boolean, deleted: Boolean) {
        withContext(Dispatchers.IO) { accountStore.clear() }
        if (accountLinkedConnection()) clearDevice()
        else {
            CloudPush.disableLocally(getApplication())
            clearPrivateState(clearStore = true)
            _state.update { it.copy(drafts = emptyMap(), deliveries = emptyMap(), sentPrompts = emptyMap(), attachments = emptyMap(),
                output = "", outputTruncated = false,
                attachmentStorage = null, review = null, structuredHistory = null, activity = null,
                projectFiles = null, projectFilesLoading = false, projectFilesError = null, projectFilesRequestedPath = null, projectFilesRequestedCursor = null) }
            viewModelScope.launch(Dispatchers.IO) { runCatching { java.io.File(getApplication<Application>().cacheDir, "review-files").deleteRecursively() } }
        }
        recovery.privateClearJob?.join()
        _state.update { it.copy(accountEmail = null, signInRequired = false, accountDeletionUncertain = false, devices = emptyList(), chooseDevice = false,
            cloudPushEnabled = false, cloudPushStatus = "Cloud push is off",
            message = if (recovery.privateClearFailure != null) "Account access removed, but local recovery data could not be cleared. Check storage and forget the connection."
                else if (deleted) "Cloud account deleted. Laptop pairing and local remote-control access must be revoked separately on your laptop."
                else if (revoked) "Signed out." else "Signed out on this phone. The server session could not be revoked while offline.") }
        refreshSavedLaptops()
    }
    private suspend fun useCredentials(credentials: Credentials, openingNotification: Boolean = false) {
        if (!openingNotification) cancelNotificationOpening()
        val active = foreground
        recovery.privateClearJob?.join()
        check(recovery.privateClearFailure == null) { "Local recovery data could not be cleared. Check storage and try forgetting the connection again before reconnecting." }
        recovery.clearFinishedJob()
        flushPersistAndWait()
        currentCoroutineContext().ensureActive()
        foreground(false)
        connectionGeneration++
        paneSelection.cancel()
        clearPrivateState()
        getApplication<Application>().stopService(android.content.Intent(getApplication<Application>(), ReplyNotificationService::class.java))
        bridge = Bridge.saved(getApplication(), credentials)
        val scope = connectionScope(credentials)
        val archive = recovery.load(scope)
        val scoped = archive.entries.filter { it.scope == scope }
        pendingNotificationPane = null
        _state.update { RemoteState(url = credentials.url, paired = true, portalDeviceId = credentials.portalDeviceId,
            openingNotification = openingNotification,
            accountEmail = it.accountEmail, signInRequired = it.signInRequired, devices = it.devices,
            notificationsEnabled = it.notificationsEnabled, busy = it.busy, message = "Laptop connected",
            drafts = scoped.associate { entry -> entry.paneId to entry.draft }.filterValues { value -> value.isNotEmpty() },
            deliveries = scoped.mapNotNull { entry -> entry.delivery?.let { delivery -> entry.paneId to delivery } }.toMap(),
            cloudPushEnabled = CloudPush.enabled(getApplication()), cloudPushStatus = if (CloudPush.enabled(getApplication())) "Cloud push is on" else "Cloud push is off") }
        refreshSavedLaptops()
        foreground(active)
    }
    fun pair(url: String, code: String, onPaired: () -> Unit = {}) = action {
        cancelSignIn()
        val normalized = Bridge.normalizeUrl(url)
        val api = Bridge(Credentials(normalized, "", ""))
        val result = api.call(listOf("v1", "pair"), "POST", buildJsonObject { put("code", code.trim()); put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}") })
        val credentials = Credentials(normalized, result.getValue("token").jsonPrimitive.content, result.getValue("deviceId").jsonPrimitive.content)
        withContext(Dispatchers.IO) { store.save(credentials) }
        useCredentials(credentials)
        onPaired()
    }
    fun pairQr(pairing: PairingQr, onPaired: () -> Unit = {}) {
        if (pairing.laptopId == null) { pair(pairing.url, pairing.code, onPaired); return }
        action {
            cancelSignIn()
            require(pairing.expires > System.currentTimeMillis() / 1000) { "This QR expired. Generate another on your laptop." }
            val pairingAccount = accountStore.load()
            val pairingGeneration = connectionGeneration
            val initial = Credentials(pairing.url, "", "", relayLaptopId = pairing.laptopId, relayPublicKey = pairing.publicKey, relayVersion = pairing.version, relayRoutingToken = pairing.routingToken, relayRoutingExpires = pairing.routingExpires)
            // This nonce belongs only to this phone's attempt, never to the shared QR.
            val nonce = if (pairing.version >= 3) relayEncode(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }) else null
            val result = Bridge(initial).call(listOf("v1", "pair"), "POST", buildJsonObject { put("code", pairing.code); put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}") }, pairingNonce = nonce)
            require(result["laptopId"]?.jsonPrimitive?.content == pairing.laptopId) { "Laptop identity did not match the QR code." }
            check(pairingGeneration == connectionGeneration) { "Your connection changed while pairing. Scan a fresh QR." }
            val hosted = Deployment.isPortalOrigin(pairing.url)
            val email = pairingOwnerForRelay(pairing.url, pairingAccount, accountStore.load())
            val credentials = initial.copy(token = result.getValue("token").jsonPrimitive.content, deviceId = result.getValue("deviceId").jsonPrimitive.content,
                portalDeviceId = if (email != null) pairing.laptopId else null,
                relayRoutingToken = result["routingToken"]?.jsonPrimitive?.contentOrNull,
                relayRoutingExpires = result["routingExpires"]?.jsonPrimitive?.longOrNull)
            if (pairing.version >= 3) {
                relayRoutingToken(credentials)
                require(credentials.relayRoutingExpires == 0L && credentials.relayRoutingToken != pairing.routingToken) { "Laptop did not issue phone routing access. Generate a fresh QR." }
            }
            require(credentials.token.isNotBlank() && credentials.deviceId.isNotBlank()) { "The laptop returned an invalid pairing. Scan a fresh QR." }
            val entry = TrustedLaptop(credentials, if (hosted) result["claimToken"]?.jsonPrimitive?.contentOrNull else null, email)
            withContext(Dispatchers.IO) { synchronized(CredentialStorageLock.monitor) {
                check(pairingGeneration == connectionGeneration) { "Your connection changed while pairing. Scan a fresh QR." }
                check(email == pairingOwnerForRelay(pairing.url, pairingAccount, accountStore.load())) { "Your account expired while pairing. Scan a fresh QR." }
                trustedLaptops.save(entry); store.save(credentials)
            } }
            if (email != null) claimPendingLaptops(email)
            useCredentials(credentials)
            if (entry.claimToken != null && email != null && trustedLaptops.findCredentials(credentials)?.claimToken != null)
                _state.update { it.copy(message = "Laptop connected privately. Account linking is pending; refresh laptops to retry.") }
            onPaired()
        }
    }
    fun test(url: String) = action {
        val normalized = Bridge.normalizeUrl(url)
        val api = bridge?.takeIf { it.credentials.url == normalized } ?: Bridge(Credentials(normalized, "", ""))
        val health = try { api.call(listOf("v1", "health")) } catch (e: BridgeHttpException) {
            if (e.statusCode != 401) throw e
            _state.update { it.copy(message = "Server is reachable. Pair this device to check laptop and Herdr status.") }
            return@action
        }
        _state.update { it.copy(message = if (health["herdrOnline"]?.jsonPrimitive?.booleanOrNull == true) "Bridge is reachable; Herdr is running" else "Bridge is reachable; Herdr is offline") }
    }
    fun forget() {
        cancelSignIn()
        bridge?.credentials?.takeIf { it.relayLaptopId != null }?.deviceId?.let(trustedLaptops::remove)
        clearDevice(); refreshSavedLaptops()
    }
    private fun clearDevice() {
        cancelNotificationOpening()
        val wasForeground = foreground
        pendingNotificationPane = null
        setReplyNotifications(false)
        foreground(false); store.clear(); bridge = null
        connectionGeneration++
        paneSelection.cancel()
        clearPrivateState(clearStore = true)
        recovery.activeScope = ""
        CloudPush.disableLocally(getApplication())
        viewModelScope.launch(Dispatchers.IO) { runCatching { java.io.File(getApplication<Application>().cacheDir, "review-files").deleteRecursively() } }
        foreground = wasForeground
        _state.update { RemoteState(accountEmail = it.accountEmail, signInRequired = it.signInRequired, devices = it.devices) }
    }
    fun loadHistory(earlier: Boolean = false) {
        val id = _state.value.selectedId ?: return
        if (_state.value.historyLoading) return
        val api = bridge ?: return
        val generation = connectionGeneration
        val selectionGeneration = paneSelection.generation
        val cursor = if (earlier) _state.value.structuredHistory?.nextCursor else null
        if (earlier && cursor == null) return
        _state.update { it.copy(historyLoading = true, historyError = null) }
        viewModelScope.launch {
            try {
                val result = Bridge.json.decodeFromJsonElement<StructuredHistory>(api.call(listOf("v1", "panes", id, "history"), query = cursor?.let { mapOf("cursor" to it) } ?: emptyMap()))
                if (generation == connectionGeneration && selectionGeneration == paneSelection.generation && _state.value.selectedId == id) _state.update { it.copy(structuredHistory = if (earlier) prependHistory(result, it.structuredHistory) else result) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (generation == connectionGeneration && selectionGeneration == paneSelection.generation && _state.value.selectedId == id) _state.update { it.copy(historyError = if (e is BridgeHttpException && e.statusCode == 404) "Update the laptop bridge to read conversation history." else e.message ?: "Could not load history. Try again.") } }
            finally { if (generation == connectionGeneration && selectionGeneration == paneSelection.generation && _state.value.selectedId == id) _state.update { it.copy(historyLoading = false) } }
        }
    }
    fun loadActivity() {
        if (_state.value.activityLoading) return
        val api = bridge ?: return
        val generation = connectionGeneration
        _state.update { it.copy(activityLoading = true, activityError = null) }
        viewModelScope.launch {
            try {
                val result = Bridge.json.decodeFromJsonElement<ActivityTimeline>(api.call(listOf("v1", "activity")))
                if (generation == connectionGeneration) _state.update { it.copy(activity = result) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (generation == connectionGeneration) _state.update { it.copy(activityError = if (e is BridgeHttpException && e.statusCode == 404) "Update the laptop bridge to see activity." else e.message ?: "Could not load activity. Try again.") } }
            finally { if (generation == connectionGeneration) _state.update { it.copy(activityLoading = false) } }
        }
    }
    fun refresh() = action {
        val api = requireBridge(); val generation = connectionGeneration
        val next = api.snapshot()
        if (generation != connectionGeneration || api !== bridge) return@action
        applySnapshot(next)
        if (_state.value.selectedId != null && next.herdrOnline) readOutput()
    }

    /** Browse one bounded page of the selected session's project files, optionally continuing a cursor. */
    fun loadProjectFiles(directory: String? = null, cursor: String? = null) = files.loadProjectFiles(directory, cursor)

    fun startHerdr() = action {
        val current = _state.value
        require(current.online && !current.snapshot.herdrOnline && current.snapshot.canStartHerdr) { "Reconnect to the bridge before starting Herdr." }
        val api = requireBridge(); val generation = connectionGeneration
        api.call(listOf("v1", "herdr", "start"), "POST", operationId = operationId())
        val next = api.snapshot()
        if (generation != connectionGeneration || api !== bridge) return@action
        applySnapshot(next)
        _state.update { it.copy(message = if (next.herdrOnline) "Herdr is running" else "Herdr launch requested. Waiting for it to become available.") }
    }
    private fun applySnapshot(next: Snapshot, live: Boolean = _state.value.live) {
        bridge?.credentials?.let { credentials ->
            val app = getApplication<Application>()
            CompletionAlerts.reconcile(app, next, credentials.deviceId, credentials.portalDeviceId)
        }
        val previous = _state.value.snapshot
        if (snapshotPollFingerprint(previous) != snapshotPollFingerprint(next)) outputPoller.reset()
        val selected = _state.value.selectedId
        val nextSelection = paneSelection.reconcile(selected, next)
        val closed = selected != null && nextSelection == null
        if (closed || !next.herdrOnline || next.stale) {
            modelMenuRequest = null
            dismissedModelMenuId = null
            questionRequest = null
            dismissedQuestionId = null
        }
        if (closed) { outputJob?.cancel(); outputJob = null }
        val attention = next.panes.filter { it.kind != "terminal" && it.status in setOf("blocked", "needs_input", "error") }.map { it.id }.toSet()
        val unread = attentionTracker.accept(next, selected)
        _state.update { it.copy(snapshot = next, online = true, live = live, loadingInitialConnection = false, connectionError = next.error,
            selectedId = if (closed) null else it.selectedId,
            output = if (closed) "" else it.output,
            review = if (closed) null else it.review,
            reviewLoading = !closed && it.reviewLoading,
            sentPrompts = it.sentPrompts.filterKeys { id -> next.panes.any { pane -> pane.id == id } },
            question = if (closed || !next.herdrOnline || next.stale) null else it.question,
            questionReviewAvailable = !closed && next.herdrOnline && !next.stale && it.questionReviewAvailable,
            questionPending = !closed && next.herdrOnline && !next.stale && it.questionPending,
            agentModelMenu = if (closed || !next.herdrOnline || next.stale) null else it.agentModelMenu,
            modelMenuPending = if (closed || !next.herdrOnline || next.stale) false else it.modelMenuPending,
            currentModel = if (closed || !next.herdrOnline) null else it.currentModel,
            outputTruncated = if (closed) false else it.outputTruncated,
            outputRevision = if (closed || !next.herdrOnline || next.stale) -1 else it.outputRevision,
            terminalAttachmentId = if (closed || !next.herdrOnline || next.stale) null else it.terminalAttachmentId,
            attentionIds = attention, unreadIds = unread,
            message = if (closed) "This pane has closed. Select another pane from the dashboard." else it.message) }
        if (nextSelection != null && nextSelection != selected) select(nextSelection)
        if (selected != null && nextSelection == selected && outputVisible &&
            previous.panes.find { it.id == selected }?.status in setOf("working", "running", "starting") &&
            next.panes.find { it.id == selected }?.status in setOf("idle", "done") &&
            !_state.value.historyLoading) loadHistory()
        openPendingNotificationPane()
        if (closed) schedulePersist()
        // Resume output polling only when live membership returns after an outage.
        val restored = !previous.herdrOnline || previous.stale || previous.panes.none { it.id == selected }
        if (restored && next.herdrOnline && !next.stale && next.panes.any { it.id == _state.value.selectedId } && outputJob?.isActive != true) beginOutput()
    }
    fun select(id: String?) {
        if (id != null && _state.value.snapshot.panes.none { it.id == id }) return
        modelMenuRequest = null
        dismissedModelMenuId = null
        wakePolling()
        files.clearProjectFiles()
        _state.update { it.copy(review = null, reviewLoading = false,
            structuredHistory = null, historyLoading = false, historyError = null) }
        paneSelection.selected()
        if (id != null) attentionTracker.read(id)
        questionRequest = null
        dismissedQuestionId = null
        _state.update { it.copy(selectedId = id, question = null, questionReviewAvailable = false, questionPending = false, agentModelMenu = null, modelMenuPending = false, currentModel = null, outputReady = id == null, output = "", outputTruncated = false, outputRevision = -1, terminalAttachmentId = null, unreadIds = id?.let { pane -> it.unreadIds - pane } ?: it.unreadIds) }
        outputJob?.cancel(); outputJob = null; beginOutput()
        if (id != null && outputVisible && _state.value.online &&
            _state.value.snapshot.panes.any { it.id == id && it.kind != "terminal" }) loadHistory()
    }
    private fun beginOutput() {
        if (!foreground || !outputVisible || _state.value.selectedId == null || outputJob?.isActive == true) return
        outputJob = viewModelScope.launch {
            var failures = 0
            while (isActive && _state.value.selectedId != null) {
                if (!_state.value.online || !_state.value.snapshot.herdrOnline) { delay(1500); continue }
                try { readOutput(); failures = 0 }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) {
                    failures = (failures + 1).coerceAtMost(5)
                    if (e is BridgeHttpException) {
                        // Refresh membership so a closed pane cannot keep polling forever.
                        try { applySnapshot(requireBridge().snapshot()) }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { /* The next live reconnect will refresh membership. */ }
                        // Reconciliation may have selected a replacement and canceled this reader.
                        currentCoroutineContext().ensureActive()
                        if (_state.value.selectedId == null) break
                        val transient = shouldRetryPaneOutput(e, _state.value.selectedId, _state.value.snapshot)
                        if (failures == 1) _state.update { it.copy(message = "${e.message ?: "Output unavailable."}${if (transient) " Retrying automatically." else " Reopen the pane to retry."}") }
                        if (!transient) break
                    } else if (failures == 1) _state.update { it.copy(message = "Cannot reach terminal output. Retrying automatically.") }
                }
                if (failures == 0) {
                    val state = _state.value
                    val pane = state.snapshot.panes.find { it.id == state.selectedId }
                    outputPoller.pause(listOf(state.selectedId, state.output, state.terminalAttachmentId),
                        pane?.status in setOf("working", "running", "starting", "blocked", "needs_input", "needs-input") ||
                            pendingAction() || waitingForModelMenu(state.selectedId))
                } else delay((1000L shl failures) + Random.nextLong(1000))
            }
        }
    }
    private suspend fun readOutput() {
        val id = _state.value.selectedId ?: return
        val api = requireBridge(); val generation = connectionGeneration
        val selectionGeneration = paneSelection.generation
        val result = api.output(id)
        if (generation != connectionGeneration || api !== bridge) return
        if (selectionGeneration != paneSelection.generation) return
        val before = _state.value
        if (before.selectedId != id || !before.online || !before.snapshot.herdrOnline || before.snapshot.stale ||
            !acceptTerminalOutput(before.terminalAttachmentId, before.outputRevision, result.attachmentId, result.revision)) return
        val attachmentChanged = before.terminalAttachmentId != null && before.terminalAttachmentId != result.attachmentId
        if (attachmentChanged) {
            modelMenuRequest = null
            dismissedModelMenuId = null
            questionRequest = null
            dismissedQuestionId = null
        }
        val waiting = waitingForModelMenu(id)
        val menu = result.agentModelMenu?.takeIf { it.isValid() && it.id != dismissedModelMenuId &&
            !attachmentChanged && (waiting || before.agentModelMenu != null) }
        if (menu != null) modelMenuRequest = id to android.os.SystemClock.elapsedRealtime()
        if (menu == null && !waiting && modelMenuRequest?.first == id) modelMenuRequest = null
        val observedQuestion = result.question?.takeIf { before.snapshot.questionSelectionEnabled && it.isValid() && !attachmentChanged && menu == null }
        val oldQuestion = observedQuestion != null && observedQuestion.id == dismissedQuestionId
        val question = observedQuestion?.takeUnless { oldQuestion }
        val waitingQuestion = before.snapshot.questionSelectionEnabled && !attachmentChanged &&
            (result.questionAwaitingTransition || oldQuestion ||
                (waitingForQuestion(id) && question == null && result.questionReviewAvailable))
        if (!waitingQuestion) questionRequest = null
        if (!waitingQuestion && !oldQuestion) dismissedQuestionId = null
        _state.update { current ->
            if (current.selectedId != id || !current.online || !current.snapshot.herdrOnline || current.snapshot.stale ||
                !acceptTerminalOutput(current.terminalAttachmentId, current.outputRevision, result.attachmentId, result.revision)) current
            else current.copy(output = result.text, outputReady = true, outputTruncated = result.truncated,
                outputRevision = result.revision, outputSource = result.source, terminalAttachmentId = result.attachmentId,
                question = question, questionReviewAvailable = current.snapshot.questionSelectionEnabled && !attachmentChanged && result.questionReviewAvailable && menu == null,
                questionPending = waitingQuestion,
                currentModel = null, agentModelMenu = menu,
                modelMenuPending = current.modelMenuPending && waiting && menu == null,
                message = if (attachmentChanged && (current.modelMenuPending || current.agentModelMenu != null))
                    "The terminal changed. Reopen its model choices after refreshing."
                else if (!waiting && current.modelMenuPending) "Model choices did not appear. Check the terminal before trying again."
                else if (!waitingQuestion && current.questionPending && question == null) "The question is no longer visible. Check the terminal before trying again."
                else current.message)
        }
    }
    fun addAttachments(id: String, uris: List<Uri>) = action {
        requireAttachments(id)
        files.addAttachments(id, uris)
    }
    fun removeAttachment(id: String, uri: Uri) = files.removeAttachment(id, uri)
    private suspend fun requireAttachments(id: String) {
        requireActivePane(id)
        require(_state.value.snapshot.attachmentsEnabled && _state.value.snapshot.panes.any { it.id == id && it.kind != "terminal" }) { "Attachments require an agent pane and an updated laptop bridge." }
    }
    fun prompt(text: String, onSent: () -> Unit) = action {
        val id = requireNotNull(_state.value.selectedId)
        val api = requireBridge()
        val generation = connectionGeneration
        requireActivePane(id)
        val attachmentId = requireTerminalAttachment(id)
        requireDeliverySettled(id)
        val submittedDraft = text
        _state.update { current -> if (current.drafts.containsKey(id)) current else current.copy(drafts = current.drafts + (id to text)) }
        val files = _state.value.attachments[id].orEmpty()
        require(text.isNotBlank() || files.isNotEmpty()) { "Enter a prompt or add an attachment." }
        if (files.isNotEmpty()) requireAttachments(id)
        val operationId = operationId()
        var dispatchStarted = false
        try {
            val ids = this@RemoteModel.files.uploadForPrompt(id, files, api, generation) ?: return@action
            requireActivePane(id)
            _state.update { it.copy(sendingStatus = "Sending…") }
            dispatchStarted = true
            val delivered = delivery.dispatchPrompt(id, operationId, submittedDraft, attachmentId, buildJsonObject {
                put("text", text)
                put("attachmentId", attachmentId)
                if (ids.isNotEmpty()) putJsonArray("attachmentIds") { ids.forEach { add(it) } }
            }, api, generation)
            if (!delivered) return@action
            val same = delivery.finishPrompt(id, operationId, submittedDraft)
            if (same) onSent()
            loadHistory()
            if (_state.value.selectedId == id) runCatching { readOutput() }.onFailure { if (it is CancellationException) throw it }
        } catch (error: CancellationException) { throw error
        } catch (error: Exception) {
            if (generation != connectionGeneration || api !== bridge) return@action
            if (!dispatchStarted) setDelivery(id, operationId, "failed", "Not sent. ${error.message ?: "Preparation failed."}", submittedDraft)
            throw error
        } finally { _state.update { it.copy(sendingStatus = null) } }
    }
    fun key(key: String) = action {
        val paneId = requireNotNull(_state.value.selectedId); val api = requireBridge(); val generation = connectionGeneration; val operation = operationId(); beginDelivery(paneId, operation, "Sending key…", operation = "keys")
        try {
            val attachmentId = requireTerminalAttachment(paneId)
            flushPersistAndWait()
            if (generation != connectionGeneration || api !== bridge) return@action
            if (_state.value.selectedId != paneId) { setDelivery(paneId, operation, "failed", "Not sent; the selected pane changed.", operation = "keys"); return@action }
            require(requireTerminalAttachment(paneId) == attachmentId) { "The terminal changed. Refresh it before sending." }
            api.call(listOf("v1", "panes", paneId, "keys"), "POST", buildJsonObject { put("attachmentId", attachmentId); putJsonArray("keys") { add(key) } }, operation)
            if (generation != connectionGeneration || api !== bridge) return@action
            setDelivery(paneId, operation, "delivered", "Key dispatch acknowledged. Check the terminal.", operation = "keys"); runCatching { readOutput() }.onFailure { if (it is CancellationException) throw it }
        } catch (error: CancellationException) { throw error
        } catch (error: Exception) { if (generation != connectionGeneration || api !== bridge) return@action; setDelivery(paneId, operation, if (isUncertain(error)) "uncertain" else "failed", if (isUncertain(error)) "Delivery is uncertain. Inspect the pane before retrying." else (error.message ?: "Key delivery failed."), operation = "keys"); throw error }
    }
    fun insertTerminalText(text: String) = action {
        val paneId = requireNotNull(_state.value.selectedId)
        val api = requireBridge(); val generation = connectionGeneration
        val attachmentId = requireTerminalAttachment(paneId)
        require(text.isNotEmpty() && text.length <= 16000 && text.none { it == '\r' || it == '\u001b' || it == '\u0000' }) { "Enter up to 16000 characters of terminal text." }
        val operation = operationId()
        beginDelivery(paneId, operation, "Inserting text…", operation = "input")
        try {
            flushPersistAndWait()
            if (generation != connectionGeneration || api !== bridge) return@action
            require(requireTerminalAttachment(paneId) == attachmentId) { "The terminal changed. Refresh it before sending." }
            api.call(listOf("v1", "panes", paneId, "input"), "POST", buildJsonObject {
                put("attachmentId", attachmentId); put("text", text)
            }, operation)
            if (generation != connectionGeneration || api !== bridge) return@action
            setDelivery(paneId, operation, "delivered", "Text dispatch acknowledged. Check the terminal.", operation = "input")
            _state.update { current -> if (current.drafts[paneId] == text) current.copy(drafts = current.drafts - paneId) else current }
            schedulePersist()
            runCatching { readOutput() }.onFailure { if (it is CancellationException) throw it }
        } catch (error: CancellationException) { throw error
        } catch (error: Exception) {
            if (generation != connectionGeneration || api !== bridge) return@action
            setDelivery(paneId, operation, if (isUncertain(error)) "uncertain" else "failed",
                if (isUncertain(error)) "Text may have been sent. Check the terminal before trying again." else (error.message ?: "Text was not sent."), operation = "input")
            throw error
        }
    }
    fun reviewQuestion() = questionAction("question-review")
    /** Submit only the displayed live question; a native dispatch is not agent completion. */
    fun answerQuestion(questionId: String, option: Int?, answerText: String? = null) =
        questionAction("answer", questionId, option, answerText)
    private fun questionAction(operation: String, questionId: String? = null, option: Int? = null, answerText: String? = null) = action {
        val paneId = requireNotNull(_state.value.selectedId)
        val navigation = paneSelection.generation
        requireActivePane(paneId)
        require(paneSelection.generation == navigation) { "The selected conversation changed. Review its question again." }
        requireDeliverySettled(paneId)
        val current = _state.value
        require(questionPaneReady(current, paneId)) {
            "Reconnect to this Codex terminal with control access before reviewing its question."
        }
        val question = current.question
        if (operation == "question-review") {
            require(current.questionReviewAvailable && question == null) { "No queued question is visible. Refresh the terminal." }
        } else {
            require(question != null && question.isValid() && question.id == questionId) { "This question changed. Refresh before answering." }
            require(if (question.stage == "text") option == null && answerText != null && validQuestionAnswer(answerText)
                else answerText == null && option in question.options.indices) { "Choose a displayed option or enter an answer." }
        }
        val attachmentId = requireTerminalAttachment(paneId)
        val body = buildJsonObject {
            put("attachmentId", attachmentId)
            questionId?.let { put("questionId", it) }
            option?.let { put("option", it) }
            answerText?.trim()?.let { put("text", it) }
        }
        val api = requireBridge(); val generation = connectionGeneration; val receipt = operationId()
        beginDelivery(paneId, receipt, if (operation == "question-review") "Opening question…" else "Sending choice…", operation = "question.$operation")
        var dispatchStarted = false
        try {
            flushPersistAndWait()
            if (generation != connectionGeneration || api !== bridge || _state.value.selectedId != paneId || paneSelection.generation != navigation) {
                setDelivery(paneId, receipt, "failed", "Not sent; the connection or selected pane changed.", operation = "question.$operation")
                return@action
            }
            require(requireTerminalAttachment(paneId) == attachmentId) { "The terminal changed. Refresh before answering." }
            val fresh = _state.value
            require(questionPaneReady(fresh, paneId)) { "Terminal control changed. Refresh before answering." }
            if (questionId != null) require(fresh.question == question) { "The question changed before sending. Refresh it." }
            else require(fresh.questionReviewAvailable && fresh.question == null) { "The queued question changed. Refresh it." }
            dispatchStarted = true
            api.call(listOf("v1", "panes", paneId, operation), "POST", body, receipt)
            if (generation != connectionGeneration || api !== bridge) return@action
            setDelivery(paneId, receipt, "delivered", "Question action dispatched. Check the terminal.", operation = "question.$operation")
            if (_state.value.selectedId != paneId || paneSelection.generation != navigation) return@action
            questionRequest = paneId to android.os.SystemClock.elapsedRealtime()
            dismissedQuestionId = questionId
            _state.update { it.copy(question = null, questionReviewAvailable = false, questionPending = true) }
            runCatching { readOutput() }.onFailure { if (it is CancellationException) throw it }
        } catch (error: CancellationException) { throw error
        } catch (error: Exception) {
            if (generation != connectionGeneration || api !== bridge) return@action
            questionRequest = null
            _state.update { if (it.selectedId == paneId && paneSelection.generation == navigation)
                it.copy(question = null, questionReviewAvailable = false, questionPending = false) else it }
            val uncertain = dispatchStarted && isUncertain(error)
            setDelivery(paneId, receipt, if (uncertain) "uncertain" else "failed",
                if (uncertain) "Question action may have been sent. Check its receipt before trying again." else (error.message ?: "Question action was not sent."), operation = "question.$operation")
            throw error
        }
    }
    fun control(operation: String) = action {
        val id = _state.value.selectedId ?: return@action
        requireActivePane(id)
        val body = if (operation == "stop") buildJsonObject { put("attachmentId", requireTerminalAttachment(id)) } else buildJsonObject {}
        val api = requireBridge(); val generation = connectionGeneration; val operationId = operationId(); beginDelivery(id, operationId, "${operation.replaceFirstChar { it.uppercase() }}…", operation = operation)
        try { flushPersistAndWait() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            setDelivery(id, operationId, "failed", "Not sent. ${error.message ?: "Could not save the receipt."}", operation = operation)
            throw error
        }
        if (generation != connectionGeneration || api !== bridge) return@action
        if (_state.value.selectedId != id) { setDelivery(id, operationId, "failed", "Not sent; the selected pane changed.", operation = operation); return@action }
        val restartNavigation = paneSelection.generation
        if (operation == "close") {
            try { api.call(listOf("v1", "panes", id), "DELETE", operationId = operationId); if (generation != connectionGeneration || api !== bridge) return@action; setDelivery(id, operationId, "delivered", "Delivered", operation = operation); select(null) }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (generation != connectionGeneration || api !== bridge) return@action; setDelivery(id, operationId, if (isUncertain(error)) "uncertain" else "failed", if (isUncertain(error)) "Delivery is uncertain. Inspect the pane before retrying." else (error.message ?: "Operation failed."), operation = operation); throw error }
        } else {
            if (operation == "restart") paneSelection.started(operationId, id)
            val result = try { api.call(listOf("v1", "panes", id, operation), "POST", body, operationId) } catch (error: CancellationException) { throw error } catch (error: Exception) {
                if (generation != connectionGeneration || api !== bridge) return@action
                setDelivery(id, operationId, if (isUncertain(error)) "uncertain" else "failed", if (isUncertain(error)) "Delivery is uncertain. Inspect the pane before retrying." else (error.message ?: "Operation failed."), operation = operation); throw error
            }
            if (generation != connectionGeneration || api !== bridge) return@action
            setDelivery(id, operationId, "delivered", "Delivered", operation = operation)
            if (operation == "restart") result["paneId"]?.jsonPrimitive?.content?.let { paneSelection.acknowledge(restartNavigation, it) }
        }
        val next = api.snapshot()
        if (generation != connectionGeneration || api !== bridge) return@action
        applySnapshot(next)
    }
    fun openAgentModelMenu() = agentModelAction("model")
    fun selectAgentModel(menuId: String, option: Int) = agentModelAction("model-select", menuId, option)
    fun cancelAgentModelMenu(menuId: String) = agentModelAction("model-cancel", menuId)
    fun agentModelKey(menuId: String, key: String) = agentModelAction("model-key", menuId, key = key)
    fun dismissAgentModelMenuLocally() {
        dismissedModelMenuId = _state.value.agentModelMenu?.id
        modelMenuRequest = null
        _state.update { it.copy(agentModelMenu = null, modelMenuPending = false,
            message = "Model menu dismissed on phone. Check the terminal before sending other input.") }
    }
    private fun agentModelAction(operation: String, menuId: String? = null, option: Int? = null, key: String? = null) = action {
        val id = requireNotNull(_state.value.selectedId)
        requireActivePane(id)
        val current = _state.value
        require(current.selectedId == id) { "Not sent; the selected pane changed." }
        val pane = current.snapshot.panes.find { it.id == id }
        require(supportsModelSelection(current.snapshot, pane)) { "Update the laptop bridge to change this agent’s model." }
        require(current.snapshot.canControl && current.online && current.snapshot.herdrOnline && !current.snapshot.stale) {
            "Reconnect with control access before changing models."
        }
        val attachmentId = requireTerminalAttachment(id)
        if (menuId == null) {
            if (current.agentModelMenu != null || current.modelMenuPending) { readOutput(); return@action }
            require(pane?.status in setOf("idle", "done") && current.question == null && !current.questionReviewAvailable && !current.questionPending) { "Wait for the agent to finish or answer its question before changing models." }
        }
        else {
            val menu = requireNotNull(current.agentModelMenu) { "This model menu closed. Open Change model again." }
            require(menu.id == menuId && menu.isValid()) { "The model menu changed. Use the current options." }
            require(key == null || (menu.provider == "opencode" && key in setOf("up", "down"))) { "Use the model menu controls." }
            require(option == null || (menu.mode == "options" && option in menu.options.indices)) { "Choose one of the displayed options." }
        }
        val api = requireBridge(); val generation = connectionGeneration; val receipt = operationId()
        val body = buildJsonObject { put("attachmentId", attachmentId); menuId?.let { put("menuId", it) }; option?.let { put("option", it) }; key?.let { put("key", it) } }
        beginDelivery(id, receipt, "Sending model action…", operation = operation)
        var dispatchStarted = false
        try {
            flushPersistAndWait()
            if (generation != connectionGeneration || api !== bridge || _state.value.selectedId != id) {
                setDelivery(id, receipt, "failed", "Not sent; the connection or selected pane changed.", operation = operation)
                return@action
            }
            require(requireTerminalAttachment(id) == attachmentId) { "The terminal changed. Refresh before changing models." }
            dispatchStarted = true
            api.call(listOf("v1", "panes", id, operation), "POST", body, receipt)
            if (generation != connectionGeneration || api !== bridge || _state.value.selectedId != id) return@action
            if (operation == "model" || operation == "model-key") dismissedModelMenuId = null
            else dismissedModelMenuId = menuId
            modelMenuRequest = if (operation == "model-cancel") null else id to android.os.SystemClock.elapsedRealtime()
            _state.update { it.copy(agentModelMenu = if (operation == "model-key") it.agentModelMenu else null,
                modelMenuPending = operation == "model") }
            setDelivery(id, receipt, "delivered", "Model action dispatched. Check the terminal.", operation = operation)
            runCatching { readOutput() }.onFailure { if (it is CancellationException) throw it }
            _state.update { it.copy(message = when (operation) {
                "model" -> if (it.agentModelMenu == null) "Opening model choices…" else null
                "model-cancel" -> if (it.agentModelMenu == null) "Model menu closed." else null
                else -> if (it.agentModelMenu == null) "Selection sent. Check the terminal for confirmation." else null
            }) }
        } catch (cancelled: CancellationException) { throw cancelled
        } catch (error: Exception) {
            if (generation != connectionGeneration || api !== bridge) return@action
            modelMenuRequest = null
            dismissedModelMenuId = menuId
            _state.update { it.copy(agentModelMenu = null, modelMenuPending = false) }
            val uncertain = dispatchStarted && isUncertain(error)
            setDelivery(id, receipt, if (uncertain) "uncertain" else "failed",
                if (uncertain) "Model action delivery is uncertain. Inspect the terminal before trying again."
                else (error.message ?: "Model action was not sent."), operation = operation)
            // Keep the prompt draft and its delivery receipt intact. Never retry a model mutation.
            runCatching { readOutput() }.onFailure { if (it is CancellationException) throw it }
            throw if (uncertain) java.io.IOException("Model action delivery is uncertain. Check the live menu before trying again.", error) else error
        }
    }
    fun renamePane(id: String, title: String) = sessionAction(id, "rename", buildJsonObject { put("title", title.trim()) })
    fun focusPane(id: String) = sessionAction(id, "focus")
    private fun sessionAction(id: String, operation: String, body: JsonObject = buildJsonObject {}) = action {
        requireActivePane(id)
        if (operation == "rename") require(body["title"]!!.jsonPrimitive.content.length in 1..120) { "Use a session name between 1 and 120 characters." }
        val api = requireBridge(); val generation = connectionGeneration; val receipt = operationId()
        beginDelivery(id, receipt, if (operation == "rename") "Renaming session…" else "Selecting in Herdr on laptop…", operation = operation)
        try {
            flushPersistAndWait()
            if (generation != connectionGeneration || api !== bridge) return@action
            api.call(listOf("v1", "panes", id, operation), "POST", body, receipt)
        } catch (error: CancellationException) { throw error
        } catch (error: Exception) {
            if (generation != connectionGeneration || api !== bridge) return@action
            setDelivery(id, receipt, if (isUncertain(error)) "uncertain" else "failed", error.message ?: "Session action failed.", operation = operation)
            throw error
        }
        if (generation != connectionGeneration || api !== bridge) return@action
        setDelivery(id, receipt, "delivered", if (operation == "rename") "Session renamed." else "Selected in Herdr on laptop.", operation = operation)
        val next = api.snapshot()
        if (generation == connectionGeneration && api === bridge) applySnapshot(next)
    }
    fun browseDirectories(path: String? = null, cursor: String? = null) {
        val api = bridge ?: return
        val generation = connectionGeneration
        directoriesJob?.cancel()
        _state.update { it.copy(directoriesLoading = true, directoriesError = null, directoriesRequestedPath = path, directoriesRequestedCursor = cursor) }
        directoriesJob = viewModelScope.launch {
            try {
                val listing = api.directories(path, cursor)
                if (generation == connectionGeneration && api === bridge) _state.update { it.copy(directories = mergeDirectoryPage(it.directories, listing, cursor)) }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (generation == connectionGeneration && api === bridge) _state.update { it.copy(directoriesError = error.message ?: "Could not load folders. Try again.") }
            } finally {
                if (generation == connectionGeneration && api === bridge && isActive) _state.update { it.copy(directoriesLoading = false) }
            }
        }
    }
    fun create(projectId: String?, kind: String, name: String, directory: String? = null, onCreated: () -> Unit) = action {
        require(_state.value.online && _state.value.snapshot.herdrOnline && !_state.value.snapshot.stale) { "Herdr must be connected before opening a session." }
        val terminal = kind == "terminal"
        require(!terminal || _state.value.snapshot.terminalCreationEnabled) { "Update the laptop bridge to open plain terminals." }
        val sessionName = name.trim().ifBlank { "remote-${System.currentTimeMillis().toString(36)}" }
        require(Regex("^[a-z][a-z0-9_-]{0,31}$").matches(sessionName)) { "Name must start with a lowercase letter and contain up to 32 lowercase letters, digits, underscores or hyphens." }
        val body = agentCreationBody(projectId, directory, kind, sessionName)
        val api = requireBridge(); val generation = connectionGeneration; val operation = operationId()
        val navigation = paneSelection.generation
        beginDelivery("__create__", operation, if (terminal) "Opening terminal…" else "Starting agent…", operation = "agent.create")
        try { flushPersistAndWait() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            setDelivery("__create__", operation, "failed", "Not sent. ${error.message ?: "Could not save the receipt."}", operation = "agent.create")
            throw error
        }
        if (generation != connectionGeneration || api !== bridge) return@action
        val result = try { api.call(listOf("v1", "agents"), "POST", body, operation) } catch (error: CancellationException) { throw error } catch (error: Exception) {
            if (generation != connectionGeneration || api !== bridge) return@action
            setDelivery("__create__", operation, if (isUncertain(error)) "uncertain" else "failed", if (isUncertain(error)) "Session creation is uncertain. Check the dashboard before retrying." else (error.message ?: "Session creation failed."), operation = "agent.create"); throw error
        }
        if (generation != connectionGeneration || api !== bridge) return@action
        setDelivery("__create__", operation, "delivered", if (terminal) "Terminal opened." else "Agent started.", operation = "agent.create")
        paneSelection.acknowledge(navigation, result.getValue("paneId").jsonPrimitive.content)
        onCreated()
        val next = api.snapshot()
        if (generation != connectionGeneration || api !== bridge) return@action
        applySnapshot(next)
    }
    private suspend fun paneCall(action: String, body: JsonObject = buildJsonObject {}, operationId: String? = null): JsonObject {
        val id = requireNotNull(_state.value.selectedId)
        requireActivePane(id)
        return requireBridge().call(listOf("v1", "panes", id, action), "POST", body, operationId)
    }
    private suspend fun requireActivePane(id: String) {
        val current = _state.value
        val api = requireBridge(); val generation = connectionGeneration
        requireAvailablePane(id, current.online, current.snapshot) {
            val next = api.snapshot()
            if (generation != connectionGeneration || api !== bridge) throw CancellationException("Connection changed")
            applySnapshot(next)
            next
        }
        require(current.selectedId != id || _state.value.selectedId == id) { "Not sent; the selected pane changed." }
    }
    private fun requireBridge() = requireNotNull(bridge) { "Pair this device first." }
    private fun requireTerminalAttachment(id: String): String = delivery.terminalAttachment(id)
    private fun operationId(): String = delivery.operationId()
    private fun isUncertain(error: Throwable): Boolean = delivery.isUncertain(error)
    private fun requireDeliverySettled(paneId: String) = delivery.requireSettled(paneId)
    private fun beginDelivery(paneId: String, id: String, message: String, draft: String = "", operation: String = "prompt") =
        delivery.begin(paneId, id, message, draft, operation)
    private fun setDelivery(paneId: String, id: String, status: String, message: String, draft: String = "", operation: String = "prompt") =
        delivery.mark(paneId, id, status, message, draft, operation)
    fun checkDelivery(id: String) = action {
        val delivery = _state.value.deliveries[id] ?: return@action
        this@RemoteModel.delivery.reconcile(id, delivery)
    }
    fun acknowledgeDelivery(id: String) = delivery.acknowledge(id)
    private fun action(block: suspend () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true) }
        wakePolling()
        viewModelScope.launch {
            try { block() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { _state.update { it.copy(message = e.message ?: "Request failed. Check connection before retrying.", signInRequired = it.signInRequired || e is PortalSignInRequired) } }
            finally { _state.update { it.copy(busy = false) }; wakePolling() }
        }
    }
}
