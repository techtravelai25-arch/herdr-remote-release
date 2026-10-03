package dev.herdr.remote

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** Mission Status settings retain the same account, voice, and history entry points. */
@Composable internal fun SettingsScreen(
    state: RemoteState, themeMode: ThemeMode, onThemeChange: (ThemeMode) -> Unit,
    onConnection: () -> Unit, onNotifications: () -> Unit, onDiagnostics: () -> Unit, onUpdates: () -> Unit,
    onGettingStarted: () -> Unit = {}
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().wrapContentWidth(Alignment.CenterHorizontally).widthIn(max = 720.dp)
        .verticalScroll(rememberScrollState()).padding(horizontal = 12.dp).padding(top = 8.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.secondaryContainer) {
            Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("MISSION STATUS", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSecondaryContainer)
                Text(state.snapshot.hostname.ifBlank { "Your workspace" }, style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSecondaryContainer)
                Text(when {
                    state.signInRequired -> "Sign in again to reach your laptop. Your drafts are saved."
                    !state.paired -> "Connect your laptop to supervise your agents."
                    !state.online -> "Connection saved · Waiting for your laptop"
                    !state.snapshot.herdrOnline -> "Laptop connected · Herdr is not running"
                    state.snapshot.stale -> "Laptop connected · Updating saved session status"
                    state.live -> "Laptop connected · Live session updates"
                    else -> "Laptop connected · Syncing session updates"
                }, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSecondaryContainer)
            }
        }
        SettingsHeading("Appearance")
        Text("Mission Status in light or dark, or follow your device.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.selectableGroup()) {
                ThemeMode.entries.forEachIndexed { index, mode ->
                    Row(Modifier.fillMaxWidth().selectable(selected = mode == themeMode, role = Role.RadioButton, onClick = { onThemeChange(mode) })
                        .heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Icon(when(mode) { ThemeMode.SYSTEM -> Icons.Default.BrightnessAuto; ThemeMode.LIGHT -> Icons.Default.LightMode; ThemeMode.DARK -> Icons.Default.DarkMode }, null)
                        Text(when(mode) { ThemeMode.SYSTEM -> "Use device setting"; ThemeMode.LIGHT -> "Light"; ThemeMode.DARK -> "Dark" }, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                        RadioButton(selected = themeMode == mode, onClick = null)
                    }
                    if (index < ThemeMode.entries.lastIndex) HorizontalDivider(Modifier.padding(start = 48.dp), color = MaterialTheme.colorScheme.outlineVariant)
                }
            }
        }
        SettingsHeading("Voice input")
        VoiceInputSettings()
        SettingsHeading("Workspace")
        Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surface) {
            Column {
                SettingsRow(Icons.Default.Computer, "Laptop & account", state.accountEmail ?: if (state.paired) "Connected with QR pairing" else "Connect a laptop", onConnection)
                HorizontalDivider(Modifier.padding(start = 68.dp), color = MaterialTheme.colorScheme.outlineVariant)
                SettingsRow(Icons.Default.NotificationsNone, "Notifications", when { state.cloudPushEnabled -> "Cloud push enabled"; state.notificationsEnabled -> "Live monitoring enabled"; else -> "Choose how agents notify you" }, onNotifications)
                HorizontalDivider(Modifier.padding(start = 68.dp), color = MaterialTheme.colorScheme.outlineVariant)
                SettingsRow(Icons.Default.Storage, "Connection diagnostics", "Phone, account, and laptop status", onDiagnostics)
            }
        }
        SettingsHeading("About")
        Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surface) {
            Column {
                SettingsRow(Icons.Default.Explore, "Getting started", "Pairing, decisions and offline access", onGettingStarted)
                HorizontalDivider(Modifier.padding(start = 68.dp), color = MaterialTheme.colorScheme.outlineVariant)
                if (Deployment.updatesEnabled) SettingsRow(Icons.Default.SystemUpdate, "App updates", "Herdr Remote · ${BuildConfig.VERSION_NAME}", onUpdates)
                else SettingsRow(Icons.Default.SystemUpdate, "Download releases", "Herdr Remote · ${BuildConfig.VERSION_NAME}") {
                    openWebLink(context, BuildConfig.DOWNLOAD_URL)
                }
                HorizontalDivider(Modifier.padding(start = 68.dp), color = MaterialTheme.colorScheme.outlineVariant)
                SettingsRow(Icons.Default.Code, "Source code", "Open source · AGPL-3.0-or-later") {
                    openWebLink(context, "https://github.com/techtravelai25-arch/herdr-remote-release")
                }
                if (Deployment.portalEnabled) {
                    HorizontalDivider(Modifier.padding(start = 68.dp), color = MaterialTheme.colorScheme.outlineVariant)
                    SettingsRow(Icons.Default.PrivacyTip, "Privacy policy", "How account and relay data are handled") {
                        openWebLink(context, "$PORTAL_ORIGIN/privacy")
                    }
                    HorizontalDivider(Modifier.padding(start = 68.dp), color = MaterialTheme.colorScheme.outlineVariant)
                    SettingsRow(Icons.Default.DeleteOutline, "Account deletion", "Deletion options and local pairing limits") {
                        openWebLink(context, "$PORTAL_ORIGIN/account/delete")
                    }
                }
            }
        }
        Text("Your agents run on your laptop. This app keeps you connected.", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun SettingsHeading(text: String) {
    Text(text, Modifier.padding(top = 8.dp).semantics { heading() }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
}

@Composable private fun SettingsRow(icon: ImageVector, title: String, subtitle: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).heightIn(min = 64.dp).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerLow) {
            Icon(icon, null, Modifier.padding(10.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
