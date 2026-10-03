package dev.herdr.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StartupRecoveryTest {
    @Test fun formatterIncludesSafeMetadataAndCausesWithoutMessages() {
        val root = IllegalStateException("Bearer super-secret-token")
        root.stackTrace = arrayOf(StackTraceElement("example.Root", "start", "Root.kt", 7))
        val cause = RuntimeException("password=do-not-report")
        cause.stackTrace = arrayOf(StackTraceElement("example.Cause", "run", "Cause.kt", 9))
        root.initCause(cause)

        val report = formatStartupCrash("dev.herdr.remote", "0.4.3", 18, 35, root)

        assertTrue(report.contains("Package: dev.herdr.remote"))
        assertTrue(report.contains("Version: 0.4.3 (18)"))
        assertTrue(report.contains("Android SDK: 35"))
        assertTrue(report.contains("java.lang.IllegalStateException"))
        assertTrue(report.contains("java.lang.RuntimeException"))
        assertTrue(report.contains("example.Root.start(Root.kt:7)"))
        assertFalse(report.contains("Bearer super-secret-token"))
        assertFalse(report.contains("password=do-not-report"))
    }

    @Test fun formatterBoundsLongCauseChainsAndStacks() {
        var error: Throwable = RuntimeException("secret")
        repeat(20) { error = RuntimeException("secret-$it", error).also { value ->
            value.stackTrace = Array(200) { index -> StackTraceElement("pkg.Type$index", "method", "File.kt", index) }
        } }

        val report = formatStartupCrash("pkg", "test", 1, 26, error)

        assertTrue(report.length < 16000)
        assertTrue(report.contains("Cause 4:"))
        assertFalse(report.contains("secret"))
        assertFalse(report.contains("Cause 5:"))
    }
}
