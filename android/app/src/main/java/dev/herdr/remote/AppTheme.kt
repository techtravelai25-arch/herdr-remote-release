package dev.herdr.remote

import android.content.Context
import androidx.core.content.edit
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape

enum class ThemeMode { SYSTEM, LIGHT, DARK }

fun decodeThemeMode(value: String?): ThemeMode = when (value?.lowercase()) {
    "light" -> ThemeMode.LIGHT
    "dark" -> ThemeMode.DARK
    else -> ThemeMode.SYSTEM
}

fun isDarkTheme(mode: ThemeMode, systemDark: Boolean): Boolean = when (mode) {
    ThemeMode.SYSTEM -> systemDark
    ThemeMode.LIGHT -> false
    ThemeMode.DARK -> true
}

class ThemePreference(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences("appearance", Context.MODE_PRIVATE)
    var mode by mutableStateOf(decodeThemeMode(preferences.getString(KEY_MODE, null)))
        private set

    fun updateMode(value: ThemeMode) {
        if (mode == value) return
        mode = value
        preferences.edit { putString(KEY_MODE, value.name.lowercase()) }
    }

    private companion object { const val KEY_MODE = "theme_mode" }
}

@Composable
fun rememberThemePreference(context: Context = LocalContext.current): ThemePreference =
    remember(context.applicationContext) { ThemePreference(context.applicationContext) }

val LocalThemePreference = staticCompositionLocalOf<ThemePreference> {
    error("ThemePreference is only available inside HerdrTheme")
}

private val LightScheme = lightColorScheme(
    primary = Color(0xFFB54509), onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDBC4), onPrimaryContainer = Color(0xFF47200B),
    secondary = Color(0xFF526678), onSecondary = Color.White,
    secondaryContainer = Color(0xFFE1EAF2), onSecondaryContainer = Color(0xFF162638),
    tertiary = Color(0xFF276A55), onTertiary = Color.White,
    tertiaryContainer = Color(0xFFBCEED9), onTertiaryContainer = Color(0xFF002116),
    error = Color(0xFFBA1A1A), onError = Color.White,
    errorContainer = Color(0xFFFFDAD6), onErrorContainer = Color(0xFF410002),
    background = Color(0xFFF2F5F7), onBackground = Color(0xFF162638),
    surface = Color.White, onSurface = Color(0xFF162638),
    surfaceVariant = Color(0xFFE0E5EA), onSurfaceVariant = Color(0xFF526272),
    outline = Color(0xFF718091), outlineVariant = Color(0xFFD3DCE4),
    scrim = Color.Black, inverseSurface = Color(0xFF26394D), inverseOnSurface = Color(0xFFE8EEF7), inversePrimary = Color(0xFFFFAE74),
    surfaceDim = Color(0xFFD8E0E7), surfaceBright = Color.White,
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFECF1F5),
    surfaceContainer = Color(0xFFE7EDF2), surfaceContainerHigh = Color(0xFFE1E8EF), surfaceContainerHighest = Color(0xFFDAE3EC)
)

private val DarkScheme = darkColorScheme(
    primary = Color(0xFFFFAE74), onPrimary = Color(0xFF47200B),
    primaryContainer = Color(0xFF74310B), onPrimaryContainer = Color(0xFFFFDBC4),
    secondary = Color(0xFFB7CADD), onSecondary = Color(0xFF26394D),
    secondaryContainer = Color(0xFF3B5065), onSecondaryContainer = Color(0xFFE1EAF2),
    tertiary = Color(0xFFA0D2BC), onTertiary = Color(0xFF083828),
    tertiaryContainer = Color(0xFF20503F), onTertiaryContainer = Color(0xFFBCEED9),
    error = Color(0xFFFFB4AB), onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF0C131C), onBackground = Color(0xFFE8EEF7),
    surface = Color(0xFF14202E), onSurface = Color(0xFFE8EEF7),
    surfaceVariant = Color(0xFF304051), onSurfaceVariant = Color(0xFFA7B6C7),
    outline = Color(0xFF899EB3), outlineVariant = Color(0xFF304051),
    scrim = Color.Black, inverseSurface = Color(0xFFE8EEF7), inverseOnSurface = Color(0xFF26394D), inversePrimary = Color(0xFFB54509),
    surfaceDim = Color(0xFF0C131C), surfaceBright = Color(0xFF34495F),
    surfaceContainerLowest = Color(0xFF080F17), surfaceContainerLow = Color(0xFF14202E),
    surfaceContainer = Color(0xFF192939), surfaceContainerHigh = Color(0xFF213448), surfaceContainerHighest = Color(0xFF2B4056)
)

/** Stable hero contrast in either appearance, matching the Mission Status concept. */
internal object MissionPalette {
    val Hero = Color(0xFF14273B)
    val OnHero = Color.White
    val HeroMuted = Color(0xFFBBCAD9)
    val Accent = Color(0xFFFFBC86)
    val OnAccent = Color(0xFF47200B)
}

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp), small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp), extraLarge = RoundedCornerShape(28.dp)
)

private val AppTypography = Typography()

fun appColorScheme(dark: Boolean): ColorScheme = if (dark) DarkScheme else LightScheme

@Composable
fun HerdrTheme(themeMode: ThemeMode = ThemeMode.SYSTEM, preference: ThemePreference? = null, content: @Composable () -> Unit) {
    val dark = isDarkTheme(themeMode, isSystemInDarkTheme())
    if (preference == null) MaterialTheme(colorScheme = appColorScheme(dark), typography = AppTypography, shapes = AppShapes, content = content)
    else CompositionLocalProvider(LocalThemePreference provides preference) {
        MaterialTheme(colorScheme = appColorScheme(dark), typography = AppTypography, shapes = AppShapes, content = content)
    }
}
