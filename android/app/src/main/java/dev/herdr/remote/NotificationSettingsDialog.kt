package dev.herdr.remote

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable internal fun NotificationSettingsDialog(
    state: RemoteState,
    denied: Boolean,
    onCloudChange: (Boolean) -> Unit,
    onMonitoring: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Surface(shape = MaterialTheme.shapes.medium, color = colorResource(R.color.launcher_background)) {
                Image(painterResource(R.drawable.herdr_remote_logo), contentDescription = null, modifier = Modifier.size(56.dp))
            }
        },
        title = { Text("Notifications") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Know when a reply is ready or an agent needs you.")
                if (Deployment.portalEnabled) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Cloud push", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
                        Text("Receive alerts while your phone sleeps.", style = MaterialTheme.typography.bodySmall)
                    }
                    Switch(checked = state.cloudPushEnabled, enabled = !state.busy, onCheckedChange = onCloudChange)
                }
                if (Deployment.portalEnabled) {
                    Text(state.cloudPushStatus, style = MaterialTheme.typography.bodySmall)
                    HorizontalDivider()
                }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Live monitoring · ${if (state.notificationsEnabled) "On" else "Off"}",
                        fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
                    Text("Keeps a quiet notification while listening to your laptop. Battery restrictions may delay alerts.",
                        style = MaterialTheme.typography.bodySmall)
                }
                if (denied) Text("Notifications are blocked. Allow them in Android settings to receive alerts.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            TextButton(onClick = onMonitoring) {
                Text(if (state.notificationsEnabled) "Turn off monitoring" else if (denied) "Open settings" else "Enable monitoring")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}
