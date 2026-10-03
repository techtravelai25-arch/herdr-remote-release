package dev.herdr.remote

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import org.junit.Rule
import org.junit.Test

class NotificationOpeningPreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, theme = "android:Theme.Material.NoActionBar")

    private fun render(name: String, mode: ThemeMode = ThemeMode.LIGHT, scale: Float = 1f, conversation: Boolean = true) {
        paparazzi.snapshot(name) {
            CompositionLocalProvider(LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, scale)) {
                HerdrTheme(themeMode = mode) {
                    NotificationOpeningScreen(onCancel = {}, openingConversation = conversation)
                }
            }
        }
    }

    @Test fun notificationLight() = render("notification-opening-light")
    @Test fun notificationDark() = render("notification-opening-dark", mode = ThemeMode.DARK)
    @Test fun initialConnection() = render("initial-connection", conversation = false)
    @Test fun narrowLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 800,
            xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        render("notification-opening-large-text", scale = 2f)
    }
}
