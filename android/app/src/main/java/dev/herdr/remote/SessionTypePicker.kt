package dev.herdr.remote

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.DataObject
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun SessionTypePicker(kind: String, terminalSupported: Boolean, terminalInputAllowed: Boolean, onKind: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Session type", style = MaterialTheme.typography.labelLarge)
        FlowRow(
            modifier = Modifier.fillMaxWidth().selectableGroup(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            listOf("codex", "claude", "opencode", "terminal").forEach { option ->
                val selected = kind == option
                val enabled = option != "terminal" || terminalSupported
                // Match the provider symbols used in the session list.
                val icon = when (option) {
                    "codex" -> Icons.Default.Code
                    "claude" -> Icons.Default.AutoAwesome
                    "opencode" -> Icons.Default.DataObject
                    else -> Icons.Default.Terminal
                }
                FilterChip(
                    selected = selected,
                    onClick = { onKind(option) },
                    enabled = enabled,
                    modifier = Modifier.heightIn(min = 48.dp).semantics { role = Role.RadioButton },
                    shape = MaterialTheme.shapes.small,
                    label = {
                        Text(kindLabel(option), modifier = Modifier.padding(vertical = 8.dp),
                            style = MaterialTheme.typography.labelLarge)
                    },
                    leadingIcon = { Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp)) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
                        selectedLabelColor = MaterialTheme.colorScheme.onPrimaryContainer,
                        selectedLeadingIconColor = MaterialTheme.colorScheme.onPrimaryContainer
                    ),
                    border = BorderStroke(1.dp, when {
                        !enabled -> MaterialTheme.colorScheme.outline.copy(alpha = 0.38f)
                        selected -> MaterialTheme.colorScheme.primary
                        else -> MaterialTheme.colorScheme.outline
                    })
                )
            }
        }
        if (kind == "terminal") {
            Text("A plain shell in the selected folder. No AI agent is started.", style = MaterialTheme.typography.bodyMedium)
            if (!terminalInputAllowed) Text("This laptop currently allows viewing terminals only. Enable terminal input on the laptop to send commands.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else if (!terminalSupported) {
            Text("Update the laptop bridge to open plain terminals.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
