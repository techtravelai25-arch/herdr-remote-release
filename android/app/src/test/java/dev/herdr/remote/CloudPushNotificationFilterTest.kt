package dev.herdr.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudPushNotificationFilterTest {
    @Test fun disablingCloudPushTargetsOnlyItsOwnAlerts() {
        assertTrue(CloudPush.isCloudPushNotification(CompletionAlerts.slot("push", "laptop", "pane-1"), "cloud_agent_alerts"))
        assertTrue(CloudPush.isCloudPushNotification(CompletionAlerts.slot("push", "laptop", "pane-1"), null))
        assertTrue(CloudPush.isCloudPushNotification(null, "cloud_agent_alerts"))
        assertFalse(CloudPush.isCloudPushNotification(CompletionAlerts.slot("reply", "laptop", "pane-1"), "reply_completed"))
        assertFalse(CloudPush.isCloudPushNotification(CompletionAlerts.slot("attention", "laptop", "pane-1"), "reply_attention"))
        assertFalse(CloudPush.isCloudPushNotification(null, "reply_monitor"))
        assertFalse(CloudPush.isCloudPushNotification("pushy:laptop:pane", "reply_completed"))
    }
}
