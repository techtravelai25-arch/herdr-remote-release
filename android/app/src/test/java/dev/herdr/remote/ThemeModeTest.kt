package dev.herdr.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance

class ThemeModeTest {
    @Test fun decodesKnownModesAndFallsBackToSystem() {
        assertEquals(ThemeMode.LIGHT, decodeThemeMode("light"))
        assertEquals(ThemeMode.DARK, decodeThemeMode("DARK"))
        assertEquals(ThemeMode.SYSTEM, decodeThemeMode(null))
        assertEquals(ThemeMode.SYSTEM, decodeThemeMode("unknown"))
    }

    @Test fun resolvesExplicitModesBeforeSystemPreference() {
        assertTrue(isDarkTheme(ThemeMode.DARK, false))
        assertTrue(isDarkTheme(ThemeMode.DARK, true))
        assertFalse(isDarkTheme(ThemeMode.LIGHT, false))
        assertFalse(isDarkTheme(ThemeMode.LIGHT, true))
    }

    @Test fun systemModeFollowsSystemPreference() {
        assertTrue(isDarkTheme(ThemeMode.SYSTEM, true))
        assertFalse(isDarkTheme(ThemeMode.SYSTEM, false))
    }

    @Test fun representativeTextAndErrorColorsMeetReadableContrast() {
        fun ratio(foreground: Color, background: Color): Float {
            val lighter = maxOf(foreground.luminance(), background.luminance())
            val darker = minOf(foreground.luminance(), background.luminance())
            return (lighter + 0.05f) / (darker + 0.05f)
        }
        for (scheme in listOf(appColorScheme(false), appColorScheme(true))) {
            assertTrue(ratio(scheme.onSurface, scheme.surface) >= 4.5f)
            assertTrue(ratio(scheme.onSurfaceVariant, scheme.surface) >= 4.5f)
            assertTrue(ratio(scheme.onError, scheme.error) >= 4.5f)
        }
    }
    @Test fun missionStatusActionAndContainerTextMeetReadableContrast() {
        fun assertReadable(name: String, foreground: Color, background: Color) {
            val lighter = maxOf(foreground.luminance(), background.luminance())
            val darker = minOf(foreground.luminance(), background.luminance())
            val ratio = (lighter + 0.05f) / (darker + 0.05f)
            assertTrue("$name contrast $ratio must meet 4.5:1 for normal text", ratio >= 4.5f)
        }
        for (dark in listOf(false, true)) {
            val scheme = appColorScheme(dark)
            val mode = if (dark) "dark" else "light"
            assertReadable("$mode primary action", scheme.onPrimary, scheme.primary)
            assertReadable("$mode attention card", scheme.onPrimaryContainer, scheme.primaryContainer)
            assertReadable("$mode secondary card", scheme.onSecondaryContainer, scheme.secondaryContainer)
            assertReadable("$mode success badge", scheme.onTertiaryContainer, scheme.tertiaryContainer)
            assertReadable("$mode failure badge", scheme.onErrorContainer, scheme.errorContainer)
            assertReadable("$mode composer", scheme.onSurface, scheme.surfaceContainer)
            assertReadable("$mode muted composer text", scheme.onSurfaceVariant, scheme.surfaceContainer)
            assertReadable("$mode background text", scheme.onBackground, scheme.background)
        }
        assertReadable("hero title", MissionPalette.OnHero, MissionPalette.Hero)
        assertReadable("hero metadata", MissionPalette.HeroMuted, MissionPalette.Hero)
        assertReadable("hero accent label", MissionPalette.Accent, MissionPalette.Hero)
        assertReadable("hero action", MissionPalette.OnAccent, MissionPalette.Accent)
    }

}
