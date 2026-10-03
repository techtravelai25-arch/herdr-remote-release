package dev.herdr.remote

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test

class DirectoryPickerTest {
    @Test fun plainTerminalRequestKeepsKindAndFolderWithoutAgentSubstitution() {
        val body = agentCreationBody(null, "/home/user/shell work", "terminal", "shell")
        assertEquals("terminal", body["kind"]?.jsonPrimitive?.content)
        assertEquals("/home/user/shell work", body["directory"]?.jsonPrimitive?.content)
        assertEquals("shell", body["name"]?.jsonPrimitive?.content)
        assertFalse(body.containsKey("projectId"))
    }

    @Test fun directoryLaunchDoesNotSendAConflictingProject() {
        val body = agentCreationBody("legacy", "/home/user/Folder with spaces/项目", "codex", "new-agent")
        assertEquals("/home/user/Folder with spaces/项目", body["directory"]?.jsonPrimitive?.content)
        assertFalse(body.containsKey("projectId"))
        assertEquals("codex", body["kind"]?.jsonPrimitive?.content)
    }

    @Test fun legacyProjectSelectionStillWorksAndEmptySelectionIsRejected() {
        assertEquals("external", agentCreationBody("external", null, "claude", "agent")["projectId"]?.jsonPrimitive?.content)
        assertThrows(IllegalArgumentException::class.java) { agentCreationBody(null, null, "codex", "agent") }
    }

    @Test fun additionalPagesAppendOnlyWithinTheSameFolder() {
        val first = DirectoryListing("/home/user", "/home/user", directories = listOf(RemoteDirectory("a", "/home/user/a")), nextCursor = "1")
        val second = first.copy(directories = listOf(RemoteDirectory("b", "/home/user/b")), nextCursor = null)
        assertEquals(listOf("a", "b"), mergeDirectoryPage(first, second, "1").directories.map { it.name })
        assertEquals(listOf("b"), mergeDirectoryPage(first, second, null).directories.map { it.name })
        assertEquals(second.copy(current = "/home/user/other"), mergeDirectoryPage(first, second.copy(current = "/home/user/other"), "1"))
    }

    @Test fun encodedFolderQuerySurvivesGrantRefreshAndPagination() = runBlocking {
        val requested = mutableListOf<Pair<String?, String?>>()
        val path = "/home/user/项目 & drafts/#notes"
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            requested += chain.request().url.queryParameter("path") to chain.request().url.queryParameter("cursor")
            val unauthorized = requested.size == 1
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(if (unauthorized) 401 else 200).message("fixture")
                .body((if (unauthorized) "{}" else """{"home":"/home/user","current":"/home/user","directories":[],"recent":[],"nextCursor":null}""").toResponseBody()).build()
        }.build()
        val bridge = Bridge(Credentials("https://laptop.example", "old", "phone", "laptop"), refreshCredentials = { it.copy(token = "new") }, injectedClient = client)
        bridge.directories(path, "200")
        assertEquals(listOf(path to "200", path to "200"), requested)
    }
}
