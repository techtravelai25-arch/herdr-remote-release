package dev.herdr.remote

import java.io.IOException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal const val RELAY_ENVELOPE_LIMIT = 512 * 1024
internal const val RELAY_CHUNK_BYTES = 128 * 1024
internal fun relayEncode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
internal fun relayDecode(value: String): ByteArray {
    require(value.length <= RELAY_ENVELOPE_LIMIT && value.matches(Regex("[A-Za-z0-9_-]*"))) { "Invalid encrypted relay data." }
    return Base64.getUrlDecoder().decode(value)
}
private val relayCurveParameters by lazy {
    (KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair().public as ECPublicKey).params
}
internal fun relayPublicKey(encoded: String): ECPublicKey {
    require(encoded.length in 80..256) { "Invalid laptop identity. Scan a new QR code." }
    val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(relayDecode(encoded))) as? ECPublicKey
        ?: error("Invalid laptop identity.")
    val reference = relayCurveParameters
    require(key.params.curve == reference.curve && key.params.generator == reference.generator &&
        key.params.order == reference.order && key.params.cofactor == reference.cofactor) { "Unsupported laptop encryption key." }
    return key
}

/** A fresh ephemeral key for each RPC. Laptop identity comes only from a scanned QR. */
internal class RelayCipher(private val laptopId: String, publicKey: String, val id: String = UUID.randomUUID().toString()) {
    private val ephemeral = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val key: SecretKeySpec
    init {
        require(laptopId.matches(Regex("[a-zA-Z0-9_-]{1,80}"))) { "Invalid laptop identity." }
        val shared = KeyAgreement.getInstance("ECDH").apply { init(ephemeral.private); doPhase(relayPublicKey(publicKey), true) }.generateSecret()
        val salt = MessageDigest.getInstance("SHA-256").digest("herdr-remote-relay-v1".toByteArray(Charsets.UTF_8))
        val extract = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(salt, "HmacSHA256")) }.doFinal(shared)
        shared.fill(0)
        val expanded = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(extract, "HmacSHA256")) }
            .doFinal("$laptopId:$id".toByteArray(Charsets.UTF_8) + byteArrayOf(1))
        extract.fill(0)
        key = SecretKeySpec(expanded, "AES")
        expanded.fill(0)
    }
    private fun aad(direction: String) = "herdr-remote-relay-v1:$laptopId:$id:$direction".toByteArray(Charsets.UTF_8)
    fun encrypt(plain: JsonObject): JsonObject {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv)); updateAAD(aad("request")) }
        return buildJsonObject {
            put("v", 1); put("id", id); put("epk", relayEncode(ephemeral.public.encoded)); put("iv", relayEncode(iv))
            put("data", relayEncode(cipher.doFinal(plain.toString().toByteArray(Charsets.UTF_8))))
        }.also { require(it.toString().toByteArray().size <= RELAY_ENVELOPE_LIMIT) { "This request is too large for the encrypted connection." } }
    }
    fun decrypt(envelope: JsonObject): JsonObject {
        require(envelope["v"]?.jsonPrimitive?.intOrNull == 1 && envelope["id"]?.jsonPrimitive?.content == id) { "The encrypted response does not match this request." }
        val iv = relayDecode(envelope.getValue("iv").jsonPrimitive.content)
        require(iv.size == 12) { "Invalid encrypted response." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)); updateAAD(aad("response")) }
        return Json.parseToJsonElement(cipher.doFinal(relayDecode(envelope.getValue("data").jsonPrimitive.content)).toString(Charsets.UTF_8)).jsonObject
    }
}

internal suspend fun executeNetwork(http: OkHttpClient, request: Request): Response = suspendCancellableCoroutine { continuation ->
    val call = http.newCall(request)
    continuation.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
        override fun onResponse(call: Call, response: Response) { if (continuation.isActive) continuation.resume(response) else response.close() }
    })
}

internal object RelayTransport {
    /** Key agreement, the capped body read, AES-GCM and JSON parsing all run on [Dispatchers.IO]. */
    suspend fun execute(http: OkHttpClient, request: Request, credentials: Credentials): Response = withContext(Dispatchers.IO) {
        val laptopId = credentials.relayLaptopId ?: error("Missing encrypted connection identity.")
        val origin = Bridge.normalizeUrl(credentials.url).toHttpUrl()
        require(request.url.isHttps && request.url.host == origin.host && request.url.port == origin.port &&
            request.url.username.isEmpty() && request.url.password.isEmpty()) { "Invalid relay address." }
        val routingToken = relayRoutingToken(credentials)
        val crypto = RelayCipher(laptopId, credentials.relayPublicKey ?: error("Scan your laptop QR code to verify its identity."))
        val body = request.body?.let { Buffer().also(it::writeTo).readByteArray() } ?: byteArrayOf()
        val plain = buildJsonObject {
            put("method", request.method)
            put("path", request.url.encodedPath + (request.url.encodedQuery?.let { "?$it" } ?: ""))
            put("headers", buildJsonObject {
                request.headers.forEach { (name, value) -> put(name, value) }
                if (request.header("Content-Type") == null) request.body?.contentType()?.let { put("Content-Type", it.toString()) }
            })
            put("body", relayEncode(body)); put("timestamp", System.currentTimeMillis())
        }
        val outer = Request.Builder().url(origin.newBuilder().addPathSegment("v1").addPathSegment("relay").addPathSegment(laptopId).addPathSegment("rpc").build())
            .apply { routingToken?.let { header("Authorization", "Bearer $it") } }
            .post(crypto.encrypt(plain).toString().toRequestBody("application/json".toMediaType())).build()
        executeNetwork(http, outer).use { response ->
            if (!response.isSuccessful) {
                val uncertain = request.method !in listOf("GET", "HEAD") && (response.code >= 500 || response.code == 408)
                throw BridgeHttpException(response.code, if (uncertain)
                    "The connection was interrupted. This action may have completed; check the laptop or delivery status before sending it again."
                else when (response.code) {
                    401, 403 -> "This laptop needs a fresh pairing. Update the laptop companion and scan its QR to reconnect."
                    404, 503, 504 -> "Your laptop is offline. Keep it awake and connected, then reconnect."
                    429 -> "The encrypted connection is busy. Wait a moment and try again."
                    else -> "The encrypted connection failed. Reconnect and check its status."
                }, errorCode = if (uncertain) "operation_uncertain" else if (response.code in listOf(401, 403)) "relay_pairing_required" else null, operationId = request.header("X-Operation-Id"), operationStatus = if (uncertain) "uncertain" else null)
            }
            if (response.body == null) error("Empty relay response.")
            val bytes = requireNotNull(readBoundedBody(response.body, RELAY_ENVELOPE_LIMIT)) { "Encrypted response is too large." }
            val decoded = try { crypto.decrypt(Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject) }
                catch (e: Exception) { throw IOException(if (request.method in listOf("GET", "HEAD")) "Could not verify the encrypted laptop response. Reconnect or scan your laptop again."
                    else "Could not verify the laptop response. This action may have completed; check the laptop before sending it again.", e) }
            val status = decoded.getValue("status").jsonPrimitive.int
            require(status in 100..599) { "Invalid laptop response." }
            val headers = Headers.Builder().apply { decoded["headers"]?.jsonObject?.forEach { (name, value) -> add(name, value.jsonPrimitive.content) } }.build()
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status).message("Laptop response")
                .headers(headers).body(relayDecode(decoded.getValue("body").jsonPrimitive.content).toResponseBody(headers["Content-Type"]?.toMediaType())).build()
        }
    }
}

internal fun relayRoutingToken(credentials: Credentials, now: Long = System.currentTimeMillis() / 1000): String? {
    val token = credentials.relayRoutingToken
    if (token == null && credentials.relayVersion < 3) return null // Explicit legacy v2 only; strict servers reject it.
    require(token?.matches(Regex("[A-Za-z0-9_-]{43}")) == true && credentials.relayRoutingExpires != null) { "Scan a fresh laptop QR to restore routing access." }
    require(credentials.relayRoutingExpires == 0L || credentials.relayRoutingExpires > now) { "This routing ticket expired. Generate a fresh laptop QR." }
    return token
}
