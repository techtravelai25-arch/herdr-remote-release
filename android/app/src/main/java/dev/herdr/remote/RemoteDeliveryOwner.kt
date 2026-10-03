package dev.herdr.remote

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal fun DeliveryState.isUnresolved(): Boolean = status in setOf("sending", "running", "unknown", "uncertain")

internal fun RemoteState.reserveDelivery(paneId: String, delivery: DeliveryState): RemoteState {
    check(deliveries[paneId]?.isUnresolved() != true) {
        "A previous action may still be pending. Check its delivery status or confirm what happened on the laptop before sending another action."
    }
    return copy(deliveries = deliveries + (paneId to delivery))
}

internal fun RemoteState.acknowledgeUncertainDelivery(paneId: String): RemoteState {
    val delivery = deliveries[paneId] ?: return this
    if (delivery.status !in setOf("unknown", "uncertain")) return this
    return copy(deliveries = deliveries + (paneId to delivery.copy(
        status = "acknowledged",
        message = "You checked the laptop. The earlier action may have completed; another action is now allowed.")))
}

/** Owns admission, receipt state and status reconciliation for mutating operations. */
internal class RemoteDeliveryOwner(
    private val state: MutableStateFlow<RemoteState>,
    private val recovery: RemoteRecoveryOwner,
    private val bridge: () -> Bridge?,
    private val generation: () -> Long,
    private val selection: PaneSelectionLifecycle,
    private val applySnapshot: (Snapshot) -> Unit,
) {
    fun operationId(): String = java.util.UUID.randomUUID().toString()
    fun isUncertain(error: Throwable): Boolean = error !is BridgeHttpException || error.errorCode == "operation_uncertain" ||
        error.operationStatus == "uncertain" || error.statusCode == 408 || error.statusCode >= 500

    fun requireSettled(paneId: String) {
        check(state.value.deliveries[paneId]?.isUnresolved() != true) {
            "A previous action may still be pending. Check its delivery status or confirm what happened on the laptop before sending another action."
        }
    }

    fun begin(paneId: String, id: String, message: String, draft: String = "", operation: String = "prompt") {
        state.update { it.reserveDelivery(paneId, DeliveryState(id, "sending", message, draft, operation)) }
        recovery.schedule()
    }

    fun mark(paneId: String, id: String, status: String, message: String, draft: String = "", operation: String = "prompt") {
        state.update { current ->
            if (current.deliveries[paneId]?.id != id) current else
                current.copy(deliveries = current.deliveries + (paneId to DeliveryState(id, status, message, draft, operation)))
        }
        recovery.schedule()
    }

    fun terminalAttachment(id: String): String {
        val current = state.value
        require(current.selectedId == id && current.online && current.snapshot.herdrOnline && !current.snapshot.stale &&
            current.outputReady && current.snapshot.panes.any { it.id == id }) { "Reconnect and refresh this terminal before sending input." }
        return requireNotNull(current.terminalAttachmentId) { "Wait for a fresh terminal view before sending input." }
    }

    /** Creates and commits the receipt before the bridge mutation. A lost response remains uncertain. */
    suspend fun dispatchPrompt(id: String, receipt: String, draft: String, attachmentId: String,
        body: JsonObject, api: Bridge, connection: Long): Boolean {
        begin(id, receipt, "Sending…", draft)
        var sent = false
        try {
            recovery.flushAndWait()
            if (connection != generation() || api !== bridge()) return false
            if (state.value.selectedId != id) {
                mark(id, receipt, "failed", "Not sent; the selected pane changed.", draft)
                return false
            }
            require(terminalAttachment(id) == attachmentId) { "The terminal changed. Refresh it before sending." }
            sent = true
            api.call(listOf("v1", "panes", id, "prompt"), "POST", body, receipt)
            return connection == generation() && api === bridge()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (connection == generation() && api === bridge()) {
                val status = if (sent && isUncertain(error)) "uncertain" else "failed"
                mark(id, receipt, status, if (status == "uncertain") "Delivery is uncertain. Inspect the pane before retrying."
                    else if (!sent) "Not sent. ${error.message ?: "Preparation failed."}" else (error.message ?: "Delivery failed."), draft)
            }
            throw error
        }
    }

    fun finishPrompt(id: String, receipt: String, draft: String): Boolean {
        val same = state.value.drafts[id] == draft
        state.update { current -> current.copy(attachments = if (same) current.attachments - id else current.attachments,
            drafts = if (same) current.drafts - id else current.drafts,
            sentPrompts = if (draft.isBlank()) current.sentPrompts else current.sentPrompts +
                (id to (current.sentPrompts[id].orEmpty() + draft).takeLast(10)),
            deliveries = current.deliveries + (id to DeliveryState(receipt, "delivered", "Prompt dispatch acknowledged. Check the terminal.", "", "prompt"))) }
        recovery.schedule()
        return same
    }

    suspend fun reconcile(id: String, delivery: DeliveryState) {
        val api = requireNotNull(bridge()) { "Pair this device first." }
        val connection = generation()
        val navigation = selection.generation
        val recoverRestartSelection = delivery.operation == "restart" &&
            (selection.canRecover(delivery.id, id) || state.value.selectedId == id)
        if (recoverRestartSelection && !selection.canRecover(delivery.id, id)) selection.started(delivery.id, id)
        try {
            val result = api.call(listOf("v1", "operations", delivery.id))
            if (connection != generation() || api !== bridge()) return
            val status = result["status"]?.jsonPrimitive?.contentOrNull ?: "uncertain"
            when (status) {
                "succeeded" -> {
                    val same = state.value.drafts[id] == delivery.draft
                    state.update { current ->
                        if (current.deliveries[id]?.id != delivery.id) current else
                            current.copy(drafts = if (same) current.drafts - id else current.drafts,
                                deliveries = current.deliveries + (id to delivery.copy(status = "delivered",
                                    message = if (delivery.operation in setOf("input", "keys", "prompt") || delivery.operation.startsWith("question.")) "Dispatch acknowledged. Check the terminal." else "Delivered", draft = "")))
                    }
                    if (id == "__create__" || recoverRestartSelection) {
                        val replacement = result["response"]?.jsonObject?.get("paneId")?.jsonPrimitive?.contentOrNull
                        if (recoverRestartSelection && replacement != null) selection.acknowledgeReceipt(delivery.id, id, replacement)
                        if (id == "__create__" && replacement != null) selection.acknowledge(navigation, replacement)
                        val next = api.snapshot()
                        if (connection != generation() || api !== bridge()) return
                        applySnapshot(next)
                    }
                    recovery.schedule()
                }
                "failed" -> mark(id, delivery.id, "failed", result["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull ?: "Delivery failed.", delivery.draft, delivery.operation)
                else -> mark(id, delivery.id, "uncertain", "Delivery is uncertain. Inspect the pane before retrying.", delivery.draft, delivery.operation)
            }
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) {
            if (connection == generation()) mark(id, delivery.id, "uncertain", "Could not check delivery status. Inspect the pane before retrying.", delivery.draft, delivery.operation)
        }
    }

    fun acknowledge(id: String) {
        if (state.value.busy) return
        if (state.value.deliveries[id]?.status !in setOf("unknown", "uncertain")) return
        state.update { it.acknowledgeUncertainDelivery(id) }
        recovery.schedule()
    }
}
