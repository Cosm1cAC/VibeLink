package com.vibelink.app.ui.screens

import android.content.Context
import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.gson.Gson
import com.vibelink.app.audio.AudioLevel
import com.vibelink.app.audio.LiveCallAudioService
import com.vibelink.app.audio.LiveCallAudioStreamer
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.AsrCheckpointInfo
import com.vibelink.app.network.AsrProviderInfo
import com.vibelink.app.network.LiveCallEvent
import com.vibelink.app.network.ProviderRegistryResponse
import com.vibelink.app.network.Session
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
    val sessions: List<Session> = emptyList(),
    val sessionId: String = "",
    val sessionTitle: String = "",
    val sessionActive: Boolean = false,
    val agent: String = "claude",
    val model: String = "",
    val asrProvider: String = "",
    val events: List<LiveCallEvent> = emptyList(),
    val qaPairs: List<QaPair> = emptyList(),
    val remoteLevel: Double = 0.0,
    val localLevel: Double = 0.0,
    val statusText: String = "Ready",
    val errorText: String = "",
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val audioRunning: Boolean = false,
    val audioStatus: String = "",
    val providerRegistry: ProviderRegistryResponse = ProviderRegistryResponse(),
    val asrProviders: List<AsrProviderInfo> = emptyList(),
    val asrCheckpoints: List<AsrCheckpointInfo> = emptyList(),
    val asrRecoveryStatus: String = "",
    val deviceHint: String = "Android mic streams PCM to the bridge; server normalizes to 16 kHz mono before ASR.",
)

class CallViewModel : ViewModel() {
    private val gson = Gson()
    private val _uiState = MutableStateFlow(CallUiState())
    val uiState: StateFlow<CallUiState> = _uiState.asStateFlow()

    private var eventSource: EventSource? = null
    private var audioStreamer: LiveCallAudioStreamer? = null
    private var appContext: Context? = null
    private val seenEvents = mutableSetOf<String>()

    fun load(apiClient: ApiClient) {
        viewModelScope.launch {
            _uiState.update { it.copy(loading = it.sessions.isEmpty(), refreshing = it.sessions.isNotEmpty(), errorText = "") }
            try {
                val registry = runCatching { apiClient.getProviderRegistry() }.getOrDefault(ProviderRegistryResponse())
                val asrProviders = runCatching { apiClient.listAsrProviders() }.getOrDefault(emptyList())
                val sessions = apiClient.listSessions()
                _uiState.update { state ->
                    val selected = sessions.firstOrNull { it.id == state.sessionId } ?: sessions.firstOrNull()
                    val defaultAgent = registry.providers.firstOrNull { it.id == state.agent && it.available }?.id
                        ?: registry.providers.firstOrNull { it.capabilities.liveCallAssistant && it.available }?.id
                        ?: state.agent
                    state.copy(
                        sessions = sessions,
                        providerRegistry = registry,
                        asrProviders = asrProviders,
                        agent = defaultAgent,
                        loading = false,
                        refreshing = false,
                        sessionId = selected?.id.orEmpty(),
                        sessionTitle = selected?.title.orEmpty(),
                        sessionActive = selected?.status != "stopped" && selected != null,
                        statusText = selected?.let { statusFromSession(it) } ?: "Ready",
                    )
                }
                _uiState.value.sessionId.takeIf { it.isNotBlank() }?.let { selectSession(apiClient, it) }
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        errorText = error.message ?: "Failed to load Live Call sessions",
                    )
                }
            }
        }
    }

    fun setAgent(value: String) {
        _uiState.update { it.copy(agent = value.ifBlank { "claude" }) }
    }

    fun setModel(value: String) {
        _uiState.update { it.copy(model = value) }
    }

    fun setAsrProvider(value: String) {
        _uiState.update { it.copy(asrProvider = value) }
    }

    fun selectSession(apiClient: ApiClient, sessionId: String) {
        if (sessionId.isBlank()) return
        viewModelScope.launch {
            stopAudio()
            eventSource?.cancel()
            eventSource = null
            seenEvents.clear()
            _uiState.update { state ->
                val selected = state.sessions.firstOrNull { it.id == sessionId }
                state.copy(
                    sessionId = sessionId,
                    sessionTitle = selected?.title.orEmpty(),
                    sessionActive = selected?.status != "stopped",
                    events = emptyList(),
                    qaPairs = emptyList(),
                    remoteLevel = selected?.remote?.rms ?: 0.0,
                    localLevel = selected?.local?.rms ?: 0.0,
                    statusText = selected?.let { statusFromSession(it) } ?: "Loading session",
                    errorText = "",
                    refreshing = true,
                )
            }
            try {
                val events = apiClient.fetchLiveCallEvents(sessionId, after = 0, limit = MAX_EVENTS)
                val checkpoints = runCatching { apiClient.listAsrCheckpoints(sessionId) }.getOrDefault(emptyList())
                applyEvents(events)
                val cursor = events.maxOfOrNull { it.cursor } ?: 0
                subscribeEvents(apiClient, sessionId, cursor)
                _uiState.update { it.copy(refreshing = false, asrCheckpoints = checkpoints) }
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(refreshing = false, errorText = error.message ?: "Failed to load Live Call events")
                }
            }
        }
    }

    fun createSession(apiClient: ApiClient, workspaceId: String = "") {
        if (_uiState.value.loading) return
        val agent = _uiState.value.agent
        val model = _uiState.value.model
        val asrProvider = _uiState.value.asrProvider
        viewModelScope.launch {
            stopAudio()
            eventSource?.cancel()
            eventSource = null
            seenEvents.clear()
            _uiState.update {
                it.copy(
                    loading = true,
                    errorText = "",
                    statusText = "Creating Live Call",
                    events = emptyList(),
                    qaPairs = emptyList(),
                )
            }
            try {
                val session = apiClient.createSession(
                    title = "Live Call",
                    source = "android",
                    workspaceId = workspaceId,
                    asrProvider = asrProvider,
                    agent = agent,
                    model = model,
                )
                if (session == null) {
                    _uiState.update { it.copy(loading = false, errorText = "Bridge returned an empty session") }
                    return@launch
                }
                val sessions = apiClient.listSessions()
                _uiState.update {
                    it.copy(
                        sessions = sessions,
                        sessionId = session.id,
                        sessionTitle = session.title,
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
                        statusText = "Ready",
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
                val sessions = apiClient.listSessions()
                _uiState.update {
                    it.copy(
                        sessions = sessions,
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

    fun pauseSession(apiClient: ApiClient) {
        val sessionId = _uiState.value.sessionId
        if (sessionId.isBlank()) return
        viewModelScope.launch {
            runCatching { apiClient.pauseSession(sessionId) }
                .onSuccess { session ->
                    appContext?.applicationContext?.startService(
                        android.content.Intent(appContext, LiveCallAudioService::class.java)
                            .setAction(LiveCallAudioService.ACTION_PAUSE)
                    )
                    _uiState.update {
                        it.copy(
                            sessionActive = session?.status != "stopped",
                            statusText = "Paused",
                            audioStatus = "Paused",
                            errorText = "",
                        )
                    }
                }
                .onFailure { error -> _uiState.update { it.copy(errorText = error.message ?: "Failed to pause Live Call") } }
        }
    }

    fun resumeSession(apiClient: ApiClient) {
        val sessionId = _uiState.value.sessionId
        if (sessionId.isBlank()) return
        viewModelScope.launch {
            runCatching { apiClient.resumeSession(sessionId) }
                .onSuccess { session ->
                    appContext?.applicationContext?.startService(
                        android.content.Intent(appContext, LiveCallAudioService::class.java)
                            .setAction(LiveCallAudioService.ACTION_RESUME)
                    )
                    _uiState.update {
                        it.copy(
                            sessionActive = session?.status != "stopped",
                            statusText = "Resumed",
                            audioStatus = "Resumed",
                            errorText = "",
                        )
                    }
                }
                .onFailure { error -> _uiState.update { it.copy(errorText = error.message ?: "Failed to resume Live Call") } }
        }
    }

    fun refreshAsrDiagnostics(apiClient: ApiClient) {
        val sessionId = _uiState.value.sessionId
        viewModelScope.launch {
            val providers = runCatching { apiClient.listAsrProviders() }.getOrDefault(_uiState.value.asrProviders)
            val checkpoints = if (sessionId.isNotBlank()) {
                runCatching { apiClient.listAsrCheckpoints(sessionId) }.getOrDefault(_uiState.value.asrCheckpoints)
            } else {
                emptyList()
            }
            _uiState.update {
                it.copy(
                    asrProviders = providers,
                    asrCheckpoints = checkpoints,
                    asrRecoveryStatus = "ASR diagnostics refreshed.",
                    errorText = "",
                )
            }
        }
    }

    fun recoverAsrCheckpoints(apiClient: ApiClient) {
        val sessionId = _uiState.value.sessionId
        if (sessionId.isBlank()) return
        viewModelScope.launch {
            runCatching { apiClient.recoverAsrCheckpoints(sessionId) }
                .onSuccess { checkpoints ->
                    _uiState.update {
                        it.copy(
                            asrCheckpoints = checkpoints,
                            asrRecoveryStatus = "Recovery event emitted for ${checkpoints.size} checkpoint(s).",
                            errorText = "",
                        )
                    }
                }
                .onFailure { error ->
                    _uiState.update { it.copy(errorText = error.message ?: "Failed to recover ASR checkpoints") }
                }
        }
    }

    fun sendTranscript(apiClient: ApiClient, text: String, speaker: String = "remote", final: Boolean = true) {
        val sessionId = _uiState.value.sessionId
        val trimmed = text.trim()
        if (sessionId.isBlank() || trimmed.isBlank()) return
        viewModelScope.launch {
            try {
                apiClient.sendTranscript(sessionId, trimmed, final, speaker)
                _uiState.update { it.copy(statusText = if (final) "Transcript sent" else "Partial transcript sent", errorText = "") }
            } catch (error: Exception) {
                _uiState.update { it.copy(errorText = error.message ?: "Failed to send transcript") }
            }
        }
    }

    fun startAudio(context: Context, apiClient: ApiClient) {
        val sessionId = _uiState.value.sessionId
        if (sessionId.isBlank()) {
            _uiState.update { it.copy(errorText = "Create or select a Live Call first.") }
            return
        }
        if (audioStreamer?.isRunning == true) return
        appContext = context.applicationContext
        runCatching {
            val intent = LiveCallAudioService.startIntent(context.applicationContext, apiClient.baseUrl, apiClient.token, sessionId)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.applicationContext.startForegroundService(intent)
            else context.applicationContext.startService(intent)
        }.onSuccess {
            _uiState.update { it.copy(audioRunning = true, audioStatus = "Background microphone service started", errorText = "") }
            return
        }
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
        val sessionId = _uiState.value.sessionId
        audioStreamer?.stop()
        audioStreamer = null
        if (sessionId.isNotBlank()) {
            runCatching {
                val context = appContext
                if (context != null) context.applicationContext.startService(LiveCallAudioService.stopIntent(context.applicationContext))
            }
        }
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

    private fun applyEvents(events: List<LiveCallEvent>) {
        for (event in events) applyEvent(event)
    }

    private fun applyEvent(event: LiveCallEvent) {
        if (!seenEvents.add(eventKey(event))) return
        _uiState.update { state ->
            val events = (state.events + event).takeLast(MAX_EVENTS)
            val withLevel = applyEventLevel(state.copy(events = events), event)
            withLevel.copy(
                qaPairs = reduceQaPairs(withLevel.qaPairs, event),
                sessionActive = if (event.type == "live_call.stopped") false else withLevel.sessionActive,
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
        _uiState.update { it.copy(localLevel = level.rms, audioRunning = audioStreamer?.isRunning == true) }
    }

    private fun reduceQaPairs(current: List<QaPair>, event: LiveCallEvent): List<QaPair> {
        return when (event.type) {
            "live_call.question.detected" -> current + QaPair(question = event.text, agentState = "idle")
            "live_call.agent.thinking" -> markThinking(current, event.question.ifBlank { event.text })
            "live_call.agent.delta" -> appendAnswer(current, event.text, "streaming")
            "live_call.agent.done" -> finishAnswer(current, event.text)
            "live_call.agent.error" -> appendAnswer(current, event.error.ifBlank { event.text }, "error")
            else -> current
        }.takeLast(MAX_QA_PAIRS)
    }

    private fun markThinking(current: List<QaPair>, question: String): List<QaPair> {
        if (current.isEmpty()) return listOf(QaPair(question = question, agentState = "thinking"))
        val last = current.last()
        return if (last.agentState == "idle") {
            current.dropLast(1) + last.copy(agentState = "thinking")
        } else if (last.agentState == "done") {
            current + QaPair(question = question.ifBlank { last.question }, agentState = "thinking")
        } else {
            current
        }
    }

    private fun appendAnswer(current: List<QaPair>, text: String, state: String): List<QaPair> {
        val clean = text.trim()
        if (clean.isBlank()) return current
        if (current.isEmpty()) return listOf(QaPair(answer = clean, agentState = state))
        return current.dropLast(1) + current.last().let { last ->
            if (last.agentState == "streaming") last.copy(answer = last.answer + clean, agentState = state)
            else last.copy(answer = clean, agentState = state)
        }
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
        "live_call.asr.provider" -> "ASR provider selected"
        "live_call.audio_segment" -> "Speech segment ready"
        "live_call.audio_checkpoint.recovered" -> "ASR checkpoint recovered"
        "live_call.transcript.partial" -> "Listening"
        "live_call.transcript.final" -> "Transcript received"
        "live_call.question.detected" -> "Question detected"
        "live_call.agent.thinking" -> "Assistant thinking"
        "live_call.agent.delta" -> "Assistant answering"
        "live_call.agent.done" -> "Assistant answer ready"
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

        private fun statusFromSession(session: Session): String {
            return when (session.status) {
                "stopped" -> "Stopped"
                "ready", "active" -> "Live Call ${session.id.take(8)} ready"
                else -> session.status.ifBlank { "Ready" }
            }
        }

        private fun eventKey(event: LiveCallEvent): String {
            return event.id.ifBlank { "${event.cursor}:${event.type}:${event.text.hashCode()}:${event.taskId}" }
        }
    }
}
