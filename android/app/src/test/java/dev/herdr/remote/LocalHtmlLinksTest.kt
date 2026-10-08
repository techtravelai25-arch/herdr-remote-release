package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class LocalHtmlLinksTest {
    @Test fun recognizesProjectFilesAndExplicitLoopbackServers() {
        listOf("/home/me/project/output/report.html", ".lavish/tasks/index.html", "./output/report.htm",
            "file:///home/me/project/report.html", "file://localhost/home/me/report.html",
            "http://localhost:3000/", "http://127.0.0.1:8080/report.html", "http://[::1]:5173/",
            "/home/me/My Project/report.html", "/home/me/report.html:12", "output/report.html#results")
            .forEach { assertEquals(it, localHtmlTarget(it)) }
    }

    @Test fun leavesOrdinaryWebLinksAloneAndRejectsUnsafeTargets() {
        listOf("https://example.com/report.html", "http://localhost.example.com:3000/", "http://localhost/",
            "http://localhost:22/", "http://user:secret@localhost:3000/", "file://other/home/report.html",
            "javascript:alert(1)", "content://private/report.html", "../report.html", "output/%2e%2e/report.html",
            "output/report.html\n", "output\\report.html", "/home/me/credentials.json")
            .forEach { assertNull(it, localHtmlTarget(it)) }
        assertEquals("https://example.com/report.html", safeTranscriptLink("https://example.com/report.html"))
    }

    @Test fun markdownAndPlainPathsAreTappableWithoutChangingSourceCharacters() {
        val spans = markdownSpans("[Open result](.lavish/tasks/index.html) and [Spaced](</home/me/My Project/report.html>)")
        assertEquals(listOf(".lavish/tasks/index.html", "/home/me/My Project/report.html"), spans.mapNotNull { it.url })
        val raw = "Open /home/me/output/report.html, .lavish/tasks/index.html or http://localhost:3000/."
        val links = transcriptLinkRanges(raw).map { raw.substring(it.start, it.endExclusive) }
        assertEquals(listOf("/home/me/output/report.html", ".lavish/tasks/index.html", "http://localhost:3000/"), links)
        assertEquals(raw, markdownSpans(raw).joinToString("") { it.text })
    }

    @Test fun webHtmlLinksDoNotGainOverlappingLocalLinks() {
        val text = "See https://example.com/output/report.html and file:///home/me/report.html"
        val ranges = transcriptLinkRanges(text)
        assertEquals(2, ranges.size)
        assertEquals("https://example.com/output/report.html", text.substring(ranges[0].start, ranges[0].endExclusive))
        assertEquals("file:///home/me/report.html", text.substring(ranges[1].start, ranges[1].endExclusive))
    }
}
