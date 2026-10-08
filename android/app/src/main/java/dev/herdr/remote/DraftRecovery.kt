package dev.herdr.remote

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.MessageDigest

@Serializable data class DeliveryState(val id: String, val status: String, val message: String, val draft: String = "", val operation: String = "prompt")
/** Only unsent drafts and operation receipts survive an app restart. */
@Serializable data class RecoveryEntry(
    val scope: String, val paneId: String, val draft: String = "", val touchedAt: Long = 0,
    val delivery: DeliveryState? = null,
)
@Serializable data class RecoveryArchive(val entries: List<RecoveryEntry> = emptyList())

/** Stable across grant renewal; a new account sign-in intentionally gets a new namespace. */
fun conversationScope(url: String, deviceId: String, accountToken: String? = null): String =
    MessageDigest.getInstance("SHA-256").digest("$url\n$deviceId\n${accountToken.orEmpty()}".toByteArray())
        .joinToString("") { "%02x".format(it) }

fun boundRecovery(archive: RecoveryArchive, now: Long): RecoveryArchive {
    var bytes = 0
    val entries = archive.entries.sortedByDescending { it.touchedAt }
        .filter { it.touchedAt > now - 7 * 86400000L && (it.draft.isNotBlank() || it.delivery != null) }
        .take(30).map { entry -> entry.copy(draft = entry.draft.take(16000)) }
        .filter { entry ->
            bytes += (entry.draft + entry.delivery?.draft.orEmpty()).toByteArray().size
            bytes <= 1024 * 1024
        }
    return archive.copy(entries = entries)
}

// Unknown legacy fields (historyEnabled, text, savedAt, truncated) are discarded on decode.
internal fun decodeRecovery(raw: String, now: Long): RecoveryArchive = boundRecovery(
    Json { ignoreUnknownKeys = true }.decodeFromString<RecoveryArchive>(raw), now)

class DraftRecovery internal constructor(private val read: () -> String?, private val write: (String) -> Unit) {
    // Retain the storage identity so upgrading rewrites every account's old output in place.
    constructor(context: Context): this(EncryptedStorage(context, "saved_conversations", "herdr.remote.conversations.v1"))
    private constructor(storage: EncryptedStorage): this(storage::load, { storage.save(it) })
    private var unreadable = false
    var cleanupFailed: Boolean = false; private set
    val failureMessage: String? get() = when {
        unreadable -> "Stored drafts could not be read and cached output could not be removed. Forget the connection to reset local recovery data."
        cleanupFailed -> "Old cached output could not be removed. Check available storage and reopen the app."
        else -> null
    }
    fun load(): RecoveryArchive {
        cleanupFailed = false
        unreadable = false
        val raw = read() ?: return RecoveryArchive()
        val archive = runCatching { decodeRecovery(raw, System.currentTimeMillis()) }.getOrElse {
            unreadable = true
            cleanupFailed = true
            return RecoveryArchive()
        }
        val encoded = Json.encodeToString(archive)
        if (raw != encoded) {
            try { write(encoded) }
            catch (_: Exception) { cleanupFailed = true }
        }
        return recoverDeliveries(archive)
    }
    fun save(archive: RecoveryArchive) {
        check(!unreadable) { failureMessage.orEmpty() }
        write(Json.encodeToString(boundRecovery(archive, System.currentTimeMillis())))
        cleanupFailed = false
    }
    fun clear() {
        write(Json.encodeToString(RecoveryArchive()))
        unreadable = false
        cleanupFailed = false
    }
}

fun recoverDeliveries(archive: RecoveryArchive): RecoveryArchive = archive.copy(entries = archive.entries.map { entry ->
    val delivery = entry.delivery
    if (delivery?.status in setOf("sending", "running")) entry.copy(delivery = delivery?.copy(status = "uncertain", message = "Delivery was interrupted. Check its status before resending.")) else entry
})

internal fun Pane.hasUnacknowledgedAttention(): Boolean {
    if (kind == "terminal" || status !in setOf("blocked", "needs_input", "error")) return false
    val eventId = attentionEventId?.takeIf(String::isNotBlank) ?: return true
    return !attentionAcknowledged && eventId !in acknowledgedAttentionEventIds
}

class AttentionTracker {
    private val previous = mutableMapOf<String, Pane>()
    private val unread = mutableSetOf<String>()
    // A completion acknowledgement must not consume a later completion or a blocker.
    private val unreadCompletions = mutableMapOf<String, String>()
    private val unreadAttentions = mutableMapOf<String, String?>()
    fun reset() { previous.clear(); unread.clear(); unreadCompletions.clear(); unreadAttentions.clear() }
    fun read(id: String) { unread.remove(id); unreadCompletions.remove(id); unreadAttentions.remove(id) }
    fun accept(snapshot: Snapshot, selectedId: String?): Set<String> {
        if (!snapshot.herdrOnline || snapshot.stale) return unread.toSet()
        val live = snapshot.panes.map { it.id }.toSet()
        previous.keys.retainAll(live); unread.retainAll(live); unreadCompletions.keys.retainAll(live)
        unreadAttentions.keys.retainAll(live)
        for (pane in snapshot.panes) {
            val acknowledged = pane.acknowledgedCompletionEventIds +
                listOfNotNull(pane.completionEventId?.takeIf { pane.completionAcknowledged })
            if (unreadCompletions[pane.id]?.let { it in acknowledged } == true) read(pane.id)
            val acknowledgedAttention = pane.acknowledgedAttentionEventIds +
                listOfNotNull(pane.attentionEventId?.takeIf { pane.attentionAcknowledged })
            val legacyAttentionResumed = unreadAttentions.containsKey(pane.id) && unreadAttentions[pane.id] == null &&
                pane.status in setOf("working", "idle", "done")
            if (unreadAttentions[pane.id]?.let { it in acknowledgedAttention } == true ||
                legacyAttentionResumed) read(pane.id)
            val old = previous.put(pane.id, pane)
            val completion = pane.status in setOf("done", "idle")
            val eventId = pane.completionEventId?.takeIf(String::isNotBlank)
            val attentionEventId = pane.attentionEventId?.takeIf(String::isNotBlank)
            // Event identity also catches completion while polling missed its working state.
            val changed = if (completion && eventId != null) old?.completionEventId != eventId
                else if (!completion && attentionEventId != null) old?.attentionEventId != attentionEventId
                else old?.status != pane.status
            if (old != null && changed && pane.kind != "terminal" &&
                pane.status in setOf("done", "idle", "blocked", "needs_input", "error") &&
                !(legacyAttentionResumed && completion && eventId == null) &&
                (if (completion) eventId == null || eventId !in acknowledged else pane.hasUnacknowledgedAttention())) {
                if (selectedId != pane.id) {
                    unread.add(pane.id)
                    if (completion) {
                        unreadAttentions.remove(pane.id)
                        if (eventId != null) unreadCompletions[pane.id] = eventId
                        else unreadCompletions.remove(pane.id)
                    } else {
                        unreadCompletions.remove(pane.id)
                        unreadAttentions[pane.id] = attentionEventId
                    }
                }
            }
        }
        if (selectedId != null) read(selectedId)
        return unread.toSet()
    }
}

/** First observation establishes a baseline; repeat snapshots cannot re-alert. */
class InputAttentionTracker {
    private val previous = mutableMapOf<String, Pane>()
    fun accept(snapshot: Snapshot): List<Pane> {
        if (!snapshot.herdrOnline || snapshot.stale) return emptyList()
        previous.keys.retainAll(snapshot.panes.map { it.id }.toSet())
        return snapshot.panes.filter { pane ->
            val old = previous.put(pane.id, pane)
            val changed = if (!pane.attentionEventId.isNullOrBlank()) old?.attentionEventId != pane.attentionEventId
                else old?.status != pane.status
            old != null && changed &&
                pane.hasUnacknowledgedAttention()
        }
    }
}
