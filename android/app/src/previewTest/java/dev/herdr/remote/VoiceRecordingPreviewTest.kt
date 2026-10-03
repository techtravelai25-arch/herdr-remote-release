package dev.herdr.remote

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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

class VoiceRecordingPreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, theme = "android:Theme.Material.NoActionBar")
    private val quiet = VoiceRecordingState(recording = true, seconds = 3, levels = List(20) { 0f })
    private val loud = quiet.copy(seconds = 27, levels = listOf(.08f, .2f, .45f, .8f, .5f, .25f, .12f, .4f, .9f, .75f, .35f, .16f, .2f, .5f, .85f, 1f, .7f, .4f, .15f, .08f))

    private fun render(name: String, state: VoiceRecordingState, dark: Boolean = false, scale: Float = 1f) {
        paparazzi.snapshot(name) {
            CompositionLocalProvider(LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, scale)) {
                HerdrTheme(themeMode = if (dark) ThemeMode.DARK else ThemeMode.LIGHT) {
                    Surface(Modifier.fillMaxSize()) {
                        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            VoiceRecordingFeedback(state, Modifier.weight(1f))
                            Column {
                                IconButton(onClick = {}, modifier = Modifier.size(48.dp)) {
                                    Icon(if (state.transcribing) Icons.Default.Close else Icons.Default.Stop, "Stop")
                                }
                                if (state.recording) IconButton(onClick = {}, modifier = Modifier.size(48.dp)) { Icon(Icons.Default.Close, "Cancel") }
                            }
                        }
                    }
                }
            }
        }
    }
    @Test fun quiet() = render("voice-quiet", quiet)
    @Test fun speech() = render("voice-speech", loud)
    @Test fun speechDark() = render("voice-speech-dark", loud, dark = true)
    @Test fun transcribing() = render("voice-transcribing", VoiceRecordingState(transcribing = true))
    @Test fun narrowLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 700, xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        render("voice-320dp-large-text", loud, scale = 2f)
    }
    @Test fun transcribingNarrowLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 700, xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        render("voice-transcribing-320dp-large-text", VoiceRecordingState(transcribing = true), dark = true, scale = 2f)
    }
}
