package dev.herdr.remote

import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Synthetic laptop/pane IDs exercise Android's tray without contacting a real session. */
@RunWith(AndroidJUnit4::class)
class NotificationAcknowledgementTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val channel = "herdr_test_acknowledgement"

    private fun prepare() {
        assertTrue("Notification permission must be enabled for the tray test", ReplyNotifications.hasPermission(context))
        manager.createNotificationChannel(NotificationChannel(channel, "Notification test", NotificationManager.IMPORTANCE_LOW))
    }

    private fun post(source: String, device: String, pane: String, event: String) {
        CompletionAlerts.show(context, source, device, pane, event) { rawPost(CompletionAlerts.slot(source, device, pane)) }
    }

    private fun rawPost(tag: String) {
        manager.notify(tag, 1, NotificationPresentation.builder(context, channel)
            .setContentTitle("Synthetic acknowledgement test").setContentText("Test fixture").build())
    }

    private fun assertPresent(tags: Set<String>, present: Boolean) {
        val deadline = System.currentTimeMillis() + 5000
        do {
            val active = manager.activeNotifications.map { it.tag }.toSet()
            if (tags.all { (it in active) == present }) return
            Thread.sleep(50)
        } while (System.currentTimeMillis() < deadline)
        fail("Expected fixture tags to be ${if (present) "present" else "absent"}: $tags")
    }

    @Test fun pcAcknowledgementRemovesMatchingTrayAlertsAndProtectsOtherPaneAndNewerEvent() {
        prepare()
        val device = "test-${UUID.randomUUID()}"
        val cloud = "test-${UUID.randomUUID()}"
        val pane = "test-pane"
        val other = "other-pane"
        val completion = UUID.randomUUID().toString()
        val a = UUID.randomUUID().toString()
        val b = UUID.randomUUID().toString()
        val tags = setOf(CompletionAlerts.slot("reply", device, pane), CompletionAlerts.slot("attention", device, pane),
            CompletionAlerts.slot("push", cloud, pane))
        val otherTag = CompletionAlerts.slot("reply", device, other)
        try {
            post("reply", device, pane, completion)
            post("attention", device, pane, a)
            post("push", cloud, pane, a)
            post("reply", device, other, completion)
            assertPresent(tags + otherTag, true)
            val acknowledged = Pane(pane, "test-workspace", kind = "codex", status = "needs_input",
                completionEventId = completion, completionAcknowledged = true,
                attentionEventId = a, attentionAcknowledged = true)
            CompletionAlerts.reconcile(context, Snapshot(herdrOnline = true, stale = true,
                panes = listOf(acknowledged)), device, cloud)
            CompletionAlerts.reconcile(context, Snapshot(herdrOnline = false,
                panes = listOf(acknowledged)), device, cloud)
            assertPresent(tags + otherTag, true)
            CompletionAlerts.reconcile(context, Snapshot(herdrOnline = true, panes = listOf(acknowledged)), device, cloud)
            assertPresent(tags, false)
            assertPresent(setOf(otherTag), true)
            post("attention", device, pane, b)
            post("push", cloud, pane, b)
            CompletionAlerts.reconcile(context, Snapshot(herdrOnline = true, panes = listOf(acknowledged)), device, cloud)
            val newer = tags - CompletionAlerts.slot("reply", device, pane)
            assertPresent(newer, true)
            CompletionAlerts.reconcile(context, Snapshot(herdrOnline = true, panes = listOf(acknowledged.copy(
                attentionEventId = b))), device, cloud)
            assertPresent(newer, false)
            // The tombstone also prevents a delayed replay after cancellation.
            post("attention", device, pane, b)
            assertPresent(newer, false)
        } finally {
            CompletionAlerts.clear(context, "reply", device, pane, completion)
            CompletionAlerts.clear(context, "reply", device, other, completion)
            listOf(a, b).forEach { event ->
                CompletionAlerts.clear(context, "attention", device, pane, event)
                CompletionAlerts.clear(context, "push", cloud, pane, event)
            }
            (tags + otherTag).forEach { manager.cancel(it, 1) }
            manager.deleteNotificationChannel(channel)
        }
    }

    @Test fun upgradeLegacyTrayAlertOnlyClearsAfterFreshConfirmedResume() {
        prepare()
        val device = "test-${UUID.randomUUID()}"
        val pane = Pane("test-legacy-pane", "test-workspace", kind = "codex", status = "unknown")
        val tag = CompletionAlerts.slot("attention", device, pane.id)
        try {
            // Pre-upgrade attention notifications had this tag but no persisted ledger entry.
            rawPost(tag)
            assertPresent(setOf(tag), true)
            CompletionAlerts.reconcile(context, Snapshot(herdrOnline = true, panes = listOf(pane)), device, null)
            CompletionAlerts.reconcile(context, Snapshot(herdrOnline = true, stale = true,
                panes = listOf(pane.copy(status = "working"))), device, null)
            CompletionAlerts.reconcile(context, Snapshot(herdrOnline = false,
                panes = listOf(pane.copy(status = "working"))), device, null)
            assertPresent(setOf(tag), true)
            CompletionAlerts.reconcile(context, Snapshot(herdrOnline = true,
                panes = listOf(pane.copy(status = "working"))), device, null)
            assertPresent(setOf(tag), false)
        } finally {
            manager.cancel(tag, 1)
            manager.deleteNotificationChannel(channel)
        }
    }
}
