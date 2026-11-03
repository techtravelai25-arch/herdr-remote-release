package dev.herdr.remote

import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.junit.Assert.assertEquals
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Callback-level regressions for [TerminalLiveView] driven by plain [RemoteState]/[Pane] fakes,
 * plus the live terminal's control path against a fake laptop (an OkHttp interceptor).
 */
class TerminalLiveViewRegressionTest {
    @get:Rule val compose = createComposeRule()


    private fun fakeState(
        pane: Pane?,
        online: Boolean = true,
        stale: Boolean = false,
        canControl: Boolean = true,
        terminalInputEnabled: Boolean = true,
        attachmentsEnabled: Boolean = false,
        busy: Boolean = false,
        outputReady: Boolean = true,
        attachmentId: String? = "test-attachment",
        output: String = "",
        stream: Boolean = false,
    ) = RemoteState(
        online = online,
        busy = busy,
        selectedId = pane?.id,
        snapshot = Snapshot(
            herdrOnline = true,
            panes = listOfNotNull(pane),
            terminalInputEnabled = terminalInputEnabled,
            canControl = canControl,
            attachmentsEnabled = attachmentsEnabled,
            terminalStreamEnabled = stream,
            stale = stale,
        ),
        terminalAttachmentId = attachmentId,
        output = output,
        outputReady = outputReady,
    )

    @Composable
    private fun TestTerminal(
        state: RemoteState,
        pane: Pane?,
        onDraft: (String) -> Unit = {},
        onInsert: (String) -> Unit = {},
        onPrompt: (String) -> Unit = {},
        onKey: (String) -> Unit = {},
        onAttach: () -> Unit = {},
        onRemoveAttachment: (Uri) -> Unit = {},
        onManageAttachments: () -> Unit = {},
        onBrowseFiles: () -> Unit = {},
        onCheckDelivery: (String) -> Unit = {},
        liveBridge: () -> Bridge? = { null },
    ) {
        HerdrTheme {
            TerminalLiveView(
                state, pane, onDraft, onInsert, onPrompt, onKey, {}, onAttach, onRemoveAttachment,
                onManageAttachments, onBrowseFiles, onCheckDelivery, liveBridge = liveBridge,
            )
        }
    }

    private fun codexPane(id: String = "pane-1", status: String = "idle") =
        Pane(id, "workspace", kind = "codex", status = status)

    /** A fake laptop: answers the live stream with a paint, control with a session, and records typed input. */
    private class FakeLaptop {
        val inputs = java.util.Collections.synchronizedList(mutableListOf<String>())
        val bridge = Bridge(Credentials("https://laptop.invalid", "", "phone"), injectedClient = okhttp3.OkHttpClient.Builder()
            .addInterceptor { chain ->
                val request = chain.request()
                val path = request.url.encodedPath
                val body = when {
                    path.endsWith("/stream") -> if (request.url.queryParameter("epoch") == null)
                        """{"epoch":"e1","seq":0,"nextSeq":11,"reset":true,"cols":80,"rows":24,"data":"${java.util.Base64.getEncoder().encodeToString("hello world".toByteArray())}"}"""
                        else { Thread.sleep(300); """{"epoch":"e1","seq":11,"nextSeq":11,"reset":false,"cols":80,"rows":24,"data":""}""" }
                    path.endsWith("/control") -> """{"controlId":"c1","nextSeq":1}"""
                    path.endsWith("/stream-input") -> {
                        val buffer = okio.Buffer(); request.body?.writeTo(buffer); inputs.add(buffer.readUtf8()); """{"ok":true}"""
                    }
                    else -> "{}"
                }
                okhttp3.Response.Builder().request(request).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("OK")
                    .body(body.toByteArray().toResponseBody("application/json".toMediaType())).build()
            }.build())
    }


    @Test
    fun multilineDraftKeepsReaderVisibleAndComposerReachableInLandscape() {
        val pane = Pane("landscape-terminal", "workspace", kind = "terminal", status = "idle")
        val output = "Terminal output remains readable"
        val draft = "first line\nsecond line\nthird line\nfourth line"
        var state by mutableStateOf(fakeState(pane, output = output).copy(drafts = mapOf(pane.id to "short draft")))
        compose.setContent {
            // Fit the portrait test host while constraining height to the audited landscape size.
            // The narrower width also exercises more wrapping than the 530 dp landscape viewport.
            Box(Modifier.requiredSize(width = 360.dp, height = 290.dp)) {
                TestTerminal(state, pane, onDraft = { value ->
                    state = state.copy(drafts = mapOf(pane.id to value))
                })
            }
        }

        val minReaderPixels = 128f * InstrumentationRegistry.getInstrumentation()
            .targetContext.resources.displayMetrics.density
        fun assertReaderVisible() {
            val reader = compose.onAllNodes(hasScrollAction() and hasAnyDescendant(hasText(output)))
                .onLast().fetchSemanticsNode()
            assertTrue("Output reader should reserve at least 128 dp", reader.size.height + 1 >= minReaderPixels)
            assertTrue("Output reader should be visible before scrolling to controls", reader.boundsInRoot.height > 0f)
        }

        assertReaderVisible()
        compose.runOnIdle { state = state.copy(drafts = mapOf(pane.id to draft)) }
        assertReaderVisible()
        compose.onNodeWithText(draft).performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Insert terminal text").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun offlineDisablesTerminalInput() {
        val pane = codexPane(status = "blocked")
        var keys = 0
        compose.setContent { TestTerminal(fakeState(pane, online = false), pane, onKey = { keys++ }) }
        compose.onNodeWithText("Showing the last snapshot. Reconnect before sending input.").assertExists()
        compose.onNodeWithContentDescription("Show terminal keys").performScrollTo().performClick()
        compose.onNodeWithText("Enter").performScrollTo().assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, keys) }
    }

    @Test
    fun staleSnapshotDisablesTerminalInput() {
        val pane = codexPane(status = "blocked")
        compose.setContent { TestTerminal(fakeState(pane, stale = true), pane) }
        compose.onNodeWithText("Showing the last snapshot. Reconnect before sending input.").assertExists()
        compose.onNodeWithContentDescription("Show terminal keys").performScrollTo().performClick()
        compose.onNodeWithText("Enter").performScrollTo().assertIsNotEnabled()
    }

    @Test
    fun missingAttachmentDisablesTerminalInput() {
        val pane = codexPane(status = "blocked")
        compose.setContent { TestTerminal(fakeState(pane, attachmentId = null), pane) }
        compose.onNodeWithText("Waiting for a fresh pane attachment before input.").assertExists()
        compose.onNodeWithContentDescription("Show terminal keys").performScrollTo().performClick()
        compose.onNodeWithText("Enter").performScrollTo().assertIsNotEnabled()
    }

    @Test
    fun attachFilesCallbackFiresWhenAllowed() {
        val pane = codexPane()
        var attaches = 0
        compose.setContent {
            TestTerminal(fakeState(pane, attachmentsEnabled = true), pane, onAttach = { attaches++ })
        }
        compose.onNodeWithContentDescription("Attachment options", substring = true).performClick()
        compose.onNodeWithText("Attach files").performClick()
        compose.runOnIdle { assertEquals(1, attaches) }
    }

    @Test
    fun attachFilesDisabledWhenBusyDoesNotFire() {
        val pane = codexPane()
        var attaches = 0
        compose.setContent {
            TestTerminal(fakeState(pane, attachmentsEnabled = true, busy = true), pane, onAttach = { attaches++ })
        }
        compose.onNodeWithContentDescription("Attachment options", substring = true).performClick()
        compose.onNodeWithText("Attach files").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, attaches) }
    }

    @Test
    fun terminalPaneHasNoAttachmentControl() {
        val pane = Pane("pane-t", "workspace", kind = "terminal", status = "idle")
        compose.setContent { TestTerminal(fakeState(pane, attachmentsEnabled = true), pane) }
        compose.onNodeWithContentDescription("Attachment options", substring = true).assertDoesNotExist()
    }

    @Test
    fun blockedPaneSaysWhatTheAgentNeedsInItsOwnWords() {
        val pane = codexPane(status = "blocked").copy(blockedKind = "permission", activity = "Allow rm -rf build?")
        compose.setContent { TestTerminal(fakeState(pane), pane) }
        compose.onAllNodes(hasText("Needs your approval")).onLast().assertIsDisplayed()
        compose.onAllNodes(hasText("Allow rm -rf build?")).onLast().assertIsDisplayed()
    }

    @Test
    fun liveTerminalTakesControlAndTypesTheKeyBytesOnce() {
        val laptop = FakeLaptop()
        val pane = codexPane()
        compose.setContent { TestTerminal(fakeState(pane, stream = true), pane, liveBridge = { laptop.bridge }) }
        compose.onNodeWithText("Live terminal").assertIsDisplayed()
        compose.onNodeWithText("Take control").performScrollTo().performClick()
        compose.waitUntil(5000) { compose.onAllNodes(hasText("Stop control")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Enter").performScrollTo().performClick()
        compose.waitUntil(5000) { laptop.inputs.isNotEmpty() }
        compose.waitForIdle(); Thread.sleep(500)
        assertEquals(1, laptop.inputs.size)
        assertTrue(laptop.inputs.single().contains("\"seq\":1"))
        assertTrue(laptop.inputs.single().contains("\"data\":\"\\r\""))
    }

    /** Runs [script] in the live terminal's WebView and returns its JSON result. */
    private fun liveTerminalJs(script: String): String {
        val result = java.util.concurrent.atomic.AtomicReference("null")
        val done = java.util.concurrent.CountDownLatch(1)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            fun find(view: View): WebView? = view as? WebView
                ?: (view as? ViewGroup)?.let { group -> (0 until group.childCount).firstNotNullOfOrNull { find(group.getChildAt(it)) } }
            val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).first()
            val view = find(activity.window.decorView)
            if (view == null) done.countDown() else view.evaluateJavascript(script) { result.set(it); done.countDown() }
        }
        done.await(5, java.util.concurrent.TimeUnit.SECONDS)
        return result.get()
    }

    @Test
    fun liveTerminalShowsThePaintedTextOnScreen() {
        val laptop = FakeLaptop()
        val pane = codexPane()
        compose.setContent { TestTerminal(fakeState(pane, stream = true), pane, liveBridge = { laptop.bridge }) }
        compose.onNodeWithText("Live terminal").assertIsDisplayed()
        // The painted row must be inside a page that fills the view; a WRAP_CONTENT WebView gives the page no height.
        val probe = "(function(){var t=document.getElementById('terminal'),r=document.querySelector('.xterm-rows');" +
            "return (t?t.clientHeight:-1)+'|'+(!!r&&r.innerText.indexOf('hello world')>=0)})()"
        var last = ""
        val shown = { last.trim('"').split('|').let { it.size == 2 && (it[0].toIntOrNull() ?: 0) > 100 && it[1] == "true" } }
        runCatching { compose.waitUntil(10_000) { last = liveTerminalJs(probe); shown() } }
        assertTrue("terminal height in CSS px | painted text found: $last", shown())
    }

    @Test
    fun liveTerminalControlNeedsControlAccess() {
        val pane = codexPane()
        compose.setContent { TestTerminal(fakeState(pane, stream = true, canControl = false), pane, liveBridge = { FakeLaptop().bridge }) }
        compose.onNodeWithText("Take control").performScrollTo().assertIsNotEnabled()
    }
}
