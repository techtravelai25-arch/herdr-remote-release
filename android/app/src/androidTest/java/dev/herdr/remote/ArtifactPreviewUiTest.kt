package dev.herdr.remote

import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import java.io.File
import java.io.IOException

class ArtifactPreviewUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun textAndImageRoutingCannotSendUnknownBinaryToAnUnrelatedViewer() {
        val uri = Uri.parse("content://${context.packageName}.updates/review_files/qa.json")
        val text = ArtifactDownloads.viewerIntent(context, uri, "json")
        assertEquals(ArtifactPreviewActivity::class.java.name, text.component?.className)
        assertEquals(uri, text.data)
        val image = ArtifactDownloads.viewerIntent(context, uri, "png")
        assertEquals(Intent.ACTION_VIEW, image.action)
        assertEquals("image/png", image.type)
        for (extension in listOf("bin", "unknownherdr")) {
            val error = assertThrows(IOException::class.java) { ArtifactDownloads.viewerIntent(context, uri, extension) }
            assertEquals("No preview is available for this file type. Use Save to keep a copy.", error.message)
        }
    }

    private fun awaitText(text: String) {
        compose.waitUntil(5000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(text).assertExists()
    }

    private fun preview(text: String, block: (ActivityScenario<ArtifactPreviewActivity>) -> Unit) {
        val folder = File(context.cacheDir, "review-files").apply { mkdirs() }
        val file = File.createTempFile("qa-preview-", ".txt", folder).apply { writeText(text) }
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
            ActivityScenario.launch<ArtifactPreviewActivity>(Intent(context, ArtifactPreviewActivity::class.java)
                .setData(uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use(block)
        } finally { file.delete() }
    }

    @Test fun localTextDisplaysVerbatimWithoutAnotherAppAndSurvivesRecreation() {
        val text = "# Test report\n{\"ok\":true}\ncafé ₹ ✓\n<script>not executable</script>"
        preview(text) { activity ->
            awaitText(text)
            activity.recreate()
            awaitText(text)
            compose.onNodeWithText("Close").performClick()
        }
    }

    @Test fun emptyAndLargeFilesHaveUsefulBoundedPreviews() {
        preview("") { awaitText("This file is empty.") }
        preview("a".repeat(200_000) + "OMITTED TAIL") {
            awaitText("Preview limited to 200,000 characters. Save the file to read all of it.")
            compose.onNodeWithText("a".repeat(200_000)).assertExists()
            compose.onNodeWithText("OMITTED TAIL", substring = true).assertDoesNotExist()
        }
    }

    @Test fun arbitraryContentAndWebUrisAreNotLoaded() {
        for (uri in listOf("https://example.test/file.txt", "content://other.app/private.txt")) {
            ActivityScenario.launch<ArtifactPreviewActivity>(Intent(context, ArtifactPreviewActivity::class.java)
                .setData(Uri.parse(uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
                awaitText("This file is unavailable. Open it again from the laptop.")
            }
        }
    }
}
