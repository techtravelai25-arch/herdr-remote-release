package dev.herdr.remote

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** One row of the conversation: what you wrote, what the agent answered, or the tool steps in between. */
internal sealed interface TranscriptItem {
    val key: String
    data class Turn(override val key: String, val fromUser: Boolean, val text: String, val timestamp: String?) : TranscriptItem
    data class Steps(override val key: String, val steps: List<HistoryMessage>) : TranscriptItem
    data class Notice(override val key: String, val text: String) : TranscriptItem
}

private const val PENDING_PROMPT_WINDOW_MS = 90_000L

private fun normalizedText(value: String) = value.trim().replace(Regex("\\s+"), " ")

/**
 * Structured messages become turns; runs of tool activity collapse into one step group. A prompt that was just
 * sent from this phone is shown at once, and disappears as soon as the saved transcript contains it.
 */
internal fun transcriptItems(history: StructuredHistory, sentPrompts: List<String> = emptyList(), sentAtMs: Long? = null,
                             nowMs: Long = System.currentTimeMillis()): List<TranscriptItem> {
    val items = mutableListOf<TranscriptItem>()
    var steps = mutableListOf<HistoryMessage>()
    fun flushSteps() {
        if (steps.isNotEmpty()) items += TranscriptItem.Steps("steps:${steps.first().id}", steps.toList())
        steps = mutableListOf()
    }
    for (message in history.messages) {
        when (message.role) {
            "tool" -> steps += message
            "user", "assistant" -> { flushSteps(); items += TranscriptItem.Turn(message.id, message.role == "user", message.text, message.timestamp) }
            else -> { flushSteps(); items += TranscriptItem.Notice(message.id, message.text) }
        }
    }
    flushSteps()
    if (sentAtMs != null && nowMs - sentAtMs in 0..PENDING_PROMPT_WINDOW_MS) {
        val recentUser = history.messages.filter { it.role == "user" }.takeLast(30).map { normalizedText(it.text) }
        // lastPromptAt belongs only to the newest send. Reusing it for older
        // unsaved prompts would make an expired prompt appear again after a new send.
        sentPrompts.takeLast(1).filter { prompt -> prompt.isNotBlank() && normalizedText(prompt) !in recentUser }.forEachIndexed { index, prompt ->
            items += TranscriptItem.Turn("pending:$index:${prompt.hashCode()}", true, prompt, null)
        }
    }
    return items
}

private fun stepSummary(steps: List<HistoryMessage>): String {
    val calls = steps.filter { it.toolName != null }
    // "mcp__server__tool" reads best as just "tool".
    val names = calls.map { it.toolName!!.substringAfterLast("__") }.distinct()
    val count = calls.size.takeIf { it > 0 } ?: steps.size
    val noun = if (count == 1) "tool step" else "tool steps"
    return if (names.isEmpty()) "$count $noun" else "$count $noun · ${names.take(2).joinToString(", ")}${if (names.size > 2) ", …" else ""}"
}

@Composable internal fun ConversationTranscript(
    history: StructuredHistory,
    agentLabel: String,
    working: Boolean,
    sentPrompts: List<String>,
    sentAtMs: Long?,
    fontSize: Float,
    loadingEarlier: Boolean,
    onEarlier: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var pendingExpired by remember(sentAtMs) { mutableStateOf(false) }
    LaunchedEffect(sentAtMs) {
        val sentAt = sentAtMs ?: return@LaunchedEffect
        val remaining = (PENDING_PROMPT_WINDOW_MS - (System.currentTimeMillis() - sentAt) + 1)
            .coerceAtLeast(0L)
        delay(remaining)
        pendingExpired = true
    }
    val items = remember(history, sentPrompts, sentAtMs, pendingExpired) {
        val now = if (pendingExpired && sentAtMs != null)
            maxOf(System.currentTimeMillis(), sentAtMs + PENDING_PROMPT_WINDOW_MS + 1)
        else System.currentTimeMillis()
        transcriptItems(history, sentPrompts, sentAtMs, now)
    }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val atBottom by remember { derivedStateOf { !listState.canScrollForward } }
    val rows = items.size + if (working) 1 else 0
    val lastKey = items.lastOrNull()?.key
    var placed by remember { mutableStateOf(false) }
    var behind by remember { mutableStateOf(false) }
    // Composition runs before the new row is laid out, so atBottom still describes what the reader was looking at.
    suspend fun scrollToEnd() {
        listState.scrollToItem(rows - 1 + if (history.hasMore) 1 else 0)
        // The newest reply can be taller than the viewport; its end, not its first line, is the latest content.
        listState.scrollBy(1_000_000f)
    }
    LaunchedEffect(lastKey, working) {
        if (rows == 0) return@LaunchedEffect
        if (!placed || atBottom) { scrollToEnd(); placed = true; behind = false }
        else behind = true
    }
    LaunchedEffect(atBottom) { if (atBottom) behind = false }
    Box(modifier) {
        LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (history.hasMore) item(key = "earlier") {
                OutlinedButton(onClick = onEarlier, enabled = !loadingEarlier, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(if (loadingEarlier) "Loading…" else "Load earlier messages")
                }
            }
            items(items, key = { it.key }) { item ->
                when (item) {
                    is TranscriptItem.Turn -> if (item.fromUser) UserTurn(item, fontSize) else AgentTurn(item, agentLabel, fontSize)
                    is TranscriptItem.Steps -> StepGroup(item)
                    is TranscriptItem.Notice -> Text(item.text, Modifier.fillMaxWidth(), style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
            if (working) item(key = "working") {
                Row(Modifier.fillMaxWidth().padding(start = 4.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text("$agentLabel is working…", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        if (!atBottom && rows > 0) FilledTonalButton(
            onClick = { scope.launch { listState.scrollToItem(rows - 1 + if (history.hasMore) 1 else 0); listState.scrollBy(1_000_000f) } },
            modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp)) {
            Text(if (behind) "New messages ↓" else "Latest ↓")
        }
    }
}

@Composable private fun UserTurn(turn: TranscriptItem.Turn, fontSize: Float) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(listOfNotNull("You", turn.timestamp?.let(::activityLabel)).joinToString(" · "),
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(color = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
            shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 4.dp),
            modifier = Modifier.fillMaxWidth(0.88f)) {
            SelectionContainer(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                Text(turn.text, fontSize = fontSize.sp, lineHeight = (fontSize * 1.4f).sp)
            }
        }
    }
}

@Composable private fun AgentTurn(turn: TranscriptItem.Turn, agentLabel: String, fontSize: Float) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(listOfNotNull(agentLabel, turn.timestamp?.let(::activityLabel)).joinToString(" · "),
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(topStart = 4.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 16.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), modifier = Modifier.fillMaxWidth()) {
            SelectionContainer(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                RichTranscript(turn.text, fontSize, true)
            }
        }
    }
}

@Composable private fun StepGroup(group: TranscriptItem.Steps) {
    var open by rememberSaveable(group.key) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(start = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.clickable { open = !open }.heightIn(min = 36.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (open) "▾ " else "▸ ", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(stepSummary(group.steps), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (open) group.steps.forEach { step ->
            val call = step.toolName != null
            Text(if (call) "${step.toolName!!.substringAfterLast("__")}  ${step.text}" else step.text,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
                fontWeight = if (call) FontWeight.SemiBold else FontWeight.Normal,
                color = if (call) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = if (call) 3 else 4, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 14.dp))
        }
    }
}
