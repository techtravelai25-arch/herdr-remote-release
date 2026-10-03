package dev.herdr.remote

import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DashboardStatusTest {
    @Test fun actualStatesRemainDistinct() {
        assertEquals(DashboardStatus.WORKING, dashboardStatus("working"))
        assertEquals(DashboardStatus.IDLE, dashboardStatus("idle"))
        assertEquals(DashboardStatus.DONE, dashboardStatus("done"))
        assertEquals(DashboardStatus.BLOCKED, dashboardStatus("blocked"))
        assertEquals(DashboardStatus.WAITING, dashboardStatus("needs_input"))
        assertEquals(DashboardStatus.WAITING, dashboardStatus("needs-input"))
        assertEquals(DashboardStatus.ERROR, dashboardStatus("error"))
        assertEquals(DashboardStatus.UNKNOWN, dashboardStatus("delivered"))
        assertEquals(DashboardStatus.UNKNOWN, dashboardStatus("future_status"))
        assertEquals("Starting", dashboardStatusLabel("starting"))
        assertEquals("Status unavailable", dashboardStatusLabel(""))
    }

    @Test fun everyBadgeHasReadableTextInBothThemesIncludingStale() {
        for (dark in listOf(false, true)) for (stale in listOf(false, true)) {
            for (status in DashboardStatus.entries) {
                val colors = dashboardStatusColors(status, appColorScheme(dark), stale)
                val ratio = (maxOf(colors.foreground.luminance(), colors.container.luminance()) + .05f) /
                    (minOf(colors.foreground.luminance(), colors.container.luminance()) + .05f)
                assertTrue("$status dark=$dark stale=$stale contrast=$ratio", ratio >= 4.5f)
                if (stale) assertEquals(appColorScheme(dark).onSurfaceVariant, colors.foreground)
            }
        }
    }
}
