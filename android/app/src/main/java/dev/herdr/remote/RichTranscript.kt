package dev.herdr.remote

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import kotlinx.coroutines.flow.first
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable internal fun CopyTextButton(text: String, label: String = "Copy") {
    val clipboard = LocalClipboardManager.current
    var copied by remember(text) { mutableStateOf(false) }
    TextButton(onClick = { clipboard.setText(AnnotatedString(text)); copied = true }, modifier = Modifier.heightIn(min = 48.dp)) {
        Icon(Icons.Default.ContentCopy, null, Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(if (copied) "Copied" else label, style = MaterialTheme.typography.labelMedium)
    }
}

/** Compact copy action shares a message header while retaining a 48dp touch target. */
@Composable internal fun CopyTextIconButton(text: String, label: String = "Copy") {
    val clipboard = LocalClipboardManager.current
    var copied by remember(text) { mutableStateOf(false) }
    IconButton(onClick = { clipboard.setText(AnnotatedString(text)); copied = true }, modifier = Modifier.size(48.dp)) {
        Icon(if (copied) Icons.Default.Check else Icons.Default.ContentCopy, if (copied) "Copied" else label, Modifier.size(16.dp))
    }
}

/** Code keeps its exact characters; only safe http(s) substrings gain a browser handoff. */
@Composable private fun SelectableCodeText(
    text: String, fontSize: Float, query: String,
    selectedMatch: TranscriptSearchMatch?, revealRequest: Int?, onRevealed: (Int) -> Unit,
) {
    val openLink = rememberTranscriptLinkOpener()
    val annotated = remember(text, openLink) {
        buildAnnotatedString {
            append(text)
            transcriptLinkRanges(text).forEach { span ->
                val target = text.substring(span.start, span.endExclusive)
                addLink(LinkAnnotation.Url(target) { annotation -> openLink((annotation as LinkAnnotation.Url).url) }, span.start, span.endExclusive)
            }
        }
    }
    SearchableTranscriptText(annotated, query, selectedMatch = selectedMatch, revealRequest = revealRequest, onRevealed = onRevealed,
        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace,
            fontSize = fontSize.sp, lineHeight = (fontSize * 1.35f).sp), softWrap = false)
}

/**
 * Links only safe http(s) substrings; the displayed characters stay identical so
 * transcript search anchors and copy text never shift.
 */
internal fun linkedAnnotated(text: String, context: android.content.Context,
    openLink: (String) -> Unit = { openWebLink(context, it) }): AnnotatedString =
    buildAnnotatedString {
        append(text)
        transcriptLinkRanges(text).forEach { span ->
            val target = text.substring(span.start, span.endExclusive)
            addLink(LinkAnnotation.Url(target) { annotation -> openLink((annotation as LinkAnnotation.Url).url) }, span.start, span.endExclusive)
        }
    }

/** Reveal the selected character range, including inside horizontally scrolling code. */
@OptIn(ExperimentalFoundationApi::class)
@Composable internal fun SearchableTranscriptText(
    text: AnnotatedString,
    query: String,
    modifier: Modifier = Modifier,
    selectedMatch: TranscriptSearchMatch? = null,
    revealRequest: Int? = null,
    onRevealed: (Int) -> Unit = {},
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    softWrap: Boolean = true,
) {
    val colors = MaterialTheme.colorScheme
    val highlighted = remember(text, query, selectedMatch, colors) {
        buildAnnotatedString {
            append(text)
            searchTextRanges(text.text, query).forEach { range ->
                val selected = selectedMatch?.start == range.first
                addStyle(SpanStyle(
                    background = if (selected) colors.tertiary else colors.tertiaryContainer,
                    color = if (selected) colors.onTertiary else colors.onTertiaryContainer
                ), range.first, range.last + 1)
            }
        }
    }
    val requester = remember { BringIntoViewRequester() }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    var placed by remember { mutableStateOf(false) }
    val onRevealedNow by rememberUpdatedState(onRevealed)
    LaunchedEffect(revealRequest, selectedMatch) {
        val request = revealRequest ?: return@LaunchedEffect
        val match = selectedMatch ?: return@LaunchedEffect
        if (match.start !in text.indices) return@LaunchedEffect
        val measured = snapshotFlow { layout?.takeIf { placed && it.layoutInput.text.text == text.text } }
            .first { it != null }!!
        // The character rectangle, rather than its message's top, locates
        // repeated matches deep inside a long paragraph or code block.
        requester.bringIntoView(measured.getBoundingBox(match.start))
        onRevealedNow(request)
    }
    Text(highlighted, modifier = modifier.bringIntoViewRequester(requester)
        .onGloballyPositioned { placed = true }, style = style, softWrap = softWrap,
        onTextLayout = { layout = it })
}

@Composable internal fun RichTranscript(
    text: String, fontSize: Float, wrap: Boolean, query: String = "",
    selectedMatch: TranscriptSearchMatch? = null, revealRequest: Int? = null,
    onRevealed: (Int) -> Unit = {},
) {
    val blocks = remember(text) { markdownBlocks(text) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        blocks.forEachIndexed { index, block ->
            val selected = selectedMatch?.takeIf { it.segmentIndex == index }
            if (block.kind == "code") {
                Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(block.language.ifBlank { "Code" }, Modifier.padding(top = 16.dp), style = MaterialTheme.typography.labelSmall)
                            CopyTextIconButton(block.text, "Copy code")
                        }
                        // Keep the requester inside the horizontal viewport so
                        // BringIntoView can scroll both code and conversation.
                        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 8.dp)) {
                            SelectableCodeText(block.text, fontSize, query, selected, revealRequest, onRevealed)
                        }
                    }
                }
            } else MarkdownParagraph(block, fontSize, wrap, query, selected, revealRequest, onRevealed)
        }
    }
}

@Composable private fun MarkdownParagraph(
    block: MarkdownBlock, fontSize: Float, wrap: Boolean, query: String,
    selectedMatch: TranscriptSearchMatch?, revealRequest: Int?, onRevealed: (Int) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val openLink = rememberTranscriptLinkOpener()
    val spans = remember(block.text) { markdownSpans(block.text) }
    val annotated = buildAnnotatedString {
        spans.forEach { span ->
            val start = length
            append(span.text)
            when (span.kind) {
                "bold" -> addStyle(SpanStyle(fontWeight = FontWeight.Bold), start, length)
                "code" -> addStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = colors.surfaceVariant), start, length)
                "link" -> {
                    addStyle(SpanStyle(color = colors.primary, textDecoration = TextDecoration.Underline), start, length)
                    addLink(LinkAnnotation.Url(span.url.orEmpty()) { annotation -> openLink((annotation as LinkAnnotation.Url).url) }, start, length)
                }
            }
            if (span.kind == "bold" || span.kind == "code") transcriptLinkRanges(span.text).forEach { range ->
                val url = span.text.substring(range.start, range.endExclusive)
                addStyle(SpanStyle(color = colors.primary, textDecoration = TextDecoration.Underline), start + range.start, start + range.endExclusive)
                addLink(LinkAnnotation.Url(url) { annotation -> openLink((annotation as LinkAnnotation.Url).url) },
                    start + range.start, start + range.endExclusive)
            }
        }
    }
    SearchableTranscriptText(annotated, query, selectedMatch = selectedMatch, revealRequest = revealRequest, onRevealed = onRevealed,
        modifier = if (block.kind == "heading") Modifier.semantics { heading() } else Modifier,
        style = MaterialTheme.typography.bodyMedium.copy(color = colors.onSurface,
            fontSize = (fontSize + if (block.kind == "heading") 3f else 0f).sp,
            lineHeight = (fontSize * 1.4f).sp,
            fontWeight = if (block.kind == "heading") FontWeight.SemiBold else FontWeight.Normal),
        softWrap = wrap)
}
