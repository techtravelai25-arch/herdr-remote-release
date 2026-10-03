package dev.herdr.remote

import android.graphics.Color
import android.widget.ImageView
import android.widget.LinearLayout
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.Density
import org.junit.Rule
import org.junit.Test

class LogoPreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5.copy(
        screenWidth = 360, screenHeight = 360, xdpi = 160, ydpi = 160, density = Density.MEDIUM),
        theme = "android:Theme.Material.NoActionBar")

    @Test fun logoAndLauncher() {
        val context = paparazzi.context
        val layout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setBackgroundColor(Color.rgb(20, 39, 59))
        }
        layout.addView(ImageView(context).apply { setImageResource(R.drawable.herdr_remote_logo) },
            LinearLayout.LayoutParams(200, 200))
        val row = LinearLayout(context).apply { gravity = android.view.Gravity.CENTER }
        // Layoutlib has no launcher-supplied adaptive mask; inspect the actual
        // foreground artwork here. Device launchers provide their own mask.
        row.addView(ImageView(context).apply { setImageResource(R.drawable.ic_launcher_foreground) }, LinearLayout.LayoutParams(72, 72))
        row.addView(ImageView(context).apply { setImageResource(R.drawable.ic_notification_herdr) },
            LinearLayout.LayoutParams(24, 24).apply { marginStart = 36 })
        layout.addView(row)
        paparazzi.snapshot(layout, name = "herdr-logo-launcher-notification")
    }
}
