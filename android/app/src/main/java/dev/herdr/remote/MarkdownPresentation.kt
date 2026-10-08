package dev.herdr.remote

import java.net.URI

/** Small, deliberately non-HTML Markdown subset. Unsupported syntax stays visible. */
data class MarkdownBlock(val text: String, val kind: String = "paragraph", val level: Int = 0, val language: String = "")
data class MarkdownSpan(val text: String, val kind: String = "text", val url: String? = null)

fun safeWebLink(value: String): String? = runCatching {
    val uri = URI(value)
    value.takeIf { uri.scheme?.lowercase() in setOf("https", "http") && !uri.host.isNullOrBlank() && uri.userInfo == null && value.none { it.isISOControl() } }
}.getOrNull()

/** Raw http(s) text inside prose and fenced code becomes tappable only when it is a safe web link. */
val rawUrlPattern = Regex("""https?://[^\s`\[\]'"<>{}\\|]+""")

fun markdownBlocks(text: String): List<MarkdownBlock> {
    val result = mutableListOf<MarkdownBlock>()
    val pending = mutableListOf<String>()
    var fence: String? = null
    var language = ""
    fun flush() {
        if (pending.isNotEmpty()) result += MarkdownBlock(pending.joinToString("\n"), if (fence != null) "code" else "paragraph", language = language)
        pending.clear()
    }
    text.lines().forEach { line ->
        val trimmed = line.trimStart()
        val marker = if (trimmed.startsWith("```")) "```" else if (trimmed.startsWith("~~~")) "~~~" else null
        if (marker != null && fence == null) {
            flush(); fence = marker; language = trimmed.drop(3).trim().take(40)
        } else if (fence != null && trimmed == fence) {
            flush(); fence = null; language = ""
        } else if (fence != null) pending += line
        else {
            val heading = Regex("^(#{1,6}) (.+)$").matchEntire(line)
            if (heading != null) {
                flush(); result += MarkdownBlock(heading.groupValues[2], "heading", heading.groupValues[1].length)
            } else if (line.isBlank()) flush()
            else pending += line
        }
    }
    flush()
    return result
}

/** A single passive safe-link candidate: the raw text goes to the screen unchanged. */
data class UrlSpan(val start: Int, val endExclusive: Int)

/** Index every raw http(s) substring that is a safe web link, so code can render it tappable without altering text. */
fun rawUrlRanges(text: String): List<UrlSpan> =
    rawUrlPattern.findAll(text).mapNotNull { match ->
        var candidate = match.value.trimEnd('.', ',', ';', ':', '!', '?')
        while (candidate.endsWith(')') && candidate.count { it == ')' } > candidate.count { it == '(' }) candidate = candidate.dropLast(1)
        while (candidate.endsWith(']') && candidate.count { it == ']' } > candidate.count { it == '[' }) candidate = candidate.dropLast(1)
        candidate = candidate.trimEnd('.', ',', ';', ':', '!', '?')
        safeWebLink(candidate)?.let { UrlSpan(match.range.first, match.range.first + candidate.length) }
    }.toList()

fun markdownSpans(text: String): List<MarkdownSpan> {
    val pattern = Regex("`([^`\n]+)`|\\*\\*([^*\n]+)\\*\\*|\\[([^]\\n]+)]\\((<[^>\\n]+>|[^)\\s]+)\\)")
    val result = mutableListOf<MarkdownSpan>()
    var end = 0
    pattern.findAll(text).forEach { match ->
        if (match.range.first > end) plainSegmentSpans(text.substring(end, match.range.first)).forEach { result += it }
        result += when {
            match.groupValues[1].isNotEmpty() -> MarkdownSpan(match.groupValues[1], "code")
            match.groupValues[2].isNotEmpty() -> MarkdownSpan(match.groupValues[2], "bold")
            else -> safeTranscriptLink(match.groupValues[4].removePrefix("<").removeSuffix(">"))?.let { MarkdownSpan(match.groupValues[3], "link", it) } ?: MarkdownSpan(match.value)
        }
        end = match.range.last + 1
    }
    if (end < text.length) plainSegmentSpans(text.substring(end)).forEach { result += it }
    return result
}

/** Plain segments also carry raw http(s) text: linked only when `safeWebLink` accepts it. */
internal fun plainSegmentSpans(value: String): List<MarkdownSpan> {
    val result = mutableListOf<MarkdownSpan>()
    var cursor = 0
    transcriptLinkRanges(value).forEach { range ->
        if (range.start > cursor) result += MarkdownSpan(value.substring(cursor, range.start))
        result += MarkdownSpan(value.substring(range.start, range.endExclusive), "link", safeTranscriptLink(value.substring(range.start, range.endExclusive)))
        cursor = range.endExclusive
    }
    if (cursor < value.length) result += MarkdownSpan(value.substring(cursor))
    return result
}
