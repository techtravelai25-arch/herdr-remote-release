package dev.herdr.remote

internal enum class NotificationPaneResolution { WAIT, OPEN, CLOSED }

/** Only current membership can confirm that a notification's conversation has closed. */
internal fun notificationPaneResolution(id: String, online: Boolean, snapshot: Snapshot): NotificationPaneResolution = when {
    !online || !snapshot.herdrOnline || snapshot.stale -> NotificationPaneResolution.WAIT
    snapshot.panes.any { it.id == id } -> NotificationPaneResolution.OPEN
    else -> NotificationPaneResolution.CLOSED
}
