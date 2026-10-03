package dev.herdr.remote

import androidx.compose.material3.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import org.junit.Rule
import org.junit.Test

class CodexModelPreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, theme = "android:Theme.Material.NoActionBar")
    @Test fun modelLight() = paparazzi.snapshot("codex-model-light") {
        HerdrTheme(ThemeMode.LIGHT) { CodexModelDialog(CodexModelMenu("1", "Select model", listOf("gpt-5.4 (current)", "gpt-5.3-codex", "gpt-5.3-codex-spark")), true, false, {}, {}, {}) }
    }
    @Test fun claudeLight() = paparazzi.snapshot("claude-model-light") {
        HerdrTheme(ThemeMode.LIGHT) { CodexModelDialog(CodexModelMenu("3", "Select model", listOf("Default (recommended)", "Sonnet", "Opus"), provider = "claude"), true, false, {}, {}, {}) }
    }
    @Test fun openCodeNativeDark() = paparazzi.snapshot("opencode-model-native-dark") {
        HerdrTheme(ThemeMode.DARK) { CodexModelDialog(CodexModelMenu("4", "Select model", emptyList(), -1, provider = "opencode", mode = "terminal",
            ansi = "Select model\n\nOpenAI\n\u001b[1;38;2;240;240;240;48;2;60;75;90m  GPT-5.4                         \u001b[0m\n  GPT-5.3 Codex\n\nAnthropic\n  Claude Sonnet"), true, false, {}, {}, {}) }
    }
    @Test fun reasoningDarkLarge() = paparazzi.snapshot("codex-reasoning-dark-large") {
        CompositionLocalProvider(LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, 1.5f)) {
            HerdrTheme(ThemeMode.DARK) { CodexModelDialog(CodexModelMenu("2", "Select reasoning effort", listOf("Low", "Medium", "High (current)", "Extra high"), 2, "reasoning"), true, false, {}, {}, {}) }
        }
    }
}
