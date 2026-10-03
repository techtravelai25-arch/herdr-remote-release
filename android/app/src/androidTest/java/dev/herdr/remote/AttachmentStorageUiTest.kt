package dev.herdr.remote

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class AttachmentStorageUiTest {
    @get:Rule val compose = createComposeRule()

    private val inventory = Json.parseToJsonElement("""{
        "usedBytes":4,"quotaBytes":1024,
        "attachments":[{"id":"file-123","name":"fixture.txt","size":4,"cwd":"/project"}]
    }""").jsonObject

    private fun state(stale: Boolean) = RemoteState(
        online = true,
        snapshot = Snapshot(canControl = true, stale = stale),
        attachmentStorage = inventory,
    )

    @Test fun staleSnapshotDoesNotOfferDelete() {
        val deleted = mutableListOf<String>()
        compose.setContent {
            HerdrTheme {
                AttachmentStorageDialog(state(stale = true), onRefresh = {}, onDelete = { deleted += it }, onDismiss = {})
            }
        }

        compose.onNodeWithText("Delete from laptop").assertIsNotEnabled()
        compose.onNodeWithText("Delete file").assertDoesNotExist()
        compose.runOnIdle { assertTrue(deleted.isEmpty()) }
    }

    @Test fun losingFreshnessWhileConfirmationIsOpenDisablesDelete() {
        val deleted = mutableListOf<String>()
        var current by mutableStateOf(state(stale = false))
        compose.setContent {
            HerdrTheme {
                AttachmentStorageDialog(current, onRefresh = {}, onDelete = { deleted += it }, onDismiss = {})
            }
        }

        compose.onNodeWithText("Delete from laptop").assertIsEnabled().performClick()
        compose.onNodeWithText("Delete file").assertIsEnabled()
        compose.runOnIdle { current = current.copy(snapshot = current.snapshot.copy(stale = true)) }
        compose.onNodeWithText("Delete file").assertIsNotEnabled()
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { assertTrue(deleted.isEmpty()) }
    }
}
