package dev.herdr.remote

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ReviewPresentationTest {
    private fun data(status: String) = buildJsonObject { put("status", status) }
    @Test fun cleanBranchIsNotAFile() {
        assertEquals(ReviewFiles(emptyList(), true), reviewFiles(data("## main...origin/main\n")))
    }
    @Test fun legacyPathsAndRenameAreDecoded() {
        val result = reviewFiles(data("## main\n M app/Main.kt\nR  \"old -> name.txt\" -> \"new\\nname.txt\"\n?? \"caf\\303\\251.txt\"\n"))
        assertTrue(result.complete)
        assertEquals(listOf("app/Main.kt", "new\nname.txt", "café.txt"), result.files.map { it.path })
        assertEquals("old -> name.txt", result.files[1].previousPath)
        assertEquals("Renamed", result.files[1].status)
    }
    @Test fun structuredPathsAreAlreadyDecoded() {
        val result = reviewFiles(Json.parseToJsonElement("""{"status":"## main","changedFiles":[{"path":"a -> b.txt","status":"untracked"}],"changedFilesComplete":false}""").jsonObject)
        assertEquals("a -> b.txt", result.files.single().path)
        assertFalse(result.complete)
    }
    @Test fun unknownAndTruncatedOutputNeverMeansClean() {
        assertFalse(reviewFiles(data("fatal: unknown repository")).complete)
        assertFalse(reviewFiles(buildJsonObject { put("status", "## main"); put("truncated", true) }).complete)
        assertFalse(reviewFiles(buildJsonObject { put("changedFiles", JsonArray(emptyList())); put("statusError", "Unavailable") }).complete)
    }
    @Test fun diffTruncationDoesNotInvalidateCompleteStructuredFiles() {
        assertTrue(reviewFiles(buildJsonObject {
            put("changedFiles", JsonArray(emptyList())); put("changedFilesComplete", true); put("truncated", true)
        }).complete)
    }
    @Test fun malformedOrMissingStatusIsIncomplete() {
        assertFalse(reviewFiles(buildJsonObject {}).complete)
        assertFalse(reviewFiles(data("R  missing rename destination")).complete)
        assertEquals("📄 notes.txt", decodeGitPath("\"📄 notes.txt\""))
    }
    @Test fun conflictCodesBeatAddedAndDeleted() {
        listOf("DD", "AU", "UD", "UA", "DU", "AA", "UU").forEach { assertEquals("Conflicted", reviewStatus(it)) }
    }
}
