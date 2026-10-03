package dev.herdr.remote

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** The bridge supplies an observed model; an unknown model stays explicitly unnamed. */
@Composable internal fun ComposerModelButton(currentModel: String?, enabled: Boolean, supported: Boolean,
    onClick: () -> Unit, modifier: Modifier = Modifier) {
    val model = currentModel?.trim()?.takeIf { it.isNotBlank() }
    val description = if (!supported) "Change model unavailable. Update the laptop bridge." else
        model?.let { "Current model: $it. Change model." } ?: "Change model. Current model unavailable."
    TextButton(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 48.dp)
        .semantics(mergeDescendants = true) { contentDescription = description },
        contentPadding = PaddingValues(horizontal = 8.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) {
        Row(verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(model ?: "Model", style = MaterialTheme.typography.labelMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 120.dp))
            Icon(Icons.Default.KeyboardArrowDown, null, Modifier.size(16.dp))
        }
    }
}
