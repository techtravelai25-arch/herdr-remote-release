package dev.herdr.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationPermissionPolicyTest {
    @Test fun notificationEnableUsesTheAvailableAndroidGate() {
        data class Case(
            val name: String,
            val sdkInt: Int,
            val runtimeGranted: Boolean,
            val notificationsEnabled: Boolean,
            val deniedPreviously: Boolean,
            val expected: NotificationEnableAction,
        )
        val cases = listOf(
            Case("Android 13+ fully allowed", 35, true, true, false, NotificationEnableAction.ENABLE),
            Case("Android 13+ app switch off after runtime grant", 35, true, false, false, NotificationEnableAction.OPEN_SETTINGS),
            Case("Android 13+ runtime permission missing", 35, false, true, false, NotificationEnableAction.REQUEST_PERMISSION),
            Case("Android 13+ runtime permission missing and app switch off", 35, false, false, false, NotificationEnableAction.REQUEST_PERMISSION),
            Case("Android 13+ previously denied", 35, false, false, true, NotificationEnableAction.OPEN_SETTINGS),
            Case("Android 12 app switch off", 32, false, false, false, NotificationEnableAction.OPEN_SETTINGS),
            Case("Android 12 notifications allowed", 32, false, true, false, NotificationEnableAction.ENABLE),
        )
        cases.forEach { case ->
            assertEquals(case.name, case.expected, notificationEnableAction(case.sdkInt,
                case.runtimeGranted, case.notificationsEnabled, case.deniedPreviously))
        }
    }
}
