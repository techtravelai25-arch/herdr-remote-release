package dev.herdr.remote

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.app.ActivityOptionsCompat
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.android.resources.ScreenOrientation
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import kotlinx.serialization.json.*
import org.junit.Rule
import org.junit.Test
import java.lang.reflect.Proxy

/** Reproducible native layout fixtures; no account, network or emulator is involved. */
class FeaturePreviewTest {
    @Test fun firstRunGuideNarrowLargeTextLight() = firstRunGuideNarrow(ThemeMode.LIGHT)
    @Test fun firstRunGuideNarrowLargeTextDark() = firstRunGuideNarrow(ThemeMode.DARK)
    private fun firstRunGuideNarrow(mode: ThemeMode) {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 900,
            xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        val context = fixtureContext()
        paparazzi.snapshot(name = "first-run-qr-320dp-200percent-${mode.name.lowercase()}") {
            CompositionLocalProvider(LocalContext provides context, LocalDensity provides Density(1f, 2f)) {
                HerdrTheme(themeMode = mode, preference = ThemePreference(context)) { FirstRunGuide(onDone = {}, initialPage = 1) }
            }
        }
    }

    @Test fun groqVoiceGuideNarrowLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 1000,
            xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        render("groq-voice-guide-320dp-200percent", ThemeMode.LIGHT, "Voice input", scale = 2f) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) { VoiceInputSettings() }
        }
    }

    @Test fun groqVoiceSavedNarrow() = groqVoiceSavedNarrow(scale = 1f)
    @Test fun groqVoiceSavedNarrowLargeText() = groqVoiceSavedNarrow(scale = 2f)

    private fun groqVoiceSavedNarrow(scale: Float) {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 1000,
            xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        val textSizeLabel = if (scale == 1f) "normal" else "200percent"
        render("groq-voice-saved-320dp-$textSizeLabel", ThemeMode.LIGHT, "Voice input", scale = scale) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) { SavedGroqVoiceSettingsPreview() }
        }
    }

    @Composable private fun SavedGroqVoiceSettingsPreview() {
        GroqVoiceSettingsContent(
            keyAvailable = true,
            keyUnreadable = false,
            changingKey = false,
            keyValue = "",
            message = null,
            onKeyValueChange = {},
            onSave = {},
            onChangeKey = {},
            onCancelChange = {},
            onRemove = {},
            provider = VoiceProvider.GROQ,
        )
    }

    @Test fun savedLaptopsNarrowLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 1900, xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        render("saved-laptops-320dp-200percent", ThemeMode.LIGHT, "Laptop & account", scale = 2f) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                SavedLaptopsList(listOf(
                    SavedLaptopChoice("phone-a", "laptop-a", "Work laptop", true, false),
                    SavedLaptopChoice("phone-b", "laptop-b", "Personal Linux workstation", false, false),
                ), true, {}, { _, _ -> }, {})
            }
        }
    }

    @Test fun homeFolderPickerWithRecentDirectories() {
        render("home-folder-picker", ThemeMode.LIGHT, "New agent") {
            DirectoryPickerDialog(
                state = RemoteState(directories = DirectoryListing(
                    home = "/home/developer", current = "/home/developer/projects", parent = "/home/developer",
                    recent = listOf(RemoteDirectory("remote-app", "/home/developer/projects/herdr-remote")),
                    directories = listOf(RemoteDirectory("Client work", "/home/developer/projects/Client work"), RemoteDirectory("personal", "/home/developer/projects/personal")),
                )),
                browse = { _, _ -> }, choose = {}, dismiss = {},
            )
        }
    }

    @Test fun recentFolderPickerShowsFullPaths() {
        render("recent-folder-picker", ThemeMode.LIGHT, "New agent") {
            DirectoryPickerDialog(
                state = RemoteState(directories = DirectoryListing(
                    home = "/home/developer", current = "/home/developer",
                    recent = listOf(RemoteDirectory("remote-app", "/home/developer/projects/herdr-remote"), RemoteDirectory("Client work", "/home/developer/projects/Client work")),
                )),
                browse = { _, _ -> }, choose = {}, dismiss = {}, initialRecent = true,
            )
        }
    }

    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, theme = "android:Theme.Material.NoActionBar")
    // Register the real voice permission launcher without launching Android activities.
    // A launch is a fixture error: these snapshots never request microphone access.
    private fun fixtureActivityResults() = object : ActivityResultRegistryOwner {
        override val activityResultRegistry = object : ActivityResultRegistry() {
            override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>,
                input: I, options: ActivityOptionsCompat?) {
                error("Preview fixture must not launch activities or request permissions")
            }
        }
    }
    private fun fixtureContext(): Context {
        val values = mutableMapOf<String, Any?>()
        lateinit var editor: SharedPreferences.Editor
        editor = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { _, method, args ->
            when {
                method.name.startsWith("put") -> { values[args[0] as String] = args[1]; editor }
                method.name == "commit" -> true
                method.name == "apply" -> null
                else -> editor
            }
        } as SharedPreferences.Editor
        val preferences = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
            when (method.name) {
                "edit" -> editor
                "getAll" -> values
                "contains" -> values.containsKey(args[0])
                "getBoolean", "getFloat", "getString", "getLong", "getInt" -> values[args[0]] ?: args[1]
                else -> null
            }
        } as SharedPreferences
        return object : ContextWrapper(paparazzi.context) {
            override fun getApplicationContext(): Context = this
            override fun getSharedPreferences(name: String?, mode: Int) = preferences
        }
    }
    private val panes = listOf(
        Pane("checkout", "shop", title = "Review checkout validation", cwd = "/home/developer/projects/storefront", kind = "codex", status = "blocked", lastActivity = "2026-09-20T11:48:00Z"),
        Pane("receipt", "shop-review", title = "Add order receipt emails", cwd = "/home/developer/projects/storefront", kind = "claude", status = "working", lastActivity = "2026-09-20T11:46:00Z"),
        Pane("docs", "tools", title = "Update installation guide", cwd = "/home/developer/projects/remote-app", kind = "opencode", status = "done", lastActivity = "2026-09-20T11:42:00Z"),
        Pane("shell", "tools", title = "Development server", cwd = "/home/developer/projects/remote-app", kind = "terminal", status = "idle", lastActivity = "2026-09-20T11:40:00Z"),
    )
    private fun fixtureState() = RemoteState(
        paired = true, online = true, live = true, accountEmail = "developer@example.com",
        snapshot = Snapshot(herdrOnline = true, hostname = "Developer's laptop", attachmentsEnabled = true,
            workspaces = listOf(Workspace("shop", "Storefront"), Workspace("shop-review", "Review"), Workspace("tools", "Developer tools")), panes = panes),
        attentionIds = setOf("checkout"), unreadIds = setOf("checkout", "docs"),
        notificationsEnabled = true,
    )
    private fun conversationState() = fixtureState().copy(selectedId = "checkout",
        output = "› Review the checkout changes.\n\n## Review complete\nThe **validation** now handles missing addresses.\n\n```kotlin\nrequire(address.isNotBlank())\n```\n\n[Open the documentation](https://developer.android.com)\n\nChoose whether to add the regression test.",
        outputTruncated = true, drafts = mapOf("checkout" to "Add the regression test, then run it."),
        deliveries = mapOf("checkout" to DeliveryState("op", "unknown", "Delivery uncertain. Check before resending.")),
    )

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable private fun Chrome(title: String, tabs: Boolean = false, createEnabled: Boolean = true, reviewEnabled: Boolean = true, content: @Composable () -> Unit) {
        Scaffold(
            topBar = { AppTopBar(if (title == "Sessions") "Herdr" else if (title == "Review checkout") "Review checkout validation" else title, subtitle = if (title == "Development server") "remote-app" else if (tabs || title == "Review checkout") "storefront" else null, canBack = title != "Sessions", actions = {
                if (title == "Sessions") IconButton(onClick = {}) { Icon(Icons.Default.Settings, "Settings") }
                else if (tabs || title == "Review checkout") IconButton(onClick = {}) { Icon(Icons.Default.MoreVert, "Agent actions") }
            }) },
            bottomBar = { if (title == "Sessions") NewAgentBar(enabled = createEnabled, onCreate = {}) }
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                if (tabs) TabRow(selectedTabIndex = 0, containerColor = MaterialTheme.colorScheme.background) {
                    Tab(selected = true, onClick = {}, text = { Text("Conversation") })
                    Tab(selected = false, enabled = reviewEnabled, onClick = {}, text = { Text("Review results") })
                }
                Box(Modifier.weight(1f)) { content() }
            }
        }
    }

    private fun render(name: String, mode: ThemeMode, title: String, scale: Float = 1f, tabs: Boolean = false, createEnabled: Boolean = true, reviewEnabled: Boolean = true,
        content: @Composable () -> Unit) {
        val context = fixtureContext()
        val preference = ThemePreference(context).also { it.updateMode(mode) }
        org.junit.Assert.assertEquals(mode, ThemePreference(context).mode)
        val activityResults = fixtureActivityResults()
        paparazzi.snapshot(name = "mission-status-$name") {
            CompositionLocalProvider(LocalContext provides context,
                LocalActivityResultRegistryOwner provides activityResults,
                LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, scale)) {
                HerdrTheme(themeMode = mode, preference = preference) { Chrome(title, tabs, createEnabled, reviewEnabled, content) }
            }
        }
    }
    private fun conversation(mode: ThemeMode, scale: Float = 1f, bottom: Boolean = false, suffix: String = "") {
        val state = conversationState()
        render("conversation-${mode.name.lowercase()}$suffix", mode, "Review checkout", scale, tabs = true) {
            AgentDetailContent(state, panes.first(), {}, { _, _ -> },
                outerScroll = rememberScrollState(if (bottom) Int.MAX_VALUE else 0))
        }
    }
    private fun sessions(mode: ThemeMode, suffix: String = "") {
        render("sessions-${mode.name.lowercase()}$suffix", mode, "Sessions") {
            SessionsScreen(fixtureState(), onSelect = {}, onRefresh = {}, onReconnect = {}, onStartHerdr = {}, onCheckCreate = {})
        }
    }
    private fun dashboardStatusFixture(mode: ThemeMode, scale: Float = 1f, stale: Boolean = false) {
        val states = listOf("working", "needs_input", "blocked", "done", "idle", "error")
        val state = fixtureState().copy(attentionIds = emptySet(), unreadIds = emptySet(),
            snapshot = fixtureState().snapshot.copy(stale = stale, panes = states.mapIndexed { index, status ->
                Pane("status-$index", "tools", title = listOf("Build the dashboard", "Choose a deployment target", "Resolve missing credentials", "Update the installation guide", "Development server", "Retry failed checks")[index],
                    cwd = "/home/developer/projects/remote-app", kind = if (index == 4) "terminal" else "codex", status = status)
            }))
        render("dashboard-status-${mode.name.lowercase()}-$scale-$stale", mode, "Sessions", scale) {
            CompositionLocalProvider(androidx.compose.ui.platform.LocalInspectionMode provides true) {
                SessionsScreen(state, onSelect = {}, onRefresh = {}, onReconnect = {}, onStartHerdr = {}, onCheckCreate = {})
            }
        }
    }
    @Test fun dashboardStatusLight() = dashboardStatusFixture(ThemeMode.LIGHT)
    @Test fun dashboardStatusDark() = dashboardStatusFixture(ThemeMode.DARK)
    @Test fun dashboardStatusStale() = dashboardStatusFixture(ThemeMode.LIGHT, stale = true)
    @Test fun dashboardStatusNarrowLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 1900, xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        dashboardStatusFixture(ThemeMode.LIGHT, scale = 2f)
    }
    private fun sessionsOfflineWithLastUpdated() {
        val state = fixtureState().copy(
            online = false,
            live = false,
            snapshot = fixtureState().snapshot.copy(lastUpdatedAt = "2026-09-20T11:48:00Z", stale = false),
        )
        render("sessions-offline-last-updated", ThemeMode.LIGHT, "Sessions", createEnabled = false) {
            SessionsScreen(state, onSelect = {}, onRefresh = {}, onReconnect = {}, onStartHerdr = {}, onCheckCreate = {})
        }
    }
    private fun settings(mode: ThemeMode) {
        render("settings-${mode.name.lowercase()}", mode, "Settings") {
            SettingsScreen(fixtureState(), mode, onThemeChange = {}, onConnection = {}, onNotifications = {}, onDiagnostics = {}, onUpdates = {})
        }
    }

    @Test fun sessionsLight() = sessions(ThemeMode.LIGHT)
    @Test fun sessionsDark() = sessions(ThemeMode.DARK)
    private fun dashboardAfterCreation(mode: ThemeMode, status: String = "delivered") {
        val state = fixtureState().copy(
            attentionIds = emptySet(), unreadIds = emptySet(),
            snapshot = fixtureState().snapshot.copy(
                panes = panes.map { it.copy(status = "idle") },
                lastUpdatedAt = "2026-09-20T11:48:00Z",
            ),
            deliveries = mapOf("__create__" to DeliveryState("create-preview", status,
                if (status == "delivered") "Agent started." else "Check whether your agent started before trying again.",
                operation = "agent.create")),
        )
        render("dashboard-creation-$status-${mode.name.lowercase()}", mode, "Sessions") {
            SessionsScreen(state, {}, {}, {}, {}, {})
        }
    }
    @Test fun dashboardCreationDeliveredLight() = dashboardAfterCreation(ThemeMode.LIGHT)
    @Test fun dashboardCreationDeliveredDark() = dashboardAfterCreation(ThemeMode.DARK)
    @Test fun dashboardCreationUncertain() = dashboardAfterCreation(ThemeMode.LIGHT, "uncertain")
    @Test fun sessionsLastRow() {
        render("sessions-light-last-row", ThemeMode.LIGHT, "Sessions") {
            SessionsScreen(fixtureState(), {}, {}, {}, {}, {},
                listState = androidx.compose.foundation.lazy.rememberLazyListState(initialFirstVisibleItemIndex = 100))
        }
    }
    @Test fun sessionsLargeText() {
        render("sessions-light-large-text", ThemeMode.LIGHT, "Sessions", scale = 2f) {
            SessionsScreen(fixtureState(), {}, {}, {}, {}, {})
        }
    }
    @Test fun sessionsOfflineLastUpdated() = sessionsOfflineWithLastUpdated()
    @Test fun missionDashboardEmpty() {
        val state = fixtureState().copy(snapshot = fixtureState().snapshot.copy(panes = emptyList()),
            attentionIds = emptySet(), unreadIds = emptySet())
        render("dashboard-empty", ThemeMode.LIGHT, "Sessions") {
            SessionsScreen(state, {}, {}, {}, {}, {})
        }
    }
    @Test fun missionDashboardStale() {
        val state = fixtureState().copy(live = false,
            snapshot = fixtureState().snapshot.copy(stale = true, lastUpdatedAt = "2026-09-20T11:48:00Z"))
        render("dashboard-stale", ThemeMode.DARK, "Sessions", createEnabled = false) {
            SessionsScreen(state, {}, {}, {}, {}, {})
        }
    }
    @Test fun missionDashboardSignInRequired() {
        val state = fixtureState().copy(online = false, live = false, signInRequired = true,
            connectionError = "Sign in again to reconnect to Developer's laptop.")
        render("dashboard-sign-in-required", ThemeMode.LIGHT, "Sessions", createEnabled = false) {
            SessionsScreen(state, {}, {}, {}, {}, {})
        }
    }
    private fun compactDevice(height: Int = 640) {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(
            screenWidth = 320, screenHeight = height, xdpi = 160, ydpi = 160,
            density = com.android.resources.Density.MEDIUM))
    }
    @Test fun missionDashboardNarrow() {
        compactDevice()
        sessions(ThemeMode.LIGHT, suffix = "-320dp")
    }
    @Test fun missionComposerConstrainedHeight() {
        // Models the reduced viewport above a keyboard, not an actual IME.
        compactDevice(height = 420)
        conversation(ThemeMode.DARK, bottom = true, suffix = "-320dp-short-composer")
    }
    @Test fun compactConversationNarrow() {
        compactDevice()
        val state = conversationState().copy(outputTruncated = false, deliveries = emptyMap(),
            drafts = emptyMap(), output = """
                › Review checkout validation and summarize the changes.

                The address check now rejects blank input before submitting the order.

                - Added a required-address message.
                - Kept the entered delivery details after a failed submission.
                - Covered missing and whitespace-only addresses.

                › Did the regression tests pass?

                All 12 checkout tests passed. The order receipt flow is unchanged.

                ```text
                CheckoutValidationTest  8 passed
                OrderSubmissionTest     4 passed
                ```

                Ready for a final review of the checkout diff.
            """.trimIndent())
        render("compact-conversation-light-320dp", ThemeMode.LIGHT, "Review checkout", tabs = true) {
            AgentDetailContent(state, panes.first(), {}, { _, _ -> })
        }
    }
    @Test fun terminalFirstAgentNarrow() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 820,
            xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        val pane = panes.first()
        val state = fixtureState().copy(selectedId = pane.id,
            snapshot = fixtureState().snapshot.copy(terminalInputEnabled = true),
            terminalAttachmentId = "preview-attachment",
            output = """Review complete. Checkout validation is ready.

                Which step should I take next?
                  1. Run focused tests
                › 2. Explain the diff
                  3. Stop here

                Use arrow keys and Enter to choose.
            """.trimIndent(),
            drafts = mapOf(pane.id to "Run the focused tests"))
        render("terminal-first-agent-narrow", ThemeMode.LIGHT, "Review checkout", tabs = true) {
            TerminalLiveView(state, pane, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})
        }
    }

    @Test fun terminalConversationHidesIdleFooter() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320, screenHeight = 820,
            xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        val pane = panes.first().copy(status = "done")
        val state = fixtureState().copy(selectedId = pane.id,
            snapshot = fixtureState().snapshot.copy(panes = listOf(pane), terminalInputEnabled = true),
            terminalAttachmentId = "preview-attachment",
            output = "The checkout regression tests passed.\n\nThe validation is ready for review.\n\n" +
                "› Ask Codex to do anything\n\n  model · Context 90% left",
            drafts = emptyMap())
        render("terminal-conversation-idle-footer-hidden", ThemeMode.LIGHT, "Review checkout", tabs = true) {
            TerminalLiveView(state, pane, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})
        }
    }

    @Test fun compactTerminalPopulated() {
        val pane = panes.last()
        val state = fixtureState().copy(selectedId = pane.id, output = """
            ${'$'} npm run dev
            > storefront@1.8.0 dev
            > vite --host

              VITE v7.1.0 ready in 284 ms
              Local: http://localhost:3000/

            11:40:02 GET /                 200  14ms
            11:40:02 GET /assets/app.js    200   4ms
            11:40:03 GET /api/products     200  26ms
            11:40:05 GET /api/cart         200  12ms
            11:41:08 hmr update /src/Checkout.tsx
            11:41:09 GET /checkout         200   8ms
            11:41:11 POST /api/validate    422  19ms
            11:41:13 POST /api/validate    200  17ms
            11:41:14 POST /api/orders      201  42ms
            11:41:14 GET /orders/1042      200  11ms
            11:42:06 hmr update /src/Receipt.tsx
            11:42:07 GET /orders/1042      200   9ms

            No compilation errors. Watching for changes.
        """.trimIndent())
        for (mode in listOf(ThemeMode.LIGHT, ThemeMode.DARK)) {
            render("compact-terminal-${mode.name.lowercase()}", mode, "Development server", tabs = true) {
                AgentDetailContent(state, pane, {}, { _, _ -> })
            }
        }
    }
    @Test fun missionOfflineQuestion() {
        val state = conversationState().copy(online = false, live = false,
            question = BridgeQuestion("q-offline", "Proceed with the deployment?", listOf("Run the tests first", "Keep reviewing"), 0))
        render("offline-question", ThemeMode.DARK, "Review checkout", tabs = true, reviewEnabled = false) {
            AgentDetailContent(state, panes.first(), {}, { _, _ -> })
        }
    }
    @Test fun missionQueuedQuestionRecovery() {
        val state = conversationState().copy(question = null, deliveries = emptyMap(), outputTruncated = false,
            output = "Review paused.\n\n• Queued follow-up inputs ? 1 question alt + ↑ to answer")
        render("queued-question-recovery", ThemeMode.LIGHT, "Review checkout", tabs = true) {
            AgentDetailContent(state, panes.first(), {}, { _, _ -> })
        }
    }
    @Test fun missionTerminalReadOnly() {
        val pane = panes.last()
        val state = fixtureState().copy(selectedId = pane.id, output = "$ npm run dev\nServer ready on localhost:3000", drafts = mapOf(pane.id to "npm test"))
        render("terminal-read-only", ThemeMode.DARK, "Development server", tabs = true) {
            AgentDetailContent(state, pane, {}, { _, _ -> }, outerScroll = rememberScrollState(Int.MAX_VALUE))
        }
    }
    @Test fun renameSession() {
        render("rename-session-light", ThemeMode.LIGHT, "Review checkout") {
            RenameSessionDialog("Review checkout validation", true, {}, {})
        }
    }
    @Test fun conversationLight() = conversation(ThemeMode.LIGHT)
    @Test fun conversationDark() = conversation(ThemeMode.DARK)
    @Test fun openCodeConversationLight() = openCodeConversation(ThemeMode.LIGHT)
    @Test fun openCodeConversationDark() = openCodeConversation(ThemeMode.DARK)
    @Test fun openCodeConversationNarrow() {
        compactDevice()
        openCodeConversation(ThemeMode.LIGHT, "-320dp")
    }
    private fun openCodeConversation(mode: ThemeMode, suffix: String = "") {
        val pane = panes[2].copy(title = "Repo improvement suggestions", status = "working")
        val output = requireNotNull(javaClass.classLoader!!.getResource("opencode-phone-preview.txt")).readText()
        val state = fixtureState().copy(selectedId = pane.id, output = output)
        render("opencode-${mode.name.lowercase()}$suffix", mode, pane.title, tabs = true) {
            AgentDetailContent(state, pane, {}, { _, _ -> })
        }
    }
    @Test fun settingsLight() = settings(ThemeMode.LIGHT)
    @Test fun settingsDark() = settings(ThemeMode.DARK)
    @Test fun notificationSettingsLight() = notificationSettings(ThemeMode.LIGHT)
    @Test fun notificationSettingsDark() = notificationSettings(ThemeMode.DARK)
    @Test fun notificationSettingsNarrow() {
        compactDevice()
        notificationSettings(ThemeMode.LIGHT)
    }
    private fun notificationSettings(mode: ThemeMode) {
        render("notification-settings-${mode.name.lowercase()}", mode, "Settings") {
            NotificationSettingsDialog(fixtureState().copy(cloudPushEnabled = true, cloudPushStatus = "Cloud push is enabled."),
                denied = false, onCloudChange = {}, onMonitoring = {}, onDismiss = {})
        }
    }
    @Test fun largeTextComposerReachable() = conversation(ThemeMode.LIGHT, scale = 2f, bottom = true, suffix = "-200percent-composer")
    @Test fun questionLight() {
        val state = conversationState().copy(question = BridgeQuestion("q-preview", "Which connection recovery should we test?", listOf("Reconnect", "Refresh session", "Check status", "Other"), 0))
        render("question-light", ThemeMode.LIGHT, "Review checkout", tabs = true) {
            AgentDetailContent(state, panes.first(), {}, { _, _ -> })
        }
    }
    @Test fun questionDark() {
        val state = conversationState().copy(question = BridgeQuestion("q-preview", "Which connection recovery should we test?", listOf("Reconnect", "Refresh session", "Check status", "Other"), 0))
        render("question-dark", ThemeMode.DARK, "Review checkout", tabs = true) {
            AgentDetailContent(state, panes.first(), {}, { _, _ -> })
        }
    }
    @Test fun questionLargeText() {
        val state = conversationState().copy(question = BridgeQuestion("q-preview", "Which connection recovery should we test?", listOf("Reconnect", "Refresh session", "Check status", "Other"), 0))
        render("question-light-200percent", ThemeMode.LIGHT, "Review checkout", scale = 2f, tabs = true) {
            AgentDetailContent(state, panes.first(), {}, { _, _ -> })
        }
    }
    @Test fun questionOtherAnswerLight() {
        val state = conversationState().copy(question = BridgeQuestion("q-other-preview", "Which connection recovery should we test?", listOf("Reconnect", "Refresh session", "Check status", "Other"), 3))
        render("question-other-light", ThemeMode.LIGHT, "Review checkout", tabs = true) {
            AgentDetailContent(state, panes.first(), {}, { _, _ -> })
        }
    }
    @Test fun questionFreeTextLight() {
        val state = conversationState().copy(question = BridgeQuestion("q-text-preview", "What should we test next?", emptyList(), freeText = true))
        render("question-free-text-light", ThemeMode.LIGHT, "Review checkout", tabs = true) {
            AgentDetailContent(state, panes.first(), {}, { _, _ -> })
        }
    }
    @Test fun terminalQuestionRecoveryLight() {
        val state = conversationState().copy(
            question = null,
            output = """
                • Queued follow-up inputs ? 1 question alt + ↑ to answer
                Which deletion is failing on the phone? I’ll check the saved-data path.
                › 1. Clear saved history in Settings
                2. Delete an uploaded file
                3. Remove a saved session or connection
                4. Other

                enter submit  ctrl + ] skip  alt + ↓ main prompt
            """.trimIndent(),
        )
        render("terminal-question-recovery-light", ThemeMode.LIGHT, "Review checkout", tabs = true) {
            AgentDetailContent(state, panes.first(), {}, { _, _ -> })
        }
    }
    @Test fun searchSelectedCodeOccurrence() {
        val text = "Context before the code.\n\n```kotlin\nval first = \"needle\"\n" +
            (1..18).joinToString("\n") { "val row$it = $it" } +
            "\nval final = \"needle\"\n```\n\nContext after the code."
        val selected = transcriptSearchMatches(listOf(TerminalBlock(text, false)), "needle").last()
        val context = fixtureContext()
        val preference = ThemePreference(context).also { it.updateMode(ThemeMode.LIGHT) }
        var revealed = false
        val view = androidx.compose.ui.platform.ComposeView(paparazzi.context).apply {
            layoutParams = android.view.ViewGroup.LayoutParams(-1, -1)
            setContent {
                CompositionLocalProvider(LocalContext provides context) {
                    HerdrTheme(themeMode = ThemeMode.LIGHT, preference = preference) {
                        Chrome("Search recent output") {
                            Column(Modifier.fillMaxSize().padding(16.dp)) {
                                Text("2 of 2 matches · needle")
                                Box(Modifier.height(260.dp).fillMaxWidth().verticalScroll(rememberScrollState())) {
                                    RichTranscript(text, 15f, true, "needle", selected, revealRequest = 1,
                                        onRevealed = { revealed = true })
                                }
                            }
                        }
                    }
                }
            }
        }
        // Advance actual Compose animation frames instead of inspecting only
        // the initial frame, before BringIntoView has completed its scroll.
        paparazzi.gif(view, "v0.4.1-search-selected-code", 0, 1500, 10)
        org.junit.Assert.assertTrue("The selected code occurrence was revealed", revealed)
    }
    @OptIn(ExperimentalMaterial3Api::class)
    @Test fun wideLandscape() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(
            screenWidth = 1600, screenHeight = 900, xdpi = 160, ydpi = 160,
            density = com.android.resources.Density.MEDIUM, orientation = ScreenOrientation.LANDSCAPE))
        sessions(ThemeMode.LIGHT, suffix = "-wide")
        render("workspace-dark-wide", ThemeMode.DARK, "Review checkout") {
            AdaptiveSessionLayout(
                sessions = { SessionsScreen(conversationState(), {}, {}, {}, {}, {}) },
                conversation = {
                    Column {
                        TabRow(selectedTabIndex = 0, containerColor = MaterialTheme.colorScheme.background) {
                            Tab(selected = true, onClick = {}, text = { Text("Conversation") })
                            Tab(selected = false, onClick = {}, text = { Text("Review results") })
                        }
                        AgentDetailContent(conversationState(), panes.first(), {}, { _, _ -> })
                    }
                }
            )
        }
    }
    @Test fun results() {
        val result = buildJsonObject {
            put("available", true); put("status", " M app/Checkout.kt\n?? tests/CheckoutTest.kt")
            put("diff", "diff --git a/app/Checkout.kt b/app/Checkout.kt\n+require(address.isNotBlank())")
            putJsonObject("tests") { put("status", "unknown"); put("reason", "No structured test result was observed.") }
            putJsonArray("artifacts") { add(buildJsonObject { put("id", "project-example"); put("name", "artifacts/checkout-preview.png"); put("size", 32520) }) }
        }
        render("review-results-light", ThemeMode.LIGHT, "Review results") { ReviewResults(result, false, {}) }
    }
}
