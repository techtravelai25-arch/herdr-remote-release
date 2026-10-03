package dev.herdr.remote

import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import org.junit.Rule
import org.junit.Test

class PublicFeaturesPreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, theme = "android:Theme.Material.NoActionBar")
    @Test fun structuredHistoryLight() {
        paparazzi.snapshot("history-light") {
            HerdrTheme(ThemeMode.LIGHT) {
                Surface(Modifier.fillMaxSize()) {
                    ConversationHistory(StructuredHistory(listOf(
                        HistoryMessage("1", "user", "Check the reconnect flow and make sure drafts survive a network change.", "2026-09-22T08:10:00Z"),
                        HistoryMessage("2", "assistant", "The draft stays on your phone. I found a race when switching laptops and added a check before saving the response.", "2026-09-22T08:10:15Z"),
                        HistoryMessage("3", "tool", "PASS: reconnect preserves the pending draft", "2026-09-22T08:10:20Z", "Test")), "claude", true, true, "previous"), false, null, true, {}, {})
                }
            }
        }
    }
    @Test fun activityDark() {
        paparazzi.snapshot("activity-dark") {
            HerdrTheme(ThemeMode.DARK) {
                Surface(Modifier.fillMaxSize()) {
                    ActivityScreen(ActivityTimeline(listOf(
                        ActivityEvent("3", "p1", "Fix the laptop connection", "codex", "needs_input", "working", "2026-09-22T08:12:00Z"),
                        ActivityEvent("2", "p2", "Review changes", "claude", "done", "working", "2026-09-22T08:11:00Z"),
                        ActivityEvent("1", "p1", "Fix the laptop connection", "codex", "working", "idle", "2026-09-22T08:10:00Z")), "2026-09-22T08:00:00Z"), false, null, true, setOf("p1", "p2"), {}, {})
                }
            }
        }
    }
}
