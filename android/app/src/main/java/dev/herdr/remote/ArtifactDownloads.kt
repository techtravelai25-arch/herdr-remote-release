package dev.herdr.remote

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

/**
 * Bounded, authenticated file transfer from the paired laptop. Only opaque IDs
 * on fixed authenticated bridge routes are ever requested. Every transfer is
 * first staged into the small private viewer cache; the connection and account
 * identity captured at start is re-checked before the staged bytes are used,
 * so [open] never displays and [save] never exports a stale laptop's file.
 */
object ArtifactDownloads {
    const val MAX_TRANSFER_BYTES = 20L * 1024 * 1024
    private val activeFiles = ConcurrentHashMap.newKeySet<String>()

    /** Stage into the private cache, verify identity, then show in the system viewer. */
    suspend fun open(context: Context, credentials: Credentials, id: String, paneId: String? = null, stillCurrent: () -> Boolean = { true }) {
        val file = downloadVerified(context, credentials, id, paneId, stillCurrent)
        if (!stillCurrent()) {
            file.delete()
            release(file)
            error("Your selected laptop or session changed. Open the file again.")
        }
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
            context.startActivity(viewerIntent(context, uri, file.extension))
        } catch (cancelled: CancellationException) {
            file.delete(); throw cancelled
        } catch (error: ActivityNotFoundException) {
            // No viewer for this content: never crash, leave no cache orphan.
            file.delete()
            throw IOException("No app on this phone can open this file type. Use Save to keep a copy.")
        } catch (error: Exception) {
            file.delete()
            throw error
        } finally { release(file) }
    }

    internal fun viewerIntent(context: Context, uri: Uri, extension: String): Intent {
        val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.lowercase()) ?: "application/octet-stream"
        val intent = if (ArtifactPreviewActivity.supports(extension, type))
            Intent(context, ArtifactPreviewActivity::class.java).setData(uri)
        else {
            // Some apps claim all generic binary files then silently discard them.
            // A known MIME type is required for a meaningful external-viewer handoff.
            if (type == "application/octet-stream")
                throw IOException("No preview is available for this file type. Use Save to keep a copy.")
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
        }
        return intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /**
     * Stage the bounded file in private cache, verify the connection identity,
     * then copy it into the app-chosen SAF destination. Stale bytes never
     * reach an external provider: verification happens before any external
     * write, and a failed or cancelled copy removes the partial destination.
     */
    suspend fun save(context: Context, credentials: Credentials, id: String, paneId: String?, destination: Uri, stillCurrent: () -> Boolean = { true }) {
        var staged: File? = null
        try {
            val stagedFile = downloadVerified(context, credentials, id, paneId, stillCurrent)
            staged = stagedFile
            withContext(Dispatchers.IO) {
                check(stillCurrent()) { "Your selected laptop or session changed. Save the file again." }
                val output = context.contentResolver.openOutputStream(destination, "wt")
                    ?: throw IOException("The chosen destination is unavailable.")
                output.use { target -> stagedFile.inputStream().use { input ->
                    val buffer = ByteArray(8192)
                    var chunks = 0
                    while (true) {
                        coroutineContext.ensureActive()
                        if (chunks++ % 64 == 0) check(stillCurrent()) { "Your selected laptop or session changed. Save the file again." }
                        val count = input.read(buffer)
                        if (count < 0) break
                        target.write(buffer, 0, count)
                    }
                    check(stillCurrent()) { "Your selected laptop or session changed. Save the file again." }
                } }
            }
        } catch (cancelled: CancellationException) {
            deletePartial(context, destination); throw cancelled
        } catch (error: Exception) {
            deletePartial(context, destination); throw error
        } finally {
            staged?.let { it.delete(); release(it) }
        }
    }

    /**
     * Bounded authenticated download into the private cache, followed by the
     * identity re-check: a laptop or sign-in change discards the staged file.
     */
    private suspend fun downloadVerified(context: Context, credentials: Credentials, id: String, paneId: String?, stillCurrent: () -> Boolean): File {
        require(id.matches(Regex("[a-zA-Z0-9_-]{1,128}"))) { "Invalid file reference." }
        check(stillCurrent()) { "Your selected laptop or session changed. Try again." }
        val accountToken = if (credentials.portalDeviceId != null) AccountStore(context).load()?.token else null
        val auth = AccountConnection(context).resolve(credentials)
        val folder = File(context.cacheDir, "review-files").apply { mkdirs() }
        prune(folder)
        val staged = AtomicReference<File?>()
        val file = try { withContext(Dispatchers.IO) { fetch(auth, id, paneId, folder).also(staged::set) } }
            catch (error: Throwable) { staged.get()?.let { it.delete(); release(it) }; throw error }
        // The captured identity must still match before the staged bytes are used.
        try {
            coroutineContext.ensureActive()
            val current = CredentialStore(context).load()
            val currentToken = if (credentials.portalDeviceId != null) AccountStore(context).load()?.token else null
            check(current?.url == credentials.url && current.deviceId == credentials.deviceId &&
                current.portalDeviceId == credentials.portalDeviceId && currentToken == accountToken && stillCurrent()) {
                "Your selected laptop or sign-in changed. Open the file again."
            }
        } catch (error: Throwable) {
            file.delete()
            release(file)
            throw error
        }
        return file
    }

    /** Fetch through the direct or encrypted relay transport and stage into the cache. */
    private suspend fun fetch(auth: Credentials, id: String, paneId: String?, folder: File): File {
        val url = auth.url.toHttpUrl().newBuilder().apply {
            addPathSegment("v1")
            if (paneId != null) { addPathSegment("panes"); addPathSegment(paneId); addPathSegment("artifacts"); addPathSegment(id) }
            else { addPathSegment("attachments"); addPathSegment(id); addPathSegment("content") }
        }.build()
        if (auth.relayLaptopId != null || auth.relayPublicKey != null) {
            val api = Bridge(auth)
            // Older companions only accept escaped colons in workspace-qualified pane IDs.
            val start = api.call(listOf("v1", "relay-transfer", "download"), "POST", buildJsonObject { put("path", url.encodedPath.replace(":", "%3A")) })
            val transferId = start.getValue("transferId").jsonPrimitive.content
            require(transferId.matches(Regex("[a-zA-Z0-9_-]{1,128}"))) { "Invalid file transfer." }
            val size = start.getValue("size").jsonPrimitive.long
            require(size in 0..MAX_TRANSFER_BYTES) { "This file exceeds the 20 MB limit." }
            try {
                val headers = start["headers"]?.jsonObject
                val extension = extensionFrom(
                    dispositionName(headers?.get("content-disposition")?.jsonPrimitive?.content),
                    headers?.get("content-type")?.jsonPrimitive?.content,
                )
                return stage(folder, extension) { output ->
                    var offset = 0L
                    do {
                        coroutineContext.ensureActive()
                        val part = api.call(listOf("v1", "relay-transfer", "download", transferId), query = mapOf("offset" to offset.toString()))
                        val data = relayDecode(part.getValue("data").jsonPrimitive.content)
                        require(data.size <= RELAY_CHUNK_BYTES && offset + data.size <= size) { "Invalid file transfer data." }
                        output.write(data); offset += data.size
                        val eof = part.getValue("eof").jsonPrimitive.boolean
                        require(part.getValue("size").jsonPrimitive.long == size && (data.isNotEmpty() || eof)) { "File changed during download. Try again." }
                        if (eof) { require(offset == size) { "The file download is incomplete." }; break }
                    } while (true)
                }
            } finally {
                withContext(NonCancellable) { withTimeoutOrNull(5000) { runCatching { api.call(listOf("v1", "relay-transfer", "download", transferId), "DELETE") } } }
            }
        }
        val client = OkHttpClient.Builder().dns(QuickTunnelDns()).followRedirects(false).followSslRedirects(false)
            .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS).callTimeout(90, TimeUnit.SECONDS).build()
        val response = executeNetwork(client, Request.Builder().url(url).header("Authorization", "Bearer ${auth.token}").build())
        return response.use { response ->
            require(response.isSuccessful) { "The file is unavailable. Refresh results and try again." }
            val body = response.body ?: error("The file is empty.")
            require(body.contentLength() <= MAX_TRANSFER_BYTES) { "This file exceeds the 20 MB limit." }
            val serverName = dispositionName(response.header("Content-Disposition"))
            val extension = extensionFrom(serverName, response.header("Content-Type"))
            stage(folder, extension) { target ->
                body.byteStream().use { source ->
                    val buffer = ByteArray(8192); var total = 0L
                    while (true) {
                        coroutineContext.ensureActive()
                        val count = source.read(buffer); if (count < 0) break
                        total += count
                        require(total <= MAX_TRANSFER_BYTES) { "This file exceeds the 20 MB limit." }
                        target.write(buffer, 0, count)
                    }
                }
            }
        }
    }

    private suspend fun stage(folder: File, extension: String, write: suspend (OutputStream) -> Unit): File {
        val filename = UUID.randomUUID().toString()
        val output = File(folder, "$filename.$extension")
        val partial = File(folder, "$filename.part")
        try {
            partial.outputStream().use { write(it) }
            activeFiles.add(output.absolutePath)
            check(partial.renameTo(output)) { "Could not save the file." }
            return output
        } catch (error: Throwable) {
            activeFiles.remove(output.absolutePath)
            output.delete()
            throw error
        } finally { partial.delete() }
    }

    private fun release(file: File) {
        activeFiles.remove(file.absolutePath)
        prune(file.parentFile ?: return)
    }

    private fun prune(folder: File) {
        val eligible = folder.listFiles()?.filter { it.isFile && it.extension != "part" && it.absolutePath !in activeFiles }
            ?.sortedByDescending { it.lastModified() }.orEmpty()
        val cutoff = System.currentTimeMillis() - 86400000
        eligible.forEachIndexed { index, file -> if (index >= 10 || file.lastModified() < cutoff) file.delete() }
    }

    private fun deletePartial(context: Context, destination: Uri) {
        runCatching { context.contentResolver.delete(destination, null, null) }
    }

    /** Resolve a useful, safe extension from the server name, content type or fallback. */
    private fun extensionFrom(name: String, contentType: String?): String {
        val fromName = name.substringAfterLast('.', "").lowercase()
        if (Regex("[a-z0-9]{1,12}").matches(fromName)) return fromName
        return MimeTypeMap.getSingleton().getExtensionFromMimeType(contentType?.substringBefore(';')?.trim()) ?: "bin"
    }

    /** Extract a safe filename from a Content-Disposition attachment header. */
    internal fun dispositionName(raw: String?): String {
        val value = raw.orEmpty()
        val encoded = Regex("filename\\*\\s*=\\s*(?:UTF-8|utf-8)''([^;]+)").find(value)?.groupValues?.get(1)
        val plain = Regex("filename\\s*=\\s*\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(value)?.groupValues?.get(1)
        val candidate = encoded?.trim()?.let { runCatching { java.net.URLDecoder.decode(it.replace("+", "%2B"), "UTF-8") }.getOrNull() ?: it }
            ?: plain?.trim().orEmpty()
        if (!candidate.isSafeStem()) return ""
        if (candidate.length <= 120) return candidate
        val suffix = candidate.substringAfterLast('.', "").takeIf { it.length in 1..12 && it.all(Char::isLetterOrDigit) }
        return if (suffix == null) candidate.take(120) else candidate.take(119 - suffix.length) + "." + suffix
    }

    private fun String.isSafeStem(): Boolean = isNotBlank() && none { it.isISOControl() || it == '/' || it == '\\' } &&
        !startsWith(".") && this != "." && this != ".."
}
