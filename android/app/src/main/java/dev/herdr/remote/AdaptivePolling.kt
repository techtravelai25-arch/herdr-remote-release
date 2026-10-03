package dev.herdr.remote

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull

/** Fast while work changes; bounded backoff for unchanged idle observations. */
internal class PollCadence(private val activeMs: Long = 1500, private val idleMs: Long = 15000) {
    private var unchanged = 0
    fun reset() { unchanged = 0 }
    fun next(changed: Boolean, active: Boolean): Long {
        unchanged = if (changed || active) 0 else (unchanged + 1).coerceAtMost(4)
        return (activeMs * (1L shl unchanged)).coerceAtMost(idleMs)
    }
}
internal class AdaptivePoller {
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val cadence = PollCadence()
    private var fingerprint: Any? = null
    fun reset() { cadence.reset(); fingerprint = null; wake.trySend(Unit) }
    suspend fun pause(nextFingerprint: Any?, active: Boolean) {
        val delay = cadence.next(fingerprint != nextFingerprint, active)
        fingerprint = nextFingerprint
        withTimeoutOrNull(delay) { wake.receive() }
    }
}
internal fun snapshotPollFingerprint(snapshot: Snapshot): Any = listOf(snapshot.herdrOnline, snapshot.stale, snapshot.error, snapshot.panes, snapshot.workspaces)
internal fun snapshotHasWork(snapshot: Snapshot): Boolean = snapshot.panes.any { it.status in setOf("working", "running", "starting", "blocked", "needs_input", "needs-input") }
