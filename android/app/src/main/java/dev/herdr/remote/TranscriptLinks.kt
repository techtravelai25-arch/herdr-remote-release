package dev.herdr.remote

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext

internal val LocalHtmlPreviewOpener = staticCompositionLocalOf<((String) -> Unit)?> { null }

@Composable internal fun rememberTranscriptLinkOpener(): (String) -> Unit {
    val context = LocalContext.current
    val preview = LocalHtmlPreviewOpener.current
    return remember(context, preview) { { target ->
        val local = localHtmlTarget(target)
        if (local != null && preview != null) preview(local) else openWebLink(context, target)
        Unit
    } }
}
