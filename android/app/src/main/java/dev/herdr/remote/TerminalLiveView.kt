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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Keys on the live terminal key bar, in order. Their bytes come from the terminal's current keyboard mode. */
internal val liveTerminalKeys = listOf("Esc" to "esc", "Tab" to "tab", "↑" to "up", "↓" to "down", "←" to "left", "→" to "right",
    "Enter" to "enter", "Ctrl+C" to "ctrl+c", "⌫" to "backspace") + (1..9).map { "$it" to "$it" }

/** What the agent itself says it needs, in plain words. */
internal fun blockedLabel(kind: String?): String = when (kind) {
    "permission" -> "Needs your approval"
    "question" -> "Asking you a question"
    "auth" -> "Needs you to sign in"
    else -> "Waiting for your input"
}

/**
 * One pane: the conversation transcript or a live terminal (the laptop's own screen,
 * streamed), a prompt composer, and live control with a key bar. Laptops without
 * streaming get a bounded text snapshot instead.
 */
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
    onOpenHistory: () -> Unit = {},
    onEarlierHistory: () -> Unit = {},
    onAcknowledgeDelivery: (String) -> Unit = {},
    liveBridge: () -> Bridge? = { null },
) {
    val paneId = pane?.id ?: state.selectedId
    val draft = paneId?.let { state.drafts[it] }.orEmpty()
    val unresolvedDelivery = paneId?.let { state.deliveries[it]?.isUnresolved() } == true
    val connected = state.online && state.snapshot.herdrOnline && !state.snapshot.stale
    val attached = connected && pane != null && state.outputReady && state.terminalAttachmentId != null
    val canPaneControl = attached && state.snapshot.terminalInputEnabled && state.snapshot.canControl && !state.busy &&
        !unresolvedDelivery && (pane?.kind != "terminal" || state.snapshot.allowTerminalInput)
    val canInput = canPaneControl
    val canPrompt = canInput && pane?.kind != "terminal"
    val needsInput = pane?.status in setOf("blocked", "needs_input", "needs-input")
    val canPickFile = connected && pane != null && pane.kind != "terminal" &&
        state.snapshot.canControl && state.snapshot.attachmentsEnabled && !state.busy
    val streaming = state.snapshot.terminalStreamEnabled && connected && pane != null && state.terminalAttachmentId != null
    val attachments = paneId?.let { state.attachments[it] }.orEmpty()
    val vertical = rememberScrollState()
    val horizontal = rememberScrollState()
    val outer = rememberScrollState()
    var wrap by rememberSaveable(paneId) { mutableStateOf(true) }
    var exactSpacing by rememberSaveable(paneId) { mutableStateOf(pane?.kind == "terminal") }
    // A saved transcript separates what you wrote from the reply. The live terminal is one tap away,
    // shown by default when the agent is waiting for you, and the fallback when no transcript exists.
    var rawTerminal by rememberSaveable(paneId) { mutableStateOf(false) }
    var reviewConversation by remember(paneId, needsInput) { mutableStateOf(false) }
    val showTerminal = if (needsInput) !reviewConversation else rawTerminal
    val history = state.structuredHistory?.takeIf { pane != null && pane.kind != "terminal" && it.available && it.messages.isNotEmpty() }
    val transcript = history != null && !showTerminal
    val loadingTranscript = pane != null && pane.kind != "terminal" && state.structuredHistory == null && state.historyLoading && !showTerminal
    var fontSize by rememberSaveable(paneId) { mutableFloatStateOf(15f) }
    var showKeys by rememberSaveable(paneId) { mutableStateOf(false) }
    var options by remember { mutableStateOf(false) }
    var voiceBusy by remember(paneId) { mutableStateOf(false) }
    var voiceStatus by remember(paneId) { mutableStateOf<String?>(null) }
    var reviewAttachments by remember(paneId) { mutableStateOf(false) }
    var fileMenu by remember { mutableStateOf(false) }
    var acknowledgeReceipt by remember(paneId) { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val openLink = rememberTranscriptLinkOpener()
    val scope = rememberCoroutineScope()

    // Live terminal and control.
    var surface by remember(paneId) { mutableStateOf<TerminalSurface?>(null) }
    var liveNotice by remember(paneId) { mutableStateOf<String?>(null) }
    val bridge = remember(paneId, state.url, state.portalDeviceId) { liveBridge() }
    val control = remember(paneId, bridge) { bridge?.let { api -> paneId?.let { LiveControl(api, it) } } }
    var controlling by remember(paneId) { mutableStateOf(false) }
    var controlNotice by remember(paneId) { mutableStateOf<String?>(null) }
    var askTakeover by remember(paneId) { mutableStateOf(false) }
    var typed by remember(paneId) { mutableStateOf("") }
    val showLive = streaming && (showTerminal || history == null) && !transcript
    LaunchedEffect(paneId, state.terminalAttachmentId, surface, showLive) {
        val api = bridge; val target = surface; val attachment = state.terminalAttachmentId
        if (showLive && api != null && target != null && paneId != null && attachment != null)
            runLiveTerminalFeed(api, paneId, attachment, target) { liveNotice = it }
    }
    // Text size zooms the live terminal too; it always shows every laptop column.
    LaunchedEffect(surface, fontSize) { surface?.zoom(fontSize / 15f) }
    LaunchedEffect(controlling) {
        while (controlling) {
            delay(100)
            control?.flush()?.let { message -> controlNotice = message; controlling = false }
        }
    }
    DisposableEffect(control) { onDispose { scope.launch { control?.stop() } } }
    LaunchedEffect(canPaneControl, streaming) { if (!canPaneControl || !streaming) { if (controlling) control?.stop(); controlling = false } }
    fun takeControl(takeover: Boolean) {
        val attachment = state.terminalAttachmentId ?: return
        scope.launch {
            try { control?.start(attachment, takeover); controlling = control?.active == true; controlNotice = null; rawTerminal = true; reviewConversation = false }
            catch (error: BridgeHttpException) {
                if (error.errorCode == "pane_controlled_elsewhere") askTakeover = true else controlNotice = error.message
            } catch (error: Exception) { controlNotice = error.message ?: "Could not take control. Try again." }
        }
    }
    fun press(name: String) { scope.launch { surface?.keyBytes(name)?.takeIf { it.isNotEmpty() }?.let { control?.queue(it) } } }

    BoxWithConstraints(Modifier.fillMaxSize().imePadding()) {
        var headerHeightPx by remember { mutableIntStateOf(0) }
        var controlsHeightPx by remember { mutableIntStateOf(0) }
        val density = LocalDensity.current
        val surroundingHeight = with(density) { (headerHeightPx + controlsHeightPx).toDp() }
        val readerHeight = maxOf(160.dp, maxHeight - surroundingHeight - 16.dp)
        Column(Modifier.fillMaxWidth().verticalScroll(outer).heightIn(min = maxHeight)
            .padding(horizontal = 8.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Column(Modifier.fillMaxWidth().onSizeChanged { headerHeightPx = it.height },
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
            val status = when {
                !connected -> "Connection paused"
                !state.snapshot.canControl -> "Observer access"
                pane == null -> "Session unavailable"
                needsInput -> blockedLabel(pane.blockedKind)
                pane.status == "working" -> "Working"
                pane.status == "done" -> "Ready to review"
                pane.status == "error" -> "Stopped with an error"
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
                                    if (history != null) DropdownMenuItem(
                                        text = { Text(if (showTerminal) "Show conversation" else "Show live terminal") },
                                        onClick = {
                                            if (needsInput) reviewConversation = !reviewConversation else rawTerminal = !rawTerminal
                                            options = false
                                        })
                                    if (!streaming) {
                                        DropdownMenuItem(text = { Text(if (exactSpacing) "Readable text" else "Exact terminal spacing") },
                                            onClick = { exactSpacing = !exactSpacing; options = false })
                                        DropdownMenuItem(text = { Text(if (wrap) "Wrap lines: on" else "Wrap lines: off") },
                                            onClick = { wrap = !wrap; options = false })
                                    }
                                    listOf(13f, 15f, 18f, 21f).forEach { size ->
                                        DropdownMenuItem(text = { Text("Text size: ${size.toInt()} sp${if (fontSize == size) " · selected" else ""}") },
                                            onClick = { fontSize = size; options = false })
                                    }
                                    HorizontalDivider()
                                    DropdownMenuItem(text = { Text("Browse project files") }, enabled = connected && pane != null,
                                        onClick = { options = false; onBrowseFiles() })
                                    DropdownMenuItem(text = { Text("Saved history") }, enabled = pane != null,
                                        onClick = { options = false; onOpenHistory() })
                                }
                            }
                        }
                        val workspaceLabel = state.snapshot.workspaces.firstOrNull { it.id == pane?.workspaceId }?.label
                        Text(if (pane == null) "Choose another session" else
                            pane.activity ?: "${kindLabel(pane.kind)} · ${pane.lastActivity?.let { "Updated ${activityLabel(it)}" } ?: pane.projectLabel ?: workspaceLabel ?: state.snapshot.hostname}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                        pane?.progress?.let { progress ->
                            LinearProgressIndicator(progress = { progress / 100f }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp, end = 12.dp))
                        }
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
                else -> controlNotice ?: liveNotice
            }
            notice?.let { Text(it, style = MaterialTheme.typography.labelSmall,
                color = if (canInput && it != controlNotice) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error) }
            Text(when {
                transcript -> "Conversation · ${kindLabel(pane?.kind.orEmpty())}"
                showLive && controlling -> "Live terminal · you are in control"
                showLive -> "Live terminal"
                state.outputTruncated -> "Recent output · earlier content unavailable"
                else -> "Recent terminal output"
            }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
            } else if (showLive) Surface(Modifier.fillMaxWidth().height(readerHeight), color = MaterialTheme.colorScheme.surface,
                shape = MaterialTheme.shapes.medium) {
                LiveTerminalView(Modifier.fillMaxSize()) { surface = it }
            } else Surface(Modifier.fillMaxWidth().height(readerHeight), color = MaterialTheme.colorScheme.surface,
                shape = MaterialTheme.shapes.medium) {
                SelectionContainer {
                    Box(Modifier.fillMaxSize().verticalScroll(vertical)
                        .then(if (wrap) Modifier else Modifier.horizontalScroll(horizontal)).padding(12.dp)) {
                        val shown = remember(state.output, exactSpacing) { readableTerminalText(state.output, collapseRules = !exactSpacing) }
                        val styled = remember(shown, exactSpacing, openLink) {
                            buildAnnotatedString {
                                append(shown)
                                transcriptLinkRanges(shown).forEach { range ->
                                    val target = shown.substring(range.start, range.endExclusive)
                                    addLink(LinkAnnotation.Url(target) { openLink(target) }, range.start, range.endExclusive)
                                }
                                if (!exactSpacing) boxTableRanges(shown).forEach { addStyle(SpanStyle(fontFamily = FontFamily.Monospace), it.first, it.last + 1) }
                            }
                        }
                        LaunchedEffect(shown) { vertical.scrollTo(vertical.maxValue) }
                        Text(if (!state.outputReady) AnnotatedString("Loading terminal snapshot…") else if (shown.isEmpty()) AnnotatedString("(no text in this snapshot)") else styled,
                            modifier = if (wrap) Modifier.fillMaxWidth() else Modifier,
                            fontFamily = if (exactSpacing) FontFamily.Monospace else FontFamily.Default,
                            fontSize = fontSize.sp, lineHeight = (fontSize * 1.4f).sp, softWrap = wrap)
                    }
                }
            }
            Column(Modifier.fillMaxWidth().onSizeChanged { controlsHeightPx = it.height },
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            if (needsInput && !controlling) Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainer,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.5f)),
                shape = MaterialTheme.shapes.medium) {
                Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(blockedLabel(pane?.blockedKind), style = MaterialTheme.typography.titleSmall)
                    pane?.activity?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    Text(if (streaming) "Answer in the live terminal: take control, then use the keys or type."
                        else "Answer in the terminal with the keys below.",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (streaming) Button(onClick = { takeControl(false) }, enabled = canPaneControl && control != null,
                        modifier = Modifier.heightIn(min = 48.dp)) { Text("Answer in the terminal") }
                }
            }
            if (streaming && showLive) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                if (controlling) FilledTonalButton(onClick = { controlling = false; scope.launch { control?.stop() } },
                    modifier = Modifier.heightIn(min = 48.dp)) { Text("Stop control") }
                else OutlinedButton(onClick = { takeControl(false) }, enabled = canPaneControl && control != null,
                    modifier = Modifier.heightIn(min = 48.dp)) { Text("Take control") }
            }
            if (controlling) {
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    liveTerminalKeys.forEach { (label, key) ->
                        OutlinedButton(onClick = { press(key) }, contentPadding = PaddingValues(horizontal = 10.dp),
                            modifier = Modifier.heightIn(min = 48.dp)) { Text(label) }
                    }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedTextField(typed, { typed = it.take(4000) }, Modifier.weight(1f),
                        placeholder = { Text("Type into the terminal…") }, maxLines = 3)
                    TextButton(onClick = { control?.queue(typed); typed = "" }, enabled = typed.isNotEmpty()) { Text("Type") }
                    FilledTonalButton(onClick = { control?.queue(typed + "\r"); typed = "" }, modifier = Modifier.heightIn(min = 48.dp)) { Text("⏎") }
                }
            }
            if (!controlling) {
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
                if (!streaming) IconToggleButton(checked = showKeys, onCheckedChange = { showKeys = it }) {
                    Icon(Icons.Default.Keyboard, if (showKeys) "Hide terminal keys" else "Show terminal keys")
                }
                Spacer(Modifier.weight(1f))
                if (!streaming) TextButton(onClick = { onInsert(draft) }, enabled = canInput && !voiceBusy && draft.isNotEmpty()) {
                    Text("Insert text")
                }
            }
            if (showKeys && !streaming) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("Enter" to "enter", "Esc" to "esc", "Tab" to "tab", "↑" to "up", "↓" to "down", "←" to "left", "→" to "right", "Ctrl+C" to "ctrl+c").forEach { (label, key) ->
                    OutlinedButton(onClick = { onKey(key) }, enabled = canInput, modifier = Modifier.heightIn(min = 48.dp)) { Text(label) }
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
                    enabled = pane != null,
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
    }
    if (askTakeover) AlertDialog(onDismissRequest = { askTakeover = false },
        title = { Text("Take over this terminal?") },
        text = { Text("Another device is controlling this pane. Taking over stops its input.") },
        confirmButton = { TextButton(onClick = { askTakeover = false; takeControl(true) }) { Text("Take over") } },
        dismissButton = { TextButton(onClick = { askTakeover = false }) { Text("Cancel") } })
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
