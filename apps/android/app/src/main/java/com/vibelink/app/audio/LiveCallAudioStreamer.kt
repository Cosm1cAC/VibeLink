package com.vibelink.app.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import com.vibelink.app.network.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

data class AudioLevel(
    val rms: Double = 0.0,
    val peak: Double = 0.0,
    val bytes: Long = 0,
)

class LiveCallAudioStreamer(
    private val apiClient: ApiClient,
    private val scope: CoroutineScope,
) {
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    private val running = AtomicBoolean(false)
    private var webSocket: WebSocket? = null
    private var audioRecord: AudioRecord? = null
    private var recordJob: Job? = null

    val isRunning: Boolean
        get() = running.get()

    fun start(
        context: Context,
        sessionId: String,
        onStatus: (String) -> Unit = {},
        onError: (String) -> Unit = {},
        onLevel: (AudioLevel) -> Unit = {},
    ) {
        if (running.get()) return
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            onError("Microphone permission is required.")
            return
        }

        running.set(true)
        onStatus("Connecting microphone stream")
        val request = apiClient.liveCallAudioRequest(sessionId)
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("""{"sampleRate":16000,"channels":1,"encoding":"pcm16le","device":"remote"}""")
                onStatus("Microphone connected")
                recordJob = scope.launch(Dispatchers.IO) {
                    pumpAudio(webSocket, onStatus, onError, onLevel)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.contains("\"error\"")) onError(text) else onStatus(text.take(120))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                running.set(false)
                onStatus("Microphone stream closed")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                running.set(false)
                onError(t.message ?: "Microphone stream failed")
                stopRecorder()
            }
        })
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        recordJob?.cancel()
        recordJob = null
        try { webSocket?.send("""{"type":"stop"}""") } catch (_: Exception) {}
        try { webSocket?.close(1000, "client_stop") } catch (_: Exception) {}
        webSocket = null
        stopRecorder()
    }

    private fun pumpAudio(
        ws: WebSocket,
        onStatus: (String) -> Unit,
        onError: (String) -> Unit,
        onLevel: (AudioLevel) -> Unit,
    ) {
        val sampleRate = SAMPLE_RATE
        val minBuffer = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuffer == AudioRecord.ERROR || minBuffer == AudioRecord.ERROR_BAD_VALUE) {
            running.set(false)
            onError("AudioRecord does not support 16 kHz mono PCM.")
            return
        }

        val bufferSize = max(minBuffer, FRAME_BYTES)
        val recorder = try {
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(bufferSize * 2)
                .build()
        } catch (error: SecurityException) {
            running.set(false)
            onError(error.message ?: "Microphone permission denied")
            return
        } catch (error: Exception) {
            running.set(false)
            onError(error.message ?: "Unable to open microphone")
            return
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            running.set(false)
            recorder.release()
            onError("Microphone could not be initialized.")
            return
        }

        audioRecord = recorder
        val buffer = ByteArray(bufferSize)
        var totalBytes = 0L
        var lastLevelAt = 0L
        try {
            recorder.startRecording()
            onStatus("Recording microphone")
            while (running.get() && recordJob?.isActive != false) {
                val bytesRead = recorder.read(buffer, 0, buffer.size)
                if (bytesRead <= 0) continue
                totalBytes += bytesRead.toLong()
                val frame = buffer.copyOf(bytesRead)
                ws.send(frame.toByteString())

                val now = System.currentTimeMillis()
                if (now - lastLevelAt >= LEVEL_INTERVAL_MS) {
                    val level = computeLevel(frame, bytesRead, totalBytes)
                    onLevel(level)
                    ws.send("""{"type":"level","rms":${level.rms},"peak":${level.peak}}""")
                    lastLevelAt = now
                }
            }
        } catch (error: Exception) {
            if (running.get()) onError(error.message ?: "Microphone capture failed")
        } finally {
            stopRecorder()
            try { ws.send("""{"type":"flush"}""") } catch (_: Exception) {}
        }
    }

    private fun stopRecorder() {
        val recorder = audioRecord
        audioRecord = null
        if (recorder != null) {
            try {
                if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
            } catch (_: Exception) {}
            try { recorder.release() } catch (_: Exception) {}
        }
    }

    private fun computeLevel(buffer: ByteArray, byteCount: Int, totalBytes: Long): AudioLevel {
        var sum = 0.0
        var peak = 0.0
        var samples = 0
        var i = 0
        while (i + 1 < byteCount) {
            val low = buffer[i].toInt() and 0xFF
            val high = buffer[i + 1].toInt()
            val sample = ((high shl 8) or low).toShort().toInt()
            val normalized = abs(sample / 32768.0)
            sum += normalized * normalized
            peak = max(peak, normalized)
            samples += 1
            i += 2
        }
        val rms = if (samples > 0) sqrt(sum / samples) else 0.0
        return AudioLevel(rms = rms.coerceIn(0.0, 1.0), peak = peak.coerceIn(0.0, 1.0), bytes = totalBytes)
    }

    companion object {
        private const val SAMPLE_RATE = 16_000
        private const val FRAME_BYTES = 3_200
        private const val LEVEL_INTERVAL_MS = 250L
    }
}
