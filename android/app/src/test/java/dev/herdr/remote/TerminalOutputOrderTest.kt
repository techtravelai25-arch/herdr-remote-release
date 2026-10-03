package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class TerminalOutputOrderTest {
    @Test fun dropsOutOfOrderSnapshotsWithinOneAttachment() {
        assertTrue(acceptTerminalOutput("one", 10, "one", 10))
        assertFalse(acceptTerminalOutput("one", 10, "one", 9))
        assertTrue(acceptTerminalOutput("one", 10, "one", 11))
    }

    @Test fun replacementAttachmentCanStartAtAnEarlierRevision() {
        assertTrue(acceptTerminalOutput("one", 10, "two", 1))
        assertTrue(acceptTerminalOutput(null, -1, "new", 0))
    }
}
