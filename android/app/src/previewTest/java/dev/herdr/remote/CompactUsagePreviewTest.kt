package dev.herdr.remote

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
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
import java.time.Instant

/** Compact disclosure, long summaries, and honest cached states at native text sizes. */
class CompactUsagePreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, theme = "android:Theme.Material.NoActionBar")
    private val now = Instant.parse("2026-09-21T17:20:00Z")
    private val provider = ProviderUsage("codex", "Codex", status = "available", updatedAt = now.toString(),
        windows = listOf(UsageWindow("weekly", "Weekly", 35.0, "2026-09-24T10:00:00Z")))

    private fun render(name: String, mode: ThemeMode = ThemeMode.LIGHT, scale: Float = 1f,
        usage: ProviderUsage = provider, expanded: Boolean = false, offline: Boolean = false, stale: Boolean = false) {
        paparazzi.snapshot(name) {
            CompositionLocalProvider(LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, scale)) {
                HerdrTheme(themeMode = mode) {
                    Surface(Modifier.fillMaxSize()) {
                        Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()),
                            verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            ProviderUsageRow(usage, offline, stale, now, expanded, {})
                        }
                    }
                }
            }
        }
    }

    @Test fun compactWeekly() = render("usage-compact")
    @Test fun compactDark() = render("usage-dark", mode = ThemeMode.DARK)
    @Test fun expandedDetails() = render("usage-expanded", expanded = true)
    @Test fun unavailable() = render("usage-unavailable", usage = ProviderUsage("codex", "Codex"))
    @Test fun stale() = render("usage-stale", stale = true)
    @Test fun offline() = render("usage-offline", offline = true)
    @Test fun largeTextMultipleWindows() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 960, xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        render("usage-large-text", scale = 2f, usage = provider.copy(windows = listOf(
            UsageWindow("session", "Session", 82.0, "2026-09-21T19:00:00Z"), provider.windows.first())))
    }
}
