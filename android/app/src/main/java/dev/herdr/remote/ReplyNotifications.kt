package dev.herdr.remote

import android.Manifest
import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.net.ConnectivityManager
import android.net.Network
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.core.net.toUri
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect

object ReplyNotifications {
    const val EXTRA_PANE_ID = "reply_pane_id"
    const val EXTRA_LOCAL_DEVICE_ID = "reply_local_device_id"
    private const val PREFS = "reply_notifications"
    private const val ENABLED = "enabled"
    fun enabled(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ENABLED, false)
    fun hasPermission(context: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
    internal fun showCompletion(context: Context, device: String, pane: Pane) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("reply_completed", "Completed replies", NotificationManager.IMPORTANCE_DEFAULT))
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_PANE_ID, pane.id)
            putExtra(EXTRA_LOCAL_DEVICE_ID, device)
            data = "herdr-remote://reply/${android.net.Uri.encode(device)}/${android.net.Uri.encode(pane.id)}".toUri()
        }
        val open = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val copy = NotificationCopy.next(context, "done", pane.kind)
        manager.notify(CompletionAlerts.slot("reply", device, pane.id), 1, NotificationPresentation.alert(
            context, "reply_completed", copy.title, "${copy.body}\n${pane.title.ifBlank { "Conversation" }}",
            open, kindLabel(pane.kind),
        ).build())
    }
    fun setEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putBoolean(ENABLED, enabled) }
        if (enabled) start(context) else context.stopService(Intent(context, ReplyNotificationService::class.java))
    }
    /** Call from a visible activity only; Android restricts background service starts. */
    fun start(context: Context) {
        if (enabled(context) && hasPermission(context)) {
            ContextCompat.startForegroundService(context, Intent(context, ReplyNotificationService::class.java))
        }
    }
}

/** Observe snapshots through a direct event socket or adaptive encrypted relay polling; never fetch terminal output. */
class ReplyNotificationService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var monitor: Job? = null
    private val tracker = ReplyCompletionTracker()
    private val attention = InputAttentionTracker()
    private val manager get() = getSystemService(NotificationManager::class.java)
    private val connectivity get() = getSystemService(ConnectivityManager::class.java)
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            scope.launch {
                if (monitor != null && ReplyNotifications.enabled(this@ReplyNotificationService)) {
                    monitor?.cancel()
                    monitor = scope.launch { listen() }
                }
            }
        }
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        connectivity.registerDefaultNetworkCallback(networkCallback)
        manager.createNotificationChannel(NotificationChannel(MONITOR_CHANNEL, "Reply monitoring", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Keeps the laptop connection available for reply alerts"
            setShowBadge(false)
        })
        manager.createNotificationChannel(NotificationChannel(REPLY_CHANNEL, "Completed replies", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Alerts when an agent finishes replying"
        })
        manager.createNotificationChannel(NotificationChannel(ATTENTION_CHANNEL, "Needs your input", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Alerts when an agent is waiting for input"
        })
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            ReplyNotifications.setEnabled(this, false)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!ReplyNotifications.enabled(this) || !ReplyNotifications.hasPermission(this)) {
            stopSelf(); return START_NOT_STICKY
        }
        val notification = monitoringNotification("Listening for replies and requests for input")
        if (Build.VERSION.SDK_INT >= 34) startForeground(MONITOR_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(MONITOR_ID, notification)
        if (monitor?.isActive != true) monitor = scope.launch { listen() }
        return START_NOT_STICKY
    }
    private var monitoredCredentials: Credentials? = null
    private suspend fun listen() {
        val credentials = withContext(Dispatchers.IO) { CredentialStore(this@ReplyNotificationService).load() }
        if (credentials == null) { stopSelf(); return }
        monitoredCredentials = credentials
        val api = Bridge.saved(this, credentials)
        reconnectContinuously(disconnected = { setStatus("Reconnecting to your laptop…") }) { connected ->
            // The first snapshot establishes a baseline; idle/done panes never notify.
            api.events().collect { snapshot ->
                if (!ReplyNotifications.hasPermission(this)) { stopSelf(); return@collect }
                connected()
                setStatus(if (snapshot.herdrOnline) "Listening for replies and requests for input" else "Waiting for Herdr on your laptop")
                CompletionAlerts.reconcile(this@ReplyNotificationService, snapshot,
                    credentials.deviceId, credentials.portalDeviceId)
                tracker.accept(snapshot).forEach(::notifyReply)
                attention.accept(snapshot).forEach(::notifyAttention)
            }
        }
    }
    private var lastStatus: String? = null
    private fun setStatus(text: String) {
        if (text != lastStatus) {
            lastStatus = text
            manager.notify(MONITOR_ID, monitoringNotification(text))
        }
    }
    private fun openPane(id: String? = null): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (id != null) { putExtra(ReplyNotifications.EXTRA_PANE_ID, id); putExtra(ReplyNotifications.EXTRA_LOCAL_DEVICE_ID, monitoredCredentials?.deviceId); data = "herdr-remote://reply/${android.net.Uri.encode(monitoredCredentials?.deviceId.orEmpty())}/${android.net.Uri.encode(id)}".toUri() }
        }
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    private fun monitoringNotification(text: String): Notification {
        val stop = PendingIntent.getService(this, 0, Intent(this, ReplyNotificationService::class.java).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationPresentation.builder(this, MONITOR_CHANNEL)
            .setContentTitle("Live monitoring").setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setShowWhen(false)
            .setContentIntent(openPane()).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(0, "Stop monitoring", stop).build()
    }
    private fun notifyReply(pane: Pane) {
        if (!ReplyNotifications.enabled(this) || !ReplyNotifications.hasPermission(this)) return
        val device = monitoredCredentials?.deviceId ?: return
        // Older bridges have no event ID. Keep the observed working -> done fallback.
        CompletionAlerts.show(this, "reply", device, pane.id, pane.completionEventId ?: "legacy:${System.currentTimeMillis()}") {
            ReplyNotifications.showCompletion(this, device, pane)
        }
    }
    private fun notifyAttention(pane: Pane) {
        if (!ReplyNotifications.enabled(this) || !ReplyNotifications.hasPermission(this)) return
        val copy = NotificationCopy.next(this, if (pane.status == "error") "error" else "needs_input", pane.kind)
        manager.notify("attention:${monitoredCredentials?.deviceId.orEmpty()}:${pane.id}", 1, NotificationPresentation.alert(
            this, ATTENTION_CHANNEL, copy.title, "${copy.body}\n${pane.title.ifBlank { "Conversation" }}",
            openPane(pane.id), kindLabel(pane.kind),
        ).build())
    }
    override fun onDestroy() {
        connectivity.unregisterNetworkCallback(networkCallback)
        scope.cancel()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    companion object {
        private const val MONITOR_CHANNEL = "reply_monitor"
        private const val REPLY_CHANNEL = "reply_completed"
        private const val ATTENTION_CHANNEL = "agent_attention"
        private const val MONITOR_ID = 1701
        private const val STOP = "dev.herdr.remote.STOP_REPLY_NOTIFICATIONS"
    }
}
