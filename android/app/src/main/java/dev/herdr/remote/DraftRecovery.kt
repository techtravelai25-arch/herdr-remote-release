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

class AttentionTracker {
    private val previous = mutableMapOf<String, String>()
    private val unread = mutableSetOf<String>()
    fun reset() { previous.clear(); unread.clear() }
    fun read(id: String) { unread.remove(id) }
    fun accept(snapshot: Snapshot, selectedId: String?): Set<String> {
        if (!snapshot.herdrOnline) return unread.toSet()
        val live = snapshot.panes.map { it.id }.toSet()
        previous.keys.retainAll(live); unread.retainAll(live)
        for (pane in snapshot.panes) {
            val old = previous.put(pane.id, pane.status)
            if (old != null && old != pane.status && pane.kind != "terminal" && pane.status in setOf("done", "idle", "blocked", "needs_input", "error")) {
                if (selectedId != pane.id) unread.add(pane.id)
            }
        }
        if (selectedId != null) unread.remove(selectedId)
        return unread.toSet()
    }
}

/** First observation establishes a baseline; repeat snapshots cannot re-alert. */
class InputAttentionTracker {
    private val previous = mutableMapOf<String, String>()
    fun accept(snapshot: Snapshot): List<Pane> {
        if (!snapshot.herdrOnline) return emptyList()
        previous.keys.retainAll(snapshot.panes.map { it.id }.toSet())
        return snapshot.panes.filter { pane ->
            val old = previous.put(pane.id, pane.status)
            pane.kind != "terminal" && old != null && old != pane.status && pane.status in setOf("blocked", "needs_input", "error")
        }
    }
}
