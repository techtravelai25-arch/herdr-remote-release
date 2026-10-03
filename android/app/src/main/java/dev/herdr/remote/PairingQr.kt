package dev.herdr.remote

import java.net.URI
import java.net.URLDecoder
import kotlinx.serialization.json.*

/** Parse locally before making any network request. Never include payloads in errors. */
data class PairingQr(val url: String, val code: String, val expires: Long, val laptopId: String? = null, val publicKey: String? = null, val version: Int = 1, val routingToken: String? = null, val routingExpires: Long? = null) {
    companion object {
        fun parse(input: String, nowSeconds: Long = System.currentTimeMillis() / 1000): PairingQr {
            require(input.length in 1..2048) { "This is not a Herdr Remote pairing QR code." }
            if (input.trimStart().startsWith("{")) return parseRelay(input, nowSeconds)
            val uri = try { URI(input) } catch (_: Exception) {
                throw IllegalArgumentException("This is not a valid pairing QR code.")
            }
            require(uri.scheme == "herdr-remote" && uri.rawAuthority == "pair" && uri.rawPath.isNullOrEmpty() && uri.rawFragment == null) {
                "This is not a Herdr Remote pairing QR code."
            }
            val params = linkedMapOf<String, String>()
            for (part in uri.rawQuery.orEmpty().split('&')) {
                val fields = part.split('=', limit = 2)
                require(fields.size == 2) { "The pairing QR code is incomplete." }
                val key = decode(fields[0])
                require(key in setOf("v", "url", "code", "expires") && !params.containsKey(key)) { "The pairing QR code has invalid fields." }
                params[key] = decode(fields[1])
            }
            require(params.keys == setOf("v", "url", "code", "expires")) { "The pairing QR code is incomplete." }
            require(params["v"] == "1") { "This pairing QR version is unsupported. Update Herdr Remote." }
            val code = params.getValue("code")
            require(code.matches(Regex("[0-9a-f]{32}"))) { "The pairing code is invalid. Generate a new QR code." }
            val rawExpiry = params.getValue("expires")
            val expires = rawExpiry.takeIf { it.matches(Regex("[0-9]{1,12}")) }?.toLongOrNull()
                ?: throw IllegalArgumentException("The pairing QR expiry is invalid.")
            require(expires > nowSeconds) { "This pairing QR code has expired. Run herdr-remote pair again on your laptop." }
            require(expires - nowSeconds <= 600) { "The pairing QR expiry is invalid. Check your phone clock and generate a new code." }
            val url = try { Bridge.normalizeUrl(params.getValue("url")) } catch (_: Exception) {
                throw IllegalArgumentException("The pairing QR must contain an HTTPS server address without a path or credentials.")
            }
            return PairingQr(url, code, expires)
        }
        private fun parseRelay(input: String, nowSeconds: Long): PairingQr {
            val fieldNames = Regex("\"([a-zA-Z]+)\"\\s*:").findAll(input).map { it.groupValues[1] }.toList()
            require(fieldNames.size in setOf(7, 9) && fieldNames.distinct().size == fieldNames.size) { "The pairing QR code has duplicate or invalid fields." }
            val value = try { Json.parseToJsonElement(input).jsonObject } catch (_: Exception) { error("Invalid pairing QR code.") }
            val version = value["version"]?.jsonPrimitive?.intOrNull
            val expected = setOf("type", "version", "url", "laptopId", "publicKey", "code", "expires") + if (version == 3) setOf("routingToken", "routingExpires") else emptySet()
            require(value.keys == expected) { "The pairing QR code has invalid fields." }
            require(value.getValue("type").jsonPrimitive.content == "herdr-remote" && version in setOf(2, 3)) { "Update the app to use this pairing QR." }
            val origin = Bridge.normalizeUrl(value.getValue("url").jsonPrimitive.content)
            val laptopId = value.getValue("laptopId").jsonPrimitive.content
            require(laptopId.matches(Regex("[a-zA-Z0-9_-]{1,80}"))) { "Invalid laptop identity." }
            val key = value.getValue("publicKey").jsonPrimitive.content
            relayPublicKey(key)
            val code = value.getValue("code").jsonPrimitive.content
            require(code.matches(Regex("[0-9a-f]{32}"))) { "Invalid pairing code. Generate a new QR." }
            val expires = value.getValue("expires").jsonPrimitive.long
            require(expires > nowSeconds && expires - nowSeconds <= 600) { "This QR expired or your phone clock is incorrect. Generate a new QR on your laptop." }
            val routingToken = value["routingToken"]?.jsonPrimitive?.content
            val routingExpires = value["routingExpires"]?.jsonPrimitive?.longOrNull
            if (version == 3) {
                require(routingToken?.matches(Regex("[A-Za-z0-9_-]{43}")) == true) { "Invalid routing ticket. Generate a fresh laptop QR." }
                require(routingExpires != null && routingExpires > nowSeconds && routingExpires <= expires) { "The QR routing ticket expired. Generate a fresh laptop QR." }
            }
            return PairingQr(origin, code, expires, laptopId, key, version!!, routingToken, routingExpires)
        }
        private fun decode(value: String): String = try { URLDecoder.decode(value, "UTF-8") } catch (_: Exception) {
            throw IllegalArgumentException("The pairing QR code contains invalid encoding.")
        }
    }
}
