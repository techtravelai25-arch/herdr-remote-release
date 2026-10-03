package dev.herdr.remote

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

internal enum class VoiceProvider { ANDROID, GROQ }

internal class VoiceProviderStore(context: Context) {
    val preferences = context.applicationContext.getSharedPreferences("voice_input", Context.MODE_PRIVATE)
    fun load(): VoiceProvider = runCatching {
        VoiceProvider.valueOf(preferences.getString("provider", VoiceProvider.ANDROID.name) ?: VoiceProvider.ANDROID.name)
    }.getOrDefault(VoiceProvider.ANDROID)
    fun save(provider: VoiceProvider) { check(preferences.edit().putString("provider", provider.name).commit()) }
}

internal interface VoiceSession {
    val recording: Boolean
    val uploading: Boolean
    val seconds: Int
    val levels: List<Float>
    var error: String?
    fun cancel()
    fun start(onTranscript: (String) -> Unit)
    fun finish(onTranscript: (String) -> Unit)
}

/** Owns one disposable Groq recording/upload; never sends a prompt. */
private class VoiceCapture(private val context: Context, private val scope: CoroutineScope) : VoiceSession {
    override var recording by mutableStateOf(false)
        private set
    override var uploading by mutableStateOf(false)
        private set
    override var seconds by mutableIntStateOf(0)
        private set
    override var levels by mutableStateOf<List<Float>>(emptyList())
        private set
    private val levelHistory = VoiceLevelHistory()
    override var error by mutableStateOf<String?>(null)
    private var recorder: MediaRecorder? = null
    private var audio: File? = null
    private var timer: Job? = null
    private var upload: Job? = null
    private var generation = 0
    private var apiKey = ""
    private val transcriber = GroqTranscriber()

    override fun cancel() {
        generation++
        timer?.cancel(); timer = null
        upload?.cancel(); upload = null
        runCatching { recorder?.release() }; recorder = null
        audio?.delete(); audio = null
        apiKey = ""
        recording = false
        uploading = false
        seconds = 0
        levelHistory.reset()
        levels = emptyList()
    }

    override fun start(onTranscript: (String) -> Unit) {
        cancel()
        error = null
        try {
            apiKey = GroqKeyStore(context).load()
        } catch (_: Exception) {
            error = "Could not unlock your Groq key. Enter it again in Settings → Voice input."
            return
        }
        try {
            if (apiKey.isBlank()) {
                error = "Add your Groq API key in Settings → Voice input first."
                return
            }
            val file = File.createTempFile("groq-voice-", ".m4a", context.cacheDir)
            audio = file
            @Suppress("DEPRECATION")
            val next = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
            recorder = next
            next.setAudioSource(MediaRecorder.AudioSource.MIC)
            next.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            next.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            next.setAudioChannels(1)
            next.setAudioSamplingRate(16000)
            next.setAudioEncodingBitRate(64000)
            next.setOutputFile(file.absolutePath)
            next.setOnErrorListener { _, _, _ ->
                cancel()
                error = "Recording failed. Please try again."
            }
            next.prepare()
            next.start()
            recording = true
            val started = SystemClock.elapsedRealtime()
            timer = scope.launch {
                while (recording) {
                    delay(80)
                    // maxAmplitude reports the peak since the previous read; only read while recording.
                    val amplitude = try {
                        next.maxAmplitude
                    } catch (_: Exception) {
                        cancel()
                        error = "Microphone became unavailable. Please record again."
                        break
                    }
                    levels = levelHistory.sample(amplitude)
                    seconds = ((SystemClock.elapsedRealtime() - started) / 1000).toInt()
                    if (seconds >= 120) {
                        finish(onTranscript)
                        break
                    }
                }
            }
        } catch (_: Exception) {
            cancel()
            error = "Could not start the microphone. Check permission and try again."
        }
    }

    override fun finish(onTranscript: (String) -> Unit) {
        if (!recording) return
        timer?.cancel(); timer = null
        val file = audio ?: return
        try {
            recorder?.stop()
        } catch (_: Exception) {
            cancel()
            error = "Recording was too short or unavailable. Please record again."
            return
        } finally {
            runCatching { recorder?.release() }; recorder = null
        }
        recording = false
        levelHistory.reset()
        levels = emptyList()
        uploading = true
        val requestGeneration = generation
        val requestKey = apiKey
        apiKey = ""
        upload = scope.launch {
            try {
                val transcript = transcriber.transcribe(file, requestKey)
                if (generation == requestGeneration) onTranscript(transcript)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                if (generation == requestGeneration) {
                    error = failure.message ?: "Transcription failed. Please try again."
                }
            } finally {
                file.delete()
                if (generation == requestGeneration) {
                    audio = null
                    uploading = false
                    seconds = 0
                    upload = null
                }
            }
        }
    }
}

@Composable
internal fun VoiceInput(sessionKey: String, enabled: Boolean, onBusyChange: (Boolean) -> Unit = {}, compact: Boolean = false, onStatusChange: (String?, Boolean) -> Unit = { _, _ -> }, onRecordingStateChange: (VoiceRecordingState) -> Unit = {}, onTranscript: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val providerStore = remember(context) { VoiceProviderStore(context) }
    var provider by remember(providerStore) { mutableStateOf(providerStore.load()) }
    DisposableEffect(providerStore) {
        val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key == "provider") provider = providerStore.load()
        }
        providerStore.preferences.registerOnSharedPreferenceChangeListener(listener)
        onDispose { providerStore.preferences.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    val groqCapture = remember(sessionKey) { VoiceCapture(context.applicationContext, scope) }
    val androidCapture = remember(sessionKey) { AndroidVoiceRecognition(context.applicationContext, scope) }
    val capture: VoiceSession = if (provider == VoiceProvider.GROQ) groqCapture else androidCapture
    val latestCapture by rememberUpdatedState(capture)
    val latestCallback by rememberUpdatedState(onTranscript)
    val latestEnabled by rememberUpdatedState(enabled)
    val latestBusyChange by rememberUpdatedState(onBusyChange)
    val latestRecordingStateChange by rememberUpdatedState(onRecordingStateChange)
    SideEffect { latestRecordingStateChange(VoiceRecordingState(capture.recording, capture.uploading, capture.seconds, capture.levels)) }
    SideEffect { latestBusyChange(capture.recording || capture.uploading) }
    var permissionRequested by remember(sessionKey) { mutableStateOf(false) }
    var startWhenResumed by remember(sessionKey) { mutableStateOf(false) }
    val deliver: (String) -> Unit = {
        if (latestEnabled && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) latestCallback(it)
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (permissionRequested) {
            permissionRequested = false
            if (granted && latestEnabled) {
                if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) latestCapture.start(deliver)
                else startWhenResumed = true
            } else if (!granted) {
                latestCapture.cancel()
                latestCapture.error = "Microphone permission is required. Allow it in Android app settings."
            }
        }
    }
    DisposableEffect(groqCapture, androidCapture, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && startWhenResumed) {
                startWhenResumed = false
                if (latestEnabled) latestCapture.start(deliver)
            }
            if (event == Lifecycle.Event.ON_STOP) {
                startWhenResumed = false
                permissionRequested = false
                groqCapture.cancel()
                androidCapture.cancel()
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            startWhenResumed = false
            permissionRequested = false
            lifecycle.removeObserver(observer)
            groqCapture.cancel()
            androidCapture.cancel()
            latestBusyChange(false)
            latestRecordingStateChange(VoiceRecordingState())
        }
    }
    LaunchedEffect(enabled, provider) {
        if (provider == VoiceProvider.GROQ) androidCapture.cancel() else groqCapture.cancel()
        if (!enabled) {
            startWhenResumed = false
            permissionRequested = false
            capture.cancel()
        }
    }
    val statusMessage = when {
        capture.error != null -> capture.error
        capture.uploading -> if (provider == VoiceProvider.GROQ) "Transcribing with Groq…" else "Transcribing with Android…"
        capture.recording -> "Recording · ${capture.seconds / 60}:${(capture.seconds % 60).toString().padStart(2, '0')} · 2 min max"
        else -> null
    }
    SideEffect { onStatusChange(statusMessage, capture.error != null) }
    val toggleRecording: () -> Unit = {
        if (capture.recording) capture.finish(deliver)
        else if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) capture.start(deliver)
        else {
            permissionRequested = true
            permission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
    if (compact) {
        Column(Modifier.width(48.dp).padding(bottom = 4.dp)) {
            if (capture.uploading) {
                IconButton(onClick = { capture.cancel() }, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.Default.Close, "Cancel voice transcription")
                }
            } else {
                IconButton(enabled = enabled && !permissionRequested, onClick = toggleRecording, modifier = Modifier.size(48.dp)) {
                    Icon(if (capture.recording) Icons.Default.Stop else Icons.Default.Mic,
                        if (capture.recording) "Stop recording and transcribe" else "Voice input",
                        tint = if (capture.recording) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (capture.recording) IconButton(onClick = { capture.cancel() }, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.Default.Close, "Cancel voice input")
                }
            }
        }
    } else Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (capture.uploading) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Text(if (provider == VoiceProvider.GROQ) "Transcribing with Groq…" else "Transcribing with Android…", Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.labelMedium)
            } else {
                TextButton(enabled = enabled && !permissionRequested, onClick = toggleRecording) {
                    Icon(if (capture.recording) Icons.Default.Stop else Icons.Default.Mic, contentDescription = null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(if (capture.recording) "Stop · ${capture.seconds / 60}:${(capture.seconds % 60).toString().padStart(2, '0')}" else "Voice input")
                }
                if (capture.recording) Text("2 min max", Modifier.weight(1f), style = MaterialTheme.typography.labelSmall)
            }
            if (capture.recording || capture.uploading) {
                IconButton(onClick = { capture.cancel() }) { Icon(Icons.Default.Close, contentDescription = "Cancel voice input") }
            }
        }
        capture.error?.let { Text(it, Modifier.padding(horizontal = 12.dp, vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
internal fun VoiceInputSettings() {
    val context = LocalContext.current
    val store = remember { GroqKeyStore(context.applicationContext) }
    val providerStore = remember { VoiceProviderStore(context.applicationContext) }
    var provider by remember { mutableStateOf(providerStore.load()) }
    var key by remember { mutableStateOf("") }
    val initialKeyState = remember { runCatching { store.load().isNotBlank() } }
    var saved by remember { mutableStateOf(initialKeyState.getOrDefault(false)) }
    var unreadable by remember { mutableStateOf(initialKeyState.isFailure) }
    var changing by remember { mutableStateOf(!saved || unreadable) }
    var message by remember { mutableStateOf<String?>(null) }

    GroqVoiceSettingsContent(
        keyAvailable = saved,
        keyUnreadable = unreadable,
        changingKey = changing,
        keyValue = key,
        message = message,
        provider = provider,
        onProviderChange = { next ->
            try {
                providerStore.save(next)
                provider = next
                message = null
            } catch (_: Exception) {
                message = "Could not save the voice input choice. Please try again."
            }
        },
        onKeyValueChange = { key = it; message = null },
        onSave = {
            try {
                store.save(key.trim())
                key = ""
                saved = true
                unreadable = false
                changing = false
                message = null
            } catch (_: Exception) {
                message = "Could not save the key securely. Please try again."
            }
        },
        onChangeKey = {
            key = ""
            changing = true
            message = null
        },
        onCancelChange = {
            key = ""
            changing = false
            message = null
        },
        onRemove = {
            try {
                store.save("")
                key = ""
                saved = false
                unreadable = false
                changing = true
                message = null
            } catch (_: Exception) {
                message = "Could not remove the key. Please try again."
            }
        },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun GroqVoiceSettingsContent(
    keyAvailable: Boolean,
    keyUnreadable: Boolean,
    changingKey: Boolean,
    keyValue: String,
    message: String?,
    onKeyValueChange: (String) -> Unit,
    onSave: () -> Unit,
    onChangeKey: () -> Unit,
    onCancelChange: () -> Unit,
    onRemove: () -> Unit,
    provider: VoiceProvider = VoiceProvider.ANDROID,
    onProviderChange: (VoiceProvider) -> Unit = {},
) {
    val context = LocalContext.current
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Voice input", style = MaterialTheme.typography.titleMedium)
            Text("Turn speech into an editable draft.", style = MaterialTheme.typography.bodyMedium)
            Column(Modifier.selectableGroup()) {
                VoiceProvider.entries.forEach { choice ->
                    Row(
                        Modifier.fillMaxWidth().selectable(
                            selected = provider == choice,
                            role = Role.RadioButton,
                            onClick = { onProviderChange(choice) },
                        ).heightIn(min = 48.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        RadioButton(selected = provider == choice, onClick = null)
                        Text(if (choice == VoiceProvider.ANDROID) "Android speech recognition" else "Groq", style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
            if (provider == VoiceProvider.ANDROID) {
                Text("Default. Uses your phone's speech service; no Groq API key is needed. The service may use the internet to process audio.", style = MaterialTheme.typography.bodySmall)
                Text("Tap the microphone in a conversation and allow microphone access. Your words appear as an editable draft before you send them.", style = MaterialTheme.typography.bodySmall)
                if (keyAvailable || keyUnreadable) {
                    Text(
                        if (keyUnreadable) "A saved Groq key could not be unlocked." else "A Groq API key is saved on this phone.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    TextButton(onClick = onRemove) { Text("Remove Groq key") }
                }
            } else {
                Text("Groq requires your own API key and an internet connection.", style = MaterialTheme.typography.bodySmall)

                when {
                    keyUnreadable -> {
                        Text(
                            "Could not unlock the saved API key. Enter a replacement or remove it.",
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Text("The API key is encrypted on this phone.", style = MaterialTheme.typography.bodySmall)
                    }
                    keyAvailable -> {
                        Text("API key added", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                        Text("Stored encrypted on this phone.", style = MaterialTheme.typography.bodySmall)
                        if (changingKey) {
                            Text("The stored key remains in use until the replacement is saved.", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    else -> {
                        Text(
                            "1. Sign in to Groq Console and create an API key.\n2. Copy it and paste it below.\n3. Tap the microphone in a conversation and allow microphone access.\n4. Stop recording to transcribe, then edit the draft before sending it to your laptop.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        OutlinedButton(onClick = { openWebLink(context, "https://console.groq.com/keys") }) {
                            Text("Open Groq API keys")
                        }
                        Text("Your API key is encrypted on this phone.", style = MaterialTheme.typography.bodySmall)
                    }
                }

                if (keyAvailable && !changingKey) {
                    FlowRow(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        TextButton(onClick = onChangeKey) { Text("Change key") }
                        TextButton(onClick = onRemove) { Text("Remove key") }
                    }
                } else {
                    OutlinedTextField(
                        value = keyValue,
                        onValueChange = onKeyValueChange,
                        label = { Text("Groq API key") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                    )
                    FlowRow(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Button(enabled = keyValue.isNotBlank(), onClick = onSave) { Text("Save key") }
                        if (keyAvailable && changingKey) {
                            TextButton(onClick = onCancelChange) { Text("Cancel") }
                        }
                        if (keyUnreadable) {
                            TextButton(onClick = onRemove) { Text("Remove key") }
                        }
                    }
                }

                Text(
                    "Audio is sent directly to Groq for transcription; the transcript stays a draft until you tap Send.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Text("Up to 2 minutes per voice message in Herdr Remote.", style = MaterialTheme.typography.bodySmall)
                Text(
                    "Groq free Whisper v3 limits: 20 requests/minute, 2,000 requests/day, 2 audio hours/hour, and 8 audio hours/day. Shared across your organization; your account may vary.",
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(onClick = { openWebLink(context, "https://console.groq.com/settings/limits") }) {
                    Text("View Groq account limits")
                }
            }
            message?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
