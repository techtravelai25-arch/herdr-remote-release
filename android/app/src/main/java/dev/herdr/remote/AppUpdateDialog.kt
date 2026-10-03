package dev.herdr.remote

import android.content.ClipData
import android.content.Intent
import android.provider.Settings
import androidx.core.net.toUri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import java.util.Locale

@Composable
fun AppUpdateDialog(dismiss: () -> Unit, model: AppUpdater = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val installer = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { /* Android owns installation confirmation. */ }
    fun install() {
        val file = model.state.value.apk
        if (file == null || !file.isFile) {
            model.installationError("The downloaded APK is no longer available. Download it again.")
            return
        }
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
            installer.launch(Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                clipData = ClipData.newRawUri("App update", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            })
        } catch (_: Exception) { model.installationError("Android could not open the installer. Try installing again.") }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (context.packageManager.canRequestPackageInstalls()) install()
        else model.installationError("Allow updates from Herdr Remote in Android settings, then tap Install update again.")
    }
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("App updates") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Installed: ${state.installedVersion} (${state.installedCode})")
                Text("Cloud updates work even when you're signed out or your laptop is offline.", style = MaterialTheme.typography.bodySmall)
                state.latest?.let { Text("Latest: ${it.versionName} (${it.versionCode}) · ${String.format(Locale.US, "%.1f", it.size / (1024.0 * 1024.0))} MB") }
                Text(state.message, color = if (state.error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                if (state.downloading) {
                    val total = state.latest?.size ?: 1L
                    LinearProgressIndicator(progress = { (state.downloadedBytes.toFloat() / total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                    Text("${(state.downloadedBytes * 100 / total).coerceIn(0L, 100L)}% downloaded")
                } else if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (state.apk != null) Text("Android will ask you to confirm installation. Your app data stays on this device.", style = MaterialTheme.typography.bodySmall)
                if (!state.busy && state.latest != null && state.latest!!.versionCode > state.installedCode && state.apk == null) {
                    Button(onClick = model::download, modifier = Modifier.fillMaxWidth()) { Text("Download update") }
                }
                if (state.latest != null && state.latest!!.versionCode > state.installedCode) {
                    TextButton(onClick = {
                        try { context.startActivity(Intent(Intent.ACTION_VIEW, BuildConfig.DOWNLOAD_URL.toUri())) }
                        catch (_: Exception) { model.installationError("Could not open the browser. Use the public release page on this phone.") }
                    }, modifier = Modifier.fillMaxWidth()) { Text("Download in browser") }
                }
                if (!state.busy && state.apk != null) {
                    Button(onClick = {
                        if (context.packageManager.canRequestPackageInstalls()) install()
                        else try {
                            permission.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${context.packageName}".toUri()))
                        } catch (_: Exception) { model.installationError("Open Android settings and allow Herdr Remote to install updates, then try again.") }
                    }, modifier = Modifier.fillMaxWidth()) { Text("Install update") }
                }
                if (state.busy) TextButton(onClick = model::cancel) { Text("Cancel") }
            }
        },
        confirmButton = { TextButton(onClick = model::check, enabled = !state.busy) { Text("Check for updates") } },
        dismissButton = { TextButton(onClick = dismiss) { Text("Close") } },
    )
}
