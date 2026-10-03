package dev.herdr.remote

import kotlinx.serialization.Serializable
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Serializable data class ProviderUsage(
    val id: String,
    val name: String,
    val status: String = "unavailable",
    val windows: List<UsageWindow> = emptyList(),
    val updatedAt: String? = null,
    val message: String? = null,
)

@Serializable data class UsageWindow(
    val id: String,
    val label: String,
    val remainingPercent: Double? = null,
    val resetsAt: String? = null,
)

internal fun dashboardUsage(providers: List<ProviderUsage>): List<ProviderUsage> = providers.ifEmpty {
    listOf(ProviderUsage("codex", "Codex", message = "Usage is not available from your laptop yet."))
}

// Unknown or invalid measurements must never look like a full or exhausted quota.
internal fun UsageWindow.validRemainingPercent(): Double? = remainingPercent?.takeIf { it.isFinite() && it in 0.0..100.0 }

internal fun ProviderUsage.hasMeasurements(): Boolean = status in setOf("available", "stale") && windows.any { it.validRemainingPercent() != null }

internal fun usageStatus(provider: ProviderUsage, offline: Boolean, stale: Boolean, now: Instant = Instant.now()): String = when {
    !provider.hasMeasurements() -> "Unavailable"
    offline -> "Last known · offline"
    stale || provider.status == "stale" || provider.measurementsExpired(now) -> "Last known · updating"
    else -> "Available"
}

private fun ProviderUsage.measurementsExpired(now: Instant): Boolean {
    val updated = updatedAt?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return true
    return updated.isAfter(now.plusSeconds(60)) || updated.isBefore(now.minusSeconds(300)) || windows.any { window ->
        window.resetsAt?.let { value ->
            runCatching { !Instant.parse(value).isAfter(now) }.getOrDefault(true)
        } ?: false
    }
}

internal fun usagePercentLabel(percent: Double): String = NumberFormat.getNumberInstance().apply {
    maximumFractionDigits = 1
}.format(percent) + "% left"

internal fun usageTimestamp(value: String?): String? = value?.let {
    runCatching { DateTimeFormatter.ofPattern("MMM d, HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(it)) }.getOrNull()
}
