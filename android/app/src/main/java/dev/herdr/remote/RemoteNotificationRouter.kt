package dev.herdr.remote

import android.app.Application
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/** Routes notification taps to their laptop and pane, and owns the reply-alert and cloud-push settings. */
internal class RemoteNotificationRouter(
    private val app: Application,
    private val scope: CoroutineScope,
    private val state: MutableStateFlow<RemoteState>,
    private val bridge: () -> Bridge?,
    private val store: CredentialStore,
    private val accountStore: AccountStore,
    private val trustedLaptops: TrustedLaptops,
    private val portal: Portal,
    private val useCredentials: suspend (Credentials, Boolean) -> Unit,
    private val accountLinkedConnection: () -> Boolean,
    private val select: (String) -> Unit,
    private val foreground: () -> Boolean,
) {
    var pendingNotificationPane: String? = null
    private var notificationJob: Job? = null

    fun cancelNotificationOpening() {
        notificationJob?.cancel(); notificationJob = null
        pendingNotificationPane = null
        state.update { it.copy(openingNotification = false) }
    }

    fun openNotificationPane(id: String, deviceId: String? = null, localDeviceId: String? = null) {
        cancelNotificationOpening()
        if (id.isBlank() || id.length > 256 || id.any { it.code < 0x20 || it.code == 0x7f }) return
        if (localDeviceId != null && !localDeviceId.matches(Regex("[A-Za-z0-9_-]{1,80}"))) return
        if (deviceId != null && !deviceId.matches(Regex("[A-Za-z0-9_-]{1,80}"))) return
        state.update { it.copy(openingNotification = true, loadingInitialConnection = false) }
        notificationJob = scope.launch {
            try {
                withTimeout(20_000) {
                    if (localDeviceId != null && localDeviceId != bridge()?.credentials?.deviceId) {
                        val credentials = selectTrustedLaptop(trustedLaptops.all(), localDeviceId, accountStore.load()).credentials
                        withContext(Dispatchers.IO) { ensureActive(); store.save(credentials) }
                        useCredentials(credentials, true)
                    }
                    if (deviceId != null && deviceId != bridge()?.credentials?.portalDeviceId) {
                        if (accountStore.load() == null) throw PortalSignInRequired()
                        val registry = portal.devices().also { devices -> state.update { it.copy(devices = devices) } }
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
                        useCredentials(credentials, true)
                    }
                    check(bridge() != null) { "Connect your laptop to open this conversation." }
                    if (state.value.signInRequired && accountLinkedConnection()) throw PortalSignInRequired()
                    pendingNotificationPane = id
                    openPendingNotificationPane()
                    state.first { !it.openingNotification }
                }
            } catch (error: TimeoutCancellationException) {
                pendingNotificationPane = null
                state.update { it.copy(openingNotification = false, message = "Could not open the conversation. Check your connection and try the notification again.") }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                pendingNotificationPane = null
                state.update { it.copy(openingNotification = false,
                    signInRequired = it.signInRequired || error is PortalSignInRequired,
                    message = error.message ?: "That conversation could not be opened.") }
            }
        }
    }
    fun openPendingNotificationPane() {
        val id = pendingNotificationPane ?: return
        when (notificationPaneResolution(id, state.value.online, state.value.snapshot)) {
            NotificationPaneResolution.WAIT -> return
            NotificationPaneResolution.OPEN -> select(id)
            NotificationPaneResolution.CLOSED -> state.update { it.copy(message = "That reply pane has closed.") }
        }
        pendingNotificationPane = null
        state.update { it.copy(openingNotification = false) }
    }
    suspend fun setCloudPushEnabled(enabled: Boolean) {
        if (enabled) {
            state.update { it.copy(cloudPushStatus = "Cloud push is registering") }
            try {
                CloudPush.enable(app)
                ReplyNotifications.setEnabled(app, false)
                app.stopService(android.content.Intent(app, ReplyNotificationService::class.java))
                state.update { it.copy(cloudPushEnabled = true, cloudPushStatus = "Cloud push is on", notificationsEnabled = false) }
            } catch (error: Exception) {
                CloudPush.disableLocally(app)
                state.update { it.copy(cloudPushEnabled = false, cloudPushStatus = "Cloud push needs setup", message = error.message ?: "Cloud push could not be enabled.") }
                throw error
            }
        } else {
            runCatching { CloudPush.disable(app) }.getOrElse { CloudPush.disableLocally(app) }
            state.update { it.copy(cloudPushEnabled = false, cloudPushStatus = "Cloud push is off") }
            if (foreground()) refreshReplyNotifications()
        }
    }
    fun setReplyNotifications(enabled: Boolean) {
        if (enabled && (!ReplyNotifications.hasPermission(app) || bridge() == null)) {
            state.update { it.copy(message = "Allow notifications and pair your laptop to enable reply alerts.") }
            return
        }
        if (enabled && CloudPush.enabled(app)) {
            CloudPush.disableLocally(app)
            state.update { it.copy(cloudPushEnabled = false, cloudPushStatus = "Cloud push is off") }
            scope.launch { runCatching { CloudPush.disable(app) } }
        }
        try {
            ReplyNotifications.setEnabled(app, enabled)
            state.update { it.copy(notificationsEnabled = enabled) }
        } catch (_: Exception) {
            ReplyNotifications.setEnabled(app, false)
            state.update { it.copy(notificationsEnabled = false, message = "Could not start reply alerts. Reopen the app and try again.") }
        }
    }
    fun refreshReplyNotifications() {
        val enabled = ReplyNotifications.enabled(app) && ReplyNotifications.hasPermission(app) && bridge() != null
        setReplyNotifications(enabled)
    }
}
