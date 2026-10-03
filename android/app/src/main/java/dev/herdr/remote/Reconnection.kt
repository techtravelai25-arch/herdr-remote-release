package dev.herdr.remote

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlin.random.Random

/** Retry only observation; never replay prompts or other mutations after a disconnect. */
internal suspend fun reconnectContinuously(
    disconnected: (Exception?) -> Unit,
    pause: suspend (Long) -> Unit = { delay(it + Random.nextLong(1000)) },
    observe: suspend (connected: () -> Unit) -> Unit,
) {
    var failures = 0
    while (currentCoroutineContext().isActive) {
        var failure: Exception? = null
        try { observe { failures = 0 } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { failure = error }
        disconnected(failure)
        failures = (failures + 1).coerceAtMost(5)
        // Retry quickly after a transient radio/tunnel loss, then back off to
        // avoid hammering an offline laptop. Observation is safe to repeat;
        // mutation requests are never made from this loop.
        pause((1000L shl (failures - 1)).coerceAtMost(16000L))
    }
}

/** Refresh stale observation before rejecting controls; never substitute another pane ID. */
internal suspend fun requireAvailablePane(
    id: String,
    online: Boolean,
    snapshot: Snapshot,
    refresh: suspend () -> Snapshot,
) {
    val current = if (online && snapshot.herdrOnline && !snapshot.stale && snapshot.panes.any { it.id == id }) snapshot else refresh()
    require(current.herdrOnline && !current.stale && current.panes.any { it.id == id }) {
        if (current.herdrOnline && !current.stale) "This pane has closed. Select the reopened pane from the dashboard."
        else current.error ?: "Herdr is unavailable. Waiting for the laptop to reconnect."
    }
}

/** Keep live selection and restart intent across outages; explicit navigation starts a new lifecycle. */
internal class PaneSelectionLifecycle {
    var generation: Long = 0
        private set
    private var replacement: String? = null
    private var restartOperation: String? = null
    private var restartSource: String? = null

    fun cancel() {
        generation++; replacement = null
        restartOperation = null; restartSource = null
    }
    fun selected() {
        cancel()
    }
    fun started(operationId: String, sourceId: String) {
        restartOperation = operationId; restartSource = sourceId
    }
    fun canRecover(operationId: String, sourceId: String): Boolean =
        restartOperation == operationId && restartSource == sourceId
    fun acknowledgeReceipt(operationId: String, sourceId: String, paneId: String) {
        if (canRecover(operationId, sourceId)) replacement = paneId
    }
    fun reconcile(selectedId: String?, snapshot: Snapshot): String? {
        if (!snapshot.herdrOnline || snapshot.stale) return selectedId
        consume(snapshot)?.let { return it }
        if (selectedId == null) return null
        if (snapshot.panes.any { it.id == selectedId }) {
            return selectedId
        }
        return null
    }
    fun acknowledge(startedAt: Long, paneId: String) {
        if (startedAt == generation) replacement = paneId
    }
    fun consume(snapshot: Snapshot): String? {
        val id = replacement ?: return null
        if (!snapshot.herdrOnline || snapshot.stale || snapshot.panes.none { it.id == id }) return null
        replacement = null
        return id
    }
}

/** A pane lookup can race desktop restart; only retry that conflict while membership can recover. */
internal fun shouldRetryPaneOutput(error: BridgeHttpException, selectedId: String?, snapshot: Snapshot): Boolean =
    error.statusCode == 408 || error.statusCode == 429 || error.statusCode >= 500 ||
        (error.statusCode == 409 && error.errorCode == "pane_not_found" && selectedId != null &&
            (!snapshot.herdrOnline || snapshot.stale || snapshot.panes.any { it.id == selectedId }))
