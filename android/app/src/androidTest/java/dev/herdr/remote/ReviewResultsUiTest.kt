package dev.herdr.remote

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ReviewResultsUiTest {
    @get:Rule val compose = createComposeRule()

    private val review = Json.parseToJsonElement("""{
      "available":true,
      "changedFilesComplete":true,
      "changedFiles":[{"path":"src/main.kt","status":"M"}],
      "diff":"@@ -1 +1 @@\n-old\n+new",
      "tests":{"verified":false,"reason":"No test report from the laptop"},
      "artifacts":[{"id":"artifact-1","name":"reports/result.txt","size":42}]
    }""").jsonObject

    @Test fun unavailableReviewCanRefreshWithoutInventingResults() {
        var refreshes = 0
        compose.setContent { HerdrTheme { ReviewResults(null, false, { refreshes++ }) } }
        compose.onNodeWithText("Results are unavailable. Reconnect and refresh.").assertExists()
        compose.onNodeWithContentDescription("Refresh results").performClick()
        compose.runOnIdle { assertEquals(1, refreshes) }
    }

    @Test fun loadingReviewDisablesAnotherRefresh() {
        var refreshes = 0
        compose.setContent { HerdrTheme { ReviewResults(null, true, { refreshes++ }) } }
        compose.onNodeWithText("Loading project results…").assertExists()
        compose.onNodeWithContentDescription("Refresh results").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, refreshes) }
    }

    @Test fun changedFileAndDiffAreReadableWithoutClaimingTestsPassed() {
        compose.setContent { HerdrTheme { ReviewResults(review, false, {}) } }
        compose.onNodeWithText("Tests · Not verified").assertExists()
        compose.onNodeWithText("main.kt").assertExists()
        compose.onNodeWithText("Show diff").performScrollTo().performClick()
        compose.onNodeWithText("@@ -1 +1 @@", substring = true).assertExists()
        compose.onNodeWithText("Hide diff").performClick()
        compose.onNodeWithText("@@ -1 +1 @@", substring = true).assertDoesNotExist()
    }

    @Test fun artifactOpenAndSaveRemainSeparateExplicitActions() {
        val opened = mutableListOf<String>()
        val saved = mutableListOf<Pair<String, String>>()
        compose.setContent {
            HerdrTheme { ReviewResults(review, false, {}, { opened += it }, { id, name -> saved += id to name }) }
        }
        compose.onNodeWithText("result.txt").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Save result.txt to device").performClick()
        compose.runOnIdle {
            assertEquals(listOf("artifact-1"), opened)
            assertEquals(listOf("artifact-1" to "reports/result.txt"), saved)
        }
    }
}
