package dev.herdr.remote

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Owns the scoped draft and receipt archive, including the commit barrier before mutations. */
internal class RemoteRecoveryOwner(
    private val storage: DraftRecovery,
    private val scope: CoroutineScope,
    private val state: () -> RemoteState,
    private val reportFailure: (String) -> Unit,
) {
    private var persistJob: Job? = null
    var privateClearJob: Job? = null
        private set
    @Volatile var privateClearFailure: Exception? = null
        private set
    private val mutex = Mutex()
    @Volatile private var epoch = 0L
    @Volatile private var version = 0L
    private val entries = mutableMapOf<String, RecoveryEntry>()
    private var archive = RecoveryArchive()
    var activeScope = ""

    val failureMessage: String? get() = storage.failureMessage

    fun load(scopeKey: String): RecoveryArchive {
        archive = storage.load()
        entries.clear()
        archive.entries.filter { it.scope == scopeKey }.forEach { entries[it.paneId] = it }
        activeScope = scopeKey
        return archive
    }

    private fun snapshot(): RecoveryArchive {
        val currentScope = activeScope
        if (currentScope.isBlank()) return RecoveryArchive()
        val current = state()
        val ids = (entries.keys + current.drafts.keys + current.deliveries.keys + current.snapshot.panes.map { it.id }).toSet()
        val next = ids.mapNotNull { id ->
            val previous = entries[id]
            val delivery = current.deliveries[id] ?: previous?.delivery
            val draft = if (current.drafts.containsKey(id)) current.drafts[id].orEmpty()
                else if (delivery?.status == "delivered") "" else previous?.draft.orEmpty()
            val changed = (current.drafts.containsKey(id) && current.drafts[id].orEmpty() != previous?.draft.orEmpty()) ||
                (current.deliveries.containsKey(id) && current.deliveries[id] != previous?.delivery)
            val touchedAt = if (changed) System.currentTimeMillis() else previous?.touchedAt ?: System.currentTimeMillis()
            if (draft.isBlank() && delivery == null) null else RecoveryEntry(currentScope, id, draft, touchedAt, delivery)
        }
        archive = boundRecovery(RecoveryArchive(archive.entries.filter { it.scope != currentScope } + next), System.currentTimeMillis())
        entries.clear()
        archive.entries.filter { it.scope == currentScope }.forEach { entries[it.paneId] = it }
        return archive
    }

    fun schedule() {
        if (activeScope.isBlank()) return
        persistJob?.cancel()
        persistJob = scope.launch {
            delay(300)
            val value = snapshot(); val capturedEpoch = epoch; val capturedVersion = ++version
            try { withContext(Dispatchers.IO) { mutex.withLock { if (capturedEpoch == epoch && capturedVersion == version) storage.save(value) } } }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { if (capturedEpoch == epoch) reportFailure(storage.failureMessage ?: "Drafts could not be saved. Check available storage before leaving the app.") }
        }
    }

    fun flush() {
        persistJob?.cancel(); persistJob = null
        if (activeScope.isBlank()) return
        val value = snapshot(); val capturedEpoch = epoch; val capturedVersion = ++version
        scope.launch(Dispatchers.IO) {
            try { mutex.withLock { if (capturedEpoch == epoch && capturedVersion == version) storage.save(value) } }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { if (capturedEpoch == epoch) reportFailure(storage.failureMessage ?: "Drafts could not be saved. Check available storage before leaving the app.") }
        }
    }

    suspend fun flushAndWait() {
        persistJob?.cancel(); persistJob = null
        if (activeScope.isBlank()) return
        val capturedEpoch = epoch
        // A concurrent save can supersede this one; dispatch waits for a committed receipt.
        while (capturedEpoch == epoch) {
            val value = snapshot(); val capturedVersion = ++version
            val committed = withContext(Dispatchers.IO) {
                mutex.withLock {
                    if (capturedEpoch != epoch || capturedVersion != version) false
                    else { storage.save(value); true }
                }
            }
            if (committed) return
        }
    }

    fun clear(clearStore: Boolean = false) {
        persistJob?.cancel(); epoch++; val capturedEpoch = epoch
        entries.clear(); archive = RecoveryArchive()
        if (clearStore) {
            privateClearFailure = null
            privateClearJob = scope.launch(Dispatchers.IO) {
                try { mutex.withLock { if (capturedEpoch == epoch) storage.clear() } }
                catch (error: CancellationException) { throw error }
                catch (error: Exception) {
                    if (capturedEpoch == epoch) {
                        privateClearFailure = error
                        reportFailure("Local recovery data could not be cleared. Check available storage and try forgetting the connection again.")
                    }
                }
            }
        }
    }

    fun clearFinishedJob() { privateClearJob = null }
}
