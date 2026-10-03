package dev.herdr.remote

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.app.ActivityOptionsCompat
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import org.junit.Rule
import org.junit.Test
import java.lang.reflect.Proxy

/** Native conversation fixtures using only current bridge-shaped question state. */
class QuestionCardPreviewTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5,
        theme = "android:Theme.Material.NoActionBar")

    private val pane = Pane("preview-question", "workspace", kind = "codex", status = "blocked")

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

    private val activityResults = object : ActivityResultRegistryOwner {
        override val activityResultRegistry = object : ActivityResultRegistry() {
            override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>,
                input: I, options: ActivityOptionsCompat?) {
                error("Question preview must not request a device permission")
            }
        }
    }

    private fun render(name: String, question: BridgeQuestion, mode: ThemeMode = ThemeMode.LIGHT,
        fontScale: Float = 1f, canControl: Boolean = true) {
        val context = fixtureContext()
        val state = RemoteState(url = "https://laptop.example", online = true, selectedId = pane.id,
            snapshot = Snapshot(herdrOnline = true, panes = listOf(pane), terminalInputEnabled = true,
                canControl = canControl, questionSelectionEnabled = true),
            terminalAttachmentId = "current-attachment", outputReady = true,
            output = "The agent is waiting for your decision.", question = question)
        paparazzi.snapshot(name) {
            CompositionLocalProvider(LocalContext provides context,
                LocalActivityResultRegistryOwner provides activityResults,
                LocalDensity provides Density(paparazzi.context.resources.displayMetrics.density, fontScale)) {
                HerdrTheme(mode) { Surface(Modifier.fillMaxSize()) {
                    TerminalLiveView(state, pane, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})
                } }
            }
        }
    }

    private fun choices() = BridgeQuestion("a".repeat(64),
        "Which deployment should receive the fix? Review the rollout order before choosing.",
        listOf("Only the staging laptop", "The production laptop after verification", "Other"),
        selectedIndex = 0, freeText = true, stage = "choices")

    @Test fun choicesLight() = render("question-choices-light", choices())

    @Test fun choicesDark() = render("question-choices-dark", choices(), ThemeMode.DARK)

    @Test fun longQuestionNarrowAtTwoHundredPercent() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 320,
            screenHeight = 920, xdpi = 160, ydpi = 160, density = com.android.resources.Density.MEDIUM))
        render("question-long-320dp-200percent", choices().copy(
            prompt = "Before proceeding, review the deployment order and the rollback constraints. ".repeat(8),
            options = (1..18).map { "Deployment path $it with a detailed explanation that wraps on a narrow phone" }),
            fontScale = 2f)
    }

    @Test fun textStageReadOnly() = render("question-text-read-only",
        BridgeQuestion("b".repeat(64), "Describe the alternate deployment plan.",
            emptyList(), freeText = true, stage = "text"), canControl = false)
}
