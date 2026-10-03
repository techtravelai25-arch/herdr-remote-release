package dev.herdr.remote

import java.net.Inet4Address
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.dnsoverhttps.DnsOverHttps

/** Recover DNS for known app origins and temporary tunnels without replaying HTTP requests. */
class QuickTunnelDns(
    private val systemDns: Dns = Dns.SYSTEM,
    private val fallbackDns: Dns = cloudflareDns(),
    private val serviceOrigins: List<String> = listOf(BuildConfig.PORTAL_ORIGIN, BuildConfig.UPDATE_ORIGIN),
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val quickTunnel = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.trycloudflare\\.com$", RegexOption.IGNORE_CASE).matches(hostname)
        val permanentHost = serviceOrigins
            .mapNotNull { it.toHttpUrlOrNull()?.host }
            .any { hostname.equals(it, ignoreCase = true) }
        val canRecover = quickTunnel || permanentHost
        var systemAddresses: List<InetAddress> = emptyList()
        var systemFailure: UnknownHostException? = null
        try {
            systemAddresses = systemDns.lookup(hostname)
            if (!canRecover) return systemAddresses
            // Some phone networks advertise IPv6 but cannot route it. Do not
            // let an unreachable AAAA result hide an available IPv4 route.
            if (systemAddresses.any { it is Inet4Address }) return preferIpv4(systemAddresses)
        } catch (original: UnknownHostException) {
            if (!canRecover) throw original
            systemFailure = original
        }
        try {
            val resolved = fallbackDns.lookup(hostname)
            if (resolved.isEmpty()) throw UnknownHostException("No DNS records")
            return preferIpv4((resolved + systemAddresses).distinct())
        } catch (failure: UnknownHostException) {
            // Preserve connectivity on genuinely IPv6-only networks if the
            // alternate resolver is unavailable, without replaying requests.
            if (systemAddresses.isNotEmpty()) return systemAddresses
            val message = if (permanentHost) "Cannot find the server address. Your sign-in and pairing are saved. Check your phone's Internet connection, then reconnect."
                else "Cannot find the laptop address. Your pairing is saved. Wake your laptop and check its Internet connection, then reconnect. A new QR is only needed if its temporary tunnel address changed."
            throw UnknownHostException(message).apply {
                initCause(failure)
                systemFailure?.let { addSuppressed(it) }
            }
        }
    }

    private fun preferIpv4(addresses: List<InetAddress>) = addresses.sortedBy { if (it is Inet4Address) 0 else 1 }

    companion object {
        // A separate client cannot inherit device credentials or recurse into
        // this resolver. Bootstrap IPs avoid relying on the failing phone DNS.
        fun cloudflareDns(): Dns = DnsOverHttps.Builder()
            .client(OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(8, TimeUnit.SECONDS)
                .callTimeout(8, TimeUnit.SECONDS)
                .followRedirects(false).followSslRedirects(false)
                .build())
            .url("https://cloudflare-dns.com/dns-query".toHttpUrl())
            .includeIPv6(false)
            .bootstrapDnsHosts(
                InetAddress.getByAddress(byteArrayOf(1, 1, 1, 1)),
                InetAddress.getByAddress(byteArrayOf(1, 0, 0, 1)),
            )
            .build()
    }
}
