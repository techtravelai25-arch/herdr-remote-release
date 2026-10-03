package dev.herdr.remote

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Android's configured speech service owns the microphone and returns an editable draft. */
internal class AndroidVoiceRecognition(private val context: Context, private val scope: CoroutineScope) : VoiceSession {
    override var recording by mutableStateOf(false)
        private set
    override var uploading by mutableStateOf(false)
        private set
    override var seconds by mutableIntStateOf(0)
        private set
    override var levels by mutableStateOf<List<Float>>(emptyList())
        private set
    override var error by mutableStateOf<String?>(null)
    private val levelHistory = VoiceLevelHistory()
    private var recognizer: SpeechRecognizer? = null
    private var timer: Job? = null
    private var resultTimeout: Job? = null
    private var generation = 0

    override fun cancel() {
        generation++
        timer?.cancel(); timer = null
        resultTimeout?.cancel(); resultTimeout = null
        recognizer?.let {
            runCatching { it.cancel() }
            runCatching { it.destroy() }
        }
        recognizer = null
        recording = false
        uploading = false
        seconds = 0
        levelHistory.reset()
        levels = emptyList()
    }

    override fun start(onTranscript: (String) -> Unit) {
        cancel()
        error = null
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            error = "Android speech recognition is unavailable on this device. Install or enable a speech service, or choose Groq in Settings → Voice input."
            return
        }
        val requestGeneration = generation
        try {
            val next = SpeechRecognizer.createSpeechRecognizer(context)
            recognizer = next
            next.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = Unit
                override fun onBeginningOfSpeech() = Unit
                override fun onRmsChanged(rmsdB: Float) {
                    if (generation == requestGeneration && recording) {
                        // RMS is reported in dB; map its useful range to the existing feedback bars.
                        levels = levelHistory.sample(((rmsdB.coerceIn(0f, 12f) / 12f) * 32767).toInt())
                    }
                }
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() {
                    if (generation == requestGeneration) waitingForResult()
                }
                override fun onError(code: Int) {
                    if (generation != requestGeneration) return
                    cancel()
                    error = androidSpeechError(code)
                }
                override fun onResults(results: Bundle?) {
                    if (generation != requestGeneration) return
                    val transcript = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()?.trim().orEmpty()
                    cancel()
                    if (transcript.isBlank()) error = "No speech was detected. Please try again."
                    else try { onTranscript(transcript) }
                    catch (failure: Exception) { error = failure.message ?: "Could not add the transcript to your draft." }
                }
                override fun onPartialResults(partialResults: Bundle?) = Unit
                override fun onEvent(eventType: Int, params: Bundle?) = Unit
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            next.startListening(intent)
            recording = true
            val started = SystemClock.elapsedRealtime()
            timer = scope.launch {
                while (recording) {
                    delay(100)
                    seconds = ((SystemClock.elapsedRealtime() - started) / 1000).toInt()
                    if (seconds >= 120) finish(onTranscript)
                }
            }
        } catch (_: Exception) {
            cancel()
            error = "Could not start Android speech recognition. Check microphone access and try again."
        }
    }

    override fun finish(onTranscript: (String) -> Unit) {
        if (!recording) return
        waitingForResult()
        try { recognizer?.stopListening() }
        catch (_: Exception) {
            cancel()
            error = "Could not finish speech recognition. Please try again."
        }
    }

    private fun waitingForResult() {
        if (uploading) return
        recording = false
        uploading = true
        timer?.cancel(); timer = null
        levelHistory.reset()
        levels = emptyList()
        resultTimeout = scope.launch {
            delay(20000)
            if (uploading) {
                cancel()
                error = "Android speech recognition timed out. Please try again."
            }
        }
    }
}

private fun androidSpeechError(code: Int): String = when (code) {
    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech was detected. Please try again."
    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Android speech recognition could not connect. Check your connection or speech service."
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is required. Allow it in Android app settings."
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "The speech service is busy. Please try again."
    else -> "Android speech recognition failed. Please try again or choose Groq in Settings → Voice input."
}
