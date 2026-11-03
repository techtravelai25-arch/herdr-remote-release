package dev.herdr.remote

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.random.Random

/** Polls the selected pane's text output: its pane attachment, the history refresh, and the text view for older laptops. */
internal class RemoteOutputOwner(
    private val scope: CoroutineScope,
    private val state: MutableStateFlow<RemoteState>,
    private val bridge: () -> Bridge?,
    private val connectionGeneration: () -> Long,
    private val paneSelection: PaneSelectionLifecycle,
    private val outputPoller: AdaptivePoller,
    private val foreground: () -> Boolean,
    private val outputVisible: () -> Boolean,
    private val pendingAction: () -> Boolean,
    private val applySnapshot: (Snapshot) -> Unit,
    private val refreshHistoryQuietly: suspend () -> Unit,
) {
    private var outputJob: Job? = null
    val active: Boolean get() = outputJob?.isActive == true
    fun cancel() { outputJob?.cancel(); outputJob = null }
    private fun requireBridge() = requireNotNull(bridge()) { "Pair this device first." }
    fun begin() {
        if (!foreground() || !outputVisible() || state.value.selectedId == null || outputJob?.isActive == true) return
        outputJob = scope.launch {
            var failures = 0
            while (isActive && state.value.selectedId != null) {
                if (!state.value.online || !state.value.snapshot.herdrOnline) { delay(1500); continue }
                try { read(); refreshHistoryQuietly(); failures = 0 }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) {
                    failures = (failures + 1).coerceAtMost(5)
                    if (e is BridgeHttpException) {
                        // Refresh membership so a closed pane cannot keep polling forever.
                        try { applySnapshot(requireBridge().snapshot()) }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { /* The next live reconnect will refresh membership. */ }
                        // Reconciliation may have selected a replacement and canceled this reader.
                        currentCoroutineContext().ensureActive()
                        if (state.value.selectedId == null) break
                        val transient = shouldRetryPaneOutput(e, state.value.selectedId, state.value.snapshot)
                        if (failures == 1) state.update { it.copy(message = "${e.message ?: "Output unavailable."}${if (transient) " Retrying automatically." else " Reopen the pane to retry."}") }
                        if (!transient) break
                    } else if (failures == 1) state.update { it.copy(message = "Cannot reach terminal output. Retrying automatically.") }
                }
                if (failures == 0) {
                    val state = state.value
                    val pane = state.snapshot.panes.find { it.id == state.selectedId }
                    // The live terminal carries the output itself; this read only keeps the attachment and history fresh.
                    if (state.snapshot.terminalStreamEnabled) delay(10_000)
                    else outputPoller.pause(listOf(state.selectedId, state.output, state.terminalAttachmentId),
                        pane?.status in setOf("working", "running", "starting", "blocked", "needs_input", "needs-input") || pendingAction())
                } else delay((1000L shl failures) + Random.nextLong(1000))
            }
        }
    }
    suspend fun read() {
        val id = state.value.selectedId ?: return
        val api = requireBridge(); val generation = connectionGeneration()
        val selectionGeneration = paneSelection.generation
        val result = api.output(id)
        if (generation != connectionGeneration() || api !== bridge()) return
        if (selectionGeneration != paneSelection.generation) return
        val before = state.value
        if (before.selectedId != id || !before.online || !before.snapshot.herdrOnline || before.snapshot.stale ||
            !acceptTerminalOutput(before.terminalAttachmentId, before.outputRevision, result.attachmentId, result.revision)) return
        state.update { current ->
            if (current.selectedId != id || !current.online || !current.snapshot.herdrOnline || current.snapshot.stale ||
                !acceptTerminalOutput(current.terminalAttachmentId, current.outputRevision, result.attachmentId, result.revision)) current
            else current.copy(output = result.text, outputReady = true, outputTruncated = result.truncated,
                outputRevision = result.revision, outputSource = result.source, terminalAttachmentId = result.attachmentId)
        }
    }
}
