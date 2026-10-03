package dev.herdr.remote

/** Compatibility data for archived display code. Live terminal text is shown as one block. */
data class TerminalPresentation(val metadata: String?, val blocks: List<TerminalBlock>, val question: TerminalQuestion? = null)
data class TerminalBlock(val text: String, val isUser: Boolean, val isActivity: Boolean = false)
data class TerminalQuestion(val prompt: String, val options: List<String>, val selectedOption: Int? = null, val submitHint: String? = null, val freeText: Boolean = false)

fun terminalPresentation(text: String, kind: String): TerminalPresentation =
    TerminalPresentation(null, if (text.isEmpty()) emptyList() else listOf(TerminalBlock(text, false)))

/** A conservative, display-only crop of an agent's trailing idle input area.
 * The full snapshot remains available; this result must never drive input or status.
 */
internal data class ConversationTerminalText(val text: String, val footerHidden: Boolean)

internal fun conversationTerminalText(text: String, kind: String, status: String): ConversationTerminalText {
    if (kind == "terminal" || status !in setOf("idle", "done", "working") || text.isBlank() || '\u001b' in text)
        return ConversationTerminalText(text, false)
    val lines = text.split('\n')
    val last = lines.indexOfLast { it.isNotBlank() }
    if (last < 3) return ConversationTerminalText(text, false)
    val firstCandidate = maxOf(0, last - 7)
    for (prompt in last downTo firstCandidate) {
        // Match a terminal input cursor at the start of a trailing block, not its wording.
        val cursorLine = lines[prompt].trimStart()
        if ((!cursorLine.startsWith('›') && !cursorLine.startsWith('❯')) || cursorLine.drop(1).isBlank()) continue
        val suffix = lines.subList(prompt + 1, last + 1).filter { it.isNotBlank() }
        // Herdr may label a trust/selection prompt idle. Its numbered choices are content,
        // even when the selection cursor and keyboard hints resemble an idle input footer.
        if (Regex("^\\d+[.)]\\s").containsMatchIn(cursorLine.drop(1).trimStart()) ||
            suffix.any { Regex("^\\d+[.)]\\s").containsMatchIn(it.trimStart()) }) continue
        if (suffix.size !in 1..3 || suffix.any { !it.startsWith("  ") && !it.isBrailleDecoration() }) continue
        var start = prompt
        while (start > 0 && lines[start - 1].isBrailleDecoration()) start--
        if (start == 0 || lines[start - 1].isNotBlank() || lines.subList(0, start - 1).none { it.isNotBlank() }) continue
        // A quoted prompt inside a fenced code example is content, not terminal chrome.
        if (lines.take(start).count { it.trimStart().startsWith("```") } % 2 != 0) continue
        return ConversationTerminalText(lines.take(start - 1).joinToString("\n").trimEnd(), true)
    }
    return ConversationTerminalText(text, false)
}

private fun String.isBrailleDecoration(): Boolean = isNotBlank() && all { it.isWhitespace() || it in '\u2800'..'\u28ff' }
