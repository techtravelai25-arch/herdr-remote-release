package dev.herdr.remote

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** A safe, useful file name for CreateDocument, preserving the useful suffix on long names. */
internal fun artifactFileName(path: String): String {
    val stem = path.substringAfterLast('/').map { if (it.isISOControl() || it == '\\' || it == '/') '_' else it }
        .joinToString("").trim().trimStart('.').ifBlank { "file" }
    if (stem.length <= 200) return stem
    val suffix = stem.substringAfterLast('.', "").takeIf { it.length in 1..12 && it.all { c -> c.isLetterOrDigit() } }
    return if (suffix == null) stem.take(200) else stem.take(199 - suffix.length) + "." + suffix
}

internal fun artifactFileDetail(entry: ArtifactFile): String = when {
    entry.isDirectory -> "Folder"
    !entry.downloadable -> "Over 20 MB · copy it on the laptop"
    entry.size != null -> fileSizeLabel(entry.size)
    else -> "Unknown size"
}

internal fun fileSizeLabel(size: Long): String = when {
        size >= 1024 * 1024 -> "%.1f MB".format(size / (1024.0 * 1024.0))
        size >= 1024 -> "%.1f KB".format(size / 1024.0)
        else -> "$size bytes"
    }

@Composable internal fun FilesBrowserDialog(
    files: ProjectDirectory?, loading: Boolean, error: String?,
    url: String, portalDeviceId: String?,
    onDismiss: () -> Unit,
    onNavigate: (directory: String?, cursor: String?) -> Unit,
    onOpen: (ArtifactFile) -> Unit,
    onSave: (ArtifactFile) -> Unit,
    operationMessage: String? = null,
) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Files on laptop") }, text = {
        Column(Modifier.fillMaxWidth().heightIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (files == null) "Loading the project files..." else files.displayName,
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            // Navigation resets whenever the connection identity changes.
            key(url, portalDeviceId) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(enabled = !loading && files?.parent != null, onClick = { onNavigate(files?.parent, null) }) { Text("Up") }
                    TextButton(enabled = !loading, onClick = { onNavigate(files?.directory, null) }) { Text("Refresh") }
                }
            }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            operationMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (files == null && error == null && !loading) Text("Waiting for this project's files. Open the Files menu again to refresh.",
                style = MaterialTheme.typography.bodyMedium)
            if (files != null && error == null && !files.truncated && files.entries.isEmpty() && files.nextCursor == null) {
                Text("No files in this folder.",
                    style = MaterialTheme.typography.bodyMedium)
            }
            if (files != null && files.truncated && files.nextCursor == null) Text("This folder has more entries than the laptop can show here.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (files != null && error == null) {
                LazyColumn(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(files.entries, key = { it.path }) { entry -> FileEntryRow(entry, loading, onOpen, onSave) }
                    if (files.nextCursor != null) item(key = "load-more") {
                        TextButton(enabled = !loading, onClick = { onNavigate(files.directory, files.nextCursor) }) { Text("Load more") }
                    }
                }
            }
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } })
}

@Composable private fun FileEntryRow(entry: ArtifactFile, loading: Boolean, onOpen: (ArtifactFile) -> Unit, onSave: (ArtifactFile) -> Unit) {
    Surface(onClick = { if (entry.isDirectory || entry.downloadable) onOpen(entry) },
        enabled = !loading && (entry.isDirectory || entry.downloadable),
        shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(if (entry.isDirectory) Icons.Default.Folder else Icons.Default.InsertDriveFile, null, Modifier.size(20.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(entry.name, Modifier.semantics { contentDescription = entry.path }, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                Text(artifactFileDetail(entry), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            }
            if (!entry.isDirectory && entry.downloadable) {
                IconButton(onClick = { onSave(entry) }, enabled = !loading) { Icon(Icons.Default.Save, "Save ${entry.name} to device") }
            }
            if (entry.isDirectory) Icon(Icons.AutoMirrored.Filled.ArrowForward, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
