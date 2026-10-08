package dev.herdr.remote

import android.app.NotificationManager
import android.content.Context
import androidx.core.content.edit
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString

/** One lock covers persistent identity changes and Android notification operations. */
internal object CompletionAlerts {
    private const val PREFS = "completion_alerts"
    private const val STATE = "ledger"
    private const val NOTIFICATION_ID = 1

    fun slot(source: String, device: String, pane: String) = "$source:$device:$pane"

    private fun load(context: Context): CompletionAlertLedger =
        runCatching { Bridge.json.decodeFromString<CompletionAlertLedger>(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(STATE, "{}").orEmpty()) }
            .getOrDefault(CompletionAlertLedger())

    private fun save(context: Context, state: CompletionAlertLedger) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit(commit = true) { putString(STATE, Bridge.json.encodeToString(state)) }
    }

    fun show(context: Context, source: String, device: String, pane: String, eventId: String,
             deliveryEventId: String? = null, display: () -> Unit) = synchronized(this) {
        if (!ReplyNotifications.hasPermission(context)) return@synchronized
        val (next, changed) = load(context).show(slot(source, device, pane), device, eventId, System.currentTimeMillis(), deliveryEventId)
        save(context, next)
        if (changed) display()
    }

    fun clear(context: Context, source: String, device: String, pane: String, targetEventId: String,
              deliveryEventId: String? = null) = synchronized(this) {
        val tag = slot(source, device, pane)
        val (next, cancel) = load(context).clear(tag, device, targetEventId, System.currentTimeMillis(), deliveryEventId)
        save(context, next)
        if (cancel) context.getSystemService(NotificationManager::class.java).cancel(tag, NOTIFICATION_ID)
    }

    /** A fresh snapshot can confirm an acknowledgement, but never replay historical completion alerts. */
    fun reconcile(context: Context, snapshot: Snapshot, localDevice: String?, cloudDevice: String?) = synchronized(this) {
        val previous = load(context)
        val (next, cancelled) = previous.reconcile(snapshot, localDevice, cloudDevice, System.currentTimeMillis())
        if (next != previous) save(context, next)
        val manager = context.getSystemService(NotificationManager::class.java)
        // Upgrade cleanup for local attention notifications posted before ledger tracking existed.
        if (snapshot.herdrOnline && !snapshot.stale && localDevice != null) {
            snapshot.panes.filter { it.status in setOf("working", "idle", "done") }.forEach { pane ->
                val tag = slot("attention", localDevice, pane.id)
                if (next.current[tag] == null) manager.cancel(tag, NOTIFICATION_ID)
            }
        }
        cancelled.forEach { manager.cancel(it, NOTIFICATION_ID) }
    }
}
