package dev.herdr.remote

import java.io.IOException
import java.io.InputStream

const val MAX_ATTACHMENT_BYTES = 20L * 1024 * 1024
const val MAX_ATTACHMENTS = 5

internal fun validateAttachmentCount(count: Int) {
    require(count in 0..MAX_ATTACHMENTS) { "Choose up to 5 attachments per message." }
}

internal fun validateAttachmentSize(size: Long?, name: String) {
    require(size == null || size in 0..MAX_ATTACHMENT_BYTES) { "$name exceeds 20 MB." }
}

/** Enforce the limit on actual bytes, including when document metadata is absent or wrong. */
internal fun copyAttachment(input: InputStream, write: (ByteArray, Int) -> Unit) {
    val buffer = ByteArray(8192)
    var total = 0L
    while (true) {
        val count = input.read(buffer)
        if (count == -1) break
        total += count
        if (total > MAX_ATTACHMENT_BYTES) throw IOException("Attachment exceeds 20 MB.")
        write(buffer, count)
    }
}
