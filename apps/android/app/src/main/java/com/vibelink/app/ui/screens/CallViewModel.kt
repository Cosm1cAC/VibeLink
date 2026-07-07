package com.vibelink.app.ui.screens

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.gson.Gson
import com.vibelink.app.audio.AudioLevel
import com.vibelink.app.audio.LiveCallAudioStreamer
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.LiveCallEvent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener

data class QaPair(
    val question: String = "",
    val answer: String = "",
    val agentState: String = "idle",
)

data class CallUiState(
    val sessionId: String = "",
    val sessionActive: Boolean = false,
    val events: List<LiveCallEvent> = emptyList(),
    val qaPairs: List<QaPair> = emptyList(),
    val remoteLevel: Double = 0.0,
    val localLevel: Double = 0.0,
    val statusText: String = "Idle",
    val errorText: String = "",
    val loading: Boolean = false,
    val audioRunning: Boolean = false,
    val audioStatus: String = "",
)

class CallViewModel : ViewModel() {
    private val gson = Gson()
    private val _uiState = MutableStateFlow(CallUiState())
    val uiState: StateFlow<CallUiState> = _uiState.asStateFlow()

    private var eventSource: EventSource? = null
    private var audioStreamer: LiveCallAudioStreamer? = null

    fun createSession(apiClient: ApiClient, workspaceId: String = "") {
        if (_uiState.value.loading) return
        viewModelScope.launch {
            stopAudio()
            eventSource?.cancel()
            eventSource = null
            _uiState.update {
                CallUiState(
                    loading = true,
                    statusText = "Creating Live Call",
                )
            }
            try {
                val session = apiClient.createSession(workspaceId = workspaceId)
                if (session == null) {
                    _uiState.update { it.copy(loading = false, errorText = "Bridge returned an empty session") }
                    return@launch
                }
                _uiState.update {
                    it.copy(
                        sessionId = session.id,
                        sessionActive = true,
                        loading = false,
                        statusText = "Live Call ${session.id.take(8)} ready",
                        errorText = "",
                    )
                }
                subscribeEvents(apiClient, session.id, session.eventCursor)
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        loading = false,
                        sessionActive = false,
                        statusText = "Idle",
                        errorText = error.message ?: "Failed to create Live Call",
                    )
                }
            }
        }
    }

    fun stopSession(apiClient: ApiClient) {
        val sessionId = _uiState.value.sessionId
        if (sessionId.isBlank()) return
        viewModelScope.launch {
            stopAudio()
            try {
                apiClient.stopSession(sessionId)
                eventSource?.cancel()
                eventSource = null
                _uiState.update {
                    it.copy(
                        sessionActive = false,
                        audioRunning = false,
                        statusText = "Stopped",
                        audioStatus = "",
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(errorText = error.message ?: "Failed to stop Live Call") }
            }
        }
    }

    fun sendMockQuestion(apiClient: ApiClient, text: String) {
        val sessionId = _uiState.value.sessionId
        val trimmed = text.trim()
        if (sessionId.isBlank() || trimmed.isBlank()) return
        viewModelScope.launch {
            try {
                apiClient.sendTranscript(sessionId, trimmed, true, "remote")
                _uiState.update { it.copy(statusText = "Transcript sent", errorText = "") }
            } catch (error: Exception) {
                _uiState.update { it.copy(errorText = error.message ?: "Failed to send transcript") }
            }
        }
    }

    fun startAudio(context: Context, apiClient: ApiClient) {
        val sessionId = _uiState.value.sessionId
        if (sessionId.isBlank()) {
            _uiState.update { it.copy(errorText = "Create a Live Call first.") }
            return
        }
        if (audioStreamer?.isRunning == true) return
        val streamer = LiveCallAudioStreamer(apiClient, viewModelScope)
        audioStreamer = streamer
        _uiState.update { it.copy(audioRunning = true, audioStatus = "Starting microphone", errorText = "") }
        streamer.start(
            context = context.applicationContext,
            sessionId = sessionId,
            onStatus = { text -> _uiState.update { it.copy(audioStatus = text, audioRunning = streamer.isRunning) } },
            onError = { text -> _uiState.update { it.copy(errorText = text, audioRunning = streamer.isRunning) } },
            onLevel = { level -> applyLocalAudioLevel(level) },
        )
    }

    fun stopAudio() {
        audioStreamer?.stop()
        audioStreamer = null
        _uiState.update { it.copy(audioRunning = false, audioStatus = "") }
    }

    private fun subscribeEvents(apiClient: ApiClient, sessionId: String, after: Int = 0) {
        eventSource?.cancel()
        eventSource = apiClient.subscribeLiveCallEvents(
            sessionId = sessionId,
            after = after,
            listener = object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    try {
                        val event = gson.fromJson(data, LiveCallEvent::class.java)
                        applyEvent(event)
                    } catch (error: Exception) {
                        _uiState.update { it.copy(errorText = error.message ?: "Failed to parse Live Call event") }
                    }
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                    _uiState.update {
                        it.copy(errorText = t?.message ?: "Live Call event stream disconnected")
                    }
                }
            },
        )
    }

    private fun applyEvent(event: LiveCallEvent) {
        _uiState.update { state ->
            val duplicate = state.events.any { existing ->
                (event.id.isNotBlank() && existing.id == event.id) ||
                    (event.cursor > 0 && existing.cursor == event.cursor && existing.type == event.type)
            }
            val events = if (duplicate) state.events else (state.events + event).takeLast(MAX_EVENTS)
            val withLevel = applyEventLevel(state.copy(events = events), event)
            withLevel.copy(
                qaPairs = reduceQaPairs(withLevel.qaPairs, event),
                statusText = statusFromEvent(withLevel.statusText, event),
                errorText = if (event.type == "live_call.agent.error") event.error.ifBlank { event.text } else withLevel.errorText,
            )
        }
    }

    private fun applyEventLevel(state: CallUiState, event: LiveCallEvent): CallUiState {
        if (event.type != "live_call.audio_level") return state
        val rms = event.level?.rms ?: 0.0
        return if (event.channel == "local") state.copy(localLevel = rms) else state.copy(remoteLevel = rms)
    }

    private fun applyLocalAudioLevel(level: AudioLevel) {
        _uiState.update { it.copy(remoteLevel = level.rms, audioRunning = audioStreamer?.isRunning == true) }
    }

    private fun reduceQaPairs(current: List<QaPair>, event: LiveCallEvent): List<QaPair> {
        return when (event.type) {
            "live_call.question.detected" -> current + QaPair(question = event.text, agentState = "thinking")
            "live_call.agent.thinking" -> ensureQuestion(current, event.question.ifBlank { event.text })
            "live_call.agent.delta" -> appendAnswer(current, event.text, "streaming")
            "live_call.agent.done" -> finishAnswer(current, event.text)
            "live_call.agent.error" -> appendAnswer(current, event.error.ifBlank { event.text }, "error")
            else -> current
        }.takeLast(MAX_QA_PAIRS)
    }

    private fun ensureQuestion(current: List<QaPair>, question: String): List<QaPair> {
        if (question.isBlank()) return current
        if (current.lastOrNull()?.question == question) return current
        return current + QaPair(question = question, agentState = "thinking")
    }

    private fun appendAnswer(current: List<QaPair>, text: String, state: String): List<QaPair> {
        val clean = text.trim()
        if (clean.isBlank()) return current
        if (current.isEmpty()) return listOf(QaPair(answer = clean, agentState = state))
        return current.dropLast(1) + current.last().let { it.copy(answer = it.answer + clean, agentState = state) }
    }

    private fun finishAnswer(current: List<QaPair>, text: String): List<QaPair> {
        val clean = text.trim()
        if (current.isEmpty()) return listOf(QaPair(answer = clean, agentState = "done"))
        return current.dropLast(1) + current.last().copy(answer = clean.ifBlank { current.last().answer }, agentState = "done")
    }

    private fun statusFromEvent(current: String, event: LiveCallEvent): String = when (event.type) {
        "live_call.started" -> "Live Call started"
        "live_call.audio_stream.connected" -> "Audio stream connected"
        "live_call.audio_stream.disconnected" -> "Audio stream disconnected"
        "live_call.transcript.partial" -> "Listening"
        "live_call.transcript.final" -> "Transcript received"
        "live_call.question.detected" -> "Question detected"
        "live_call.agent.thinking" -> "Agent thinking"
        "live_call.agent.delta" -> "Agent answering"
        "live_call.agent.done" -> "Agent answer ready"
        "live_call.stopped" -> "Stopped"
        else -> current
    }

    override fun onCleared() {
        eventSource?.cancel()
        stopAudio()
        super.onCleared()
    }

    companion object {
        private const val MAX_EVENTS = 300
        private const val MAX_QA_PAIRS = 20
    }
}
