package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class MarkdownPresentationTest {
    @Test fun rejectsExecutableAndCredentialLinks() {
        listOf("javascript:alert(1)", "file:///etc/passwd", "intent://open", "https://user:secret@example.com", "https://example.com\n").forEach { assertNull(safeWebLink(it)) }
        assertEquals("https://example.com/a?q=1", safeWebLink("https://example.com/a?q=1"))
    }
    @Test fun codeRemainsLiteralAndIncompleteFenceIsReadable() {
        val blocks = markdownBlocks("# Result\n\n```kotlin\n**not bold**\n<unsafe>")
        assertEquals("heading", blocks[0].kind)
        assertEquals("code", blocks[1].kind)
        assertEquals("**not bold**\n<unsafe>", blocks[1].text)
    }
    @Test fun unsafeMarkdownLinksStayVisibleWithoutAction() {
        val spans = markdownSpans("[danger](javascript:alert) **bold** `code`")
        assertTrue(spans.none { it.url != null })
        assertTrue(spans.first().text.contains("javascript:alert"))
        assertEquals(listOf("bold", "code"), spans.filter { it.kind != "text" }.map { it.kind })
    }

    @Test fun rawUrlsInProseBecomeSafeLinkSpansWithoutChangingText() {
        val text = "See https://example.com/docs?q=1 and internal file://x paths."
        val spans = markdownSpans(text)
        assertEquals(1, spans.count { it.kind == "link" })
        val linked = spans.single { it.kind == "link" }
        assertEquals("https://example.com/docs?q=1", linked.url)
        assertEquals(linked.text, linked.url)
        // Connected characters outside the URL stay intact plain text; the full text is preserved.
        assertEquals(text, spans.joinToString("") { it.text })
    }

    @Test fun rawUrlRangesOnlyMatchSafeHttpLinks() {
        val text = "open javascript:alert(1) and https://good.example/a and https://user:secret@bad.example"
        val ranges = rawUrlRanges(text).map { text.substring(it.start, it.endExclusive) }
        assertEquals(listOf("https://good.example/a"), ranges)
    }

    @Test fun rawUrlRangesKeepBalancedParenthesesAndDropSentencePunctuation() {
        val text = "(https://example.com/wiki/Thing_(film)), then https://example.com/file.pdf."
        val ranges = rawUrlRanges(text).map { text.substring(it.start, it.endExclusive) }
        assertEquals(listOf("https://example.com/wiki/Thing_(film)", "https://example.com/file.pdf"), ranges)
    }

    @Test fun safeWebLinkRejectsControlCharactersAndForeignSchemes() {
        assertNull(safeWebLink("https://good.example/page\n"))
        assertEquals("https://good.example/page", safeWebLink("https://good.example/page"))
        assertNull(safeWebLink("ftp://files.example.com"))
    }
}
