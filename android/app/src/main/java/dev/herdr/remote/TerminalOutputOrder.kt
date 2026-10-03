package dev.herdr.remote

/** Herdr revisions order snapshots only within the same pane attachment. */
internal fun acceptTerminalOutput(currentAttachmentId: String?, currentRevision: Long,
                                  incomingAttachmentId: String?, incomingRevision: Long): Boolean =
    currentAttachmentId != incomingAttachmentId || incomingRevision >= currentRevision
