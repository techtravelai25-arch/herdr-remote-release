package dev.herdr.remote

import kotlinx.serialization.Serializable

/** The notification in a slot has an identity, so an older clear cannot cancel a newer turn. */
@Serializable
internal data class CompletionAlertLedger(
    val current: Map<String, String> = emptyMap(),
    val tombstones: Map<String, Long> = emptyMap(),
    val seenEvents: Map<String, Long> = emptyMap(),
) {
    companion object {
        const val RETENTION_MS = 72L * 60 * 60 * 1000
    }

    fun prune(now: Long): CompletionAlertLedger = copy(
        tombstones = tombstones.filterValues { now - it < RETENTION_MS },
        seenEvents = seenEvents.filterValues { now - it < RETENTION_MS },
    )

    fun show(slot: String, device: String, eventId: String, now: Long, deliveryEventId: String? = null): Pair<CompletionAlertLedger, Boolean> {
        val state = prune(now)
        val target = "$device:$eventId"
        val delivery = deliveryEventId?.let { "$device:$it" }
        if (target in state.tombstones || (delivery != null && delivery in state.seenEvents)) return state to false
        val next = state.copy(current = state.current + (slot to eventId),
            seenEvents = if (delivery == null) state.seenEvents else state.seenEvents + (delivery to now))
        return next to (state.current[slot] != eventId)
    }


    fun reconcile(snapshot: Snapshot, localDevice: String?, cloudDevice: String?, now: Long): Pair<CompletionAlertLedger, List<String>> {
        if (!snapshot.herdrOnline || snapshot.stale) return this to emptyList()
        var state = prune(now)
        val cancelled = mutableListOf<String>()
        snapshot.panes.forEach { pane ->
            val acknowledged = (pane.acknowledgedCompletionEventIds +
                listOfNotNull(pane.completionEventId?.takeIf { pane.completionAcknowledged }))
                .filter(String::isNotBlank).distinct()
            acknowledged.forEach { id ->
                listOfNotNull(localDevice?.let { "reply" to it }, cloudDevice?.let { "push" to it }).forEach { (source, device) ->
                    val slot = "$source:$device:${pane.id}"
                    val (next, cancel) = state.clear(slot, device, id, now)
                    state = next
                    if (cancel) cancelled += slot
                }
            }
        }
        return state to cancelled
    }

    fun clear(slot: String, device: String, targetEventId: String, now: Long, deliveryEventId: String? = null): Pair<CompletionAlertLedger, Boolean> {
        val state = prune(now)
        val delivery = deliveryEventId?.let { "$device:$it" }
        val shouldCancel = state.current[slot] == targetEventId
        val next = state.copy(
            current = if (shouldCancel) state.current - slot else state.current,
            tombstones = state.tombstones + ("$device:$targetEventId" to (state.tombstones["$device:$targetEventId"] ?: now)),
            seenEvents = if (delivery == null) state.seenEvents else state.seenEvents + (delivery to now),
        )
        return next to shouldCancel
    }
}
