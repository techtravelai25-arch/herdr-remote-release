package dev.herdr.remote

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class FilesBrowserUiTest {
    @get:Rule val compose = createComposeRule()

    private val listing = ProjectDirectory(
        directory = "src",
        parent = "",
        entries = listOf(
            ArtifactFile("src/main", "main", null, false, true, null),
            ArtifactFile("src/readme.txt", "readme.txt", 42, true, false, "file-1"),
            ArtifactFile("src/large.zip", "large.zip", 25_000_000, false, false, null),
        ),
        truncated = false,
        nextCursor = "page-2",
    )

    @Test fun navigationAndPaginationKeepExactDirectoryAndCursor() {
        val navigation = mutableListOf<Pair<String?, String?>>()
        val opened = mutableListOf<String>()
        compose.setContent {
            HerdrTheme {
                FilesBrowserDialog(listing, false, null, "https://example.test", null,
                    {}, { directory, cursor -> navigation += directory to cursor },
                    { opened += it.path }, {})
            }
        }
        compose.onNodeWithText("Up").performClick()
        compose.onNodeWithText("Refresh").performClick()
        compose.onNodeWithText("main").performClick()
        compose.onNodeWithText("Load more").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals(listOf("" to null, "src" to null, "src" to "page-2"), navigation)
            assertEquals(listOf("src/main"), opened)
        }
    }

    @Test fun downloadableFileCanBeOpenedOrSavedExplicitly() {
        val opened = mutableListOf<String>()
        val saved = mutableListOf<String>()
        compose.setContent {
            HerdrTheme {
                FilesBrowserDialog(listing, false, null, "https://example.test", null,
                    {}, { _, _ -> }, { opened += it.id.orEmpty() }, { saved += it.id.orEmpty() })
            }
        }
        compose.onNodeWithText("readme.txt").performClick()
        compose.onNodeWithContentDescription("Save readme.txt to device").performClick()
        compose.runOnIdle {
            assertEquals(listOf("file-1"), opened)
            assertEquals(listOf("file-1"), saved)
        }
    }

    @Test fun oversizedFileCannotBeOpenedOrSaved() {
        val opened = mutableListOf<String>()
        val saved = mutableListOf<String>()
        compose.setContent {
            HerdrTheme {
                FilesBrowserDialog(listing, false, null, "https://example.test", null,
                    {}, { _, _ -> }, { opened += it.path }, { saved += it.path })
            }
        }
        compose.onNodeWithText("large.zip").assertExists()
        compose.onNodeWithText("Over 20 MB · copy it on the laptop").assertExists()
        compose.onNodeWithContentDescription("Save large.zip to device").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(emptyList<String>(), opened)
            assertEquals(emptyList<String>(), saved)
        }
    }

    @Test fun loadingDisablesFolderNavigationAndShowsProgress() {
        val navigation = mutableListOf<Pair<String?, String?>>()
        compose.setContent {
            HerdrTheme {
                FilesBrowserDialog(listing, true, "Temporary error", "https://example.test", null,
                    {}, { directory, cursor -> navigation += directory to cursor }, {}, {})
            }
        }
        compose.onNodeWithText("Temporary error").assertExists()
        compose.onNodeWithText("Up").assertIsNotEnabled()
        compose.onNodeWithText("Refresh").assertIsNotEnabled()
        compose.onNodeWithText("Load more").assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<Pair<String?, String?>>(), navigation) }
    }

    @Test fun fileOpenFailureIsVisibleWithoutHidingSaveOrNavigation() {
        val saved = mutableListOf<String>()
        val message = "No app on this phone can open this file type. Use Save to keep a copy."
        compose.setContent { HerdrTheme {
            FilesBrowserDialog(listing, false, null, "https://example.test", null,
                {}, { _, _ -> }, {}, { saved += it.id.orEmpty() }, operationMessage = message)
        } }
        compose.onNodeWithText(message).assertIsDisplayed()
        compose.onNodeWithContentDescription("Save readme.txt to device").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("file-1"), saved) }
    }
}
