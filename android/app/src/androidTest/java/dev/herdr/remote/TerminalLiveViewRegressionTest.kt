package dev.herdr.remote

import android.net.Uri
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Callback-level regressions for [TerminalLiveView] driven by plain [RemoteState]/[Pane] fakes.
 * No vendor screen parser is involved: assertions only cover our own display and callback logic.
 */
class TerminalLiveViewRegressionTest {
    @get:Rule val compose = createComposeRule()

    private val footerOutput = "Review complete.\n\n› Ask Codex to do anything\n\n  model · Context 90% left"

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
        question: BridgeQuestion? = null,
        questionReviewAvailable: Boolean = false,
        questionPending: Boolean = false,
        questionSelectionEnabled: Boolean = true,
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
            agentModelSelectionEnabled = true,
            modelSelectionAgents = listOf("codex", "claude"),
            questionSelectionEnabled = questionSelectionEnabled,
            stale = stale,
        ),
        terminalAttachmentId = attachmentId,
        output = output,
        outputReady = outputReady,
        question = question,
        questionReviewAvailable = questionReviewAvailable,
        questionPending = questionPending,
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
        onChangeModel: () -> Unit = {},
        onReviewQuestion: () -> Unit = {},
        onAnswerQuestion: (Int?, String?) -> Unit = { _, _ -> },
        onCancelQuestion: () -> Unit = {},
    ) {
        HerdrTheme {
            TerminalLiveView(
                state, pane, onDraft, onInsert, onPrompt, onKey, {}, onAttach, onRemoveAttachment,
                onManageAttachments, onBrowseFiles, onCheckDelivery, onChangeModel,
                onReviewQuestion = onReviewQuestion, onAnswerQuestion = onAnswerQuestion,
                onCancelQuestion = onCancelQuestion,
            )
        }
    }

    private fun codexPane(id: String = "pane-1", status: String = "idle") =
        Pane(id, "workspace", kind = "codex", status = status)

    private fun choicesQuestion() = BridgeQuestion("a".repeat(64),
        "Which deployment should receive the fix? Review the details before choosing.",
        listOf("Only the staging laptop", "The production laptop after verification", "Other"),
        selectedIndex = 0, freeText = true, stage = "choices")

    private val savedHistory = StructuredHistory(available = true, source = "claude",
        messages = listOf(HistoryMessage("reply", "assistant", "The recommendation is in the plan file.")))
    private val planMenu = "Would you like to proceed?\n❯ 1. Yes, manually approve edits\n  2. No, keep planning"

    @Test
    fun claudeApprovalShowsLiveMenuDespiteSavedHistoryAndRestoresConversation() {
        var pane by mutableStateOf(Pane("claude-plan", "workspace", kind = "claude", status = "working"))
        val keys = mutableListOf<String>()
        compose.setContent { TestTerminal(fakeState(pane, output = planMenu).copy(structuredHistory = savedHistory),
            pane, onKey = { keys += it }) }
        compose.onNodeWithText("Conversation · Claude Code").assertExists()
        compose.onNodeWithText(planMenu).assertDoesNotExist()
        compose.runOnIdle { pane = pane.copy(status = "blocked") }
        compose.onNodeWithText("Live terminal question").assertExists()
        compose.onNodeWithText(planMenu).assertIsDisplayed()
        compose.onNodeWithText("Next").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("down"), keys) }
        compose.onNodeWithContentDescription("Conversation options").performScrollTo().performClick()
        compose.onNodeWithText("Show conversation").performClick()
        compose.onNodeWithText("Conversation · Claude Code").assertExists()
        compose.onNodeWithText("Show live question").performScrollTo().performClick()
        compose.onNodeWithText(planMenu).performScrollTo().assertIsDisplayed()
        compose.runOnIdle { pane = pane.copy(status = "working") }
        compose.onNodeWithText("Conversation · Claude Code").assertExists()
        compose.onNodeWithText("Show live question").assertDoesNotExist()
        compose.runOnIdle { pane = pane.copy(status = "needs-input") }
        compose.onNodeWithText(planMenu).performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Conversation options").performScrollTo().performClick()
        compose.onNodeWithText("Show conversation").performClick()
        compose.runOnIdle { pane = pane.copy(id = "another-claude-pane") }
        compose.onNodeWithText("Live terminal question").assertExists()
    }

    @Test
    fun terminalQuestionBypassesHistoryLoadingAndPausedOldOutput() {
        var pane by mutableStateOf(Pane("claude-plan", "workspace", kind = "claude", status = "working"))
        var output by mutableStateOf("Old terminal output")
        var loading by mutableStateOf(false)
        compose.setContent { TestTerminal(fakeState(pane, output = output).copy(historyLoading = loading), pane) }
        compose.onNodeWithContentDescription("Conversation options").performClick()
        compose.onNodeWithText("Pause auto-scroll").performClick()
        compose.runOnIdle {
            pane = pane.copy(status = "needs_input")
            output = planMenu
            loading = true
        }
        compose.onNodeWithText(planMenu).assertIsDisplayed()
        compose.onNodeWithText("Old terminal output").assertDoesNotExist()
        compose.onNodeWithText("Loading conversation…").assertDoesNotExist()
    }

    @Test
    fun queuedQuestionAndOpeningStateShowLiveTextUntilNativeChoicesArrive() {
        val pane = codexPane(status = "blocked")
        val liveQuestion = "Which deployment should receive the fix?\n  1. Staging only\n  2. Production after verification\n  enter submit   ^] skip   shift+→ main prompt"
        var pending by mutableStateOf(false)
        var question by mutableStateOf<BridgeQuestion?>(null)
        var reviews = 0
        compose.setContent { TestTerminal(fakeState(pane, output = liveQuestion, question = question,
            questionReviewAvailable = !pending && question == null, questionPending = pending)
            .copy(structuredHistory = savedHistory), pane, onReviewQuestion = { reviews++; pending = true }) }
        compose.onNodeWithText("Live terminal question").assertExists()
        compose.onNodeWithText(liveQuestion).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review question").performScrollTo().performClick()
        compose.onNodeWithText("Opening question…").assertIsNotEnabled()
        compose.onNodeWithText(liveQuestion).performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Send prompt").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(1, reviews)
            pending = false
            question = choicesQuestion()
        }
        compose.onNodeWithText("Conversation · Codex").assertExists()
        compose.onNodeWithText(liveQuestion).assertDoesNotExist()
        compose.onNodeWithText("Only the staging laptop").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Opening question…").assertDoesNotExist()
    }

    @Test
    fun claudeQuestionShowsReadableChoicesAndAnswersWithoutTerminalKeys() {
        val pane = Pane("claude-question", "workspace", kind = "claude", status = "blocked")
        val question = BridgeQuestion("f".repeat(64), "How should uploaded documents be read?",
            listOf("Read documents locally\nKeep page images on this machine.",
                "Add online OCR now\nPage images leave the machine.", "Leave uploads unread"), selectedIndex = 0)
        val answers = mutableListOf<Pair<Int?, String?>>()
        val keys = mutableListOf<String>()
        compose.setContent { TestTerminal(fakeState(pane, question = question)
            .copy(structuredHistory = savedHistory), pane,
            onKey = { keys += it }, onAnswerQuestion = { index, text -> answers += index to text }) }
        compose.onNodeWithText("Conversation · Claude Code").assertExists()
        compose.onNodeWithText(question.prompt).assertExists()
        compose.onNodeWithText("Answer in the terminal").assertDoesNotExist()
        compose.onNodeWithText("Next").assertDoesNotExist()
        compose.onNodeWithContentDescription("Send prompt").assertIsNotEnabled()
        compose.onNodeWithText(question.options[1]).performScrollTo().assertIsEnabled().performClick()
        compose.onNodeWithText(question.options[1]).assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(listOf(1 to null), answers)
            assertTrue(keys.isEmpty())
        }
    }

    @Test
    fun claudeCustomAnswerUsesQuestionEditorAndFreshControlAccess() {
        val pane = Pane("claude-text", "workspace", kind = "claude", status = "blocked")
        val question = BridgeQuestion("f".repeat(64), "How should uploaded documents be read?",
            emptyList(), freeText = true, stage = "text")
        var state by mutableStateOf(fakeState(pane, question = question, online = false))
        val answers = mutableListOf<Pair<Int?, String?>>()
        compose.setContent { TestTerminal(state, pane,
            onAnswerQuestion = { index, text -> answers += index to text }) }
        compose.onNodeWithText("Your answer").assertIsNotEnabled()
        compose.runOnIdle { state = state.copy(online = true) }
        compose.onNodeWithText("Your answer").performScrollTo().performTextInput("Read files locally")
        compose.onNodeWithText("Send answer").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(null to "Read files locally"), answers) }
    }

    @Test
    fun claudeQuestionKeepsNativeTerminalRecoveryReachable() {
        val pane = Pane("claude-recovery", "workspace", kind = "claude", status = "blocked")
        val keys = mutableListOf<String>()
        var state by mutableStateOf(fakeState(pane, output = planMenu, question = choicesQuestion())
            .copy(structuredHistory = savedHistory))
        compose.setContent { TestTerminal(state, pane, onKey = { keys += it }) }
        compose.onNodeWithText("Use terminal controls").performScrollTo().performClick()
        compose.onNodeWithText("Live terminal question").assertExists()
        compose.onNodeWithText(planMenu).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Esc").performScrollTo().assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf("esc"), keys) }
        compose.onNodeWithText("Use answer buttons").performScrollTo().performClick()
        compose.onNodeWithText("Only the staging laptop").assertExists()
        compose.onNodeWithText("Next").assertDoesNotExist()
        compose.runOnIdle { state = state.copy(question = null, questionPending = true) }
        compose.onNodeWithText("Use terminal controls").performScrollTo().performClick()
        compose.onNodeWithText("Esc").performScrollTo().assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(listOf("esc", "esc"), keys)
            state = state.copy(busy = true)
        }
        compose.onNodeWithText("Esc").assertIsNotEnabled()
    }

    @Test
    fun claudeMultipleSelectionsAndReviewRequireSeparateActions() {
        val pane = Pane("claude-multi", "workspace", kind = "claude", status = "blocked")
        var question by mutableStateOf(BridgeQuestion("a".repeat(64), "Which readers should be enabled?",
            listOf("PDF", "Scanned images", "Type something", "Submit"), selectedIndex = 0,
            stage = "multi", multiSelect = true, selectedOptions = listOf(0), cancelAvailable = true))
        val answers = mutableListOf<Pair<Int?, String?>>()
        var cancelled = 0
        compose.setContent { TestTerminal(fakeState(pane, question = question), pane,
            onAnswerQuestion = { index, text -> answers += index to text }, onCancelQuestion = { cancelled++ }) }
        compose.onNodeWithText("✓ PDF").assertExists()
        compose.onNodeWithText("Scanned images").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals(listOf(1 to null), answers)
            question = question.copy(id = "b".repeat(64), selectedIndex = 1, selectedOptions = listOf(0, 1))
        }
        compose.onNodeWithText("✓ Scanned images").assertExists()
        compose.onNodeWithText("Submit").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals(listOf(1 to null, 3 to null), answers)
            question = BridgeQuestion("c".repeat(64), "Review your answers\nReaders: PDF, Scanned images",
                listOf("Submit answers"), selectedIndex = 0, stage = "review", cancelAvailable = true)
        }
        compose.onNodeWithText("Review and submit answers").assertExists()
        compose.onNodeWithText("Submit answers").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(1 to null, 3 to null, 0 to null), answers); assertEquals(0, cancelled) }
    }

    @Test
    fun claudeCancelUsesQuestionActionInsteadOfGenericEscape() {
        val pane = Pane("claude-cancel", "workspace", kind = "claude", status = "blocked")
        var cancelled = 0
        val keys = mutableListOf<String>()
        compose.setContent { TestTerminal(fakeState(pane, question = choicesQuestion().copy(cancelAvailable = true)), pane,
            onKey = { keys += it }, onCancelQuestion = { cancelled++ }) }
        compose.onNodeWithText("Cancel question").performScrollTo().performClick()
        compose.onNodeWithText("Cancel question").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(1, cancelled); assertTrue(keys.isEmpty()) }
    }

    @Test
    fun nativeQuestionKeepsSavedConversationVisible() {
        val pane = codexPane(status = "blocked")
        var question by mutableStateOf<BridgeQuestion?>(null)
        compose.setContent { TestTerminal(fakeState(pane, output = planMenu, question = question)
            .copy(structuredHistory = savedHistory), pane) }
        compose.onNodeWithText("Live terminal question").assertExists()
        compose.runOnIdle { question = choicesQuestion() }
        compose.onNodeWithText("Conversation · Codex").assertExists()
        compose.onNodeWithText(planMenu).assertDoesNotExist()
        compose.onNodeWithText("Only the staging laptop").assertExists()
        compose.onNodeWithText("Answer in the terminal").assertDoesNotExist()
        compose.runOnIdle { question = null }
        compose.onNodeWithText("Live terminal question").assertExists()
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
    fun liveQuestionShowsActualChoicesAndSubmitsChosenIndexOnlyOnce() {
        val pane = codexPane(status = "blocked")
        val answers = mutableListOf<Pair<Int?, String?>>()
        val keys = mutableListOf<String>()
        compose.setContent { TestTerminal(fakeState(pane, question = choicesQuestion()), pane,
            onKey = { keys += it }, onAnswerQuestion = { index, text -> answers += index to text }) }
        compose.onNodeWithText("Which deployment should receive the fix? Review the details before choosing.").assertExists()
        compose.onNodeWithText("Next").assertDoesNotExist()
        compose.onNodeWithText("Insert text").assertIsNotEnabled()
        compose.onNodeWithText("Model").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Send prompt").assertIsNotEnabled()
        compose.onNodeWithText("The production laptop after verification").assertIsEnabled().performClick()
        compose.onNodeWithText("The production laptop after verification").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(listOf(1 to null), answers)
            assertTrue(keys.isEmpty())
        }
    }

    @Test
    fun nativeTextStageKeepsWrittenAnswerSeparateFromTerminalComposer() {
        val pane = codexPane(status = "blocked")
        val question = BridgeQuestion("b".repeat(64), "Describe the alternate deployment plan.",
            emptyList(), freeText = true, stage = "text")
        val answers = mutableListOf<Pair<Int?, String?>>()
        compose.setContent { TestTerminal(fakeState(pane, question = question), pane,
            onAnswerQuestion = { index, text -> answers += index to text }) }
        compose.onNodeWithText("Describe the alternate deployment plan.").assertExists()
        compose.onNodeWithText("Your answer").performTextInput("Wait for the staging check")
        compose.onNodeWithText("Send answer").performClick()
        compose.onNodeWithText("Send answer").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(listOf(null to "Wait for the staging check"), answers) }
    }

    @Test
    fun revealingQuestionWithoutOptionsShowsTheWholeQuestionAndTypedAnswer() {
        val pane = codexPane(status = "blocked")
        val prompt = "Which setup address should a first-time phone user open on their PC? " +
            "Use the existing server or type a different address for the next release."
        val question = BridgeQuestion("e".repeat(64), prompt, emptyList(), freeText = true, stage = "text")
        var state by mutableStateOf(fakeState(pane, questionReviewAvailable = true))
        val answers = mutableListOf<Pair<Int?, String?>>()
        compose.setContent { TestTerminal(state, pane,
            onReviewQuestion = { state = state.copy(questionReviewAvailable = false, questionPending = true) },
            onAnswerQuestion = { index, text -> answers += index to text }) }
        compose.onNodeWithText("Review question").performClick()
        compose.onNodeWithText("Opening question…").assertIsNotEnabled()
        compose.runOnIdle { state = state.copy(questionPending = false, question = question) }
        compose.onNodeWithText(prompt).assertExists()
        compose.onNodeWithText("Review question").assertDoesNotExist()
        compose.onNodeWithText("Other").assertDoesNotExist()
        compose.onNodeWithText("Send answer").assertIsNotEnabled()
        compose.onNodeWithText("Your answer").performScrollTo().performTextInput("Use the existing server")
        compose.onNodeWithText("Send answer").performScrollTo().performClick()
        compose.onNodeWithText("Send answer").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(listOf(null to "Use the existing server"), answers) }
    }

    @Test
    fun longQuestionKeepsLastActualChoiceReachableByScrolling() {
        val pane = codexPane(status = "blocked")
        val options = (1..18).map { "Deployment path $it with a detailed explanation that wraps on a narrow phone" }
        val question = BridgeQuestion("c".repeat(64),
            "Before proceeding, review the deployment order and the rollback constraints. ".repeat(8),
            options, selectedIndex = 0)
        val answers = mutableListOf<Int?>()
        compose.setContent { TestTerminal(fakeState(pane, question = question), pane,
            onAnswerQuestion = { index, _ -> answers += index }) }
        compose.onNodeWithText(options.last()).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(17), answers) }
    }

    @Test
    fun freshCollapsedHintRevealsQuestionWithoutSendingGenericKeys() {
        val pane = codexPane(status = "blocked")
        var state by mutableStateOf(fakeState(pane, questionReviewAvailable = true))
        var reviews = 0
        var keys = 0
        compose.setContent { TestTerminal(state, pane, onKey = { keys++ }, onReviewQuestion = { reviews++ }) }
        compose.onNodeWithText("Question waiting in terminal").assertExists()
        compose.onNodeWithText("Next").assertDoesNotExist()
        compose.onNodeWithText("Review question").performClick()
        compose.runOnIdle { state = state.copy(questionReviewAvailable = false, questionPending = true) }
        compose.onNodeWithText("Opening question…").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(1, reviews); assertEquals(0, keys) }
    }

    @Test
    fun liveQuestionChoicesStayVisibleButCannotSendWhenConnectionOrReceiptIsUnsafe() {
        val pane = codexPane(status = "blocked")
        var state by mutableStateOf(fakeState(pane, question = choicesQuestion(), online = false))
        var answers = 0
        compose.setContent { TestTerminal(state, pane, onAnswerQuestion = { _, _ -> answers++ }) }
        val choice = "Only the staging laptop"
        compose.onNodeWithText(choice).assertIsNotEnabled()
        compose.runOnIdle { state = state.copy(online = true, snapshot = state.snapshot.copy(stale = true)) }
        compose.onNodeWithText(choice).assertIsNotEnabled()
        compose.runOnIdle { state = state.copy(snapshot = state.snapshot.copy(stale = false, canControl = false)) }
        compose.onNodeWithText(choice).assertIsNotEnabled()
        compose.runOnIdle { state = state.copy(snapshot = state.snapshot.copy(canControl = true), busy = true) }
        compose.onNodeWithText(choice).assertIsNotEnabled()
        compose.runOnIdle { state = state.copy(busy = false, deliveries = mapOf(pane.id to
            DeliveryState("receipt", "uncertain", "Check delivery"))) }
        compose.onNodeWithText(choice).assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, answers) }
    }

    @Test
    fun legacyBridgeKeepsTerminalNavigationInsteadOfShowingUnverifiedChoices() {
        val pane = codexPane(status = "blocked")
        var answers = 0
        var keys = 0
        compose.setContent { TestTerminal(fakeState(pane, question = choicesQuestion(),
            questionSelectionEnabled = false), pane,
            onKey = { keys++ }, onAnswerQuestion = { _, _ -> answers++ }) }
        compose.onNodeWithText("Answer in the terminal").assertExists()
        compose.onNodeWithText("Only the staging laptop").assertDoesNotExist()
        compose.onNodeWithText("Next").performClick()
        compose.runOnIdle { assertEquals(1, keys); assertEquals(0, answers) }
    }

    @Test
    fun blockedQuestionNavigationSendsExactlyOneChosenKey() {
        val pane = codexPane(status = "blocked")
        val keys = mutableListOf<String>()
        compose.setContent { TestTerminal(fakeState(pane), pane, onKey = { keys += it }) }
        compose.onNodeWithText("Answer in the terminal").assertExists()
        compose.onNodeWithText("Next").performClick()
        compose.runOnIdle { assertEquals(listOf("down"), keys) }
        compose.onNodeWithText("Confirm").performClick()
        compose.runOnIdle { assertEquals(listOf("down", "enter"), keys) }
        compose.onNodeWithText("Esc").performClick()
        compose.runOnIdle { assertEquals(listOf("down", "enter", "esc"), keys) }
    }

    @Test
    fun offlineDisablesTerminalInput() {
        val pane = codexPane(status = "blocked")
        var keys = 0
        compose.setContent { TestTerminal(fakeState(pane, online = false), pane, onKey = { keys++ }) }
        compose.onNodeWithText("Showing the last snapshot. Reconnect before sending input.").assertExists()
        compose.onNodeWithText("Next").assertIsNotEnabled()
        compose.onNodeWithText("Model").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, keys) }
    }

    @Test
    fun staleSnapshotDisablesTerminalInput() {
        val pane = codexPane(status = "blocked")
        compose.setContent { TestTerminal(fakeState(pane, stale = true), pane) }
        compose.onNodeWithText("Showing the last snapshot. Reconnect before sending input.").assertExists()
        compose.onNodeWithText("Next").assertIsNotEnabled()
        compose.onNodeWithText("Model").assertIsNotEnabled()
    }

    @Test
    fun missingAttachmentDisablesTerminalInput() {
        val pane = codexPane(status = "blocked")
        compose.setContent { TestTerminal(fakeState(pane, attachmentId = null), pane) }
        compose.onNodeWithText("Waiting for a fresh pane attachment before input.").assertExists()
        compose.onNodeWithText("Next").assertIsNotEnabled()
        compose.onNodeWithText("Model").assertIsNotEnabled()
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
    fun modelPickerDoesNotRevealIdleInputArea() {
        val pane = codexPane()
        var opens = 0
        compose.setContent { TestTerminal(fakeState(pane, output = footerOutput), pane,
            onChangeModel = { opens++ }) }
        compose.onNodeWithText("Ask Codex", substring = true).assertDoesNotExist()
        compose.onNodeWithText("input area hidden", substring = true).assertExists()
        compose.onNodeWithText("Model").performClick()
        compose.runOnIdle { assertEquals(1, opens) }
        compose.onNodeWithText("Ask Codex", substring = true).assertDoesNotExist()
        compose.onNodeWithText("input area hidden", substring = true).assertExists()
    }

    @Test
    fun switchingPaneKeepsOnlyCurrentPaneOutput() {
        val first = codexPane(id = "pane-a")
        val second = codexPane(id = "pane-b")
        var pane by mutableStateOf(first)
        compose.setContent { TestTerminal(fakeState(pane, output = footerOutput), pane) }
        compose.runOnIdle { pane = second }
        compose.onNodeWithText("Model").assertExists()
        compose.onNodeWithText("Ask Codex", substring = true).assertDoesNotExist()
    }

    @Test
    fun scrollingUpHoldsTheSnapshotUntilJumpToLatestThenFollowsAgain() {
        val pane = codexPane(status = "working")
        val original = (1..120).joinToString("\n") { "Original line $it" }
        val replacement = (121..240).joinToString("\n") { "New line $it" }
        var state by mutableStateOf(fakeState(pane, output = original))
        compose.setContent { TestTerminal(state, pane) }
        val scroller = compose.onAllNodes(hasScrollAction() and hasAnyDescendant(hasText(original))).onLast()
        scroller.performTouchInput { swipeDown() }
        compose.waitForIdle()
        val range = scroller.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
        val heldPosition = range.value()
        assertTrue("Gesture must move away from the latest output", heldPosition < range.maxValue())

        compose.runOnIdle { state = state.copy(output = replacement, outputRevision = 2, outputTruncated = true) }
        compose.onNodeWithText(original).assertExists()
        compose.onNodeWithText(replacement).assertDoesNotExist()
        assertEquals(heldPosition, scroller.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value(), 0.5f)
        compose.onNodeWithText("earlier content unavailable", substring = true).assertDoesNotExist()
        compose.onNodeWithText("New output ↓").performClick()
        compose.onNodeWithText(replacement).assertExists()
        compose.onNodeWithText("New output ↓").assertDoesNotExist()

        val newest = replacement + "\nAnother live line"
        compose.runOnIdle { state = state.copy(output = newest, outputRevision = 3) }
        compose.onNodeWithText(newest).assertExists()
        val liveRange = compose.onAllNodes(hasScrollAction() and hasAnyDescendant(hasText(newest)))
            .onLast().fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
        assertEquals(liveRange.maxValue(), liveRange.value(), 0.5f)
    }

    @Test
    fun menuPauseIgnoresUnchangedPollsAndMenuJumpShowsLatest() {
        val pane = codexPane(status = "working")
        var state by mutableStateOf(fakeState(pane, output = "Reading this reply"))
        compose.setContent { TestTerminal(state, pane) }
        compose.onNodeWithContentDescription("Conversation options").performClick()
        compose.onNodeWithText("Pause auto-scroll").performClick()
        compose.runOnIdle { state = state.copy(outputRevision = 10) }
        compose.onNodeWithText("New output ↓").assertDoesNotExist()
        compose.onNodeWithText("Jump to latest ↓").assertExists()
        compose.runOnIdle { state = state.copy(output = "Updated reply") }
        compose.onNodeWithText("Reading this reply").assertExists()
        compose.onNodeWithText("New output ↓").assertExists()
        compose.onNodeWithContentDescription("Conversation options").performClick()
        compose.onNodeWithText("Jump to latest").performClick()
        compose.onNodeWithText("Updated reply").assertExists()
        compose.onNodeWithText("New output ↓").assertDoesNotExist()
    }

    @Test
    fun heldOutputIsDiscardedWhenTerminalPaneOrLaptopChanges() {
        var state by mutableStateOf(fakeState(codexPane(), output = "Initial output"))
        compose.setContent { TestTerminal(state, state.snapshot.panes.firstOrNull { it.id == state.selectedId }) }
        // Each transition must abandon a held snapshot even if pane IDs or revisions overlap.
        listOf("attachment", "pane", "laptop", "reconnect").forEach { change ->
            compose.onNodeWithContentDescription("Conversation options").performClick()
            compose.onNodeWithText("Pause auto-scroll").performClick()
            compose.runOnIdle {
                state = when (change) {
                    "attachment" -> state.copy(terminalAttachmentId = "replacement-terminal")
                    "pane" -> state.copy(selectedId = "pane-b", snapshot = state.snapshot.copy(panes = listOf(codexPane(id = "pane-b"))))
                    "laptop" -> state.copy(portalDeviceId = "other-laptop")
                    else -> state.copy(online = false, terminalAttachmentId = null)
                }.copy(output = "Output after $change")
            }
            compose.onNodeWithText("Output after $change").assertExists()
            compose.onNodeWithText("New output ↓").assertDoesNotExist()
            compose.onNodeWithText("Jump to latest ↓").assertDoesNotExist()
        }
    }
}
