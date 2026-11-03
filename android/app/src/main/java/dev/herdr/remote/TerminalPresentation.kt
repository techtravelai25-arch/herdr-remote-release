package dev.herdr.remote

/** Compatibility data for archived display code. Live terminal text is shown as one block. */
data class TerminalPresentation(val metadata: String?, val blocks: List<TerminalBlock>)
data class TerminalBlock(val text: String, val isUser: Boolean, val isActivity: Boolean = false)

fun terminalPresentation(text: String, kind: String): TerminalPresentation =
    TerminalPresentation(null, if (text.isEmpty()) emptyList() else listOf(TerminalBlock(text, false)))


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
