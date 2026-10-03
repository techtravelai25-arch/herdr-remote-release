package dev.herdr.remote

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Owns file browsing, draft attachments and document-picker download identity. */
internal class RemoteFilesOwner(
    private val app: Application,
    private val scope: CoroutineScope,
    private val state: MutableStateFlow<RemoteState>,
    private val bridge: () -> Bridge?,
    private val generation: () -> Long,
    private val accountToken: () -> String?,
) {
    private var projectFilesJob: Job? = null
    private var projectFilesRequest = 0L
    private data class PendingArtifactSave(val id: String, val paneId: String?, val credentials: Credentials,
        val generation: Long, val api: Bridge, val accountToken: String?)
    private var pendingArtifactSave: PendingArtifactSave? = null

    fun clearProjectFiles() {
        projectFilesJob?.cancel()
        projectFilesRequest++
        state.update { it.copy(projectFiles = null, projectFilesLoading = false, projectFilesError = null,
            projectFilesRequestedPath = null, projectFilesRequestedCursor = null) }
    }

    fun loadProjectFiles(directory: String? = null, cursor: String? = null) {
        val paneId = state.value.selectedId ?: return
        if (paneId.isBlank() || paneId.length > 256) return
        val api = bridge() ?: return
        if (directory != null && directory.isNotEmpty() && (directory.length > 768 ||
                directory.split('/').any { it.isEmpty() || it.startsWith(".") || it == ".." || it.contains('\\') || it.any { c -> c.code < 0x20 || c.code == 0x7f } })) return
        if (cursor != null && (cursor.isEmpty() || cursor.length > 128)) return
        if (cursor != null && (state.value.projectFiles?.directory != directory.orEmpty() ||
                state.value.projectFiles?.nextCursor != cursor)) return
        val connection = generation()
        projectFilesJob?.cancel()
        val request = ++projectFilesRequest
        state.update { it.copy(projectFilesLoading = true, projectFilesError = null,
            projectFilesRequestedPath = directory, projectFilesRequestedCursor = cursor) }
        projectFilesJob = scope.launch {
            try {
                val listing = api.paneFiles(paneId, directory, cursor)
                if (request == projectFilesRequest && connection == generation() && api === bridge() && state.value.selectedId == paneId &&
                    listing.directory == (state.value.projectFilesRequestedPath ?: "")) {
                    state.update { it.copy(projectFiles = mergeProjectFilesPage(it.projectFiles, listing, cursor)) }
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (request == projectFilesRequest && connection == generation() && api === bridge() && state.value.selectedId == paneId)
                    state.update { it.copy(projectFilesError = projectFilesMessage(error)) }
            } finally {
                if (request == projectFilesRequest && connection == generation() && api === bridge() && state.value.selectedId == paneId)
                    state.update { it.copy(projectFilesLoading = false) }
            }
        }
    }

    private fun projectFilesMessage(error: Exception): String = when {
        error is BridgeHttpException && error.statusCode == 404 -> "Update the laptop bridge to browse this session's project files."
        error is BridgeHttpException && error.errorCode == "invalid_directory" -> "Choose a folder inside this project."
        error is BridgeHttpException && error.errorCode == "directory_unavailable" -> "This folder changed. Refresh the project files."
        else -> error.message ?: "Could not read the file list. Try again."
    }

    suspend fun addAttachments(id: String, uris: List<Uri>) {
        val existing = state.value.attachments[id].orEmpty()
        val unique = uris.distinct().filter { uri -> existing.none { it.uri == uri } }
        validateAttachmentCount(existing.size + unique.size)
        val resolver = app.contentResolver
        val files = withContext(Dispatchers.IO) {
            unique.map { uri ->
                var name = "attachment"
                var size: Long? = null
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (nameColumn >= 0) name = cursor.getString(nameColumn)?.takeIf { it.isNotBlank() } ?: name
                        if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn).takeIf { it >= 0 }
                    }
                }
                validateAttachmentSize(size, name)
                DraftAttachment(uri, name, size)
            }
        }
        state.update { it.copy(attachments = it.attachments + (id to (existing + files))) }
    }

    fun removeAttachment(id: String, uri: Uri) {
        if (state.value.busy) return
        state.update { it.copy(attachments = it.attachments + (id to it.attachments[id].orEmpty().filterNot { file -> file.uri == uri })) }
    }

    /** Returns null only when a connection switch invalidated an upload. */
    suspend fun uploadForPrompt(id: String, files: List<DraftAttachment>, api: Bridge, connection: Long): List<String>? {
        return files.mapIndexed { index, file ->
            state.update { it.copy(sendingStatus = "Uploading ${index + 1} of ${files.size}…") }
            file.uploadedId ?: api.upload(id, file, app.contentResolver).also { uploaded ->
                if (connection != generation() || api !== bridge()) return null
                state.update { current -> current.copy(attachments = current.attachments +
                    (id to current.attachments[id].orEmpty().map { if (it.uri == file.uri) it.copy(uploadedId = uploaded) else it })) }
            }
        }
    }

    suspend fun openArtifact(id: String) {
        val api = requireNotNull(bridge()) { "Pair this device first." }
        val connection = generation()
        val paneId = if (id.startsWith("project-")) requireNotNull(state.value.selectedId) else null
        ArtifactDownloads.open(app, api.credentials, id, paneId) {
            connection == generation() && api === bridge() && (paneId == null || state.value.selectedId == paneId)
        }
    }

    fun prepareArtifactSave(id: String, suggestedName: String): String? {
        val api = bridge() ?: return null
        require(id.matches(Regex("[a-zA-Z0-9_-]{1,128}"))) { "Invalid file reference." }
        val paneId = if (id.startsWith("project-")) state.value.selectedId ?: return null else null
        pendingArtifactSave = PendingArtifactSave(id, paneId, api.credentials, generation(), api,
            if (api.credentials.portalDeviceId != null) accountToken() else null)
        return artifactFileName(suggestedName)
    }

    fun completeArtifactSave(destination: Uri?) {
        val request = pendingArtifactSave.also { pendingArtifactSave = null } ?: run {
            destination?.let { runCatching { app.contentResolver.delete(it, null, null) } }
            return
        }
        if (destination == null) return
        fun current() = request.generation == generation() && request.api === bridge() &&
            (request.paneId == null || state.value.selectedId == request.paneId) &&
            (request.credentials.portalDeviceId == null || request.accountToken == accountToken())
        if (!current()) {
            runCatching { app.contentResolver.delete(destination, null, null) }
            state.update { it.copy(message = "Your selected laptop or session changed. Save the file again.") }
            return
        }
        scope.launch {
            try { ArtifactDownloads.save(app, request.credentials, request.id, request.paneId, destination, ::current) }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { state.update { it.copy(message = error.message ?: "Could not save the file.") } }
        }
    }
}
