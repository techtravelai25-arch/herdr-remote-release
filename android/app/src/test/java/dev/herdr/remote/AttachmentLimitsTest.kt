package dev.herdr.remote

import java.io.IOException
import java.io.InputStream
import org.junit.Assert.*
import org.junit.Test

class AttachmentLimitsTest {
    @Test fun selectionLimitsAcceptBoundaryAndUnknownSize() {
        validateAttachmentCount(5)
        validateAttachmentSize(MAX_ATTACHMENT_BYTES, "image.png")
        validateAttachmentSize(null, "cloud.pdf")
        assertThrows(IllegalArgumentException::class.java) { validateAttachmentCount(6) }
        assertThrows(IllegalArgumentException::class.java) { validateAttachmentSize(MAX_ATTACHMENT_BYTES + 1, "large.pdf") }
    }

    @Test fun streamAcceptsExactLimitInBoundedChunks() {
        var written = 0L
        copyAttachment(bytes(MAX_ATTACHMENT_BYTES)) { _, count ->
            assertTrue(count <= 8192)
            written += count
        }
        assertEquals(MAX_ATTACHMENT_BYTES, written)
    }

    @Test fun streamRejectsOversizedContentEvenWithoutMetadata() {
        var written = 0L
        assertThrows(IOException::class.java) {
            copyAttachment(bytes(MAX_ATTACHMENT_BYTES + 1)) { _, count -> written += count }
        }
        assertEquals(MAX_ATTACHMENT_BYTES, written)
    }

    @Test fun streamPreservesContentAndPropagatesReadFailures() {
        val result = java.io.ByteArrayOutputStream()
        val expected = "PDF or image data".toByteArray()
        copyAttachment(expected.inputStream()) { buffer, count -> result.write(buffer, 0, count) }
        assertArrayEquals(expected, result.toByteArray())
        assertThrows(IOException::class.java) {
            copyAttachment(object : InputStream() { override fun read(): Int = throw IOException("Unavailable") }) { _, _ -> }
        }
    }

    private fun bytes(length: Long) = object : InputStream() {
        private var remaining = length
        override fun read(): Int = if (remaining-- > 0) 0 else -1
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (remaining <= 0) return -1
            val count = minOf(remaining, length.toLong()).toInt()
            remaining -= count
            return count
        }
    }
}
