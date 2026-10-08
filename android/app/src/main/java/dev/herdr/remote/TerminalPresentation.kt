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
    if (kind == "claude") cropClaudeInputBox(lines)?.let { return it }
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

private val inputRule = Regex("^\\s*[─━▔]{8,}\\s*$")
private val effortRow = Regex("^\\s*\\S\\s+\\w+\\s+·\\s+/effort\\s*$")

/** Claude draws its input as a ruled box (rule, prompt rows, rule) followed by the user's status line and mode hints.
 * The box and everything under it are chrome; a prompt row that is a numbered choice is a live dialog, so it stays.
 */
private fun cropClaudeInputBox(lines: List<String>): ConversationTerminalText? {
    val last = lines.indexOfLast { it.isNotBlank() }
    for (bottom in last downTo maxOf(0, last - 9)) {
        if (!inputRule.matches(lines[bottom])) continue
        val top = (bottom - 1 downTo maxOf(0, bottom - 12)).firstOrNull { inputRule.matches(lines[it]) } ?: continue
        val box = lines.subList(top + 1, bottom).filter { it.isNotBlank() }
        val prompt = box.firstOrNull()?.trimStart() ?: continue
        if (!prompt.startsWith('❯') || Regex("^\\d+[.)]\\s").containsMatchIn(prompt.drop(1).trimStart())) continue
        if (lines.subList(bottom + 1, last + 1).any { it.trimStart().startsWith('❯') }) continue
        if (lines.take(top).count { it.trimStart().startsWith("```") } % 2 != 0) continue
        var end = top
        while (end > 0 && lines[end - 1].isBlank()) end--
        if (end > 0 && effortRow.matches(lines[end - 1])) end--
        return ConversationTerminalText(lines.take(end).joinToString("\n").trimEnd(), true)
    }
    return null
}

private val boxDrawing = '\u2500'..'\u257f'
private val tableStart = setOf('┌', '├', '└', '│', '╭', '╰', '╞', '╟', '╠', '╔', '╚', '║')
private val rulesOnly = Regex("^(\\s*)[─━═▔]{9,}\\s*$")

/** Glyphs from Claude's UI that Android's default fonts draw as empty boxes get a close, widely available stand-in. */
private fun Char.readableGlyph(): Char = when (this) {
    '⏵' -> '▶'; '⏴' -> '◀'; '⏶' -> '▲'; '⏷' -> '▼'; '⏸' -> '‖'; '⏹' -> '■'; '⏺' -> '●'; '⎿' -> '└'
    else -> this
}

/** Display-only clean-up for terminal text: stand-in glyphs always, and over-wide rule lines only in readable mode. */
internal fun readableTerminalText(text: String, collapseRules: Boolean): String {
    if (text.none { it == ' ' || it in boxDrawing || it in '\u2300'..'\u23ff' }) return text
    // Terminals pad lines with spaces to their width; wrapped on a phone those spaces split short lines mid-word.
    val lines = text.split('\n').map { line ->
        val trimmed = line.trimEnd()
        if (collapseRules) rulesOnly.matchEntire(trimmed)?.let { it.groupValues[1] + "─".repeat(24) } ?: trimmed else trimmed
    }
    return lines.joinToString("\n").map { it.readableGlyph() }.joinToString("")
}

/** Character ranges (end inclusive) of two or more consecutive lines drawn with box characters, such as tables. */
internal fun boxTableRanges(text: String): List<IntRange> {
    if (text.none { it in boxDrawing }) return emptyList()
    val result = mutableListOf<IntRange>()
    var offset = 0
    var start = -1
    var count = 0
    var end = 0
    for (line in text.split('\n')) {
        val boxLine = line.trimStart().firstOrNull() in tableStart
        if (boxLine) { if (count == 0) start = offset; count++; end = offset + line.length - 1 }
        else { if (count >= 2) result += start..end; count = 0 }
        offset += line.length + 1
    }
    if (count >= 2) result += start..end
    return result
}
