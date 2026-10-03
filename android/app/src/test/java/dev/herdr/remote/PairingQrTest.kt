package dev.herdr.remote

import java.net.URLEncoder
import org.junit.Assert.*
import org.junit.Test

class PairingQrTest {
    private val now = 1_800_000_000L
    private val code = "0123456789abcdef0123456789abcdef"
    private fun payload(url: String = "https://laptop.example.com", expires: Long = now + 300) =
        "herdr-remote://pair?v=1&url=${URLEncoder.encode(url, "UTF-8")}&code=$code&expires=$expires"
    private fun rejects(input: String) {
        assertThrows(IllegalArgumentException::class.java) { PairingQr.parse(input, now) }
    }
    @Test fun parsesTerminalPayloadAndNormalizesOrigin() {
        val result = PairingQr.parse(payload("https://LAPTOP.example.com:443/"), now)
        assertEquals("https://laptop.example.com", result.url)
        assertEquals(code, result.code)
        assertEquals(now + 300, result.expires)
    }
    @Test fun acceptsIpv6AndCustomHttpsPort() {
        assertEquals("https://[::1]:8443", PairingQr.parse(payload("https://[::1]:8443"), now).url)
    }
    @Test fun acceptsExpiryAtTenMinuteLimit() {
        assertEquals(now + 600, PairingQr.parse(payload(expires = now + 600), now).expires)
    }
    @Test fun rejectsExpiredOrImplausibleExpiry() {
        listOf(now, now - 1, now + 601, Long.MAX_VALUE).forEach { rejects(payload(expires = it)) }
        rejects(payload().replace("expires=${now + 300}", "expires=1e12"))
    }
    @Test fun rejectsUntrustedSchemeAuthorityOrPath() {
        val good = payload()
        listOf(
            good.replace("herdr-remote:", "https:"),
            good.replace("//pair?", "//other?"),
            good.replace("//pair?", "//pair/?"),
            good.replace("//pair?", "//user@pair?"),
            good.replace("//pair?", "//pair:123?"),
            "$good#fragment"
        ).forEach(::rejects)
    }
    @Test fun rejectsDuplicateUnknownMissingOrUnsupportedFields() {
        val good = payload()
        listOf(
            "$good&v=1", "$good&%76=1", "$good&other=x", "$good&", good.replace("v=1&", ""),
            good.replace("v=1", "v=2"), good.replace("v=1", "v"), good.replace("v=1", "v=%FF")
        ).forEach(::rejects)
    }
    @Test fun rejectsMalformedOrNonHexCode() {
        listOf("", "abc", code.uppercase(), "g".repeat(32)).forEach { rejects(payload().replace("code=$code", "code=$it")) }
    }
    @Test fun rejectsInsecureUrlOrCredentialsQueryFragmentAndPath() {
        listOf("http://laptop.example.com", "https://user:pass@laptop.example.com", "https://laptop.example.com/api", "https://laptop.example.com?token=x", "https://laptop.example.com#frag", "not a url").forEach { rejects(payload(it)) }
    }
    @Test fun errorsNeverEchoQrSecrets() {
        val input = payload("https://user:$code@laptop.example.com")
        val error = assertThrows(IllegalArgumentException::class.java) { PairingQr.parse(input, now) }
        assertFalse(error.message.orEmpty().contains(code))
        assertNull(error.cause)
    }
    @Test fun rejectsOversizedAndMalformedPayloads() {
        rejects(" ")
        rejects(payload() + "a".repeat(2048))
        rejects(payload().replace("v=1", "v=%GG"))
    }
}
