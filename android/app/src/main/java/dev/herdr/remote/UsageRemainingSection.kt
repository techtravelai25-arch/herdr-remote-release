package dev.herdr.remote

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import java.time.Instant

/** Provider and window lists intentionally remain open to future integrations. */
@Composable internal fun UsageRemainingSection(providers: List<ProviderUsage>, offline: Boolean, stale: Boolean) {
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(providers) {
        while (true) {
            now = Instant.now()
            delay(30_000)
        }
    }
    Column(Modifier.fillMaxWidth().padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        dashboardUsage(providers).forEach { provider ->
            key(provider.id) {
                var expanded by rememberSaveable { mutableStateOf(false) }
                ProviderUsageRow(provider, offline, stale, now, expanded) { expanded = !expanded }
            }
        }
    }
}

@Composable internal fun ProviderUsageRow(
    provider: ProviderUsage,
    offline: Boolean,
    stale: Boolean,
    now: Instant,
    expanded: Boolean,
    onToggle: () -> Unit,
) {
    val status = usageStatus(provider, offline, stale, now)
    val measured = provider.hasMeasurements()
    val summary = if (measured) provider.windows.joinToString(" · ") { window ->
        "${window.label} ${window.validRemainingPercent()?.let(::usagePercentLabel) ?: "unavailable"}"
    } else status
    Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .semantics(mergeDescendants = true) { stateDescription = if (expanded) "Expanded" else "Collapsed" }
                    .clickable(role = Role.Button, onClickLabel = if (expanded) "Hide usage details" else "Show usage details", onClick = onToggle)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("${provider.name} usage", style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold)
                    if (measured && status != "Available") {
                        Text(status, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(summary, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = null, modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (expanded) {
                HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (measured) {
                        provider.windows.forEach { window ->
                            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                val percent = window.validRemainingPercent()
                                Text("${window.label} · ${percent?.let(::usagePercentLabel) ?: "Unavailable"}",
                                    style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                                if (percent != null) {
                                    LinearProgressIndicator(progress = { (percent / 100).toFloat() },
                                        modifier = Modifier.fillMaxWidth().height(4.dp).semantics {
                                            contentDescription = "${provider.name} · ${window.label} · ${usagePercentLabel(percent)}"
                                        })
                                    Text(usageTimestamp(window.resetsAt)?.let { "Resets $it" } ?: "Reset time unavailable",
                                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    } else {
                        Text(provider.message?.takeIf { it.isNotBlank() } ?: "Usage is not available from your laptop yet.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    usageTimestamp(provider.updatedAt)?.let {
                        Text("Updated $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}
