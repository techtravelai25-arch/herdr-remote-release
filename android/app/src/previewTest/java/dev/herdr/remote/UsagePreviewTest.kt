package dev.herdr.remote

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

class UsagePreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5.copy(
        screenWidth = 320, screenHeight = 960, xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM
    ), theme = "android:Theme.Material.NoActionBar")

    private val providers = listOf(
        ProviderUsage("codex", "Codex", "available", listOf(
            UsageWindow("primary", "5 hours", 72.5, "2026-10-01T15:00:00Z"),
            UsageWindow("secondary", "Weekly", 18.0, "2026-10-05T15:00:00Z"),
        ), updatedAt = "2026-01-01T10:00:00Z"),
        ProviderUsage("future", "Another provider", message = "No usage information yet."),
    )

    @Test fun usageNarrowLight() = paparazzi.snapshot {
        HerdrTheme(ThemeMode.LIGHT) {
            Surface(Modifier.padding(16.dp)) { UsageRemainingSection(providers, offline = false, stale = false) }
        }
    }

    @Test fun usageOfflineDarkLargeText() = paparazzi.snapshot {
        CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
            HerdrTheme(ThemeMode.DARK) {
                Surface(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                    UsageRemainingSection(providers.take(1), offline = true, stale = false)
                }
            }
        }
    }
}
