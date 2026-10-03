package dev.herdr.remote

import org.junit.Assert.*
import org.junit.Test

class ArtifactDownloadsTest {
    @Test fun dispositionNamesKeepUsefulFilenamesWithParameters() {
        assertEquals("report final.pdf", ArtifactDownloads.dispositionName("""attachment; filename="report final.pdf"; size=1234"""))
        assertEquals("report.pdf", ArtifactDownloads.dispositionName("attachment; filename=report.pdf"))
        assertEquals("café.txt", ArtifactDownloads.dispositionName("attachment; filename*=UTF-8''caf%C3%A9.txt"))
        assertEquals("報告.md", ArtifactDownloads.dispositionName("attachment; filename=\"報告.md\""))
        assertEquals("résumé draft+1.py", ArtifactDownloads.dispositionName("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20draft+1.py"))
        assertTrue(ArtifactDownloads.dispositionName("attachment; filename=\"${"a".repeat(140)}.pdf\"").endsWith(".pdf"))
    }

    @Test fun dispositionNamesRejectTraversalControlAndBlankFallbacks() {
        assertEquals("", ArtifactDownloads.dispositionName("attachment; filename=\"../etc/passwd\""))
        assertEquals("", ArtifactDownloads.dispositionName(null))
        assertEquals("", ArtifactDownloads.dispositionName("inline"))
        assertEquals("", ArtifactDownloads.dispositionName("attachment; filename=\".hidden\""))
        assertEquals("", ArtifactDownloads.dispositionName("attachment; filename=\"bad\tname.txt\""))
    }
}
