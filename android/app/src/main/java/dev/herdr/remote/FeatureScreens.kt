package dev.herdr.remote

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.compose.ui.platform.LocalContext

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.serialization.json.*

private fun JsonObject?.string(key: String, fallback: String = "Unknown") = (this?.get(key) as? JsonPrimitive)?.contentOrNull ?: fallback
private fun JsonObject?.number(key: String) = (this?.get(key) as? JsonPrimitive)?.longOrNull
private fun JsonObject?.flag(key: String) = (this?.get(key) as? JsonPrimitive)?.booleanOrNull
private fun JsonObject?.objects(key: String) = (this?.get(key) as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
private fun bytes(value: Long?): String = when {
    value == null -> "Unknown"
    value >= 1024 * 1024 -> "${String.format(java.util.Locale.getDefault(), "%.1f", value / 1048576.0)} MB"
    value >= 1024 -> "${String.format(java.util.Locale.getDefault(), "%.1f", value / 1024.0)} KB"
    else -> "$value bytes"
}

@Composable private fun SectionTitle(text: String) {
    Text(text, Modifier.padding(top = 12.dp).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
}

@Composable internal fun DiagnosticsDialog(state: RemoteState, model: RemoteModel, onDismiss: () -> Unit) {
    val connectivity = LocalContext.current.getSystemService(ConnectivityManager::class.java)
    val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
    val network = when {
        capabilities == null -> "Offline"
        !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> "Connected · Internet not validated"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi · Internet available"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "Mobile data · Internet available"
        else -> "Connected · Internet available"
    }
    val account = when { state.signInRequired -> "Sign-in required"; state.accountEmail != null -> "Signed in"; else -> "No account session · QR pairing available" }
    val data = state.diagnostics
    val report = buildString {
        appendLine("Herdr Remote connection diagnostics")
        appendLine("Phone network: $network")
        appendLine("Account: $account")
        appendLine("Bridge: ${if (state.online) "reachable" else "unreachable"}")
        appendLine("Herdr: ${if (!state.online) "unknown" else if (state.snapshot.herdrOnline) "running" else "unavailable"}")
        appendLine("Live updates: ${if (state.live) "connected" else "disconnected"}")
        appendLine("Bridge uptime seconds: ${(data?.get("process") as? JsonObject).number("uptimeSeconds") ?: "Unknown"}")
        appendLine("Server checked at: ${data.string("checkedAt")}")
        appendLine("Resume supported: ${data.flag("sessionResumeSupported") ?: "Unknown"}")
        appendLine("Projects available: ${data.objects("projects").count { it.flag("available") == true }} / ${data.objects("projects").size}")
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Connection diagnostics") }, text = {
        Column(Modifier.fillMaxWidth().heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (state.diagnosticsLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
            SectionTitle("Connection diagnostics")
            Text("Phone network · $network")
            Text("Account · $account")
            Text("Bridge · ${if (state.online) "Reachable" else "Unreachable"}")
            Text("Herdr · ${if (!state.online) "Unknown until connected" else if (state.snapshot.herdrOnline) "Running" else "Unavailable"}")
            Text("Live updates · ${if (state.live) "Connected" else "Reconnecting"}")
            if (data != null) {
                Text("Checked · ${data.string("checkedAt")}", style = MaterialTheme.typography.bodySmall)
                data.objects("projects").forEach { project ->
                    Text("${project.string("label")} · ${if (project.flag("available") == true) "Available" else "Unavailable"}", style = MaterialTheme.typography.bodySmall)
                }
            } else if (!state.diagnosticsLoading) Text("Server diagnostics are unavailable. Reconnect, then refresh.", style = MaterialTheme.typography.bodySmall)
            Row {
                TextButton(onClick = model::loadDiagnostics, enabled = !state.diagnosticsLoading) { Text("Refresh") }
                CopyTextButton(report, "Copy diagnostics")
            }
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } })
}

@Composable internal fun AttachmentStorageDialog(state: RemoteState, model: RemoteModel, onDismiss: () -> Unit) {
    AttachmentStorageDialog(state, model::loadAttachmentStorage, model::deleteStoredAttachment, onDismiss)
}

@Composable internal fun AttachmentStorageDialog(state: RemoteState, onRefresh: () -> Unit, onDelete: (String) -> Unit, onDismiss: () -> Unit) {
    var deleting by remember { mutableStateOf<JsonObject?>(null) }
    val canDelete = state.online && state.snapshot.canControl && !state.snapshot.stale && !state.busy
    val data = state.attachmentStorage
    val files = data.objects("attachments")
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Uploaded files") }, text = {
        Column(Modifier.fillMaxWidth().heightIn(max = 520.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("${bytes(data.number("usedBytes"))} used of ${bytes(data.number("quotaBytes"))}", style = MaterialTheme.typography.bodyMedium)
            Text("Files already uploaded to your laptop. Removing a draft chip does not delete these files.", style = MaterialTheme.typography.bodySmall)
            state.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            if (state.attachmentsLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (files.isEmpty() && !state.attachmentsLoading) Text(if (data == null) "File inventory unavailable. Reconnect and refresh." else "No uploaded files.")
            LazyColumn(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(files, key = { it.string("id") }) { file ->
                    Column {
                        Text(file.string("name"), style = MaterialTheme.typography.titleSmall)
                        Text(bytes(file.number("size")), style = MaterialTheme.typography.bodySmall)
                        Text(file.string("cwd", "Project unavailable"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        TextButton(onClick = { if (canDelete) deleting = file }, enabled = canDelete) { Text("Delete from laptop") }
                        HorizontalDivider()
                    }
                }
            }
            TextButton(onClick = onRefresh, enabled = !state.attachmentsLoading) { Text("Refresh files") }
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } })
    deleting?.let { file ->
        AlertDialog(onDismissRequest = { deleting = null }, title = { Text("Delete ${file.string("name")}?") },
            text = { Text("Permanently remove this uploaded file from the laptop. An agent or draft that references it may need the file again.") },
            confirmButton = { TextButton(enabled = canDelete, onClick = { if (canDelete) { onDelete(file.string("id")); deleting = null } }) { Text("Delete file") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } })
    }
}

@Composable internal fun ReviewResults(data: JsonObject?, loading: Boolean, onRefresh: () -> Unit, onArtifact: (String) -> Unit = {}, onSave: (String, String) -> Unit = { _, _ -> }) {
    var showDiff by remember(data) { mutableStateOf(false) }
    var showRaw by remember(data) { mutableStateOf(false) }
    val tests = data?.get("tests") as? JsonObject
    val verified = tests.flag("verified") == true
    val files = remember(data) { data?.let(::reviewFiles) }
    val diff = data.string("diff", "")
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Review results", Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
                IconButton(onClick = onRefresh, enabled = !loading) { Icon(Icons.Outlined.Refresh, "Refresh results") }
            }
            Text("Current project working tree. Changes may include work from other sessions.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 12.dp))
        }
        if (data == null) item { Text(if (loading) "Loading project results…" else "Results are unavailable. Reconnect and refresh.", Modifier.padding(vertical = 12.dp), style = MaterialTheme.typography.bodyMedium) }
        else {
            item {
                Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(if (verified) Icons.Outlined.FactCheck else Icons.Outlined.Info, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Tests · ${if (verified) tests.string("status") else "Not verified"}", style = MaterialTheme.typography.labelLarge)
                        Text(tests.string("reason", "No structured test evidence is available."), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
            if (data.flag("available") != true) item { Text(data.string("reason", "A Git review is unavailable for this project."), Modifier.padding(vertical = 12.dp), style = MaterialTheme.typography.bodyMedium) }
            else {
                item { ReviewSectionTitle("Changed files", files?.files?.size?.toString()) }
                if (files?.files.isNullOrEmpty()) item {
                    Row(Modifier.padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (files?.complete == true) Icons.Outlined.CheckCircle else Icons.Outlined.Info, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(if (files?.complete == true) "No changes in the working tree." else "The file list is incomplete. Refresh to try again.", style = MaterialTheme.typography.bodyMedium)
                    }
                }
                val duplicates = files?.files.orEmpty().groupingBy { it.name }.eachCount()
                items(files?.files.orEmpty()) { file ->
                    ReviewFileRow(file.name, listOfNotNull(file.status,
                        file.directory.takeIf { duplicates[file.name]!! > 1 && it.isNotBlank() },
                        file.previousPath?.let { "From ${reviewDisplayPath(it)}" }).joinToString(" · "), fullName = file.path)
                }
                item {
                    if (data.flag("truncated") == true) Text("Review output is truncated. Inspect the full working tree on your laptop.", Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (files?.complete == false) Text(data.string("statusError", "Review output is incomplete. Inspect the full working tree on your laptop."), Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                    if (diff.isNotBlank()) {
                        TextButton(onClick = { showDiff = !showDiff }, modifier = Modifier.semantics { stateDescription = if (showDiff) "Expanded" else "Collapsed" }) { Text(if (showDiff) "Hide diff" else "Show diff") }
                        if (showDiff) {
                            CopyTextButton(diff, "Copy diff")
                            SelectionContainer { Text(diff, Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 8.dp), fontFamily = FontFamily.Monospace, fontSize = 13.sp, softWrap = false) }
                        }
                    }
                    if (files?.complete == false && data.string("status", "").isNotBlank()) {
                        TextButton(onClick = { showRaw = !showRaw }) { Text(if (showRaw) "Hide status details" else "Show status details") }
                        if (showRaw) SelectionContainer { Text(data.string("status", ""), Modifier.horizontalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, fontSize = 13.sp, softWrap = false) }
                    }
                }
            }
            val artifacts = data.objects("artifacts")
            val duplicateArtifacts = artifacts.groupingBy { it.string("name").substringAfterLast('/') }.eachCount()
            item { ReviewSectionTitle("Files to open", artifacts.size.toString()) }
            if (artifacts.isEmpty()) item { Text("No downloadable files are available.", Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(artifacts, key = { it.string("id") }) { file ->
                val name = file.string("name")
                val detail = listOfNotNull(bytes(file.number("size")), name.substringBeforeLast('/', "").takeIf { duplicateArtifacts[name.substringAfterLast('/')]!! > 1 && it.isNotBlank() }).joinToString(" · ")
                ReviewFileRow(name.substringAfterLast('/'), detail, fullName = name,
                    onClick = { onArtifact(file.string("id")) },
                    onSave = { onSave(file.string("id"), name) })
            }
        }
    }
}

@Composable private fun ReviewSectionTitle(title: String, count: String?) {
    Row(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleSmall)
        count?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable private fun ReviewFileRow(name: String, detail: String, fullName: String = name, onClick: (() -> Unit)? = null, onSave: (() -> Unit)? = null) {
    val content: @Composable () -> Unit = {
        Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Outlined.InsertDriveFile, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(reviewDisplayPath(name), Modifier.semantics { contentDescription = reviewDisplayPath(fullName) }, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (onSave != null) IconButton(onClick = onSave) { Icon(Icons.Outlined.Save, "Save $name to device") }
            if (onClick != null) Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (onClick == null && onSave == null) Surface(color = MaterialTheme.colorScheme.background, content = content)
    else Surface(onClick = onClick ?: onSave ?: {}, shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerLow, content = content)
}
