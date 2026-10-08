package dev.herdr.remote

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.runtime.remember
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable

@Serializable data class CodexModelMenu(
    val id: String,
    val title: String,
    val options: List<String>,
    val selectedIndex: Int = 0,
    val stage: String = "model",
    val provider: String = "codex",
    val mode: String = "options",
    val ansi: String? = null,
    val text: String? = null,
    val note: String? = null,
) {
    fun isValid(): Boolean = id.isNotBlank() && title.isNotBlank() && provider in setOf("codex", "claude", "opencode") &&
        stage in setOf("model", "reasoning", "confirm") && when (mode) {
            "terminal" -> provider == "opencode" && !ansi.orEmpty().ifBlank { text.orEmpty() }.isBlank()
            "options" -> options.isNotEmpty() && options.size <= 50 && options.all { it.isNotBlank() } && selectedIndex in options.indices
            else -> false
        }
}

internal fun supportsModelSelection(snapshot: Snapshot, pane: Pane?): Boolean =
    pane != null && pane.kind in setOf("codex", "claude", "opencode") &&
        ((snapshot.agentModelSelectionEnabled && pane.kind in snapshot.modelSelectionAgents) ||
            (pane.kind == "codex" && snapshot.codexModelSelectionEnabled))

internal fun canChangeAgentModel(state: RemoteState, pane: Pane?): Boolean =
    pane != null && state.selectedId == pane.id && supportsModelSelection(state.snapshot, pane) &&
        pane.status != "working" && (pane.status in setOf("idle", "done") || state.agentModelMenu != null) && !state.busy && state.online &&
        state.snapshot.herdrOnline && !state.snapshot.stale && state.snapshot.canControl &&
        state.outputReady && state.terminalAttachmentId != null && state.question == null &&
        !state.questionReviewAvailable && !state.questionPending

internal fun modelUnavailableMessage(state: RemoteState, pane: Pane?): String = when {
    pane?.status == "working" -> "Wait until the current response finishes, then change the model."
    pane?.status in setOf("blocked", "needs_input", "needs-input") || state.question != null || state.questionReviewAvailable || state.questionPending ->
        "Answer the agent's question before changing the model."
    pane?.status in setOf("starting", "unknown") -> "Wait until the agent is ready, then change the model."
    !state.online || !state.snapshot.herdrOnline || state.snapshot.stale ->
        "Reconnect to the laptop before changing the model."
    !state.snapshot.canControl || !state.snapshot.terminalInputEnabled ->
        "Model changes need terminal control access."
    !state.outputReady || state.terminalAttachmentId == null ->
        "Wait for a fresh pane attachment before changing the model."
    state.busy -> "Wait for the current action to finish before changing the model."
    else -> "Model controls are temporarily unavailable."
}

/** Claude pads each model name and its description with a run of spaces; show them as a title and a quieter second line. */
internal fun modelOptionParts(provider: String, option: String): Pair<String, String?> {
    if (provider != "claude") return option to null
    val parts = option.trim().split(Regex("\\s{2,}"), limit = 2)
    return if (parts.size == 2 && parts[1].isNotBlank()) parts[0] to parts[1] else option.trim() to null
}

/** The native CLI owns the available models and the next step; nothing is hard-coded here. */
@Composable internal fun CodexModelDialog(menu: CodexModelMenu, enabled: Boolean, busy: Boolean,
    onSelect: (Int) -> Unit, onCancel: () -> Unit, onDismiss: () -> Unit, onKey: (String) -> Unit = {}) {
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(when (menu.stage) { "reasoning" -> "Reasoning effort"; "confirm" -> "Confirm model change"; else -> "Change model" }) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(menu.title, style = MaterialTheme.typography.bodyMedium)
                menu.note?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!enabled && !busy) Text("Model controls are temporarily unavailable.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (menu.mode == "terminal") {
                    val styled = remember(menu.ansi, menu.text) { modelMenuAnsi(menu.ansi?.takeIf { it.isNotBlank() } ?: menu.text.orEmpty()) }
                    Text(styled, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                        softWrap = false, modifier = Modifier.fillMaxWidth().heightIn(max = 280.dp)
                            .background(Color(0xFF0C131C)).verticalScroll(rememberScrollState())
                            .horizontalScroll(rememberScrollState()).padding(8.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        TextButton(enabled = enabled && !menu.ansi.isNullOrBlank(), onClick = { onKey("up") }) { Text("Up") }
                        TextButton(enabled = enabled && !menu.ansi.isNullOrBlank(), onClick = { onKey("down") }) { Text("Down") }
                        TextButton(enabled = enabled && !menu.ansi.isNullOrBlank(), onClick = { onKey("enter") }) { Text("Select") }
                    }
                }
                if (menu.provider == "opencode" && menu.mode == "options") {
                    Text("OpenCode shows nearby choices. Browse to see more models.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        TextButton(enabled = enabled, onClick = { onKey("up") }) { Text("Earlier models") }
                        TextButton(enabled = enabled, onClick = { onKey("down") }) { Text("More models") }
                    }
                }
                menu.options.forEachIndexed { index, option ->
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        .selectable(selected = menu.selectedIndex == index, enabled = enabled,
                            role = Role.RadioButton, onClick = { onSelect(index) }).padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        RadioButton(selected = menu.selectedIndex == index, onClick = null, enabled = enabled)
                        val (name, detail) = modelOptionParts(menu.provider, option)
                        Column(Modifier.weight(1f)) {
                            Text(name, style = MaterialTheme.typography.bodyMedium)
                            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                    }
                }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(enabled = !busy, onClick = onCancel) { Text("Cancel selection") } })
}
