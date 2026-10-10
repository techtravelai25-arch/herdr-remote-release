package dev.herdr.remote

import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Keep presentation metadata with the text, so live status changes cannot recrop a held reply. */
private data class TerminalReadingSnapshot(val text: String, val kind: String, val status: String, val truncated: Boolean) {
    fun display(full: Boolean): ConversationTerminalText =
        if (full) ConversationTerminalText(text, false) else conversationTerminalText(text, kind, status)
}

/** A bounded Herdr text snapshot. Text is displayed, never interpreted as a vendor UI. */
@Composable internal fun TerminalLiveView(
    state: RemoteState,
    pane: Pane?,
    onDraft: (String) -> Unit,
    onInsert: (String) -> Unit,
    onPrompt: (String) -> Unit,
    onKey: (String) -> Unit,
    onRefresh: () -> Unit,
    onAttach: () -> Unit,
    onRemoveAttachment: (Uri) -> Unit,
    onManageAttachments: () -> Unit,
    onBrowseFiles: () -> Unit,
    onCheckDelivery: (String) -> Unit,
    onChangeModel: () -> Unit = {},
    onOpenHistory: () -> Unit = {},
    onEarlierHistory: () -> Unit = {},
    onAcknowledgeDelivery: (String) -> Unit = {},
    onReviewQuestion: () -> Unit = {},
    onAnswerQuestion: (Int?, String?) -> Unit = { _, _ -> },
    onCancelQuestion: () -> Unit = {},
) {
    val paneId = pane?.id ?: state.selectedId
    val draft = paneId?.let { state.drafts[it] }.orEmpty()
    val unresolvedDelivery = paneId?.let { state.deliveries[it]?.isUnresolved() } == true
    val connected = state.online && state.snapshot.herdrOnline && !state.snapshot.stale
    val attached = connected && pane != null && state.outputReady && state.terminalAttachmentId != null
    val nativeQuestion = state.question?.takeIf { state.snapshot.questionSelectionEnabled && it.isValid() }
    val hasNativeQuestion = state.snapshot.questionSelectionEnabled &&
        (nativeQuestion != null || state.questionReviewAvailable || state.questionPending)
    val readingIdentity = listOf(state.url, state.portalDeviceId, paneId, state.terminalAttachmentId)
    var nativeTerminalControls by remember(readingIdentity) { mutableStateOf(false) }
    LaunchedEffect(hasNativeQuestion) { if (!hasNativeQuestion) nativeTerminalControls = false }
    val canPaneControl = attached && state.snapshot.terminalInputEnabled && state.snapshot.canControl && !state.busy &&
        !unresolvedDelivery && !state.modelMenuPending && state.agentModelMenu == null &&
        (pane?.kind != "terminal" || state.snapshot.allowTerminalInput)
    val canQuestionAct = canPaneControl && pane?.kind in setOf("codex", "claude") && state.selectedId == pane?.id && !state.questionPending
    val canInput = canPaneControl && ((!hasNativeQuestion && !state.questionPending) || nativeTerminalControls)
    val canPrompt = canInput && pane?.kind != "terminal" && !hasNativeQuestion
    val canPickModel = canInput && !hasNativeQuestion && canChangeAgentModel(state, pane) && !state.modelMenuPending
    val modelButtonEnabled = canInput && !hasNativeQuestion && supportsModelSelection(state.snapshot, pane)
    val needsInput = pane?.status in setOf("blocked", "needs_input", "needs-input") || hasNativeQuestion
    // File selection is local; prompt() checks the fresh pane attachment before uploading.
    val canPickFile = connected && pane != null && pane.kind != "terminal" && !state.modelMenuPending && state.agentModelMenu == null &&
        state.snapshot.canControl && state.snapshot.attachmentsEnabled && !state.busy && !hasNativeQuestion && !state.questionPending
    val attachments = paneId?.let { state.attachments[it] }.orEmpty()
    val vertical = rememberScrollState()
    val horizontal = rememberScrollState()
    val outer = rememberScrollState()
    // One bounded, memory-only snapshot. Polling and live control state continue independently.
    // Never save terminal contents to saved-instance state or carry a hold to another attachment.
    var heldOutput by remember(readingIdentity) { mutableStateOf<TerminalReadingSnapshot?>(null) }
    val follow = heldOutput == null
    var wrap by rememberSaveable(paneId) { mutableStateOf(true) }
    var exactSpacing by rememberSaveable(paneId) { mutableStateOf(pane?.kind == "terminal") }
    var showFullTerminal by rememberSaveable(paneId) { mutableStateOf(false) }
    // A saved transcript separates what you wrote from the reply and leaves out the agent's input box and
    // status chrome. The raw terminal stays one tap away and is the fallback whenever no transcript exists.
    var rawTerminal by rememberSaveable(paneId) { mutableStateOf(false) }
    // Saved history does not contain live approval menus. Prefer the live snapshot for
    // terminal-only questions without changing the user's normal reading preference.
    // A queued or opening question has no readable native card yet. Keep its
    // live terminal visible until the bridge supplies the actual question.
    val terminalQuestion = needsInput && (nativeQuestion == null || nativeTerminalControls)
    var reviewConversation by remember(readingIdentity, terminalQuestion) { mutableStateOf(false) }
    val showTerminal = if (terminalQuestion) !reviewConversation else rawTerminal
    val history = state.structuredHistory?.takeIf { pane != null && pane.kind != "terminal" && it.available && it.messages.isNotEmpty() }
    val transcript = history != null && !showTerminal
    val loadingTranscript = pane != null && pane.kind != "terminal" && state.structuredHistory == null && state.historyLoading && !showTerminal
    LaunchedEffect(readingIdentity, terminalQuestion) { if (terminalQuestion) heldOutput = null }
    var fontSize by rememberSaveable(paneId) { mutableFloatStateOf(15f) }
    var showKeys by rememberSaveable(paneId) { mutableStateOf(false) }
    var moreKeys by rememberSaveable(paneId) { mutableStateOf(false) }
    var options by remember { mutableStateOf(false) }
    var voiceBusy by remember(paneId) { mutableStateOf(false) }
    var voiceStatus by remember(paneId) { mutableStateOf<String?>(null) }
    var reviewAttachments by remember(paneId) { mutableStateOf(false) }
    var fileMenu by remember { mutableStateOf(false) }
    var modelNotice by rememberSaveable(paneId) { mutableStateOf<String?>(null) }
    var acknowledgeReceipt by remember(paneId) { mutableStateOf<String?>(null) }
    LaunchedEffect(canPickModel) { if (canPickModel) modelNotice = null }
    val requestModel = {
        if (canPickModel) { modelNotice = null; onChangeModel() }
        else modelNotice = modelUnavailableMessage(state, pane)
    }
    val context = LocalContext.current
    val openLink = rememberTranscriptLinkOpener()
    val latestOutput = remember(state.output, pane?.kind, pane?.status, state.outputTruncated) {
        TerminalReadingSnapshot(state.output, pane?.kind ?: "terminal", pane?.status ?: "unknown", state.outputTruncated)
    }
    val currentOutput by rememberUpdatedState(latestOutput.takeIf { state.outputReady })
    val readingOutput = heldOutput ?: latestOutput
    val display = remember(readingOutput, showFullTerminal) { readingOutput.display(showFullTerminal) }
    val latestDisplay = remember(latestOutput, showFullTerminal) { latestOutput.display(showFullTerminal) }
    val newOutput = !follow && state.outputReady && latestDisplay.text != display.text
    val scrollObserver = remember(readingIdentity) { object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            if (source == NestedScrollSource.UserInput && available.y > 0 && vertical.maxValue > 0 && heldOutput == null)
                heldOutput = currentOutput
            return Offset.Zero
        }
    } }
    LaunchedEffect(vertical, display.text, follow, state.outputReady) { if (follow && state.outputReady) vertical.scrollTo(vertical.maxValue) }
    LaunchedEffect(vertical, vertical.maxValue, follow) { if (follow && state.outputReady) vertical.scrollTo(vertical.maxValue) }

    // Measure the surrounding controls, since their height changes with draft lines, text scale,
    // questions, receipts, and the keyboard. Give the reader room to show several output lines;
    // the outer scroll then carries the extra controls on short screens.
    BoxWithConstraints(Modifier.fillMaxSize().imePadding()) {
        var headerHeightPx by remember { mutableIntStateOf(0) }
        var controlsHeightPx by remember { mutableIntStateOf(0) }
        val density = LocalDensity.current
        val surroundingHeight = with(density) { (headerHeightPx + controlsHeightPx).toDp() }
        // Eight dp of vertical padding and two four-dp gaps between the three sections.
        val readerHeight = maxOf(128.dp, maxHeight - surroundingHeight - 16.dp)
        Column(Modifier.fillMaxWidth().verticalScroll(outer).heightIn(min = maxHeight)
            .padding(horizontal = 8.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Column(Modifier.fillMaxWidth().onSizeChanged { headerHeightPx = it.height },
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
            val status = when {
                !connected -> "Connection paused"
                !state.snapshot.canControl -> "Observer access"
                pane == null -> "Session unavailable"
                needsInput -> "Waiting for your decision"
                pane.status == "working" -> "Work in progress"
                pane.status == "done" -> "Ready to review"
                else -> pane.status.replace('_', ' ').replace('-', ' ').replaceFirstChar { it.uppercase() }
            }
            val accent = when {
                !connected || pane?.status == "error" -> MaterialTheme.colorScheme.error
                needsInput -> MaterialTheme.colorScheme.primary
                else -> MaterialTheme.colorScheme.secondary
            }
            Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainer,
                shape = MaterialTheme.shapes.medium) {
                Row(Modifier.height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(accent))
                    Column(Modifier.weight(1f).padding(start = 12.dp, bottom = 8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(status, style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Box {
                                IconButton(onClick = { options = true }) { Icon(Icons.Default.MoreVert, "Conversation options") }
                                DropdownMenu(expanded = options, onDismissRequest = { options = false }) {
                                    DropdownMenuItem(text = { Text("Refresh output") }, enabled = connected,
                                        onClick = { options = false; onRefresh() })
                                    DropdownMenuItem(text = { Text(if (exactSpacing) "Readable text" else "Exact terminal spacing") },
                                        onClick = { exactSpacing = !exactSpacing; options = false })
                                    if (history != null) DropdownMenuItem(
                                        text = { Text(if (showTerminal) "Show conversation" else "Show raw terminal") },
                                        onClick = {
                                            if (terminalQuestion) reviewConversation = !reviewConversation else rawTerminal = !rawTerminal
                                            options = false
                                        })
                                    if (pane?.kind != "terminal" && !transcript) DropdownMenuItem(
                                        text = { Text(if (showFullTerminal) "Hide idle input area" else "Show full terminal text") },
                                        onClick = { showFullTerminal = !showFullTerminal; options = false })
                                    DropdownMenuItem(text = { Text(if (wrap) "Wrap lines: on" else "Wrap lines: off") },
                                        onClick = { wrap = !wrap; options = false })
                                    DropdownMenuItem(text = { Text(if (follow) "Pause auto-scroll" else "Jump to latest") },
                                        enabled = state.outputReady,
                                        onClick = { heldOutput = if (follow) latestOutput else null; options = false })
                                    listOf(13f, 15f, 18f, 21f).forEach { size ->
                                        DropdownMenuItem(text = { Text("Text size: ${size.toInt()} sp${if (fontSize == size) " · selected" else ""}") },
                                            onClick = { fontSize = size; options = false })
                                    }
                                    HorizontalDivider()
                                    DropdownMenuItem(text = { Text("Browse project files") }, enabled = connected && pane != null,
                                        onClick = { options = false; onBrowseFiles() })
                                    DropdownMenuItem(text = { Text("Saved history") }, enabled = pane != null,
                                        onClick = { options = false; onOpenHistory() })
                                    if (pane?.kind in setOf("codex", "claude", "opencode")) DropdownMenuItem(
                                        text = { Text("Change model · current model unknown") }, enabled = modelButtonEnabled,
                                        onClick = { options = false; requestModel() })
                                }
                            }
                        }
                        val workspaceLabel = state.snapshot.workspaces.firstOrNull { it.id == pane?.workspaceId }?.label
                        Text(if (pane == null) "Choose another session" else
                            "${kindLabel(pane.kind)} · ${pane.lastActivity?.let { "Updated ${activityLabel(it)}" } ?: pane.projectLabel ?: workspaceLabel ?: state.snapshot.hostname}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            val notice = when {
                !connected -> "Showing the last snapshot. Reconnect before sending input."
                pane == null -> "This pane is no longer available."
                !state.snapshot.terminalInputEnabled -> "Update the laptop companion to enable terminal input."
                pane.kind == "terminal" && !state.snapshot.allowTerminalInput -> "Terminal input is disabled in the laptop settings."
                !state.snapshot.canControl -> "This connection is read-only."
                !attached -> "Waiting for a fresh pane attachment before input."
                unresolvedDelivery -> "A previous action may still be pending. Check delivery or inspect the laptop before sending another action."
                else -> null
            }
            notice?.let { Text(it, style = MaterialTheme.typography.labelSmall,
                color = if (canInput) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error) }
            Text(when {
                transcript -> "Conversation · ${kindLabel(pane?.kind.orEmpty())}"
                terminalQuestion -> "Live terminal question"
                readingOutput.truncated && display.footerHidden -> "Recent output · input area hidden · earlier content unavailable"
                readingOutput.truncated -> "Recent output · earlier content unavailable"
                display.footerHidden -> "Recent terminal output · input area hidden"
                else -> "Recent terminal output"
            },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (transcript && history != null) Surface(Modifier.fillMaxWidth().height(readerHeight), color = MaterialTheme.colorScheme.surface,
                shape = MaterialTheme.shapes.medium) {
                ConversationTranscript(history, kindLabel(pane?.kind.orEmpty()),
                    working = pane?.status in setOf("working", "running", "starting"),
                    sentPrompts = paneId?.let { state.sentPrompts[it] }.orEmpty(),
                    sentAtMs = paneId?.let { state.lastPromptAt[it] },
                    fontSize = fontSize, loadingEarlier = state.historyLoading, onEarlier = onEarlierHistory,
                    modifier = Modifier.fillMaxSize())
            } else if (loadingTranscript) Surface(Modifier.fillMaxWidth().height(readerHeight), color = MaterialTheme.colorScheme.surface,
                shape = MaterialTheme.shapes.medium) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("Loading conversation…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else Surface(Modifier.fillMaxWidth().height(readerHeight), color = MaterialTheme.colorScheme.surface,
                shape = MaterialTheme.shapes.medium) {
                Box(Modifier.fillMaxSize()) {
                    SelectionContainer {
                        Box(Modifier.fillMaxSize().nestedScroll(scrollObserver).verticalScroll(vertical)
                            .then(if (wrap) Modifier else Modifier.horizontalScroll(horizontal)).padding(12.dp)) {
                            val shown = remember(display.text, exactSpacing) { readableTerminalText(display.text, collapseRules = !exactSpacing) }
                            val styled = remember(shown, exactSpacing, openLink) {
                                buildAnnotatedString {
                                    append(shown)
                                    transcriptLinkRanges(shown).forEach { range ->
                                        val target = shown.substring(range.start, range.endExclusive)
                                        addLink(LinkAnnotation.Url(target) { openLink(target) }, range.start, range.endExclusive)
                                    }
                                    // Aligned columns need a fixed-width face even in readable text.
                                    if (!exactSpacing) boxTableRanges(shown).forEach { addStyle(SpanStyle(fontFamily = FontFamily.Monospace), it.first, it.last + 1) }
                                }
                            }
                            Text(if (!state.outputReady) AnnotatedString("Loading terminal snapshot…") else if (shown.isEmpty()) AnnotatedString("(no text in this snapshot)") else styled,
                                modifier = if (wrap) Modifier.fillMaxWidth() else Modifier,
                                fontFamily = if (exactSpacing) FontFamily.Monospace else FontFamily.Default,
                                fontSize = fontSize.sp, lineHeight = (fontSize * 1.4f).sp, softWrap = wrap)
                        }
                    }
                    // Overlaying the affordance keeps its arrival from resizing the reader's viewport.
                    if (!follow) FilledTonalButton(onClick = { heldOutput = null },
                        modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp)) {
                        Text(if (newOutput) "New output ↓" else "Jump to latest ↓")
                    }
                }
            }
            Column(Modifier.fillMaxWidth().onSizeChanged { controlsHeightPx = it.height },
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            if (hasNativeQuestion) TextButton(onClick = {
                nativeTerminalControls = !nativeTerminalControls
                reviewConversation = false
                heldOutput = null
            }) { Text(if (nativeTerminalControls) "Use answer buttons" else "Use terminal controls") }
            if (hasNativeQuestion && !nativeTerminalControls) TerminalQuestionCard(nativeQuestion, state.questionReviewAvailable,
                state.questionPending, canQuestionAct, state.terminalAttachmentId,
                paneId?.let { state.deliveries[it]?.id }, state.message,
                onReviewQuestion, onAnswerQuestion, onCancelQuestion)
            else if (needsInput) Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainer,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.5f)),
                shape = MaterialTheme.shapes.medium) {
                Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Answer in the terminal", style = MaterialTheme.typography.titleSmall)
                    if (transcript) TextButton(onClick = { reviewConversation = false; heldOutput = null }) {
                        Text("Show live question")
                    }
                    Text("Menu: Previous, Next, Confirm. Written answer: Send below. Active terminal text field: Insert text, then Confirm.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("Previous" to "up", "Next" to "down", "Confirm" to "enter", "Esc" to "esc").forEach { (label, key) ->
                            OutlinedButton(onClick = { onKey(key) }, enabled = canInput,
                                contentPadding = PaddingValues(horizontal = 3.dp),
                                modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                                Text(label, style = MaterialTheme.typography.labelMedium)
                            }
                        }
                    }
                }
            }
            if (state.modelMenuPending) Text("Opening model choices…", style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                if (pane?.kind != "terminal") Box {
                    IconButton(onClick = { fileMenu = true }, enabled = connected) {
                        Icon(Icons.Default.Add, "Attachment options${if (attachments.isEmpty()) "" else ", ${attachments.size} selected"}")
                    }
                    DropdownMenu(expanded = fileMenu, onDismissRequest = { fileMenu = false }) {
                        DropdownMenuItem(text = { Text("Attach files") }, enabled = canPickFile,
                            onClick = { fileMenu = false; onAttach() })
                        DropdownMenuItem(text = { Text("Manage uploaded files") }, enabled = connected,
                            onClick = { fileMenu = false; onManageAttachments() })
                    }
                }
                IconToggleButton(checked = showKeys, onCheckedChange = { showKeys = it }) {
                    Icon(Icons.Default.Keyboard, if (showKeys) "Hide terminal keys" else "Show terminal keys")
                }
                if (pane?.kind in setOf("codex", "claude", "opencode"))
                    ComposerModelButton(state.currentModel, modelButtonEnabled,
                        supportsModelSelection(state.snapshot, pane), requestModel)
                Spacer(Modifier.weight(1f))
                TextButton(onClick = { onInsert(draft) }, enabled = canInput && !voiceBusy && draft.isNotEmpty()) {
                    Text("Insert text")
                }
            }
            modelNotice?.let { Text(it, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary) }
            if (showKeys) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("Enter" to "enter", "Esc" to "esc", "Tab" to "tab").forEach { (label, key) ->
                        OutlinedButton(onClick = { onKey(key) }, enabled = canInput,
                            contentPadding = PaddingValues(horizontal = 4.dp),
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text(label) }
                    }
                    OutlinedButton(onClick = { moreKeys = !moreKeys },
                        contentPadding = PaddingValues(horizontal = 4.dp),
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text(if (moreKeys) "Less" else "More") }
                }
                if (moreKeys) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("↑" to "up", "↓" to "down", "←" to "left", "→" to "right", "Ctrl+C" to "ctrl+c").forEach { (label, key) ->
                        OutlinedButton(onClick = { onKey(key) }, enabled = canInput,
                            modifier = Modifier.heightIn(min = 48.dp)) { Text(label) }
                    }
                }
            }
            if (attachments.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                attachments.forEach { file ->
                    InputChip(selected = false, onClick = { onRemoveAttachment(file.uri) }, enabled = !state.busy,
                        label = { Text(file.name, maxLines = 1, overflow = TextOverflow.Ellipsis) })
                    Spacer(Modifier.width(6.dp))
                }
            }
            state.sendingStatus?.let { Text(it, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary) }
            paneId?.let { id -> state.deliveries[id]?.let { delivery ->
                if (delivery.status in setOf("unknown", "uncertain", "failed", "running"))
                    OperationReceipt(delivery, enabled = connected && !state.busy, onCheck = { onCheckDelivery(id) })
                else Text(delivery.message, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (delivery.status in setOf("unknown", "uncertain"))
                    TextButton(onClick = { acknowledgeReceipt = delivery.id }, enabled = !state.busy) {
                        Text("I checked the laptop")
                    }
            } }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(draft, onDraft, Modifier.weight(1f), enabled = pane != null && !voiceBusy,
                    placeholder = { Text(if (pane?.kind == "terminal") "Enter terminal text…" else "Message your agent…") },
                    maxLines = 4)
                VoiceInput(sessionKey = "${state.url}:${state.portalDeviceId}:${paneId}",
                    enabled = pane != null && !hasNativeQuestion && !state.questionPending,
                    compact = true, onStatusChange = { message, _ -> voiceStatus = message },
                    onBusyChange = { voiceBusy = it }, onTranscript = { transcript ->
                        val merged = listOf(draft.trimEnd(), transcript.trim()).filter { it.isNotEmpty() }.joinToString("\n")
                        if (merged.length <= 16000) onDraft(merged)
                    })
                FilledIconButton(onClick = {
                    if (pane?.kind == "terminal") onInsert(draft)
                    else if (attachments.isEmpty()) onPrompt(draft) else reviewAttachments = true
                }, enabled = !voiceBusy && (if (pane?.kind == "terminal") canInput && draft.isNotEmpty()
                    else canPrompt && (draft.isNotBlank() || attachments.isNotEmpty())),
                    modifier = Modifier.size(48.dp)) {
                    Icon(Icons.AutoMirrored.Filled.Send, if (pane?.kind == "terminal") "Insert terminal text" else "Send prompt")
                }
            }
            voiceStatus?.let { Text(it, style = MaterialTheme.typography.labelSmall) }
            }
        }
    }
    if (reviewAttachments) AttachmentReviewDialog(files = attachments,
        laptop = state.snapshot.hostname, pane = pane?.title ?: "Terminal",
        resolver = context.contentResolver, enabled = canPrompt,
        onDismiss = { reviewAttachments = false },
        onSend = { if (canPrompt) { reviewAttachments = false; onPrompt(draft) } })
    paneId?.let { id -> state.deliveries[id]?.takeIf { it.id == acknowledgeReceipt && it.status in setOf("unknown", "uncertain") }?.let {
        AlertDialog(onDismissRequest = { acknowledgeReceipt = null },
            title = { Text("Allow another action?") },
            text = { Text("The earlier action may already have happened. Check the laptop before continuing; sending again could repeat it.") },
            confirmButton = { TextButton(onClick = { acknowledgeReceipt = null; onAcknowledgeDelivery(id) },
                enabled = !state.busy) { Text("I checked; continue") } },
            dismissButton = { TextButton(onClick = { acknowledgeReceipt = null }) { Text("Keep waiting") } })
    } }
}
