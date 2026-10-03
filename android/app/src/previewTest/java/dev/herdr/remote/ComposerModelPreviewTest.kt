package dev.herdr.remote

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material3.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import org.junit.Rule
import org.junit.Test

class ComposerModelPreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 260,
        xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM), theme = "android:Theme.Material.NoActionBar")
    private fun render(name: String, model: String?, dark: Boolean = false, scale: Float = 1f, supported: Boolean = true) {
        paparazzi.snapshot(name) {
            CompositionLocalProvider(LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, scale)) {
                HerdrTheme(if (dark) ThemeMode.DARK else ThemeMode.LIGHT) {
                    Surface {
                        Column(Modifier.fillMaxSize().padding(12.dp)) {
                            HorizontalDivider()
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                IconButton(onClick = {}) { Icon(Icons.Default.Add, "Attachment options") }
                                IconButton(onClick = {}) { Icon(Icons.Default.Keyboard, "Show terminal keys") }
                                ComposerModelButton(model, supported, supported, {}, Modifier.weight(1f))
                            }
                            OutlinedTextField("", {}, placeholder = { Text("Message your agent…") }, modifier = Modifier.fillMaxWidth())
                        }
                    }
                }
            }
        }
    }
    @Test fun modelWithReasoningEffort() {
        // Keep portrait height above width so layoutlib does not rotate the narrow fixture.
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 420,
            xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        render("composer-model-effort-320dp", "gpt-6-astra · high")
    }
    @Test fun compactModel() = render("composer-model-320dp", "gpt-5.4")
    @Test fun longModelLargeText() = render("composer-long-model-320dp-large", "anthropic/claude-opus-4-6 (extended context)", dark = true, scale = 1.5f)
    @Test fun unknownModelOldBridge() = render("composer-model-unknown", null, supported = false)
}
