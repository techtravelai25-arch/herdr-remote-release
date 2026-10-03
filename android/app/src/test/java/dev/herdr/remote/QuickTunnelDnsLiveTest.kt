package dev.herdr.remote

import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in integration check; no pairing secrets or Android device required. */
class QuickTunnelDnsLiveTest {
    @Test fun resolvesAndVerifiesRealTunnelWhenSystemDnsFails() {
        val origin = System.getenv("HERDR_DNS_SMOKE_URL")
        assumeTrue("Set HERDR_DNS_SMOKE_URL to run against a live app origin", origin != null)
        requireValidSmokeOrigin(origin!!)
        val failedSystem = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> = throw UnknownHostException("Forced system DNS failure")
        }
        val client = OkHttpClient.Builder().dns(QuickTunnelDns(systemDns = failedSystem, serviceOrigins = listOf(origin)))
            .callTimeout(20, TimeUnit.SECONDS).followRedirects(false).build()
        try {
            client.newCall(Request.Builder().url("$origin/v1/health").build()).execute().use {
                assertEquals("Real HTTPS certificate verification and unauthenticated health", 401, it.code)
            }
        } finally {
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
        }
    }
    @Test fun reachesRealTunnelWhenSystemDnsReturnsOnlyUnreachableIpv6() {
        val origin = System.getenv("HERDR_DNS_SMOKE_URL")
        assumeTrue("Set HERDR_DNS_SMOKE_URL for this live test", origin != null)
        requireValidSmokeOrigin(origin!!)
        val ipv6Only = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> = listOf(InetAddress.getByName("2001:db8::1"))
        }
        val client = OkHttpClient.Builder().dns(QuickTunnelDns(systemDns = ipv6Only, serviceOrigins = listOf(origin)))
            .retryOnConnectionFailure(false).callTimeout(20, TimeUnit.SECONDS).followRedirects(false).build()
        try {
            client.newCall(Request.Builder().url("$origin/v1/health").build()).execute().use {
                assertEquals("IPv4 must work despite an unreachable system AAAA answer", 401, it.code)
            }
        } finally {
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
        }
    }

    @Test fun publicPortalManifestWorksWithNativeHttpClientAndFallbackDns() {
        val origin = System.getenv("HERDR_UPDATE_SMOKE_URL")
        assumeTrue("Set HERDR_UPDATE_SMOKE_URL for live update tests", origin != null)
        requireValidSmokeOrigin(origin!!)
        val failedSystem = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> = throw UnknownHostException("Forced phone DNS failure")
        }
        val client = OkHttpClient.Builder().dns(QuickTunnelDns(systemDns = failedSystem, serviceOrigins = listOf(origin)))
            .retryOnConnectionFailure(false).callTimeout(20, TimeUnit.SECONDS).followRedirects(false).build()
        try {
            client.newCall(Request.Builder().url("$origin/v1/app-update").build()).execute().use {
                assertEquals("The portal must support the native client without a browser challenge", 200, it.code)
                org.junit.Assert.assertTrue(it.body!!.string().contains("versionCode"))
            }
        } finally {
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
        }
    }

    private fun requireValidSmokeOrigin(raw: String) {
        val url = raw.toHttpUrlOrNull()
        require(url != null && url.isHttps && url.username.isEmpty() && url.password.isEmpty() &&
            url.encodedPath == "/" && url.query == null && url.fragment == null) {
            "Smoke URL must be an HTTPS origin without credentials, query, or fragment."
        }
    }

}
