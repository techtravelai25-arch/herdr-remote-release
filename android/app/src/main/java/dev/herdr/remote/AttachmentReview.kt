package dev.herdr.remote

import android.content.ContentResolver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException

internal data class AttachmentPreview(val name: String, val size: Long?, val mime: String?, val excerpt: String?, val readable: Boolean)
internal fun isInertTextPreview(mime: String?): Boolean =
    mime == "text/plain" || mime == "text/markdown" || mime == "application/json"

/** Reads at most 2 KiB. Never renders HTML, SVG, or another active document as content. */
internal suspend fun previewAttachment(resolver: ContentResolver, file: DraftAttachment): AttachmentPreview = withContext(Dispatchers.IO) {
    val mime = try { resolver.getType(file.uri) }
        catch (error: Exception) { if (error is CancellationException) throw error; null }
    val safeText = isInertTextPreview(mime)
    val preview = try {
        resolver.openInputStream(file.uri)?.use { input ->
            if (!safeText) return@use true to null
            val bytes = ByteArray(2049)
            val count = input.read(bytes)
            val excerpt = if (count <= 0) "(empty file)" else if (bytes.take(count).any { it == 0.toByte() }) null
                else bytes.copyOfRange(0, minOf(count, 2048)).toString(Charsets.UTF_8) + if (count > 2048) "\n… preview limited to 2 KiB" else ""
            true to excerpt
        }
    } catch (error: Exception) { if (error is CancellationException) throw error; null }
    AttachmentPreview(file.name, file.size, mime, preview?.second, preview != null)
}

@androidx.compose.runtime.Composable
internal fun AttachmentReviewDialog(
    files: List<DraftAttachment>,
    laptop: String,
    pane: String,
    resolver: ContentResolver,
    enabled: Boolean,
    onDismiss: () -> Unit,
    onSend: () -> Unit,
) {
    var previews by androidx.compose.runtime.remember(files) { androidx.compose.runtime.mutableStateOf<List<AttachmentPreview>?>(null) }
    androidx.compose.runtime.LaunchedEffect(files) {
        previews = files.map { previewAttachment(resolver, it) }
    }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { androidx.compose.material3.Text("Review files before sharing") },
        text = {
            androidx.compose.foundation.layout.Column(
                modifier = androidx.compose.ui.Modifier.heightIn(max = 460.dp)
                    .verticalScroll(androidx.compose.foundation.rememberScrollState()),
                verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp),
            ) {
                androidx.compose.material3.Text("To $laptop · $pane", style = androidx.compose.material3.MaterialTheme.typography.labelMedium)
                androidx.compose.material3.Text("These files will be uploaded to your laptop and shared with the agent when you send. Files can contain secrets even when the names look harmless.", style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                previews?.forEach { preview ->
                    androidx.compose.material3.HorizontalDivider()
                    androidx.compose.material3.Text(preview.name, style = androidx.compose.material3.MaterialTheme.typography.titleSmall)
                    androidx.compose.material3.Text("${preview.mime ?: "Unknown type"} · ${preview.size?.let { "$it bytes" } ?: "Unknown size"}", style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                    androidx.compose.material3.Text(when {
                        !preview.readable -> "Cannot read this file. Remove it and select it again."
                        preview.excerpt != null -> preview.excerpt
                        else -> "Content preview unavailable for this file type. Open the original file to inspect it before sending."
                    }, style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                        color = if (preview.readable) androidx.compose.material3.MaterialTheme.colorScheme.onSurface else androidx.compose.material3.MaterialTheme.colorScheme.error)
                }
                if (previews == null) androidx.compose.material3.CircularProgressIndicator()
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(enabled = enabled && previews?.all { it.readable } == true, onClick = onSend) { androidx.compose.material3.Text("Share and send") } },
        dismissButton = { androidx.compose.material3.TextButton(onClick = onDismiss) { androidx.compose.material3.Text("Cancel") } },
    )
}
