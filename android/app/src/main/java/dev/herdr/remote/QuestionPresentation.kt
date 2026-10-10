package dev.herdr.remote

/** Only a complete live bridge question is actionable, never terminal/history guesses. */
internal fun BridgeQuestion.isValid(): Boolean {
    if (!id.matches(Regex("[a-f0-9]{64}")) || prompt.isBlank() || prompt.length > 16000 ||
        prompt.any { it.code < 0x20 && it != '\n' && it != '\t' }) return false
    if (kind !in listOf(null, "claude_trust")) return false
    if (kind == "claude_trust" && (stage != "choices" || options.size != 2 || freeText ||
            options != listOf("No, exit", "Yes, I trust this folder") || multiSelect ||
            selectedOptions.isNotEmpty() || cancelAvailable || !hasCompleteClaudeTrustWarning(prompt))) return false
    return when (stage) {
        "choices", "multi", "review" -> options.size in 1..33 && options.all { it.isNotBlank() && it.length <= 4000 &&
            it.none { char -> char.code < 0x20 && char != '\n' && char != '\t' } } &&
            selectedIndex in options.indices && (multiSelect == (stage == "multi")) &&
            selectedOptions.distinct().size == selectedOptions.size && selectedOptions.all { it in options.indices } &&
            (multiSelect || selectedOptions.isEmpty())
        "text" -> freeText && options.isEmpty() && selectedIndex == null && selectedOptions.isEmpty()
        else -> false
    }
}

/** Keep a malformed or partial startup warning in the live terminal fallback. */
private fun hasCompleteClaudeTrustWarning(prompt: String): Boolean {
    if (!Regex("^Accessing workspace:\\n/[^\\n]+\\n\\nQuick safety check:").containsMatchIn(prompt)) return false
    val normalized = prompt.replace(Regex("\\s+"), " ").trim()
    return normalized.contains("Quick safety check: Is this a project you created or one you trust? " +
        "(Like your own code, a well-known open source project, or work from your team). " +
        "If not, take a moment to review what's in this folder first.") &&
        normalized.contains("Claude Code'll be able to read, edit, and execute files here.") &&
        normalized.endsWith("Security guide")
}

internal fun validQuestionAnswer(text: String): Boolean = text.trim().length in 1..500 &&
    text.none { it.code < 0x20 || it.code in 0x7f..0x9f }

/** The action owns the busy flag and receipt; this is its fresh pane preflight. */
internal fun questionPaneReady(state: RemoteState, paneId: String): Boolean =
    state.selectedId == paneId && state.online && state.snapshot.herdrOnline && !state.snapshot.stale &&
        state.snapshot.canControl && state.snapshot.terminalInputEnabled && state.snapshot.questionSelectionEnabled &&
        state.outputReady && state.terminalAttachmentId != null &&
        state.snapshot.panes.any { it.id == paneId && it.kind in setOf("codex", "claude") } &&
        state.agentModelMenu == null && !state.modelMenuPending && !state.questionPending
