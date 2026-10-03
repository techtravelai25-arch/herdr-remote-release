package dev.herdr.remote

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontWeight

/** Render only terminal text and SGR styles. No terminal controls become UI text or actions. */
internal fun modelMenuAnsi(raw: String): AnnotatedString {
    val source = raw.take(65536)
    val out = AnnotatedString.Builder()
    var foreground = Color(0xFFE8EEF7); var background = Color.Transparent; var bold = false; var inverse = false
    var i = 0
    fun color(index: Int): Color {
        val base = intArrayOf(0x151515, 0xCC5555, 0x55AA55, 0xC8AA55, 0x5588CC, 0xAA66CC, 0x55AAAA, 0xDDDDDD,
            0x777777, 0xFF7777, 0x77DD77, 0xFFDD77, 0x77AAFF, 0xDD88FF, 0x77DDDD, 0xFFFFFF)
        val rgb = when {
            index < 16 -> base[index.coerceAtLeast(0)]
            index < 232 -> { val n = index - 16; fun channel(v: Int) = if (v == 0) 0 else 55 + v * 40
                (channel(n / 36) shl 16) or (channel(n / 6 % 6) shl 8) or channel(n % 6) }
            else -> { val v = 8 + (index.coerceAtMost(255) - 232) * 10; (v shl 16) or (v shl 8) or v }
        }
        return Color(0xFF000000L or rgb.toLong())
    }
    fun sgr(params: String) {
        val values = params.replace(':', ';').split(';').map { it.toIntOrNull() ?: 0 }
        var p = 0
        while (p < values.size) {
            val n = values[p++]
            when (n) {
                0 -> { foreground = Color(0xFFE8EEF7); background = Color.Transparent; bold = false; inverse = false }
                1 -> bold = true
                22 -> bold = false
                7 -> inverse = true
                27 -> inverse = false
                in 30..37 -> foreground = color(n - 30)
                in 90..97 -> foreground = color(n - 90 + 8)
                in 40..47 -> background = color(n - 40)
                in 100..107 -> background = color(n - 100 + 8)
                39 -> foreground = Color(0xFFE8EEF7)
                49 -> background = Color.Transparent
                38, 48 -> {
                    val mode = values.getOrNull(p++)
                    val picked = when {
                        mode == 5 && p < values.size -> color(values[p++].coerceIn(0, 255))
                        mode == 2 && p + 2 < values.size -> Color(values[p++].coerceIn(0,255), values[p++].coerceIn(0,255), values[p++].coerceIn(0,255))
                        else -> null
                    }
                    if (picked != null) { if (n == 38) foreground = picked else background = picked }
                }
            }
        }
    }
    while (i < source.length) {
        if (source[i] == '\u001b') {
            i++
            when (source.getOrNull(i)) {
                '[' -> { i++; val start = i; while (i < source.length && source[i] !in '@'..'~') i++
                    if (i < source.length && source[i] == 'm') sgr(source.substring(start, i)); if (i < source.length) i++ }
                ']', 'P', '^', '_' -> { i++; while (i < source.length && source[i] != '\u0007' && !(source[i] == '\u001b' && source.getOrNull(i+1) == '\\')) i++
                    if (i < source.length) i += if (source[i] == '\u001b') 2 else 1 }
                else -> { if (i < source.length) i++ }
            }
            continue
        }
        val start = i
        while (i < source.length && source[i] != '\u001b') i++
        val text = source.substring(start, i).filter { !it.isISOControl() || it == '\n' || it == '\t' }
        val style = SpanStyle(color = if (inverse) background.takeUnless { it == Color.Transparent } ?: Color(0xFF0C131C) else foreground,
            background = if (inverse) foreground else background, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal)
        out.pushStyle(style); out.append(text); out.pop()
    }
    return out.toAnnotatedString()
}
