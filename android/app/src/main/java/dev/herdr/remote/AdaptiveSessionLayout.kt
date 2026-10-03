package dev.herdr.remote

import androidx.compose.foundation.layout.*
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Compact navigation drills into a session; wide windows keep its list in view. */
@Composable internal fun AdaptiveSessionLayout(sessions: @Composable () -> Unit, conversation: @Composable () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        if (maxWidth >= 840.dp) {
            Row(Modifier.fillMaxSize()) {
                Box(Modifier.width(320.dp).fillMaxHeight()) { sessions() }
                VerticalDivider()
                Box(Modifier.weight(1f).fillMaxHeight()) { conversation() }
            }
        } else conversation()
    }
}
