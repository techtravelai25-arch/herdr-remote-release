package dev.herdr.remote

/** A visible transcript unit that can own a search match and a scroll target. */
internal data class TranscriptSearchSegment(
    val blockIndex: Int,
    val segmentIndex: Int,
    val kind: String,
    val text: String
)

internal data class TranscriptSearchMatch(
    val blockIndex: Int,
    val segmentIndex: Int,
    val start: Int,
    val end: Int
)

/**
 * Projects terminal blocks onto the text actually rendered by RichTranscript.
 * Markdown markers are removed for prose; code, user messages, and tool output
 * retain their visible raw text.
 */
internal fun transcriptSearchSegments(blocks: List<TerminalBlock>): List<TranscriptSearchSegment> = buildList {
    blocks.forEachIndexed { blockIndex, block ->
        val source = block.text.trim()
        if (source.isBlank()) return@forEachIndexed
        if (block.isUser || block.isActivity) {
            add(TranscriptSearchSegment(blockIndex, 0, if (block.isUser) "user" else "activity", source))
        } else {
            markdownBlocks(source).forEachIndexed { segmentIndex, markdownBlock ->
                val visible = if (markdownBlock.kind == "code") markdownBlock.text
                else markdownSpans(markdownBlock.text).joinToString(separator = "") { it.text }
                if (visible.isNotBlank()) add(TranscriptSearchSegment(blockIndex, segmentIndex, markdownBlock.kind, visible))
            }
        }
    }
}

internal fun searchTextRanges(text: String, query: String): List<IntRange> {
    if (query.isBlank()) return emptyList()
    return buildList {
        var cursor = 0
        while (cursor < text.length) {
            val start = text.indexOf(query, cursor, ignoreCase = true)
            if (start < 0) break
            add(start until (start + query.length))
            cursor = start + query.length
        }
    }
}

internal fun transcriptSearchMatches(
    blocks: List<TerminalBlock>,
    query: String
): List<TranscriptSearchMatch> {
    if (query.isBlank()) return emptyList()
    val segments = transcriptSearchSegments(blocks)
    return buildList {
        segments.forEach { segment ->
            searchTextRanges(segment.text, query).forEach { range ->
                add(TranscriptSearchMatch(segment.blockIndex, segment.segmentIndex, range.first, range.last + 1))
            }
        }
    }
}

internal fun clampTranscriptSearchIndex(index: Int, occurrenceCount: Int): Int =
    if (occurrenceCount == 0) 0 else index.coerceIn(0, occurrenceCount - 1)
