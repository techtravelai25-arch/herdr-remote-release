package dev.herdr.remote

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.net.toUri
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

private const val CRASH_FILE = "startup-crash.txt"
private const val MAX_FRAMES = 24
private const val MAX_CAUSES = 4

internal object StartupCrashReport {
    private val writing = AtomicBoolean(false)
    private fun file(context: Context) = File(context.noBackupFilesDir, CRASH_FILE)

    fun install(context: Context) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            if (writing.compareAndSet(false, true)) runCatching { write(context, error) }
            runCatching { previous?.uncaughtException(thread, error) }
            Process.killProcess(Process.myPid())
        }
    }

    private fun write(context: Context, error: Throwable) {
        val report = formatStartupCrash(context.packageName, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE, Build.VERSION.SDK_INT, error)
        val target = file(context)
        val temp = File(target.parentFile, "$CRASH_FILE.tmp")
        temp.writeText(report, Charsets.UTF_8)
        check(temp.renameTo(target)) { "Cannot save startup report" }
    }

    fun pending(context: Context): Boolean = runCatching { file(context).isFile }.getOrDefault(false)
    fun read(context: Context): String = runCatching { file(context).bufferedReader(Charsets.UTF_8).use { reader ->
        val buffer = CharArray(16000)
        val count = reader.read(buffer)
        if (count < 0) "Crash report is empty." else String(buffer, 0, count)
    } }.getOrDefault("Crash details could not be read.")
    fun clear(context: Context) { runCatching { file(context).delete() } }
}

/** Deliberately excludes throwable messages, request URLs and account/device identifiers. */
internal fun formatStartupCrash(packageName: String, versionName: String, versionCode: Int, sdk: Int, error: Throwable): String = buildString {
    appendLine("Herdr Remote crash report")
    appendLine("Package: $packageName")
    appendLine("Version: $versionName ($versionCode)")
    appendLine("Android SDK: $sdk")
    var current: Throwable? = error
    var depth = 0
    while (current != null && depth++ < MAX_CAUSES) {
        appendLine("Cause $depth: ${current::class.java.name}")
        current.stackTrace.take(MAX_FRAMES).forEach { frame ->
            appendLine("  at ${frame.className}.${frame.methodName}(${frame.fileName ?: "Unknown Source"}:${frame.lineNumber})")
        }
        current = current.cause
    }
}.take(16000)

class RecoveryActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val report = StartupCrashReport.read(this)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }
        val title = TextView(this).apply { setText(R.string.recovery_title); textSize = 22f }
        val body = TextView(this).apply { setText(R.string.recovery_body); textSize = 16f; setPadding(0, 20, 0, 16) }
        val details = TextView(this).apply { text = report; textSize = 12f; setTextIsSelectable(true) }
        val copy = Button(this).apply {
            setText(R.string.recovery_copy)
            setOnClickListener {
                getSystemService(android.content.ClipboardManager::class.java)
                    ?.setPrimaryClip(ClipData.newPlainText("Herdr Remote crash details", report))
            }
        }
        val retry = Button(this).apply { setText(R.string.recovery_retry); setOnClickListener { StartupCrashReport.clear(this@RecoveryActivity); startActivity(Intent(this@RecoveryActivity, MainActivity::class.java)); finish() } }
        val update = Button(this).apply { setText(R.string.recovery_update); setOnClickListener { startActivity(Intent(Intent.ACTION_VIEW, BuildConfig.DOWNLOAD_URL.toUri())) } }
        root.addView(title); root.addView(body); root.addView(copy); root.addView(retry)
        if (BuildConfig.DOWNLOAD_URL.isNotEmpty()) root.addView(update)
        val scroll = ScrollView(this).apply { addView(details) }
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        root.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(24 + insets.systemWindowInsetLeft, 24 + insets.systemWindowInsetTop,
                24 + insets.systemWindowInsetRight, 24 + insets.systemWindowInsetBottom)
            insets
        }
        setContentView(root)
    }
}
