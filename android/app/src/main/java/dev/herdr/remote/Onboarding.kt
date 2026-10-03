package dev.herdr.remote

import android.content.Context
import android.provider.Settings
import androidx.core.content.edit
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal fun shouldShowFirstRunGuide(seen: Boolean, firstInstallTime: Long, lastUpdateTime: Long, hasNotification: Boolean): Boolean =
    !seen && !hasNotification && lastUpdateTime - firstInstallTime < 10_000

internal fun firstRunGuideSeen(context: Context): Boolean =
    context.getSharedPreferences("first_run_guide", Context.MODE_PRIVATE).getBoolean("seen", false)

internal fun markFirstRunGuideSeen(context: Context) {
    context.getSharedPreferences("first_run_guide", Context.MODE_PRIVATE).edit { putBoolean("seen", true) }
}

private data class GuidePage(val title: String, val body: String, val action: String)
private val guidePages = listOf(
    GuidePage("Set up your PC first", "Your agents run on your Linux PC. Install the companion there once, then connect this phone.", "Next"),
    GuidePage("Pair with your own QR", "Tap Scan laptop QR on the connection screen and scan the short-lived code shown on your PC. Email is optional; it cannot replace pairing.", "Next"),
    GuidePage("Review before you act", "See the current laptop and session before sending a decision or file. Keep your laptop online to load conversations and send actions.", "Connect my laptop"),
)

internal const val COMMUNITY_SETUP_URL = "https://github.com/techtravelai25-arch/herdr-remote-release/blob/main/docs/setup.md"

/** Community builds without a configured portal must not produce a relative /setup link. */
internal fun pcSetupUrl(origin: String = BuildConfig.PORTAL_ORIGIN): String? {
    val url = origin.toHttpUrlOrNull() ?: return null
    if (!url.isHttps || url.username.isNotEmpty() || url.password.isNotEmpty() ||
        url.encodedPath != "/" || url.query != null || url.fragment != null) return null
    return url.newBuilder().addPathSegment("setup").build().toString()
}

@Composable internal fun PcSetupInstructions(setupUrl: String? = pcSetupUrl(), onOpenSetup: (String) -> Boolean) {
    val effectiveSetupUrl = setupUrl ?: COMMUNITY_SETUP_URL
    var browserUnavailable by remember(effectiveSetupUrl) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("1. Open this link on your Linux PC", style = MaterialTheme.typography.titleMedium)
            SelectionContainer {
                Text(effectiveSetupUrl, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary)
            }
            Text("Type this address into your PC’s browser. The companion installs on your PC, not on this phone.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick = {
                browserUnavailable = !onOpenSetup(effectiveSetupUrl)
            }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Icon(Icons.Default.OpenInNew, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Open PC setup page")
            }
            if (browserUnavailable) Text("No browser is available on this phone. Open the address above on your PC.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("2. Install the PC companion", style = MaterialTheme.typography.titleMedium)
            Text("Follow the setup page to download and install Herdr Remote.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("3. Generate your pairing QR", style = MaterialTheme.typography.titleMedium)
            Text("Setup shows a QR code. To generate a fresh one, run this on your PC:",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            SelectionContainer {
                Text("herdr-remote pair", style = MaterialTheme.typography.bodyLarge, fontFamily = FontFamily.Monospace)
            }
            Text("Then tap Scan laptop QR on this phone and scan the code on your PC.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun animationEnabled(context: Context): Boolean = runCatching {
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
}.getOrDefault(true)

/** The device diagram is an example, never a simulated live session. */
@Composable private fun GuideIllustration(page: Int) {
    val navy = Color(0xFF14273B)
    val cream = Color(0xFFF5F8FC)
    val orange = Color(0xFFFFBC86)
    Surface(
        modifier = Modifier.fillMaxWidth().height(230.dp).semantics { contentDescription = "Illustration of a laptop paired with a phone" },
        shape = RoundedCornerShape(28.dp), color = navy,
    ) {
        Box(Modifier.fillMaxSize().padding(20.dp)) {
            Box(Modifier.width(210.dp).height(132.dp).align(Alignment.CenterStart).padding(top = 12.dp)) {
                Surface(Modifier.fillMaxWidth().height(112.dp), shape = RoundedCornerShape(10.dp),
                    color = Color(0xFF30465B), border = androidx.compose.foundation.BorderStroke(2.dp, Color(0xFF7890A4))) {
                    Column(Modifier.padding(13.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(Icons.Default.Terminal, null, Modifier.size(20.dp), tint = orange)
                            Box(Modifier.width(90.dp).height(6.dp).clip(RoundedCornerShape(50)).background(cream.copy(alpha = 0.65f)))
                        }
                        Box(Modifier.fillMaxWidth(0.78f).height(6.dp).clip(RoundedCornerShape(50)).background(cream.copy(alpha = 0.42f)))
                        Box(Modifier.fillMaxWidth(0.55f).height(6.dp).clip(RoundedCornerShape(50)).background(cream.copy(alpha = 0.42f)))
                    }
                }
                Box(Modifier.fillMaxWidth().height(7.dp).align(Alignment.BottomCenter).clip(RoundedCornerShape(50)).background(Color(0xFF7890A4)))
            }
            Surface(
                modifier = Modifier.width(94.dp).height(166.dp).align(Alignment.BottomEnd),
                shape = RoundedCornerShape(19.dp), color = Color(0xFF0B1723),
                border = androidx.compose.foundation.BorderStroke(2.dp, orange),
            ) {
                Box(Modifier.padding(7.dp).clip(RoundedCornerShape(13.dp)).background(cream), contentAlignment = Alignment.Center) {
                    when (page) {
                        0 -> Icon(Icons.Default.ChatBubbleOutline, null, Modifier.size(39.dp), tint = navy)
                        1 -> QrIllustration(navy)
                        else -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(7.dp)) {
                            Icon(Icons.Default.HelpOutline, null, Modifier.size(29.dp), tint = navy)
                            Box(Modifier.width(49.dp).height(5.dp).background(navy.copy(alpha = 0.5f)))
                            Surface(Modifier.width(58.dp).height(23.dp), shape = RoundedCornerShape(7.dp), color = orange) {}
                        }
                    }
                }
            }
            Surface(Modifier.align(Alignment.BottomStart), shape = RoundedCornerShape(50), color = orange) {
                Icon(when (page) { 0 -> Icons.Default.ArrowForward; 1 -> Icons.Default.Lock; else -> Icons.Default.VerifiedUser },
                    null, Modifier.padding(10.dp).size(22.dp), tint = navy)
            }
        }
    }
}

@Composable private fun QrIllustration(ink: Color) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        val rows = listOf("1110101", "1011101", "1110101", "0001010", "1110111", "1011001", "1110101")
        rows.forEach { row -> Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            row.forEach { bit -> Box(Modifier.size(5.dp).background(if (bit == '1') ink else Color.Transparent)) }
        } }
    }
}

@Composable private fun GuidePageContent(page: Int) {
    val context = LocalContext.current
    val current = guidePages[page]
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        if (page != 0) GuideIllustration(page)
        Text(current.title, style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.SemiBold)
        Text(current.body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (page == 0) PcSetupInstructions(onOpenSetup = { openWebLink(context, it) })
        if (page == 2) Text("You can inspect an answer and cancel before it leaves this phone.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable internal fun FirstRunGuide(onDone: () -> Unit, initialPage: Int = 0, finalAction: String = "Connect my laptop") {
    var page by rememberSaveable { mutableIntStateOf(initialPage.coerceIn(guidePages.indices)) }
    val context = LocalContext.current
    val animate = remember(context) { animationEnabled(context) }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = 20.dp, vertical = 8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDone, modifier = Modifier.heightIn(min = 48.dp)) { Text("Skip") }
            }
            Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
                if (animate) AnimatedContent(targetState = page, transitionSpec = {
                    (fadeIn(tween(240)) + slideInHorizontally(tween(300)) { it / 6 }) togetherWith
                        (fadeOut(tween(90)) + slideOutHorizontally(tween(180)) { -it / 9 })
                }, label = "Getting started step") { GuidePageContent(it) }
                else GuidePageContent(page)
            }
            Spacer(Modifier.height(12.dp))
            Text("${page + 1} of ${guidePages.size}", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            LinearProgressIndicator(progress = { (page + 1f) / guidePages.size }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(16.dp))
            Button(onClick = { if (page == guidePages.lastIndex) onDone() else page++ },
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text(if (page == guidePages.lastIndex) finalAction else guidePages[page].action) }
            if (page > 0) TextButton(onClick = { page-- }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Back") }
        }
    }
}
