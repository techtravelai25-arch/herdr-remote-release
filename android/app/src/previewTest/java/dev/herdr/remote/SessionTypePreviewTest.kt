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
import org.junit.Rule
import org.junit.Test

class SessionTypePreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, theme = "android:Theme.Material.NoActionBar")

    private fun render(mode: ThemeMode, scale: Float = 1f, supported: Boolean = true) {
        paparazzi.snapshot("terminal-choice-${mode.name.lowercase()}-$scale-$supported") {
            CompositionLocalProvider(LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, scale)) {
                HerdrTheme(mode) {
                    Surface {
                        Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            Text("New session", style = MaterialTheme.typography.headlineSmall)
                            SessionTypePicker(if (supported) "terminal" else "codex", supported, terminalInputAllowed = false, onKind = {})
                        }
                    }
                }
            }
        }
    }

    @Test fun terminalLight() = render(ThemeMode.LIGHT)
    @Test fun terminalDark() = render(ThemeMode.DARK)
    @Test fun oldBridge() = render(ThemeMode.LIGHT, supported = false)
    @Test fun terminalNarrowLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 1000,
            xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM, fontScale = 2f))
        render(ThemeMode.LIGHT, scale = 2f)
    }

    private fun dialog(mode: ThemeMode, directory: String? = null, scale: Float = 1f, supported: Boolean = true) {
        paparazzi.snapshot("new-session-${mode.name.lowercase()}-$scale-$supported-${directory != null}") {
            CompositionLocalProvider(LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, scale)) {
                HerdrTheme(mode) {
                    NewSessionDialog(
                        kind = "codex", onKind = {}, terminalSupported = supported, terminalInputAllowed = true,
                        directory = directory, foldersSupported = supported, browseEnabled = true, onBrowse = {},
                        name = "", onName = {}, validName = true, canCreate = directory != null && supported,
                        onCreate = {}, dismiss = {},
                    )
                }
            }
        }
    }

    @Test fun newSessionLight() = dialog(ThemeMode.LIGHT)
    @Test fun newSessionDarkSelectedFolder() = dialog(ThemeMode.DARK, "/home/developer/projects/herdr-remote")
    @Test fun newSessionOldBridge() = dialog(ThemeMode.LIGHT, supported = false)
    @Test fun newSessionNarrowLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 1000,
            xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM, fontScale = 2f))
        dialog(ThemeMode.LIGHT, scale = 2f)
    }
}
