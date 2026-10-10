package dev.herdr.remote

import android.content.Context
import android.content.ContentResolver
import android.net.Uri
import androidx.core.content.edit
import okio.BufferedSink
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal fun shouldRefreshGrant(method: String, statusCode: Int, hasPortalGrant: Boolean): Boolean =
    method == "GET" && statusCode == 401 && hasPortalGrant

/** Direct HTTPS bodies are capped like relay envelopes; review diffs are the largest legitimate JSON replies. */
internal const val BRIDGE_RESPONSE_LIMIT = 2 * 1024 * 1024

/** Reads at most [limit] bytes; returns null when the body is larger, without buffering the remainder. */
internal fun readBoundedBody(body: ResponseBody?, limit: Int): ByteArray? {
    val source = body?.source() ?: return ByteArray(0)
    source.request(limit + 1L)
    if (source.buffer.size > limit) return null
    return source.buffer.readByteArray()
}

/** Decode a bridge or portal reply; a successful reply must be a bounded JSON object. */
internal fun parseBridgeResponse(response: Response): JsonObject {
    val raw = readBoundedBody(response.body, BRIDGE_RESPONSE_LIMIT)
    val parsed = raw?.let { bytes -> runCatching { Bridge.json.parseToJsonElement(bytes.toString(Charsets.UTF_8)) as? JsonObject }.getOrNull() }
    if (!response.isSuccessful) {
        val error = parsed?.get("error") as? JsonObject
        val message = error?.get("message")?.jsonPrimitive?.contentOrNull
        throw BridgeHttpException(response.code, message ?: "Server returned HTTP ${response.code}. Check the address and pairing.",
            error?.get("code")?.jsonPrimitive?.contentOrNull,
            error?.get("operationId")?.jsonPrimitive?.contentOrNull,
            error?.get("operationStatus")?.jsonPrimitive?.contentOrNull)
    }
    if (parsed != null) return parsed
    val observation = response.request.method in listOf("GET", "HEAD")
    val problem = if (raw == null) "The laptop reply was too large to read." else "The laptop sent a reply this app cannot read (HTTP ${response.code}, not JSON)."
    throw java.io.IOException(if (observation) "$problem Update the laptop companion or check the server address."
        else "$problem This action may have completed; check the laptop before sending it again.")
}

@Serializable data class Workspace(val id: String, val label: String)
@Serializable data class Project(val id: String, val label: String)
@Serializable data class Pane(val id: String, val workspaceId: String, val tabId: String = "", val title: String = "Terminal", val cwd: String = "", val kind: String = "terminal", val status: String = "unknown", val lastActivity: String? = null, val revision: Long = 0, val projectId: String? = null, val projectLabel: String? = null, val completionEventId: String? = null, val completionAcknowledged: Boolean = false, val acknowledgedCompletionEventIds: List<String> = emptyList(), val attentionEventId: String? = null, val attentionAcknowledged: Boolean = false, val acknowledgedAttentionEventIds: List<String> = emptyList())
@Serializable data class Snapshot(val herdrOnline: Boolean = false, val hostname: String = "Laptop", val workspaces: List<Workspace> = emptyList(), val panes: List<Pane> = emptyList(), val projects: List<Project> = emptyList(), val error: String? = null, val allowTerminalInput: Boolean = false, val canStartHerdr: Boolean = false, val attachmentsEnabled: Boolean = false, val reviewEnabled: Boolean = false, val sessionResumeSupported: Boolean = false, val directoryBrowsingEnabled: Boolean = false, val terminalCreationEnabled: Boolean = false, val terminalInputEnabled: Boolean = false, val terminalSnapshotSource: String? = null, val codexModelSelectionEnabled: Boolean = false, val agentModelSelectionEnabled: Boolean = false, val modelSelectionAgents: List<String> = emptyList(), val sessionRenameEnabled: Boolean = false, val desktopHandoffEnabled: Boolean = false, val structuredHistoryEnabled: Boolean = false, val activityTimelineEnabled: Boolean = false, val permissionMode: String = "normal", val canControl: Boolean = true, val lastUpdatedAt: String? = null, val stale: Boolean = false, val usage: List<ProviderUsage> = emptyList(), val questionSelectionEnabled: Boolean = false)
@Serializable data class RemoteDirectory(val name: String, val path: String)
@Serializable data class DirectoryListing(val home: String, val current: String, val parent: String? = null, val directories: List<RemoteDirectory> = emptyList(), val recent: List<RemoteDirectory> = emptyList(), val nextCursor: String? = null)
@Serializable data class BridgeQuestion(val id: String, val prompt: String, val options: List<String>, val selectedIndex: Int? = null, val freeText: Boolean = false, val stage: String = "choices", val multiSelect: Boolean = false, val selectedOptions: List<Int> = emptyList(), val cancelAvailable: Boolean = false)
@Serializable data class Output(val text: String = "", val revision: Long = 0, val truncated: Boolean = false, val source: String = "recent_unwrapped", val attachmentId: String? = null, val currentModel: String? = null, val question: BridgeQuestion? = null, val codexModelMenu: CodexModelMenu? = null, val agentModelMenu: CodexModelMenu? = null, val questionReviewAvailable: Boolean = false, val questionAwaitingTransition: Boolean = false)
@Serializable data class Credentials(val url: String, val token: String, val deviceId: String, val portalDeviceId: String? = null, val expiresAt: Long? = null, val relayLaptopId: String? = null, val relayPublicKey: String? = null, val relayVersion: Int = 2, val relayRoutingToken: String? = null, val relayRoutingExpires: Long? = null)

/** Only encrypted credentials reach disk. Keys are non-exportable in Android Keystore. */
class BridgeHttpException(val statusCode: Int, message: String, val errorCode: String? = null, val operationId: String? = null, val operationStatus: String? = null): java.io.IOException(message)

/** Shared by every store instance so refresh commits cannot race sign-out or device changes. */
internal object CredentialStorageLock { val monitor = Any() }

internal class EncryptedStorage(context: Context, name: String, private val alias: String) {
    private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun save(value: String) = synchronized(CredentialStorageLock.monitor) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val data = cipher.doFinal(value.toByteArray())
        check(prefs.edit().putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("data", Base64.encodeToString(data, Base64.NO_WRAP)).commit()) { "Could not save credentials. Free some storage and try again." }
    }
    fun load(): String? = synchronized(CredentialStorageLock.monitor) {
        val data = prefs.getString("data", null) ?: return@synchronized null
        runCatching {
            val iv = Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)) }
            String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)))
        }.getOrElse { clear(); null }
    }
    fun clear() { synchronized(CredentialStorageLock.monitor) { prefs.edit(commit = true) { clear() } } }
}

class CredentialStore(context: Context) {
    private val storage = EncryptedStorage(context, "device_credentials", "herdr.remote.credentials.v1")
    fun save(value: Credentials) = storage.save(Json.encodeToString(value))
    fun load(): Credentials? = storage.load()?.let { raw -> runCatching { Json.decodeFromString<Credentials>(raw) }.getOrNull() }
    fun clear() = storage.clear()
}

class Bridge(
    val credentials: Credentials,
    private val resolveCredentials: suspend (Credentials) -> Credentials = { it },
    private val refreshCredentials: (suspend (Credentials) -> Credentials)? = null,
    private val injectedClient: OkHttpClient? = null,
) {
    companion object {
        val json = Json { ignoreUnknownKeys = true }
        // Credentials live on individual requests, so pooling cannot carry account tokens to a laptop.
        private val sharedClient by lazy { OkHttpClient.Builder().dns(QuickTunnelDns()).connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS).callTimeout(40, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS).retryOnConnectionFailure(false)
            .followRedirects(false).followSslRedirects(false).build() }
        fun saved(context: Context, credentials: Credentials): Bridge = Bridge(credentials, AccountConnection(context)::resolve, AccountConnection(context)::forceRefresh)
        fun normalizeUrl(input: String): String {
            val url = input.trim().toHttpUrl()
            require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null && url.encodedPath == "/") { "Use an HTTPS server URL without a path, query or credentials." }
            return url.toString().trimEnd('/')
        }
    }
    private val client get() = injectedClient ?: sharedClient
    private fun requestClient(path: List<String>, method: String): OkHttpClient =
        if (method == "POST" && (path == listOf("v1", "agents") ||
            (path.size == 4 && path.take(2) == listOf("v1", "panes") && path.last() == "restart"))) {
            // agent.start may wait for the local CLI to finish booting. The
            // bridge keeps its operation receipt while this request is open;
            // do not turn a normal 35s startup into a false delivery unknown.
            client.newBuilder().readTimeout(65, TimeUnit.SECONDS).callTimeout(75, TimeUnit.SECONDS).build()
        } else client
    private fun request(path: List<String>, auth: Credentials, query: Map<String, String> = emptyMap()): Request.Builder {
        val url = auth.url.toHttpUrl().newBuilder().apply { path.forEach { addPathSegment(it) }; query.forEach { (key, value) -> addQueryParameter(key, value) } }.build()
        return Request.Builder().url(url).apply { if (auth.token.isNotBlank()) header("Authorization", "Bearer ${auth.token}") }
    }
    suspend fun call(path: List<String>, method: String = "GET", body: JsonObject = buildJsonObject {}, operationId: String? = null, query: Map<String, String> = emptyMap(), pairingNonce: String? = null): JsonObject {
        val resolved = resolveCredentials(credentials)
        if (pairingNonce != null) require(path == listOf("v1", "pair") && method == "POST" && resolved.relayVersion >= 3 && resolved.relayLaptopId != null && resolved.token.isBlank() && pairingNonce.matches(Regex("[A-Za-z0-9_-]{43}"))) { "Invalid pairing request." }
        val req = request(path, resolved, query).apply { if (pairingNonce != null) header("X-Pairing-Nonce", pairingNonce); if (operationId != null) header("X-Operation-Id", operationId) }
            .method(method, if (method in listOf("GET", "DELETE")) null else body.toString().toRequestBody("application/json".toMediaType())).build()
        val requestClient = requestClient(path, method)
        return try { execute(req, requestClient, resolved) }
        catch (error: BridgeHttpException) {
            // A grant can be revoked or invalidated while its cached expiry is
            // still in the future. Refresh observation requests once. Never
            // replay a mutation after an authentication failure.
            if (!shouldRefreshGrant(method, error.statusCode, credentials.portalDeviceId != null && credentials.relayLaptopId == null) || refreshCredentials == null) throw error
            refreshCredentials(resolved).let { fresh -> execute(request(path, fresh, query).build(), requestClient, fresh) }
        }
    }
    /** The single choke point for laptop and portal RPCs: network, relay crypto and JSON parsing never run on the caller's dispatcher. */
    private suspend fun execute(req: Request, http: OkHttpClient = client, auth: Credentials = credentials): JsonObject = withContext(Dispatchers.IO) {
        val response = if (auth.relayLaptopId != null || auth.relayPublicKey != null) RelayTransport.execute(http, req, auth)
            else executeNetwork(http, req)
        response.use { parseBridgeResponse(it) }
    }
    suspend fun upload(paneId: String, file: DraftAttachment, resolver: ContentResolver): String {
        if (credentials.relayLaptopId != null || credentials.relayPublicKey != null) {
            val bytes = withContext(Dispatchers.IO) {
                val input = resolver.openInputStream(file.uri) ?: error("Cannot open ${file.name}. Choose the file again.")
                input.use { source -> java.io.ByteArrayOutputStream().use { output -> copyAttachment(source) { buffer, count -> output.write(buffer, 0, count) }; output.toByteArray() } }
            }
            val start = call(listOf("v1", "relay-transfer", "upload"), "POST", buildJsonObject { put("paneId", paneId); put("name", file.name); put("size", bytes.size) })
            val transferId = start.getValue("transferId").jsonPrimitive.content
            require(transferId.matches(Regex("[a-zA-Z0-9_-]{1,128}"))) { "Invalid file transfer." }
            try {
                var offset = 0
                while (offset < bytes.size) {
                    val end = minOf(offset + RELAY_CHUNK_BYTES, bytes.size)
                    val result = call(listOf("v1", "relay-transfer", "upload", transferId), "POST", buildJsonObject { put("offset", offset); put("data", relayEncode(bytes.copyOfRange(offset, end))) })
                    require(result.getValue("offset").jsonPrimitive.int == end) { "File upload was interrupted. Try again." }
                    offset = end
                }
                return call(listOf("v1", "relay-transfer", "upload", transferId, "finish"), "POST").getValue("id").jsonPrimitive.content
            } finally {
                bytes.fill(0)
                withContext(kotlinx.coroutines.NonCancellable) { kotlinx.coroutines.withTimeoutOrNull(5000) { runCatching { call(listOf("v1", "relay-transfer", "upload", transferId), "DELETE") } } }
            }
        }
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                val input = resolver.openInputStream(file.uri) ?: throw java.io.IOException("Cannot open ${file.name}. Choose the file again.")
                input.use {
                    copyAttachment(it) { buffer, count -> sink.write(buffer, 0, count) }
                }
            }
        }
        val req = request(listOf("v1", "panes", paneId, "attachments"), resolveCredentials(credentials))
            .header("X-Attachment-Name", Uri.encode(file.name)).post(body).build()
        val uploadClient = client.newBuilder().callTimeout(5, TimeUnit.MINUTES).writeTimeout(60, TimeUnit.SECONDS).build()
        return execute(req, uploadClient).getValue("id").jsonPrimitive.content
    }
    suspend fun directories(path: String? = null, cursor: String? = null): DirectoryListing = fetch(DirectoryListing.serializer(), listOf("v1", "directories"),
        buildMap { path?.let { put("path", it) }; cursor?.let { put("cursor", it) } })
    suspend fun paneFiles(paneId: String, directory: String? = null, cursor: String? = null) = withContext(Dispatchers.IO) { parseProjectFiles(
        call(listOf("v1", "panes", paneId, "files"), query = buildMap {
            directory?.let { put("directory", it) }
            cursor?.let { put("cursor", it) }
        })) }
    /** Fetch and decode a typed response off the caller's dispatcher. */
    internal suspend fun <T> fetch(deserializer: DeserializationStrategy<T>, path: List<String>, query: Map<String, String> = emptyMap()): T =
        withContext(Dispatchers.IO) { json.decodeFromJsonElement(deserializer, call(path, query = query)) }
    suspend fun snapshot(): Snapshot = fetch(Snapshot.serializer(), listOf("v1", "snapshot"))
    suspend fun output(id: String): Output = fetch(Output.serializer(), listOf("v1", "panes", id, "output"))
    internal fun events(poller: AdaptivePoller = AdaptivePoller(), urgent: () -> Boolean = { false }) = callbackFlow<Snapshot> {
        val auth = resolveCredentials(credentials)
        if (auth.relayLaptopId != null || auth.relayPublicKey != null) {
            val polling = launch {
                try { while (true) {
                    val next = snapshot()
                    send(next)
                    poller.pause(snapshotPollFingerprint(next), snapshotHasWork(next) || urgent())
                } }
                catch (e: kotlinx.coroutines.CancellationException) { throw e }
                catch (e: Exception) { close(e) }
            }
            awaitClose { polling.cancel() }
            return@callbackFlow
        }
        val socket = client.newWebSocket(request(listOf("v1", "events"), auth).build(), object: WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching {
                    val event = json.parseToJsonElement(text).jsonObject
                    if (event["type"]?.jsonPrimitive?.content == "snapshot") trySend(json.decodeFromJsonElement<Snapshot>(event.getValue("data")))
                }.onFailure { close(it) }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { response?.close(); close(t) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                close()
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { close() }
        })
        // Renew before a short-lived device grant expires, including background alerts.
        val renewal = auth.expiresAt?.let { expires -> launch {
            delay(((expires - System.currentTimeMillis() / 1000 - 30).coerceAtLeast(1)) * 1000)
            close()
        } }
        awaitClose { renewal?.cancel(); socket.cancel() }
    }
}
