package dev.herdr.remote

import android.app.Application
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/** Public cloud updates are independent of all account and laptop credentials. */
internal object CloudUpdates {
    fun request(path: String, origin: String = BuildConfig.UPDATE_ORIGIN): Request {
        require(path == "/v1/app-update" || path == "/v1/app-update/apk") { "Invalid cloud update path." }
        return Request.Builder().url(Deployment.requireOrigin(origin) + path).get().build()
    }
}

@Serializable
data class AppRelease(val versionCode: Long, val versionName: String, val sha256: String, val size: Long, val apkPath: String) {
    fun validate(): AppRelease = apply {
        require(versionCode > 0 && versionName.isNotBlank() && versionName.length <= 100) { "Invalid update version." }
        require(sha256.matches(Regex("[a-fA-F0-9]{64}"))) { "Invalid update checksum." }
        require(size in 1..(100L * 1024 * 1024)) { "Invalid update size." }
        require(apkPath == "/v1/app-update/apk") { "Invalid update download address." }
    }
}

data class AppUpdateState(
    val installedVersion: String,
    val installedCode: Long,
    val latest: AppRelease? = null,
    val busy: Boolean = false,
    val downloading: Boolean = false,
    val downloadedBytes: Long = 0,
    val apk: File? = null,
    val message: String = "Check for a new version from the cloud update service.",
    val error: Boolean = false,
)

@Suppress("DEPRECATION")
private fun PackageInfo.code(): Long = if (Build.VERSION.SDK_INT >= 28) longVersionCode else versionCode.toLong()

class AppUpdater(application: Application) : AndroidViewModel(application) {
    private val context = application
    private val installed = context.packageManager.getPackageInfo(context.packageName, 0)
    private val mutableState = MutableStateFlow(AppUpdateState(installed.versionName ?: "Unknown", installed.code()))
    val state = mutableState.asStateFlow()
    private val directory = File(context.cacheDir, "app-updates")
    private val client = OkHttpClient.Builder().dns(QuickTunnelDns())
        .connectTimeout(45, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.MINUTES).followRedirects(false).followSslRedirects(false)
        // APK GETs are safe to retry when a connection fails before delivery.
        // A partial body still fails checksum/size verification and is discarded.
        .retryOnConnectionFailure(true).build()
    private var job: Job? = null
    @Volatile private var activeCall: Call? = null

    fun check() {
        if (!Deployment.updatesEnabled || state.value.busy) return
        mutableState.update { it.copy(latest = null) }
        startWork {
            val release = request("/v1/app-update").use { response ->
                val body = response.body ?: throw IOException("The update server returned an empty response.")
                val bytes = body.byteStream().use { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(1024)
                    while (output.size() <= 16 * 1024) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                }
                require(bytes.size <= 16 * 1024) { "The update response is too large." }
                Bridge.json.decodeFromString<AppRelease>(bytes.toString(Charsets.UTF_8)).validate()
            }
            currentCoroutineContext().ensureActive()
            mutableState.update { it.copy(latest = release, apk = null, message = if (release.versionCode > installed.code()) "A new version is available." else "You're up to date.") }
        }
    }

    fun download() {
        val release = state.value.latest ?: return
        if (state.value.busy || release.versionCode <= installed.code()) return
        startWork(downloading = true) {
            check(directory.isDirectory || directory.mkdirs()) { "Could not create update storage. Free some space and retry." }
            directory.listFiles()?.filter { it.name.endsWith(".apk") || it.name.endsWith(".part") }?.forEach { it.delete() }
            val partial = File(directory, "update.part")
            try {
                val digest = MessageDigest.getInstance("SHA-256")
                var count = 0L
                request("/v1/app-update/apk").use { response ->
                    val body = response.body ?: throw IOException("The APK download was empty.")
                    require(body.contentLength() == -1L || body.contentLength() == release.size) { "The update changed. Check for updates again." }
                    body.byteStream().use { input -> partial.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val read = input.read(buffer)
                            if (read < 0) break
                            count += read
                            require(count <= release.size) { "The downloaded APK exceeds its expected size." }
                            output.write(buffer, 0, read)
                            digest.update(buffer, 0, read)
                            mutableState.update { it.copy(downloadedBytes = count) }
                        }
                    } }
                }
                require(count == release.size) { "The download was incomplete. Please retry." }
                require(digest.digest().joinToString("") { "%02x".format(it) }.equals(release.sha256, ignoreCase = true)) { "The APK checksum did not match. Check for updates and retry." }
                verifyPackage(partial, release)
                currentCoroutineContext().ensureActive()
                val apk = File(directory, "update-${release.versionCode}.apk")
                check(partial.renameTo(apk)) { "Could not save the downloaded update." }
                mutableState.update { it.copy(apk = apk, message = "Download verified. Tap Install update to continue in Android.") }
            } finally { partial.delete() }
        }
    }

    private fun startWork(downloading: Boolean = false, block: suspend () -> Unit) {
        mutableState.update { it.copy(busy = true, downloading = downloading, downloadedBytes = 0, apk = null, error = false, message = if (downloading) "Downloading update…" else "Checking for updates…") }
        job = viewModelScope.launch(Dispatchers.IO) {
            try { block() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (currentCoroutineContext().isActive) mutableState.update { current -> current.copy(error = true,
                    message = if (downloading && current.downloadedBytes == 0L && e is java.io.InterruptedIOException)
                        "The APK did not start downloading. Retry or use Download in browser below."
                    else e.message ?: "Could not update. Check your connection and try again.") }
            } finally {
                activeCall = null
                mutableState.update { it.copy(busy = false, downloading = false) }
            }
        }
    }

    private suspend fun request(path: String): Response {
        currentCoroutineContext().ensureActive()
        val call = client.newCall(CloudUpdates.request(path))
        activeCall = call
        currentCoroutineContext().ensureActive()
        val response = call.execute()
        if (!response.isSuccessful) {
            response.close()
            throw IOException(when (response.code) {
                401, 403 -> "The public update service is unavailable. Try again later."
                404, 503 -> "No cloud update is available yet. Try again later."
                in 300..399 -> "The cloud update service redirected the request. Try again later."
                else -> "Update server returned HTTP ${response.code}. Try again later."
            })
        }
        return response
    }

    @Suppress("DEPRECATION")
    private fun verifyPackage(file: File, release: AppRelease) {
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = pm.getPackageArchiveInfo(file.absolutePath, flags) ?: throw IOException("The downloaded file is not a valid APK.")
        val current = pm.getPackageInfo(context.packageName, flags)
        require(archive.packageName == "dev.herdr.remote" && archive.packageName == current.packageName) { "This APK belongs to a different app." }
        require(archive.code() == release.versionCode && archive.code() > current.code()) { "The APK version does not match the available update." }
        fun signatures(info: PackageInfo): Set<String> {
            val values = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
            return values.orEmpty().map { it.toCharsString() }.toSet()
        }
        val expected = signatures(current)
        require(expected.isNotEmpty() && signatures(archive) == expected) { "This APK was signed with a different key. Ask for an update signed with the same key as your installed app." }
    }

    fun cancel() {
        job?.cancel()
        activeCall?.cancel()
        mutableState.update { it.copy(message = "Update cancelled.", error = false) }
    }

    fun installationError(message: String) { mutableState.update { it.copy(message = message, error = true) } }
    override fun onCleared() { activeCall?.cancel(); super.onCleared() }
}
