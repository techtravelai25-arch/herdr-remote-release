package dev.herdr.remote

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test

class ConversationTranscriptUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun pendingPromptExpiresAndLaterSendStartsAFreshPreview() {
        var history by mutableStateOf(StructuredHistory(
            messages = listOf(HistoryMessage("earlier", "assistant", "Earlier reply")),
            source = "codex",
            available = true,
        ))
        var sentAt by mutableStateOf(System.currentTimeMillis())
        var sentPrompts by mutableStateOf(listOf("Pending request"))
        compose.mainClock.autoAdvance = false
        compose.setContent {
            HerdrTheme {
                ConversationTranscript(
                    history = history,
                    agentLabel = "Codex",
                    working = false,
                    sentPrompts = sentPrompts,
                    sentAtMs = sentAt,
                    fontSize = 15f,
                    loadingEarlier = false,
                    onEarlier = {},
                )
            }
        }
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithText("Pending request").assertExists()

        // Virtual time resumes the expiry effect while the history and prompt inputs stay unchanged.
        compose.mainClock.advanceTimeBy(91_000, ignoreFrameDuration = true)
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithText("Pending request").assertDoesNotExist()
        compose.onNodeWithText("Earlier reply").assertExists()

        // A later acknowledgement resets the Compose expiry effect, without renewing the older bubble.
        compose.runOnIdle {
            // A future timestamp can make the preview absent on a fast frame.
            sentAt = System.currentTimeMillis() - 1
            sentPrompts = sentPrompts + "New request"
        }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithText("New request").assertIsDisplayed()
        compose.onNodeWithText("Pending request").assertDoesNotExist()

        // The saved user turn replaces its preview. Polling and a reply must not append the old text.
        compose.runOnIdle {
            history = history.copy(messages = history.messages + listOf(
                HistoryMessage("new-user", "user", "New request", timestamp = "2026-10-08T06:15:00Z"),
                HistoryMessage("new-reply", "assistant", "New reply")))
        }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithText("New request").assertExists()
        compose.onNodeWithText("New reply").assertIsDisplayed()
        compose.onNodeWithText("Pending request").assertDoesNotExist()

        compose.mainClock.advanceTimeBy(91_000, ignoreFrameDuration = true)
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithText("New request").assertExists()
        compose.onNodeWithText("New reply").assertExists()
    }
}
