package dev.herdr.remote

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.MultipartBody
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class GroqTranscriptionTest {
    private fun recording() = File.createTempFile("voice-test", ".m4a").apply { writeBytes(byteArrayOf(1, 2, 3)) }
    private fun client(block: (Interceptor.Chain) -> Response) = OkHttpClient.Builder()
        .addInterceptor(Interceptor(block)).build()
    private fun response(chain: Interceptor.Chain, code: Int, body: String) = Response.Builder()
        .request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("Test")
        .body(body.toResponseBody()).build()

    private fun assertSanitizedChain(error: Throwable) {
        generateSequence(error) { it.cause }.take(20).forEach {
            assertFalse(it.message.orEmpty().contains("test-secret"))
            assertFalse(it.message.orEmpty().contains("private audio"))
        }
    }

    @Test fun uploadsDirectlyWithLargeV3AndReturnsText() = runBlocking<Unit> {
        val file = recording()
        try {
            val transcriber = GroqTranscriber(client { chain ->
                val request = chain.request()
                assertEquals("https://api.groq.com/openai/v1/audio/transcriptions", request.url.toString())
                assertEquals("Bearer test-secret", request.header("Authorization"))
                assertEquals("POST", request.method)
                val encoded = Buffer().also { request.body!!.writeTo(it) }.readUtf8()
                val modelPart = (request.body as MultipartBody).parts.single {
                    it.headers?.get("Content-Disposition") == "form-data; name=\"model\""
                }
                assertEquals("whisper-large-v3", Buffer().also { modelPart.body.writeTo(it) }.readUtf8())
                assertTrue(encoded.contains("filename=\"recording.m4a\""))
                assertTrue(encoded.contains("Content-Type: audio/mp4"))
                response(chain, 200, "{\"text\":\"  Hello world  \"}")
            })
            assertEquals("Hello world", transcriber.transcribe(file, " test-secret "))
        } finally { file.delete() }
    }

    @Test fun serverAndNetworkErrorsNeverEchoSecrets() = runBlocking<Unit> {
        val file = recording()
        try {
            for (code in listOf(401, 403, 429, 500, 400)) {
                val transcriber = GroqTranscriber(client { response(it, code, "test-secret private audio") })
                val error = assertThrows(GroqTranscriptionException::class.java) {
                    runBlocking { transcriber.transcribe(file, "test-secret") }
                }
                assertFalse(error.message!!.contains("test-secret"))
                assertFalse(error.message!!.contains("private audio"))
                assertSanitizedChain(error)
                if (code == 429) assertTrue(error.message!!.contains("usage limit"))
            }
            val error = assertThrows(GroqTranscriptionException::class.java) {
                runBlocking { GroqTranscriber(client { throw IOException("test-secret") }).transcribe(file, "test-secret") }
            }
            assertTrue(error.message!!.contains("internet connection"))
            assertSanitizedChain(error)
        } finally { file.delete() }
    }

    @Test fun rejectsEmptyMalformedAndOversizedResponses() = runBlocking<Unit> {
        val file = recording()
        try {
            for (body in listOf("{}", "{\"text\":\" \"}", "{\"text\":4}", "{\"text\":null}", "not json", "x".repeat(1024 * 1024 + 1), "{\"text\":\"${"x".repeat(16001)}\"}")) {
                assertThrows(GroqTranscriptionException::class.java) {
                    runBlocking { GroqTranscriber(client { response(it, 200, body) }).transcribe(file, "test-secret") }
                }
            }
        } finally { file.delete() }
    }

    @Test fun rejectsInvalidRecordingOrKeyBeforeNetwork() = runBlocking<Unit> {
        val file = recording()
        val transcriber = GroqTranscriber(client { fail("Must not upload invalid input"); error("unreachable") })
        try {
            for (key in listOf("", "a\nb", "non-ascii-☃")) {
                assertThrows(GroqTranscriptionException::class.java) { runBlocking { transcriber.transcribe(file, key) } }
            }
            file.writeBytes(byteArrayOf())
            assertThrows(GroqTranscriptionException::class.java) { runBlocking { transcriber.transcribe(file, "test-secret") } }
            RandomAccessFile(file, "rw").use { it.setLength(GroqTranscriber.MAX_AUDIO_BYTES + 1) }
            assertThrows(GroqTranscriptionException::class.java) { runBlocking { transcriber.transcribe(file, "test-secret") } }
        } finally { file.delete() }
    }

    @Test fun redirectsNeverForwardApiKey() = runBlocking<Unit> {
        val file = recording()
        var requests = 0
        try {
            val transcriber = GroqTranscriber(client { chain ->
                requests++
                response(chain, 307, "").newBuilder()
                    .header("Location", "https://other.example/transcribe").build()
            })
            assertThrows(GroqTranscriptionException::class.java) {
                runBlocking { transcriber.transcribe(file, "test-secret") }
            }
            assertEquals(1, requests)
        } finally { file.delete() }
    }

    @Test fun cancellationCancelsHttpCall() = runBlocking<Unit> {
        val started = CountDownLatch(1)
        val canceled = CountDownLatch(1)
        val file = recording()
        try {
            val transcriber = GroqTranscriber(client { chain ->
                started.countDown()
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (!chain.call().isCanceled() && System.nanoTime() < deadline) Thread.sleep(5)
                if (chain.call().isCanceled()) canceled.countDown()
                throw IOException("cancelled")
            })
            val job = launch(kotlinx.coroutines.Dispatchers.Default) { transcriber.transcribe(file, "test-secret") }
            assertTrue(started.await(5, TimeUnit.SECONDS))
            job.cancelAndJoin()
            assertTrue(canceled.await(5, TimeUnit.SECONDS))
        } finally { file.delete() }
    }
}
