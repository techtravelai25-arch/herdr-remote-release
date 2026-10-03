package dev.herdr.remote

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.unit.dp
import kotlin.math.sqrt

internal data class VoiceRecordingState(
    val recording: Boolean = false,
    val transcribing: Boolean = false,
    val seconds: Int = 0,
    val levels: List<Float> = emptyList(),
)

/** Bounded, actual microphone history. Reset between recordings and before transcription. */
internal class VoiceLevelHistory {
    private var previous = 0f
    private var history = emptyList<Float>()

    fun sample(amplitude: Int): List<Float> {
        // A small noise floor keeps digital silence and room noise from looking like speech.
        val target = sqrt(((amplitude.coerceIn(0, 32767) - 180).coerceAtLeast(0) / 32587f))
        val smoothed = previous + (target - previous) * if (target > previous) 0.65f else 0.3f
        previous = if (smoothed < 0.008f) 0f else smoothed.coerceIn(0f, 1f)
        history = (history + previous).takeLast(20)
        return history
    }

    fun reset() {
        previous = 0f
        history = emptyList()
    }
}

/** Replaces the draft field only while voice capture is busy; controls remain beside it. */
@Composable
internal fun VoiceRecordingFeedback(state: VoiceRecordingState, modifier: Modifier = Modifier) {
    Surface(modifier, color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.medium) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                if (state.transcribing) "Transcribing…" else "Recording",
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.clearAndSetSemantics {
                    contentDescription = if (state.transcribing) "Transcribing voice input" else "Recording voice input"
                    liveRegion = LiveRegionMode.Polite
                },
            )
            if (state.transcribing) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(18.dp).clearAndSetSemantics {}, strokeWidth = 2.dp)
                    Text("Preparing your draft", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                SoundHistory(state.levels)
                val elapsed = state.seconds.coerceIn(0, 120)
                Text(
                    "${elapsed / 60}:${(elapsed % 60).toString().padStart(2, '0')} / 2:00 max",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SoundHistory(levels: List<Float>) {
    // Fixed slots animate measured samples smoothly. Compose observes the system duration scale.
    val samples = List((20 - levels.size).coerceAtLeast(0)) { 0f } + levels.takeLast(20)
    val animated = samples.map { level ->
        val value by animateFloatAsState(if (level.isFinite()) level.coerceIn(0f, 1f) else 0f, tween(100), label = "Microphone level")
        value
    }
    val color = MaterialTheme.colorScheme.primary
    Canvas(Modifier.fillMaxWidth().height(24.dp).clearAndSetSemantics {}) {
        val step = size.width / 20f
        val stroke = minOf(3.dp.toPx(), step * 0.45f)
        animated.forEachIndexed { index, level ->
            val barHeight = 2.dp.toPx() + (size.height - 2.dp.toPx()) * level
            val x = (index + 0.5f) * step
            drawLine(color, Offset(x, (size.height - barHeight) / 2), Offset(x, (size.height + barHeight) / 2), stroke, StrokeCap.Round)
        }
    }
}
