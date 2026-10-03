package dev.herdr.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class ProjectFilesTest {
    private fun parse(raw: String) = parseProjectFiles(Json.parseToJsonElement(raw).jsonObject)

    @Test fun parsesDirectoriesWithOpaqueDownloadableFileIds() {
        val id = "project-" + "a".repeat(64)
        val listing = parse("""{"directory":"","parent":null,"truncated":false,"entries":[
            {"name":"docs","path":"docs","type":"directory"},
            {"name":"report.pdf","path":"report.pdf","type":"file","id":"$id","size":4821,"downloadable":true},
            {"name":"big.bin","path":"big.bin","type":"file","size":734105,"downloadable":false}]}""")
        assertTrue(listing.entries[0].isDirectory)
        assertEquals(id, listing.entries[1].id)
        assertTrue(listing.entries[1].downloadable)
        assertFalse(listing.entries[2].downloadable)
        assertNull(listing.entries[2].id)
        assertEquals(listOf("docs", "report.pdf", "big.bin"), listing.entries.map { it.path })
        assertNull(listing.parent)
        assertFalse(listing.truncated)
        assertTrue(listing.displayName.isNotBlank())
    }

    @Test fun dropsEntriesWithoutMatchingNamePathOrUnknownType() {
        val listing = parse("""{"directory":"docs","parent":"","truncated":false,"entries":[
            {"name":"writeup.md","path":"drafts/writeup.md","type":"file"},
            {"path":"orphan","type":"file","downloadable":false},
            {"name":"shim","path":"shim","type":"mount","downloadable":false}]}""")
        assertEquals("docs", listing.directory)
        assertTrue(listing.entries.isEmpty())
    }

    @Test fun rejectsResourceTraversalAndControlCharacters() {
        listOf("../escape", "..", "", "hidden/.ssh", "linked\\slash", "..…/x").forEach { attempt ->
            val escaped = attempt.replace("\\", "\\\\")
            val listing = parse("""{"directory":"src","parent":"","truncated":false,"entries":[
                {"name":"$escaped","path":"$escaped","type":"file","downloadable":false}]}""")
            assertTrue("no unsafe entry parsed for $attempt", listing.entries.isEmpty())
        }
    }

    @Test fun credentialSuffixedEntriesAreNeverParsable() {
        for (name in listOf("id_rsa", "server.pem", "backup.key", "screenshots.env")) {
            val listing = parse("""{"directory":"","parent":null,"truncated":false,"entries":[
                {"name":"$name","path":"$name","type":"file","downloadable":false}]}""")
            assertTrue(name, listing.entries.isEmpty())
        }
    }

    @Test fun truncatedDirectoriesStillLoadWithoutEntries() {
        val listing = parse("""{"directory":"out","parent":"","truncated":true,"entries":[]}""")
        assertTrue(listing.truncated)
        assertEquals("out", listing.directory)
        assertEquals("", listing.parent)
    }

    @Test fun sizesAndTypeChecksPreserveUnknowns() {
        val listing = parse("""{"directory":"","parent":null,"truncated":false,"entries":[
            {"name":"weird","path":"weird","type":"file","downloadable":false}]}""")
        assertEquals("weird", listing.entries.single().name)
        assertFalse(listing.entries.single().isDirectory)
    }

    @Test fun suggestedSaveNamesKeepReadableSuffixes() {
        assertEquals("report v2.pdf", artifactFileName("outputs/report v2.pdf"))
        assertEquals("build.log.2026.tar.gz", artifactFileName("logs/build.log.2026.tar.gz"))
        assertEquals("file", artifactFileName("file"))
        assertEquals("cache-e5319cff.png", artifactFileName("app/models/cache-e5319cff.png"))
        assertEquals("file", artifactFileName(""))
        assertEquals("bad_name.pdf", artifactFileName("out/bad\\name.pdf"))
        assertEquals("long.pdf", artifactFileName("out/long.pdf"))
    }

    @Test fun fileSizeLabelsSwitchUnits() {
        assertEquals("512 bytes", fileSizeLabel(512))
        assertEquals(String.format("%.1f KB", 2048 / 1024.0), fileSizeLabel(2048))
        assertEquals(String.format("%.1f MB", (3L * 1024 * 1024) / (1024.0 * 1024.0)), fileSizeLabel(3L * 1024 * 1024))
    }

    @Test fun nextCursorIsParsedAndBounded() {
        val withCursor = parse("""{"directory":"","parent":null,"truncated":true,"nextCursor":"page-2","entries":[]}""")
        assertEquals("page-2", withCursor.nextCursor)
        val oversized = parse("""{"directory":"","parent":null,"truncated":true,"nextCursor":"${"c".repeat(200)}","entries":[]}""")
        assertNull(oversized.nextCursor)
        val absent = parse("""{"directory":"","parent":null,"truncated":false,"entries":[]}""")
        assertNull(absent.nextCursor)
    }

    @Test fun loadMoreAppendsOnlyWithinTheSameFolder() {
        val first = parse("""{"directory":"docs","parent":"","truncated":true,"nextCursor":"1","entries":[
            {"name":"a.md","path":"docs/a.md","type":"file","downloadable":false}]}""")
        val second = parse("""{"directory":"docs","parent":"","truncated":false,"entries":[
            {"name":"a.md","path":"docs/a.md","type":"file","downloadable":false},
            {"name":"b.md","path":"docs/b.md","type":"file","downloadable":false}]}""")
        val merged = mergeProjectFilesPage(first, second, "1")
        assertEquals(listOf("docs/a.md", "docs/b.md"), merged.entries.map { it.path })
        assertNull(merged.nextCursor)
        // Without a cursor the listing replaces rather than appends.
        assertEquals(second, mergeProjectFilesPage(first, second, null))
        // A different folder never merges into the previous page.
        val other = second.copy(directory = "logs")
        assertEquals(other.entries, mergeProjectFilesPage(first, other, "1").entries)
    }
}
