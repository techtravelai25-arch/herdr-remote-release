package dev.herdr.remote

import java.security.KeyFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class RelayTransportTest {
    private val fixture = Json.parseToJsonElement(javaClass.getResource("/relay-interop-vector.json")!!.readText()).jsonObject
    private fun value(key: String) = fixture.getValue(key).jsonPrimitive.content
    private fun derive(envelope: JsonObject, laptopId: String = value("laptopId")): ByteArray {
        val laptop = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(relayDecode(value("laptopPrivatePkcs8"))))
        val phone = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(relayDecode(envelope.getValue("epk").jsonPrimitive.content)))
        val shared = KeyAgreement.getInstance("ECDH").apply { init(laptop); doPhase(phone, true) }.generateSecret()
        val salt = MessageDigest.getInstance("SHA-256").digest("herdr-remote-relay-v1".toByteArray())
        val extracted = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(salt, "HmacSHA256")) }.doFinal(shared)
        return Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(extracted, "HmacSHA256")) }
            .doFinal("$laptopId:${envelope.getValue("id").jsonPrimitive.content}".toByteArray() + byteArrayOf(1))
    }
    private fun openRequest(envelope: JsonObject): JsonObject {
        val id = envelope.getValue("id").jsonPrimitive.content
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(derive(envelope), "AES"), GCMParameterSpec(128, relayDecode(envelope.getValue("iv").jsonPrimitive.content)))
            updateAAD("herdr-remote-relay-v1:${value("laptopId")}:$id:request".toByteArray())
        }
        return Json.parseToJsonElement(cipher.doFinal(relayDecode(envelope.getValue("data").jsonPrimitive.content)).toString(Charsets.UTF_8)).jsonObject
    }
    private fun response(request: JsonObject, status: Int = 200): JsonObject {
        val id = request.getValue("id").jsonPrimitive.content
        val iv = ByteArray(12) { (it + 1).toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(derive(request), "AES"), GCMParameterSpec(128, iv))
            updateAAD("herdr-remote-relay-v1:${value("laptopId")}:$id:response".toByteArray())
        }
        val plain = buildJsonObject { put("status", status); put("headers", buildJsonObject { put("Content-Type", "application/json") }); put("body", relayEncode("{\"herdrOnline\":true}".toByteArray())) }
        return buildJsonObject { put("v", 1); put("id", id); put("iv", relayEncode(iv)); put("data", relayEncode(cipher.doFinal(plain.toString().toByteArray()))) }
    }
    @Test fun independentNodeFixtureUsesTheSameEcdhHkdfAndGcmProtocol() {
        val envelope = fixture.getValue("envelope").jsonObject
        assertArrayEquals(relayDecode(value("key")), derive(envelope))
        assertEquals(fixture.getValue("plaintext"), openRequest(envelope))
    }
    @Test fun encryptsForTheScannedLaptopAndRejectsTamperingAndReplayAcrossRequests() {
        val cipher = RelayCipher(value("laptopId"), value("laptopPublicSpki"))
        val input = buildJsonObject { put("secret", "private-terminal-output") }
        val request = cipher.encrypt(input)
        assertEquals(input, openRequest(request))
        val reply = response(request)
        assertEquals(200, cipher.decrypt(reply).getValue("status").jsonPrimitive.int)
        val corrupt = reply.toMutableMap().apply { val bytes = relayDecode(getValue("data").jsonPrimitive.content); bytes[0] = (bytes[0].toInt() xor 1).toByte(); put("data", JsonPrimitive(relayEncode(bytes))) }
        assertThrows(Exception::class.java) { cipher.decrypt(JsonObject(corrupt)) }
        assertThrows(IllegalArgumentException::class.java) { RelayCipher(value("laptopId"), value("laptopPublicSpki")).decrypt(reply) }
        assertThrows(Exception::class.java) { cipher.decrypt(request) } // request AAD is never accepted as response
    }
    @Test fun bridgeNeverSendsCredentialPathOrBodyOutsideCipherAndNeverDowngrades() = runBlocking {
        var calls = 0
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val req = chain.request(); calls++
            assertEquals("$TEST_PORTAL_ORIGIN/v1/relay/${value("laptopId")}/rpc", req.url.toString())
            assertEquals("Bearer " + "r".repeat(43), req.header("Authorization")); assertNull(req.header("X-Operation-Id"))
            val raw = Buffer().also { req.body!!.writeTo(it) }.readUtf8()
            assertFalse(raw.contains("private-token")); assertFalse(raw.contains("/v1/panes")); assertFalse(raw.contains("private prompt"))
            val envelope = Json.parseToJsonElement(raw).jsonObject
            val plain = openRequest(envelope)
            assertEquals("Bearer private-token", plain.getValue("headers").jsonObject.getValue("Authorization").jsonPrimitive.content)
            assertTrue(plain.getValue("headers").jsonObject.getValue("Content-Type").jsonPrimitive.content.startsWith("application/json"))
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(200).message("OK").body(response(envelope).toString().toResponseBody()).build()
        }.build()
        val credentials = Credentials(TEST_PORTAL_ORIGIN, "private-token", "phone", relayLaptopId = value("laptopId"), relayPublicKey = value("laptopPublicSpki"), relayVersion = 3, relayRoutingToken = "r".repeat(43), relayRoutingExpires = 0)
        val result = Bridge(credentials, injectedClient = http).call(listOf("v1", "panes", "p", "prompt"), "POST", buildJsonObject { put("text", "private prompt") }, "private-operation-id")
        assertTrue(result.getValue("herdrOnline").jsonPrimitive.boolean); assertEquals(1, calls)
        assertThrows(IllegalStateException::class.java) { runBlocking { Bridge(credentials.copy(relayPublicKey = null), injectedClient = http).snapshot() } }
        assertEquals(1, calls)
    }
    @Test fun customHttpsRelayUsesQrOriginAndRejectsMismatchedRequests() = runBlocking {
        val origin = "https://selfhost.example:8443"
        var calls = 0
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            calls++
            val request = chain.request()
            assertEquals("$origin/v1/relay/${value("laptopId")}/rpc", request.url.toString())
            val envelope = Json.parseToJsonElement(Buffer().also { request.body!!.writeTo(it) }.readUtf8()).jsonObject
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(response(envelope).toString().toResponseBody()).build()
        }.build()
        val credentials = Credentials(origin, "private-token", "phone", relayLaptopId = value("laptopId"),
            relayPublicKey = value("laptopPublicSpki"), relayVersion = 3,
            relayRoutingToken = "r".repeat(43), relayRoutingExpires = 0)
        assertTrue(Bridge(credentials, injectedClient = http).snapshot().herdrOnline)
        for (other in listOf("https://selfhost.example/v1/snapshot", "$TEST_PORTAL_ORIGIN/v1/snapshot")) {
            val request = Request.Builder().url(other).get().build()
            assertThrows(IllegalArgumentException::class.java) { runBlocking { RelayTransport.execute(http, request, credentials) } }
        }
        assertEquals(1, calls)
    }
    @Test fun relayTimeoutAfterMutationRemainsUncertainAndIsNeverRetried() {
        var calls = 0
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            calls++
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(504).message("timeout").body("{}".toResponseBody()).build()
        }.build()
        val credentials = Credentials(TEST_PORTAL_ORIGIN, "private-token", "phone", relayLaptopId = value("laptopId"), relayPublicKey = value("laptopPublicSpki"))
        val error = assertThrows(BridgeHttpException::class.java) { runBlocking {
            Bridge(credentials, injectedClient = http).call(listOf("v1", "panes", "p", "prompt"), "POST", operationId = "operation-123")
        } }
        assertEquals(1, calls)
        assertEquals("uncertain", error.operationStatus)
        assertEquals("operation-123", error.operationId)
        assertTrue(error.message!!.contains("may have completed"))
    }
    @Test fun relayQrAcceptsCustomHttpsOriginButRejectsUnsafeUrlDuplicateFieldsAndWrongCurve() {
        val qr = buildJsonObject { put("type", "herdr-remote"); put("version", 2); put("url", TEST_PORTAL_ORIGIN); put("laptopId", value("laptopId")); put("publicKey", value("laptopPublicSpki")); put("code", "0123456789abcdef0123456789abcdef"); put("expires", 1100) }
        assertEquals(value("laptopId"), PairingQr.parse(qr.toString(), 1000).laptopId)
        assertEquals("https://selfhost.example:8443", PairingQr.parse(qr.toString().replace(TEST_PORTAL_ORIGIN, "https://selfhost.example:8443"), 1000).url)
        for (unsafe in listOf("http://selfhost.example", "https://user@selfhost.example", "https://selfhost.example/api"))
            assertThrows(IllegalArgumentException::class.java) { PairingQr.parse(qr.toString().replace(TEST_PORTAL_ORIGIN, unsafe), 1000) }
        assertThrows(IllegalArgumentException::class.java) { PairingQr.parse(qr.toString().replace("{", "{\"version\":2,"), 1000) }
        assertThrows(IllegalArgumentException::class.java) { PairingQr.parse(qr.toString(), 1200) }
        val wrong = java.security.KeyPairGenerator.getInstance("EC").apply { initialize(java.security.spec.ECGenParameterSpec("secp384r1")) }.generateKeyPair()
        assertThrows(IllegalArgumentException::class.java) { relayPublicKey(relayEncode(wrong.public.encoded)) }
    }
    @Test fun relayV3QrRequiresBoundedUnexpiredBootstrapCapability() {
        val qr = buildJsonObject { put("type", "herdr-remote"); put("version", 3); put("url", TEST_PORTAL_ORIGIN); put("laptopId", value("laptopId")); put("publicKey", value("laptopPublicSpki")); put("code", "0123456789abcdef0123456789abcdef"); put("expires", 1100); put("routingToken", "r".repeat(43)); put("routingExpires", 1090) }
        val parsed = PairingQr.parse(qr.toString(), 1000)
        assertEquals(3, parsed.version); assertEquals("r".repeat(43), parsed.routingToken); assertEquals(1090L, parsed.routingExpires)
        listOf(
            JsonObject(qr - "routingToken"),
            JsonObject(qr + ("routingToken" to JsonPrimitive("secret"))),
            JsonObject(qr + ("routingExpires" to JsonPrimitive(1000))),
            JsonObject(qr + ("routingExpires" to JsonPrimitive(1101))),
        ).forEach { assertThrows(IllegalArgumentException::class.java) { PairingQr.parse(it.toString(), 1000) } }
        assertThrows(IllegalArgumentException::class.java) { PairingQr.parse(qr.toString().replace("{", "{\"routingToken\":\"" + "x".repeat(43) + "\","), 1000) }
    }
    @Test fun strictCredentialsNeverFallBackToAnonymousAndRevocationNeverRetries() {
        val credentials = Credentials(TEST_PORTAL_ORIGIN, "private-token", "phone", portalDeviceId = "registered",
            relayLaptopId = value("laptopId"), relayPublicKey = value("laptopPublicSpki"), relayVersion = 3)
        var requests = 0; var refreshes = 0
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            requests++
            assertEquals("Bearer " + "r".repeat(43), chain.request().header("Authorization"))
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(401).message("revoked").body("{}".toResponseBody()).build()
        }.build()
        assertThrows(IllegalArgumentException::class.java) { runBlocking { Bridge(credentials, injectedClient = http).snapshot() } }
        assertEquals(0, requests)
        val cap = credentials.copy(relayRoutingToken = "r".repeat(43), relayRoutingExpires = 0)
        val error = assertThrows(BridgeHttpException::class.java) { runBlocking {
            Bridge(cap, refreshCredentials = { refreshes++; it.copy(relayRoutingToken = null) }, injectedClient = http).snapshot()
        } }
        assertEquals("relay_pairing_required", error.errorCode); assertEquals(1, requests); assertEquals(0, refreshes)
        assertThrows(IllegalArgumentException::class.java) { relayRoutingToken(cap.copy(relayRoutingExpires = 99), 100) }
        assertEquals("r".repeat(43), relayRoutingToken(cap, Long.MAX_VALUE))
    }

    @Test fun pairingNonceStaysInsideCipherAndBindsOnlyOnePairAttempt() = runBlocking {
        val nonce = relayEncode(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) })
        var calls = 0
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request(); calls++
            assertNull(request.header("X-Pairing-Nonce"))
            val raw = Buffer().also { request.body!!.writeTo(it) }.readUtf8()
            assertFalse(raw.contains(nonce))
            val envelope = Json.parseToJsonElement(raw).jsonObject
            assertEquals(nonce, openRequest(envelope).getValue("headers").jsonObject.getValue("X-Pairing-Nonce").jsonPrimitive.content)
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK").body(response(envelope).toString().toResponseBody()).build()
        }.build()
        val credentials = Credentials(TEST_PORTAL_ORIGIN, "", "", relayLaptopId = value("laptopId"), relayPublicKey = value("laptopPublicSpki"), relayVersion = 3, relayRoutingToken = "r".repeat(43), relayRoutingExpires = 0)
        Bridge(credentials, injectedClient = http).call(listOf("v1", "pair"), "POST", buildJsonObject { put("code", "one-use-code") }, pairingNonce = nonce)
        assertEquals(1, calls)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { Bridge(credentials, injectedClient = http).call(listOf("v1", "snapshot"), pairingNonce = nonce) } }
        assertEquals(1, calls)
    }

}
