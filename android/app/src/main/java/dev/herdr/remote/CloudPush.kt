package dev.herdr.remote

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.work.*
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class RemoteApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        StartupCrashReport.install(this)
        if (!StartupCrashReport.pending(this) && CloudPush.enabled(this)) runCatching { CloudPush.initialize(this) }
    }
}

/** Opt-in only; FCM identifiers are public configuration, never account credentials. */
object CloudPush {
    const val EXTRA_DEVICE_ID = "push_device_id"
    private const val CHANNEL = "cloud_agent_alerts"
    private const val PUSH_SOURCE = "push"
    private const val WORK = "cloud-push-registration"
    private val registrationLock = Mutex()
    private fun prefs(context: Context) = context.getSharedPreferences("cloud_push", Context.MODE_PRIVATE)
    fun enabled(context: Context) = Deployment.portalEnabled && prefs(context).getBoolean("enabled", false)
    internal fun initialize(context: Context): FirebaseMessaging {
        require(Deployment.portalEnabled) { "Cloud push is not configured in this build." }
        val raw = prefs(context).getString("config", null) ?: error("Cloud push is not configured.")
        val c = Bridge.json.parseToJsonElement(raw).jsonObject
        val app = FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
            ?: FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
                .setApplicationId(c.getValue("applicationId").jsonPrimitive.content)
                .setApiKey(c.getValue("apiKey").jsonPrimitive.content)
                .setProjectId(c.getValue("projectId").jsonPrimitive.content)
                .setGcmSenderId(c.getValue("senderId").jsonPrimitive.content).build())
        app.setDataCollectionDefaultEnabled(false)
        return FirebaseMessaging.getInstance().also { it.isAutoInitEnabled = enabled(context) }
    }
    suspend fun enable(context: Context) = registrationLock.withLock {
        require(ReplyNotifications.hasPermission(context)) { "Allow notifications in Android settings first." }
        val portal = Portal(AccountStore(context))
        val config = portal.authenticated(listOf("v1", "push", "config"))
        require(config["available"]?.jsonPrimitive?.booleanOrNull == true) { "Cloud push needs Firebase setup on your account portal. Connection monitoring is still available." }
        withContext(Dispatchers.IO) { prefs(context).edit(commit = true) { putString("config", config.toString()); putBoolean("enabled", true) } }
        try { registerLocked(context) }
        catch (e: Exception) { prefs(context).edit { putBoolean("enabled", false) }; runCatching { initialize(context).isAutoInitEnabled = false }; throw e }
    }
    suspend fun register(context: Context) = registrationLock.withLock { registerLocked(context) }
    private suspend fun registerLocked(context: Context) {
        if (!enabled(context)) return
        val account = withContext(Dispatchers.IO) { AccountStore(context).load() } ?: throw PortalSignInRequired()
        if (account.expiresAt <= System.currentTimeMillis()/1000) throw PortalSignInRequired()
        val token = suspendCancellableCoroutine<String> { continuation ->
            initialize(context).token.addOnCompleteListener { task ->
                if (!continuation.isActive) return@addOnCompleteListener
                if (task.isSuccessful) continuation.resume(task.result)
                else continuation.resumeWithException(task.exception ?: java.io.IOException("Push registration failed."))
            }
        }
        if (!enabled(context) || withContext(Dispatchers.IO) { AccountStore(context).load()?.token } != account.token) return
        Bridge(Credentials(PORTAL_ORIGIN, account.token, "")).call(listOf("v1", "push", "subscription"), "PUT", buildJsonObject { put("token", token) })
    }
    suspend fun disable(context: Context) {
        val account = withContext(Dispatchers.IO) { AccountStore(context).load() }
        disableLocally(context)
        registrationLock.withLock {
            if (account != null) Bridge(Credentials(PORTAL_ORIGIN, account.token, "")).call(listOf("v1", "push", "subscription"), "DELETE")
        }
    }
    fun disableLocally(context: Context) {
        prefs(context).edit { putBoolean("enabled", false) }
        WorkManager.getInstance(context).cancelUniqueWork(WORK)
        runCatching { initialize(context).isAutoInitEnabled = false }
        // Only alerts posted by cloud push; local reply, attention and monitoring notifications stay.
        val manager = context.getSystemService(NotificationManager::class.java)
        runCatching { manager.activeNotifications.toList() }.getOrDefault(emptyList())
            .filter { isCloudPushNotification(it.tag, it.notification.channelId) }
            .forEach { manager.cancel(it.tag, it.id) }
    }
    /** Cloud push alerts use the `push:` ledger slot as their tag and their own channel. */
    internal fun isCloudPushNotification(tag: String?, channelId: String?): Boolean =
        tag?.startsWith("$PUSH_SOURCE:") == true || channelId == CHANNEL
    fun scheduleRegistration(context: Context) {
        if (!enabled(context)) return
        WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<PushRegistrationWorker>().setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
    fun notify(context: Context, data: Map<String, String>) {
        if (!enabled(context)) return
        val account = AccountStore(context).load() ?: return
        if (account.expiresAt <= System.currentTimeMillis()/1000) return
        val event = data["eventId"] ?: return
        val device = data["deviceId"] ?: return
        val pane = data["paneId"] ?: return
        val kind = data["kind"] ?: return
        if (!event.matches(Regex("[\\w-]{1,80}")) || !device.matches(Regex("[\\w-]{1,80}")) || pane.isBlank() || pane.length > 256 || kind !in setOf("done", "needs_input", "error", "clear")) return
        if (kind == "clear") {
            val target = data["targetEventId"]?.takeIf { it.matches(Regex("[\\w-]{1,80}")) } ?: return
            // Record the tombstone even when Android's notification permission is denied.
            CompletionAlerts.clear(context, PUSH_SOURCE, device, pane, target, event)
            return
        }
        CompletionAlerts.show(context, PUSH_SOURCE, device, pane, event, event) {
            show(context, device, pane, kind)
        }
    }

    internal fun show(context: Context, device: String, pane: String, kind: String) {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(ReplyNotifications.EXTRA_PANE_ID, pane); putExtra(EXTRA_DEVICE_ID, device)
            this.data = "herdr-remote://push/${Uri.encode(device)}/${Uri.encode(pane)}".toUri()
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Agent alerts", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val copy = NotificationCopy.next(context, kind)
        manager.notify(CompletionAlerts.slot(PUSH_SOURCE, device, pane), 1, NotificationPresentation.alert(
            context, CHANNEL, copy.title, copy.body, open,
        ).build())
    }

}

class CloudPushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { CloudPush.scheduleRegistration(this) }
    override fun onMessageReceived(message: RemoteMessage) { CloudPush.notify(this, message.data) }
}
class PushRegistrationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        CloudPush.register(applicationContext); Result.success()
    } catch (_: PortalSignInRequired) { CloudPush.disableLocally(applicationContext); Result.failure() }
    catch (e: kotlinx.coroutines.CancellationException) { throw e }
    catch (_: Exception) { if (runAttemptCount < 5) Result.retry() else Result.failure() }
}
