package dev.herdr.remote

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable internal fun NewSessionDialog(
    kind: String,
    onKind: (String) -> Unit,
    terminalSupported: Boolean,
    terminalInputAllowed: Boolean,
    directory: String?,
    foldersSupported: Boolean,
    browseEnabled: Boolean,
    onBrowse: () -> Unit,
    name: String,
    onName: (String) -> Unit,
    validName: Boolean,
    canCreate: Boolean,
    onCreate: () -> Unit,
    dismiss: () -> Unit,
    creation: DeliveryState? = null,
) {
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("New session") },
        text = {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                creation?.let {
                    Text(it.message, color = if (it.status in setOf("failed", "uncertain"))
                        MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
                    if (it.status == "sending") LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                SessionTypePicker(kind, terminalSupported, terminalInputAllowed, onKind)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Folder on laptop", style = MaterialTheme.typography.labelLarge)
                    if (foldersSupported) {
                        Text(
                            directory ?: "Choose from home or recent folders.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedButton(
                            onClick = onBrowse,
                            enabled = browseEnabled,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                            shape = MaterialTheme.shapes.medium,
                        ) {
                            Icon(Icons.Default.Folder, null, Modifier.size(20.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(if (directory == null) "Choose folder" else "Change folder")
                        }
                    } else {
                        Text("Update the laptop bridge to browse folders.", style = MaterialTheme.typography.bodyMedium)
                    }
                }
                OutlinedTextField(
                    value = name, onValueChange = onName,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Session name (optional)") },
                    singleLine = true, isError = !validName,
                    supportingText = {
                        Text(if (validName) "Leave blank to generate a name." else
                            "Start with a lowercase letter. Use up to 32 lowercase letters, digits, _ or -.")
                    },
                )
            }
        },
        confirmButton = {
            Button(onClick = onCreate, enabled = canCreate, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(if (kind == "terminal") "Open terminal" else "Start agent")
            }
        },
        dismissButton = { TextButton(onClick = dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") } },
    )
}
