package dev.herdr.remote

internal enum class NotificationEnableAction { ENABLE, REQUEST_PERMISSION, OPEN_SETTINGS }

/** Android 13+ has a runtime gate; every supported version also has an app notification switch. */
internal fun notificationEnableAction(
    sdkInt: Int,
    runtimePermissionGranted: Boolean,
    notificationsEnabled: Boolean,
    deniedPreviously: Boolean,
): NotificationEnableAction = when {
    notificationsEnabled && (sdkInt < 33 || runtimePermissionGranted) -> NotificationEnableAction.ENABLE
    deniedPreviously || sdkInt < 33 || runtimePermissionGranted -> NotificationEnableAction.OPEN_SETTINGS
    else -> NotificationEnableAction.REQUEST_PERMISSION
}
