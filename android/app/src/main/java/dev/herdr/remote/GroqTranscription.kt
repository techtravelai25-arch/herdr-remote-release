package dev.herdr.remote

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.Response

/** Encrypted separately from connection settings; shared preferences are excluded from all backups. */
class GroqKeyStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences("groq_credentials", Context.MODE_PRIVATE)

    @Synchronized fun load(): String {
        val stored = preferences.getString("encrypted_key", null) ?: return ""
        return try {
            val parts = stored.split(':')
            require(parts.size == 2)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (_: Exception) {
            throw IllegalStateException("Unable to unlock the Groq API key. Please enter it again in Settings.")
        }
    }

    @Synchronized fun save(value: String) {
        try {
            val trimmed = value.trim()
            val editor = preferences.edit()
            if (trimmed.isEmpty()) {
                editor.remove("encrypted_key")
            } else {
                validateGroqKey(trimmed)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, key())
                val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
                val ciphertext = Base64.encodeToString(cipher.doFinal(trimmed.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
                editor.putString("encrypted_key", "$iv:$ciphertext")
            }
            check(editor.commit())
        } catch (_: Exception) {
            throw IllegalStateException("Unable to save the Groq API key securely. Please try again.")
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
        }.generateKey()
    }

    private companion object { const val KEY_ALIAS = "herdr_groq_api_key_v1" }
}

class GroqTranscriptionException(message: String) : IOException(message)

private fun validateGroqKey(key: String) {
    if (key.isBlank() || key.length > 512 || key.any { it <= ' ' || it > '~' }) {
        throw GroqTranscriptionException("Enter a valid Groq API key in Settings.")
    }
}

class GroqTranscriber(injectedClient: OkHttpClient? = null) {
    private val client = (injectedClient ?: OkHttpClient()).newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(120, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .build()

    suspend fun transcribe(file: File, apiKey: String): String {
        val key = apiKey.trim()
        validateGroqKey(key)
        if (!file.isFile || file.length() == 0L) {
            throw GroqTranscriptionException("The recording is empty. Please record again.")
        }
        if (file.length() > MAX_AUDIO_BYTES) {
            throw GroqTranscriptionException("The recording is too large. Please use a shorter recording.")
        }
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("model", "whisper-large-v3")
            .addFormDataPart("response_format", "json")
            .addFormDataPart("file", "recording.m4a", file.asRequestBody("audio/mp4".toMediaType()))
            .build()
        val request = Request.Builder().url("https://api.groq.com/openai/v1/audio/transcriptions")
            .header("Authorization", "Bearer $key")
            .post(body).build()
        return suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(networkError(e))
                }
                override fun onResponse(call: Call, response: Response) {
                    // Consume and close inside the callback so cancellation cannot leak a response body.
                    val result = try { response.use { readTranscript(it) } } catch (e: GroqTranscriptionException) {
                        if (continuation.isActive) continuation.resumeWithException(e)
                        return
                    } catch (e: IOException) {
                        if (continuation.isActive) continuation.resumeWithException(networkError(e))
                        return
                    } catch (_: Exception) {
                        if (continuation.isActive) continuation.resumeWithException(
                            GroqTranscriptionException("Groq returned an unreadable transcript. Please try again."))
                        return
                    }
                    if (continuation.isActive) continuation.resume(result)
                }
            })
        }
    }

    private fun readTranscript(response: Response): String {
        if (!response.isSuccessful) throw GroqTranscriptionException(when (response.code) {
            401, 403 -> "Groq rejected the API key. Check it in Settings."
            413 -> "The recording is too large. Please use a shorter recording."
            429 -> "Groq's usage limit was reached. Please wait and try again."
            in 500..599 -> "Groq is temporarily unavailable. Please try again."
            else -> "Groq could not transcribe this recording. Please try again."
        })
        val source = response.body?.source()
            ?: throw GroqTranscriptionException("Groq returned an empty response. Please try again.")
        if (source.request(MAX_RESPONSE_BYTES + 1)) {
            throw GroqTranscriptionException("Groq returned an oversized response. Please try again.")
        }
        val element = Json.parseToJsonElement(source.readUtf8()).jsonObject["text"]
        val text = (element as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()
            ?: throw GroqTranscriptionException("Groq returned an unreadable transcript. Please try again.")
        if (text.isBlank()) throw GroqTranscriptionException("No speech was detected. Please record again.")
        if (text.length > 16000) throw GroqTranscriptionException("The transcript is too long. Please use a shorter recording.")
        return text
    }

    private fun networkError(error: IOException) = GroqTranscriptionException(
        if (error is SocketTimeoutException || error is java.io.InterruptedIOException)
            "Transcription timed out. Check your connection and try a shorter recording."
        else "Could not reach Groq. Check your internet connection and try again.")

    companion object {
        const val MAX_AUDIO_BYTES = 24L * 1024 * 1024
        private const val MAX_RESPONSE_BYTES = 1024L * 1024
    }
}
