package dev.herdr.remote

/** Only an observed working agent can complete; transient connection loss preserves that evidence. */
class ReplyCompletionTracker {
    private val working = mutableMapOf<String, String>()
    fun reset() { working.clear() }
    fun accept(snapshot: Snapshot): List<Pane> {
        if (!snapshot.herdrOnline || snapshot.stale) return emptyList()
        working.keys.retainAll(snapshot.panes.map { it.id }.toSet())
        return snapshot.panes.mapNotNull { pane ->
            if (pane.kind == "terminal") { working.remove(pane.id); return@mapNotNull null }
            when (pane.status) {
                "working" -> { working[pane.id] = pane.kind; null }
                "done" -> {
                    val observedWorking = working.remove(pane.id) == pane.kind
                    val eventId = pane.completionEventId?.takeIf(String::isNotBlank)
                    if (observedWorking && !pane.completionAcknowledged &&
                        (eventId == null || eventId !in pane.acknowledgedCompletionEventIds)) pane else null
                }
                "idle" -> { working.remove(pane.id); null }
                else -> { working.remove(pane.id); null }
            }
        }
    }
}
