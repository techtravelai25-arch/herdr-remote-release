package dev.herdr.remote

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal fun agentCreationBody(projectId: String?, directory: String?, kind: String, name: String): JsonObject {
    require(!directory.isNullOrBlank() || !projectId.isNullOrBlank()) { "Choose a folder before opening a session." }
    return buildJsonObject {
        if (!directory.isNullOrBlank()) put("directory", directory) else put("projectId", projectId!!)
        put("kind", kind)
        put("name", name)
    }
}

@Composable internal fun DirectoryPickerDialog(
    state: RemoteState,
    browse: (String?, String?) -> Unit,
    choose: (String) -> Unit,
    dismiss: () -> Unit,
    initialRecent: Boolean = false,
) {
    val listing = state.directories
    var recent by remember(state.url, state.portalDeviceId) { mutableStateOf(initialRecent) }
    val scroll = rememberScrollState()
    LaunchedEffect(listing?.current, recent) { scroll.scrollTo(0) }
    val ready = listing != null && !state.directoriesLoading && state.directoriesError == null
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("Choose folder on laptop") },
        text = {
            Column(Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(scroll), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = !recent, onClick = { recent = false }, label = { Text("Browse") })
                    FilterChip(selected = recent, onClick = { recent = true }, label = { Text("Recent") })
                }
                if (!recent) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { browse(null, null) }, enabled = !state.directoriesLoading) { Text("Home") }
                        TextButton(onClick = { browse(listing?.parent, null) }, enabled = ready && listing?.parent != null) { Text("Up") }
                    }
                    listing?.let { Text(it.current, style = MaterialTheme.typography.bodySmall) }
                }
                if (state.directoriesLoading) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text("Loading folders…")
                }
                state.directoriesError?.let { error ->
                    Text(error, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = { browse(state.directoriesRequestedPath, state.directoriesRequestedCursor) }) { Text("Retry") }
                }
                if (ready && listing != null) {
                    if (recent) {
                        Text("Choose a recent folder", style = MaterialTheme.typography.labelLarge)
                        if (listing.recent.isEmpty()) Text("Folders appear here after you open a session in them. Browse to choose your first folder.")
                        listing.recent.forEach { folder -> DirectoryRow(folder, showPath = true, actionLabel = "Choose folder") { choose(folder.path) } }
                    } else {
                        Text("Folders", style = MaterialTheme.typography.labelLarge)
                        if (listing.directories.isEmpty() && listing.nextCursor == null) Text("No subfolders. You can use this folder.", style = MaterialTheme.typography.bodyMedium)
                        listing.directories.forEach { folder -> DirectoryRow(folder) { browse(folder.path, null) } }
                        listing.nextCursor?.let { cursor -> TextButton(onClick = { browse(listing.current, cursor) }) { Text("Load more folders") } }
                    }
                }
            }
        },
        confirmButton = { if (!recent) Button(onClick = { listing?.let { choose(it.current) } }, enabled = ready) { Text("Use this folder") } },
        dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } },
    )
}

@Composable private fun DirectoryRow(folder: RemoteDirectory, showPath: Boolean = false, actionLabel: String = "Open folder", open: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = open).heightIn(min = 56.dp).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(Icons.Default.Folder, contentDescription = null)
        Column(Modifier.weight(1f)) {
            Text(folder.name, style = MaterialTheme.typography.bodyLarge)
            if (showPath) Text(folder.path, style = MaterialTheme.typography.bodySmall)
        }
        Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = actionLabel)
    }
}

internal fun mergeDirectoryPage(previous: DirectoryListing?, next: DirectoryListing, cursor: String?): DirectoryListing =
    if (cursor != null && previous?.current == next.current) next.copy(directories = (previous.directories + next.directories).distinctBy { it.path }) else next
