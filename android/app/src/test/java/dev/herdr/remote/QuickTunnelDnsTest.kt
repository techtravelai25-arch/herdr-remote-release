package dev.herdr.remote

import java.net.InetAddress
import java.net.UnknownHostException
import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class QuickTunnelDnsTest {
    private val quickTunnelHost = "fresh-name.trycloudflare.com"
    private val serviceOrigins = listOf("https://portal.example.test", "https://updates.example.test")
    private val resolvedAddress = InetAddress.getByAddress(quickTunnelHost, byteArrayOf(10, 0, 0, 1))
    private val resolvedIpv6 = InetAddress.getByName("2001:db8::1")

    private fun dns(lookup: (String) -> List<InetAddress>): Dns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> = lookup(hostname)
    }

    @Test
    fun systemSuccessDoesNotInvokeFallback() {
        var fallbackLookups = 0
        val fallback = dns {
            fallbackLookups += 1
            emptyList()
        }

        val result = QuickTunnelDns(
            systemDns = dns { listOf(resolvedAddress) },
            fallbackDns = fallback
        ).lookup(quickTunnelHost)

        assertEquals(listOf(resolvedAddress), result)
        assertEquals(0, fallbackLookups)
    }

    @Test
    fun quickTunnelMixedSystemResultsPreferIpv4() {
        var fallbackLookups = 0
        val result = QuickTunnelDns(
            systemDns = dns { listOf(resolvedIpv6, resolvedAddress) },
            fallbackDns = dns {
                fallbackLookups += 1
                emptyList()
            }
        ).lookup(quickTunnelHost)

        assertEquals(listOf(resolvedAddress, resolvedIpv6), result)
        assertEquals(0, fallbackLookups)
    }

    @Test
    fun quickTunnelIpv6OnlySystemResultUsesFallbackIpv4First() {
        var fallbackHost: String? = null
        val result = QuickTunnelDns(
            systemDns = dns { listOf(resolvedIpv6) },
            fallbackDns = dns { hostname ->
                fallbackHost = hostname
                listOf(resolvedAddress)
            }
        ).lookup(quickTunnelHost)

        assertEquals(listOf(resolvedAddress, resolvedIpv6), result)
        assertEquals(quickTunnelHost, fallbackHost)
    }

    @Test
    fun nonQuickTunnelPreservesSystemResultOrder() {
        val hostname = "api.example.com"
        val result = QuickTunnelDns(
            systemDns = dns { listOf(resolvedIpv6, resolvedAddress) },
            fallbackDns = dns { error("fallback must not be consulted") }
        ).lookup(hostname)

        assertEquals(listOf(resolvedIpv6, resolvedAddress), result)
    }

    @Test
    fun permanentPortalAndLaptopHostsPreferIpv4WithoutAlternateDns() {
        listOf("portal.example.test", "updates.example.test", "portal.example.test", "PORTAL.EXAMPLE.TEST").forEach { hostname ->
            val result = QuickTunnelDns(
                systemDns = dns { listOf(resolvedIpv6, resolvedAddress) },
                fallbackDns = dns { error("Healthy system DNS should not need fallback") },
                serviceOrigins = serviceOrigins,
            ).lookup(hostname)
            assertEquals(listOf(resolvedAddress, resolvedIpv6), result)
        }
    }

    @Test
    fun permanentHostsKeepIpv6WhenItIsTheOnlySystemRoute() {
        val result = QuickTunnelDns(
            systemDns = dns { listOf(resolvedIpv6) },
            fallbackDns = dns { throw UnknownHostException("Fallback unavailable") },
            serviceOrigins = serviceOrigins,
        ).lookup("portal.example.test")
        assertEquals(listOf(resolvedIpv6), result)
    }

    @Test
    fun permanentHostsRecoverFromSystemDnsFailureAndIpv6OnlyAnswers() {
        listOf("portal.example.test", "updates.example.test", "portal.example.test", "UPDATES.EXAMPLE.TEST").forEach { host ->
            listOf(dns { throw UnknownHostException("Phone DNS failed") }, dns { listOf(resolvedIpv6) }, dns { emptyList() }).forEach { system ->
                var requested: String? = null
                val result = QuickTunnelDns(system, dns { requested = it; listOf(resolvedAddress) }, serviceOrigins).lookup(host)
                assertEquals(host, requested)
                assertEquals(resolvedAddress, result.first())
            }
        }
    }

    @Test
    fun permanentDnsFailureKeepsCredentialsAndHasUsefulRecovery() {
        val thrown = org.junit.Assert.assertThrows(UnknownHostException::class.java) {
            QuickTunnelDns(dns { throw UnknownHostException() }, dns { emptyList() }, serviceOrigins).lookup("portal.example.test")
        }
        assertTrue(thrown.message.orEmpty().contains("sign-in and pairing are saved"))
    }

    @Test
    fun quickTunnelSystemFailureUsesFallback() {
        var fallbackHost: String? = null
        val result = QuickTunnelDns(
            systemDns = dns { throw UnknownHostException("system DNS unavailable") },
            fallbackDns = dns { hostname ->
                fallbackHost = hostname
                listOf(resolvedAddress)
            }
        ).lookup(quickTunnelHost)

        assertEquals(listOf(resolvedAddress), result)
        assertEquals(quickTunnelHost, fallbackHost)
    }

    @Test
    fun fallbackFailurePreservesPairingAndSuggestsReconnect() {
        val systemFailure = UnknownHostException("system DNS unavailable")
        val fallbackFailure = UnknownHostException("DoH unavailable")
        val thrown = org.junit.Assert.assertThrows(UnknownHostException::class.java) {
            QuickTunnelDns(
                systemDns = dns { throw systemFailure },
                fallbackDns = dns { throw fallbackFailure }
            ).lookup(quickTunnelHost)
        }

        assertTrue(thrown.message.orEmpty().contains("Your pairing is saved"))
        assertTrue(thrown.message.orEmpty().contains("reconnect"))
        assertSame(fallbackFailure, thrown.cause)
    }

    @Test
    fun fallbackScopeIsLimitedToSingleLabelQuickTunnelHosts() {
        val outOfScopeHosts = listOf(
            "trycloudflare.com",
            "nested.fresh-name.trycloudflare.com",
            "fresh-name.trycloudflare.com.evil.example",
            "api.example.com",
            "portal.example.test.evil.example",
            "other.example.test"
        )
        outOfScopeHosts.forEach { hostname ->
            val systemFailure = UnknownHostException(hostname)
            var fallbackLookups = 0
            val thrown = org.junit.Assert.assertThrows(UnknownHostException::class.java) {
                QuickTunnelDns(
                    systemDns = dns { throw systemFailure },
                    fallbackDns = dns {
                        fallbackLookups += 1
                        listOf(resolvedAddress)
                    }
                ).lookup(hostname)
            }

            assertSame(systemFailure, thrown)
            assertEquals("fallback must stay disabled for $hostname", 0, fallbackLookups)
        }
    }

    @Test
    fun nonUnknownHostSystemFailureDoesNotInvokeFallback() {
        val systemFailure = IllegalStateException("resolver failed unexpectedly")
        var fallbackLookups = 0
        val thrown = org.junit.Assert.assertThrows(IllegalStateException::class.java) {
            QuickTunnelDns(
                systemDns = dns { throw systemFailure },
                fallbackDns = dns {
                    fallbackLookups += 1
                    listOf(resolvedAddress)
                }
            ).lookup(quickTunnelHost)
        }

        assertSame(systemFailure, thrown)
        assertEquals(0, fallbackLookups)
    }
}
