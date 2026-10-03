package dev.herdr.remote

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import kotlinx.serialization.json.*
import org.junit.Rule
import org.junit.Test

class ReviewResultsPreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, theme = "android:Theme.Material.NoActionBar")
    private fun fixture(changed: Boolean = false, available: Boolean = true, artifacts: Boolean = true) = buildJsonObject {
        put("available", available)
        put("reason", "This folder is not a Git repository.")
        put("status", if (changed) "## main...origin/main\n M android/app/src/MainActivity.kt\n?? docs/release.md" else "## main...origin/main")
        putJsonObject("tests") { put("verified", false); put("reason", "No structured test run was recorded for this session.") }
        putJsonArray("artifacts") {
            (if (artifacts) listOf("app-debug.apk", "Screenshot_2026-09-21-23-57-17-024_dev.herdr.remote.jpg", "herdr-remote-release-validation-and-implementation-notes-2026-09-22.md") else emptyList()).forEachIndexed { i, name ->
                add(buildJsonObject { put("id", "$i"); put("name", name); put("size", 45235) })
            }
        }
    }
    private fun render(name: String, mode: ThemeMode = ThemeMode.LIGHT, scale: Float = 1f, changed: Boolean = false, available: Boolean = true, artifacts: Boolean = true) {
        paparazzi.snapshot(name) {
            CompositionLocalProvider(LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, scale)) {
                HerdrTheme(mode) { Surface(color = MaterialTheme.colorScheme.background) { ReviewResults(fixture(changed, available, artifacts), false, {}) } }
            }
        }
    }
    @Test fun cleanLight() = render("review-clean-light", artifacts = false)
    @Test fun filesLight() = render("review-files-light", changed = true)
    @Test fun changedDark() = render("review-changed-dark", ThemeMode.DARK, changed = true)
    @Test fun nonGit() = render("review-non-git", available = false)
    @Test fun narrowLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 1400, xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        render("review-320dp-200percent", scale = 2f)
    }
}
