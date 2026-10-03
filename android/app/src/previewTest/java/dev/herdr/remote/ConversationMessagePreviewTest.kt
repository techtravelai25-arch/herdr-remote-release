package dev.herdr.remote

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import org.junit.Rule
import org.junit.Test

/** Sender hierarchy and message padding with the screenshot's exact prompt. */
class ConversationMessagePreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, theme = "android:Theme.Material.NoActionBar")

    private fun render(name: String, mode: ThemeMode = ThemeMode.LIGHT, scale: Float = 1f) {
        paparazzi.snapshot(name) {
            CompositionLocalProvider(LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, scale)) {
                HerdrTheme(themeMode = mode) {
                    Surface(Modifier.fillMaxSize()) {
                        SelectionContainer {
                            Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState()),
                                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                TranscriptBlock(TerminalBlock("what all notifications are ther?", true), calm = true, wrap = true, agentLabel = "Codex")
                                TranscriptBlock(TerminalBlock("There are **20 reply messages** and **20 input prompts**. Each set is shuffled through before repeating.", false), calm = true, wrap = true, agentLabel = "Codex")
                                TranscriptBlock(TerminalBlock("Can you make the sender labels and the text below them line up?\n\nKeep the message easy to read, with enough space around longer replies.", true), calm = true, wrap = true, agentLabel = "Codex")
                                TranscriptBlock(TerminalBlock("The sender labels now use the same typography, and messages have consistent spacing.\n\nYour text size preference still applies.", false), calm = true, wrap = true, agentLabel = "Codex")
                                TranscriptBlock(TerminalBlock("Running layout checks", false, true), calm = true, wrap = true, agentLabel = "Codex")
                            }
                        }
                    }
                }
            }
        }
    }

    @Test fun messagesLight() = render("messages-light")
    @Test fun messagesDark() = render("messages-dark", mode = ThemeMode.DARK)
    @Test fun messagesNarrow() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 960, xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        render("messages-320dp")
    }
    @Test fun messagesLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 1800, xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        render("messages-320dp-200percent", scale = 2f)
    }
}
