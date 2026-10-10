package dev.herdr.remote

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/** Present only the bridge's current, identified question; terminal text never supplies choices. */
@Composable internal fun TerminalQuestionCard(
    question: BridgeQuestion?,
    reviewAvailable: Boolean,
    revealPending: Boolean,
    enabled: Boolean,
    attachmentId: String?,
    receiptId: String?,
    message: String?,
    onReviewQuestion: () -> Unit,
    onAnswerQuestion: (Int?, String?) -> Unit,
    onCancelQuestion: () -> Unit = {},
) {
    val validQuestion = question?.takeIf { it.isValid() }
    if (validQuestion == null && !reviewAvailable && !revealPending) return
    var requested by remember(validQuestion?.id, validQuestion?.stage, attachmentId, receiptId, message) {
        mutableStateOf(false)
    }
    var writtenAnswer by remember(validQuestion?.id, validQuestion?.stage, attachmentId) { mutableStateOf("") }
    val questionScroll = rememberScrollState()
    LaunchedEffect(validQuestion?.id, validQuestion?.stage) { questionScroll.scrollTo(0) }
    val canAct = enabled && !revealPending && !requested

    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.5f)),
        shape = MaterialTheme.shapes.medium) {
        Column(Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(questionScroll)
            .padding(horizontal = 12.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (validQuestion == null) {
                Text("Question waiting in terminal", style = MaterialTheme.typography.titleSmall)
                Text("Open the current question to read it and answer.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Button(onClick = { requested = true; onReviewQuestion() }, enabled = canAct,
                    modifier = Modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 16.dp)) {
                    Text(if (revealPending) "Opening question…" else "Review question")
                }
            } else {
                Text(when {
                    validQuestion.kind == "claude_trust" -> "Claude Code folder trust"
                    validQuestion.stage == "review" -> "Review and submit answers"
                    else -> "Answer the question"
                }, style = MaterialTheme.typography.titleSmall)
                Text(validQuestion.prompt, style = MaterialTheme.typography.bodyMedium)
                if (validQuestion.stage == "multi") Text("Tap to select or clear an option. Then choose Next or Submit.",
                    style = MaterialTheme.typography.bodySmall)
                if (validQuestion.stage == "text") {
                    OutlinedTextField(writtenAnswer, { value ->
                        if (value.length <= 500 && value.none { it.code < 0x20 || it.code in 0x7f..0x9f }) writtenAnswer = value
                    },
                        modifier = Modifier.fillMaxWidth(), enabled = enabled && !requested,
                        label = { Text("Your answer") }, singleLine = true,
                        supportingText = { Text("Up to 500 characters") })
                    Button(onClick = { requested = true; onAnswerQuestion(null, writtenAnswer.trim()) },
                        enabled = canAct && validQuestionAnswer(writtenAnswer),
                        modifier = Modifier.heightIn(min = 48.dp)) { Text("Send answer") }
                } else validQuestion.options.forEachIndexed { index, label ->
                    val select = { requested = true; onAnswerQuestion(index, null) }
                    val selected = if (validQuestion.multiSelect) index in validQuestion.selectedOptions else index == validQuestion.selectedIndex
                    val displayLabel = if (validQuestion.multiSelect && index in validQuestion.selectedOptions) "✓ $label" else label
                    if (selected) FilledTonalButton(onClick = select,
                        enabled = canAct, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp)) {
                        Text(displayLabel, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Start)
                    } else OutlinedButton(onClick = select,
                        enabled = canAct, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp)) {
                        Text(displayLabel, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Start)
                    }
                }
                if (validQuestion.cancelAvailable) TextButton(onClick = { requested = true; onCancelQuestion() }, enabled = canAct) {
                    Text("Cancel question")
                }
            }
        }
    }
}
