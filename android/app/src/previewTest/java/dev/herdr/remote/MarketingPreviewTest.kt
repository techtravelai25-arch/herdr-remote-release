package dev.herdr.remote

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Density
import androidx.core.app.ActivityOptionsCompat
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import kotlinx.serialization.json.*
import org.junit.Rule
import org.junit.Test
import java.lang.reflect.Proxy

/**
 * App-store marketing fixtures. Every snapshot is the real Compose UI rendered with
 * coherent, fictional Storefront sample data. No account, network, laptop or emulator
 * is involved, and nothing here is a device screenshot.
 */
class MarketingPreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, theme = "android:Theme.Material.NoActionBar")

    /** (1) Dashboard: three sessions with one meaningful needs-input card. */
    @Test fun dashboardDark() {
        val state = storefrontState()
        render("dashboard-dark", inspection = true) {
            Shell(title = "Herdr", topActions = {
                IconButton(onClick = {}) { Icon(Icons.Default.Settings, "Settings") }
            }, bottomAction = true) {
                SessionsScreen(state, onSelect = {}, onRefresh = {}, onReconnect = {}, onStartHerdr = {}, onCheckCreate = {})
            }
        }
    }

    /** (2) Polished Codex conversation: user request, useful response, normal composer. */
    @Test fun codexConversationDark() {
        val state = storefrontState().copy(
            selectedId = "checkout",
            currentModel = "gpt-5.4 high",
            snapshot = storefrontState().snapshot.copy(panes = storefrontState().snapshot.panes.map { pane ->
                if (pane.id == "checkout") pane.copy(status = "done") else pane
            }),
            output = CODEX_RESPONSE,
        )
        render("codex-conversation-dark") {
            Shell(title = "Add checkout address validation", subtitle = "storefront", canBack = true, tabs = true, topActions = {
                IconButton(onClick = {}) { Icon(Icons.Default.MoreVert, "Conversation options") }
            }) {
                AgentDetailContent(state, state.snapshot.panes.first { it.id == "checkout" }, {}, { _, _ -> })
            }
        }
    }

    /** (3) Decision in the same conversation, with relevant Storefront options. */
    @Test fun codexDecisionDark() {
        val state = storefrontState().copy(
            selectedId = "checkout",
            currentModel = "gpt-5.4 high",
            question = BridgeQuestion(
                "q-storefront-pickup",
                "How should pickup orders work without a shipping address?",
                listOf("Allow pickup without one", "Require one for all orders", "Ask the customer", "Other"),
                0,
            ),
            output = CODEX_DECISION,
        )
        render("codex-decision-dark") {
            Shell(title = "Add checkout address validation", subtitle = "storefront", canBack = true, tabs = true, topActions = {
                IconButton(onClick = {}) { Icon(Icons.Default.MoreVert, "Conversation options") }
            }) {
                AgentDetailContent(state, state.snapshot.panes.first { it.id == "checkout" }, {}, { _, _ -> })
            }
        }
    }

    /** (4) Review results: changed files plus clearly passing structured tests. */
    @Test fun reviewResultsDark() {
        render("review-results-dark") {
            Shell(title = "Add checkout address validation", subtitle = "storefront", canBack = true, tabs = true, selectedTab = 1, topActions = {
                IconButton(onClick = {}) { Icon(Icons.Default.MoreVert, "Conversation options") }
            }) {
                ReviewResults(storefrontReview(), false, {})
            }
        }
    }

    @Composable
    private fun Shell(
        title: String,
        subtitle: String? = null,
        canBack: Boolean = false,
        tabs: Boolean = false,
        selectedTab: Int = 0,
        bottomAction: Boolean = false,
        topActions: @Composable RowScope.() -> Unit = {},
        content: @Composable () -> Unit,
    ) {
        Scaffold(
            topBar = { AppTopBar(title, subtitle, canBack, actions = topActions) },
            bottomBar = { if (bottomAction) NewAgentBar(enabled = true, onCreate = {}) },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                if (tabs) TabRow(selectedTabIndex = selectedTab, containerColor = MaterialTheme.colorScheme.background) {
                    Tab(selected = selectedTab == 0, onClick = {}, text = { Text("Conversation") })
                    Tab(selected = selectedTab == 1, onClick = {}, text = { Text("Review results") })
                }
                Box(Modifier.weight(1f)) { content() }
            }
        }
    }

    private fun render(name: String, inspection: Boolean = false, content: @Composable () -> Unit) {
        val context = fixtureContext()
        val activityResults = fixtureActivityResults()
        paparazzi.snapshot(name = "marketing-$name") {
            CompositionLocalProvider(
                LocalContext provides context,
                LocalActivityResultRegistryOwner provides activityResults,
                LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, 1f),
                LocalInspectionMode provides inspection,
            ) {
                HerdrTheme(themeMode = ThemeMode.DARK) { content() }
            }
        }
    }

    private fun storefrontPanes() = listOf(
        Pane("checkout", "shop", title = "Add checkout address validation", cwd = "/home/developer/projects/storefront",
            kind = "codex", status = "needs_input", lastActivity = "2026-09-26T14:31:00Z"),
        Pane("receipt", "shop", title = "Send order receipt emails", cwd = "/home/developer/projects/storefront",
            kind = "claude", status = "working", lastActivity = "2026-09-26T14:28:00Z"),
        Pane("docs", "tools", title = "Update storefront setup guide", cwd = "/home/developer/projects/storefront-docs",
            kind = "opencode", status = "done", lastActivity = "2026-09-26T14:12:00Z"),
    )

    private fun storefrontState() = RemoteState(
        paired = true, online = true, live = true,
        snapshot = Snapshot(
            herdrOnline = true, hostname = "Storefront laptop",
            workspaces = listOf(Workspace("shop", "Storefront"), Workspace("tools", "Developer tools")),
            panes = storefrontPanes(), attachmentsEnabled = true, reviewEnabled = true,
            codexModelSelectionEnabled = true, canControl = true,
        ),
        attentionIds = setOf("checkout"), notificationsEnabled = true,
    )

    private fun storefrontReview() = buildJsonObject {
        put("available", true)
        put("changedFilesComplete", true)
        put("truncated", false)
        put("status", "## storefront/main\n M src/checkout/validate.ts\n M src/checkout/validate.test.ts\n M src/checkout/CheckoutForm.tsx")
        put("diff", "diff --git a/src/checkout/validate.ts b/src/checkout/validate.ts\n" +
            "--- a/src/checkout/validate.ts\n+++ b/src/checkout/validate.ts\n" +
            "@@ -18,6 +18,10 @@ export function validateOrder(order: Order) {\n" +
            "+  if (!order.shippingAddress.trim()) {\n" +
            "+    return { ok: false, message: \"Enter a shipping address\" };\n" +
            "+  }\n")
        putJsonObject("tests") {
            put("verified", true)
            put("status", "12 passed · 3 suites")
            put("reason", "All 12 checkout tests passed on the latest run.")
        }
        putJsonArray("changedFiles") {
            add(buildJsonObject { put("path", "src/checkout/validate.ts"); put("status", "modified") })
            add(buildJsonObject { put("path", "src/checkout/validate.test.ts"); put("status", "added") })
            add(buildJsonObject { put("path", "src/checkout/CheckoutForm.tsx"); put("status", "modified") })
        }
        putJsonArray("artifacts") {
            add(buildJsonObject { put("id", "checkout-tests"); put("name", "artifacts/checkout-tests.txt"); put("size", 2048) })
            add(buildJsonObject { put("id", "checkout-coverage"); put("name", "artifacts/checkout-coverage.png"); put("size", 48120) })
        }
    }

    // Register the real voice permission launcher without launching Android activities.
    // Any attempted launch is a fixture error; these snapshots never request permissions.
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

    private companion object {
        val CODEX_RESPONSE = """
            › Add a validation that blocks checkout when the shipping address is empty, and show a clear message.

            Updated `src/checkout/validate.ts` so delivery orders cannot be submitted without a complete shipping address.

            - Added an inline "Enter a shipping address" message beside the field.
            - Kept the customer's entered details after a failed submission.
            - Added coverage for missing and whitespace-only addresses.
            - Pickup orders remain available without a shipping address.

            The order summary and receipt steps are unchanged.

            gpt-5.4 high · Context 84% left
        """.trimIndent()

        val CODEX_DECISION = """
            › Add a validation that blocks checkout when the shipping address is empty, and show a clear message.

            I can add the address check for delivery orders. One edge case needs your input: pickup orders have no shipping destination.

            Should those orders still be allowed to proceed?

            gpt-5.4 high · Context 71% left
        """.trimIndent()
    }
}
