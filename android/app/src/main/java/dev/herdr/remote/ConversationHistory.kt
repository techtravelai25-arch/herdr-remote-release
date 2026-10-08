package dev.herdr.remote

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable

@Serializable data class HistoryMessage(val id: String, val role: String, val text: String, val timestamp: String? = null, val toolName: String? = null)
@Serializable data class StructuredHistory(val messages: List<HistoryMessage> = emptyList(), val source: String = "terminal", val available: Boolean = false, val hasMore: Boolean = false, val nextCursor: String? = null, val reason: String? = null, val revision: String? = null, val unchanged: Boolean = false)
@Serializable data class ActivityEvent(val id: String, val paneId: String, val title: String, val kind: String, val status: String, val previousStatus: String? = null, val timestamp: String)
@Serializable data class ActivityTimeline(val events: List<ActivityEvent> = emptyList(), val startedAt: String? = null)

internal fun prependHistory(older: StructuredHistory, current: StructuredHistory?): StructuredHistory =
    older.copy(messages = (older.messages + current?.messages.orEmpty()).distinctBy { it.id },
        revision = current?.revision ?: older.revision)

/**
 * Fold the newest page into what is already loaded. Message ids are stable per transcript record, so
 * earlier pages stay in place when the newest page overlaps them; otherwise the older pages no longer
 * join up and the newest page stands alone.
 */
internal fun mergeLatestHistory(current: StructuredHistory?, latest: StructuredHistory): StructuredHistory {
    if (current == null || !current.available || !latest.available || current.source != latest.source) return latest
    val first = latest.messages.firstOrNull() ?: return latest
    val overlap = current.messages.indexOfFirst { it.id == first.id }
    if (overlap < 0) return latest
    return latest.copy(messages = current.messages.take(overlap) + latest.messages,
        hasMore = current.hasMore, nextCursor = current.nextCursor)
}

internal fun conversationTranscriptBlocks(history: StructuredHistory?, liveBlocks: List<TerminalBlock>, sentPrompts: List<String> = emptyList()): List<TerminalBlock> {
    val saved = history?.takeIf { it.available && it.messages.isNotEmpty() }?.messages
        ?.filter { it.role == "user" || it.role == "assistant" }
        ?.map { TerminalBlock(it.text, it.role == "user") }.orEmpty()
    fun normalize(value: String) = value.trim().replace(Regex("\\s+"), " ")
    val missing = sentPrompts.filter { prompt ->
        (saved + liveBlocks).none { it.isUser && (normalize(it.text) == normalize(prompt) || it.text.trim().startsWith(prompt.trim() + "\n")) }
    }.map { TerminalBlock(it, true) }
    // The terminal can omit the echoed prompt as its viewport moves. Without
    // an in-band marker its exact position is unknown, so keep the fallback
    // beside the latest output instead of placing it above older messages.
    return saved + liveBlocks + missing
}

@Composable fun ConversationHistory(history: StructuredHistory?, loading: Boolean, error: String?, online: Boolean, onRefresh: () -> Unit, onEarlier: () -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Conversation history", style = MaterialTheme.typography.titleLarge)
            Text(if (history?.available == true) "Read from ${kindLabel(history.source)} on your laptop. Use Terminal for live output and controls." else "Messages saved by the agent on your laptop.", style = MaterialTheme.typography.bodyMedium)
            if (!online) Text("Offline · showing the last loaded history", color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onRefresh, enabled = online && !loading) { Text("Refresh history") }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
        if (history?.hasMore == true) item { OutlinedButton(onClick = onEarlier, enabled = online && !loading, modifier = Modifier.fillMaxWidth()) { Text("Load earlier messages") } }
        if (!loading && history?.available != true && error == null) item {
            Text(history?.reason ?: "History is not available for this session. Live output remains in Terminal.")
        }
        if (!loading && history?.available == true && history.messages.isEmpty()) item { Text("No saved messages yet. Refresh after the agent writes its first turn.") }
        items(history?.messages.orEmpty(), key = { it.id }) { message ->
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(when (message.role) { "user" -> "You"; "assistant" -> kindLabel(history?.source.orEmpty()); "tool" -> message.toolName ?: "Tool"; else -> "Session" },
                    style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                message.timestamp?.let { Text(activityLabel(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                Surface(color = if (message.role == "user") MaterialTheme.colorScheme.surfaceContainer else MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.medium) {
                    SelectionContainer(Modifier.fillMaxWidth().padding(12.dp)) { RichTranscript(message.text, 15f, true, "", null, null, {}) }
                }
            }
        }
    }
}

@Composable fun ActivityScreen(timeline: ActivityTimeline?, loading: Boolean, error: String?, online: Boolean, livePaneIds: Set<String>, onRefresh: () -> Unit, onPane: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Laptop activity", style = MaterialTheme.typography.titleLarge)
            Text("Status changes observed by your laptop bridge. A completed status does not verify the work.", style = MaterialTheme.typography.bodyMedium)
            timeline?.startedAt?.let { Text("Observed since ${activityLabel(it)}", style = MaterialTheme.typography.labelMedium) }
            if (!online) Text("Offline · last loaded activity", color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onRefresh, enabled = online && !loading) { Text("Refresh activity") }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
        if (!loading && timeline?.events.isNullOrEmpty() && error == null) item { Text("No activity recorded yet. New status changes will appear here.") }
        items(timeline?.events.orEmpty(), key = { it.id }) { event ->
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(activityLabel(event.timestamp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(event.title, style = MaterialTheme.typography.titleMedium)
                Text(event.previousStatus?.let { "${it.replace('_', ' ')} → ${event.status.replace('_', ' ')}" } ?: event.status.replace('_', ' '), style = MaterialTheme.typography.bodyMedium)
                if (event.paneId in livePaneIds) TextButton(onClick = { onPane(event.paneId) }) { Text("Open conversation") }
                HorizontalDivider()
            }
        }
    }
}
