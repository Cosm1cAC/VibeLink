package com.vibelink.app.ui.screens

import android.content.Context
import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.gson.Gson
import com.vibelink.app.audio.AudioLevel
import com.vibelink.app.audio.LiveCallAudioService
import com.vibelink.app.audio.LiveCallAudioStreamer
import com.vibelink.app.mobile.EventStreamRecoveryPolicy
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.AsrCheckpointInfo
import com.vibelink.app.network.AsrProviderInfo
import com.vibelink.app.network.LiveCallEvent
import com.vibelink.app.network.ProviderRegistryResponse
import com.vibelink.app.network.Session
import com.vibelink.app.data.AppLanguage
import com.vibelink.app.ui.i18n.AppStrings
import com.vibelink.app.ui.i18n.appStringsFor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener

data class QaPair(
    val question: String = "",
    val answer: String = "",
    val agentState: String = "idle",
    val correlationId: String = "",
)

object LiveCallQaReducer {
    fun reduce(current: List<QaPair>, event: LiveCallEvent, maxPairs: Int = 20): List<QaPair> {
        return when (event.type) {
            "live_call.question.detected" -> appendQuestion(current, event)
            "live_call.agent.thinking" -> markThinking(current, event)
            "live_call.agent.delta" -> appendAnswer(current, event, "streaming")
            "live_call.agent.done" -> finishAnswer(current, event)
            "live_call.agent.error" -> appendAnswer(current, event.copy(text = event.error.ifBlank { event.text }), "error")
            else -> current
        }.takeLast(maxPairs)
    }

    private fun appendQuestion(current: List<QaPair>, event: LiveCallEvent): List<QaPair> {
        val question = event.text.trim()
        if (question.isBlank()) return current
        return current + QaPair(
            question = question,
            agentState = "idle",
            correlationId = correlationId(event).ifBlank { event.id.ifBlank { "cursor:${event.cursor}" } },
        )
    }

    private fun markThinking(current: List<QaPair>, event: LiveCallEvent): List<QaPair> {
        val question = event.question.ifBlank { event.text }.trim()
        val index = findTargetIndex(current, event, question)
        if (index < 0) return current + QaPair(
            question = question,
            agentState = "thinking",
            correlationId = correlationId(event),
        )
        return current.replaceAt(index) { pair ->
            pair.copy(
                question = pair.question.ifBlank { question },
                agentState = "thinking",
                correlationId = pair.correlationId.ifBlank { correlationId(event) },
            )
        }
    }

    private fun appendAnswer(current: List<QaPair>, event: LiveCallEvent, state: String): List<QaPair> {
        val clean = event.text.trim()
        if (clean.isBlank()) return current
        val index = findTargetIndex(current, event, event.question)
        if (index < 0) return current + QaPair(
            question = event.question,
            answer = clean,
            agentState = state,
            correlationId = correlationId(event),
        )
        return current.replaceAt(index) { pair ->
            val nextAnswer = if (pair.agentState == "streaming" && state == "streaming") pair.answer + clean else clean
            pair.copy(
                answer = nextAnswer,
                agentState = state,
                correlationId = pair.correlationId.ifBlank { correlationId(event) },
            )
        }
    }

    private fun finishAnswer(current: List<QaPair>, event: LiveCallEvent): List<QaPair> {
        val clean = event.text.trim()
        val index = findTargetIndex(current, event, event.question)
        if (index < 0) return current + QaPair(
            question = event.question,
            answer = clean,
            agentState = "done",
            correlationId = correlationId(event),
        )
        return current.replaceAt(index) { pair ->
            pair.copy(
                answer = clean.ifBlank { pair.answer },
                agentState = "done",
                correlationId = pair.correlationId.ifBlank { correlationId(event) },
            )
        }
    }

    private fun findTargetIndex(current: List<QaPair>, event: LiveCallEvent, question: String): Int {
        val correlationId = correlationId(event)
        if (correlationId.isNotBlank()) {
            current.indexOfLast { it.correlationId == correlationId }.takeIf { it >= 0 }?.let { return it }
        }
        val cleanQuestion = question.trim()
        if (cleanQuestion.isNotBlank()) {
            current.indexOfLast { it.question == cleanQuestion }.takeIf { it >= 0 }?.let { return it }
        }
        return current.indexOfLast { it.agentState != "done" }.takeIf { it >= 0 } ?: current.lastIndex
    }

    private fun correlationId(event: LiveCallEvent): String {
        return event.questionId.ifBlank { event.taskId }
    }

    private inline fun List<QaPair>.replaceAt(index: Int, transform: (QaPair) -> QaPair): List<QaPair> {
        return mapIndexed { currentIndex, pair -> if (currentIndex == index) transform(pair) else pair }
    }
}

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
    val statusText: String = "ready",
    val errorText: String = "",
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val audioRunning: Boolean = false,
    val audioStatus: String = "",
    val providerRegistry: ProviderRegistryResponse = ProviderRegistryResponse(),
    val asrProviders: List<AsrProviderInfo> = emptyList(),
    val asrCheckpoints: List<AsrCheckpointInfo> = emptyList(),
    val asrRecoveryStatus: String = "",
    val deviceHint: String = "",
)

class CallViewModel : ViewModel() {
    private var strings: AppStrings = appStringsFor(AppLanguage.Default)

    fun setLanguage(language: AppLanguage) {
        strings = appStringsFor(language)
        _uiState.update { state ->
            state.copy(
                statusText = if (state.statusText == "ready") strings.ready else state.statusText,
                deviceHint = strings.foregroundMicHint,
            )
        }
    }
    private var resiliencePaused = false

    fun setResiliencePaused(paused: Boolean) {
        if (resiliencePaused == paused) return
        resiliencePaused = paused
        if (paused) cancelEventStream()
    }
    private val gson = Gson()
    private val _uiState = MutableStateFlow(CallUiState())
    val uiState: StateFlow<CallUiState> = _uiState.asStateFlow()

    private var eventSource: EventSource? = null
    private var eventReconnectJob: Job? = null
    private var eventStreamGeneration = 0L
    private var lastEventCursor = 0
    private var reconnectAttempt = 0
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
                        statusText = selected?.let { statusFromSession(it, strings) } ?: strings.ready,
                    )
                }
                _uiState.value.sessionId.takeIf { it.isNotBlank() }?.let { selectSession(apiClient, it) }
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        errorText = strings.loadingLiveCallSessionsFailed(error.message.orEmpty()),
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
            cancelEventStream()
            seenEvents.clear()
            lastEventCursor = 0
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
                    statusText = selected?.let { statusFromSession(it, strings) } ?: strings.loadingLiveCallSession,
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
                    it.copy(refreshing = false, errorText = strings.loadingLiveCallEventsFailed(error.message.orEmpty()))
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
            cancelEventStream()
            seenEvents.clear()
            lastEventCursor = 0
            _uiState.update {
                it.copy(
                    loading = true,
                    errorText = "",
                    statusText = strings.creatingLiveCall,
                    events = emptyList(),
                    qaPairs = emptyList(),
                )
            }
            try {
                val session = apiClient.createSession(
                    title = strings.liveCall,
                    source = "android",
                    workspaceId = workspaceId,
                    asrProvider = asrProvider,
                    agent = agent,
                    model = model,
                )
                if (session == null) {
                    _uiState.update { it.copy(loading = false, errorText = strings.emptyLiveCallSession) }
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
                        statusText = strings.liveCallReady(session.id),
                        errorText = "",
                    )
                }
                subscribeEvents(apiClient, session.id, session.eventCursor)
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        loading = false,
                        sessionActive = false,
                        statusText = strings.ready,
                        errorText = strings.createLiveCallFailed(error.message.orEmpty()),
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
                cancelEventStream()
                val sessions = apiClient.listSessions()
                _uiState.update {
                    it.copy(
                        sessions = sessions,
                        sessionActive = false,
                        audioRunning = false,
                        statusText = strings.liveCallSessionStatus("stopped"),
                        audioStatus = "",
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(errorText = strings.stopLiveCallFailed(error.message.orEmpty())) }
            }
        }
    }

    fun pauseSession(apiClient: ApiClient) {
        val sessionId = _uiState.value.sessionId
        if (sessionId.isBlank()) return
        viewModelScope.launch {
            runCatching { apiClient.pauseSession(sessionId) }
                .onSuccess { session ->
                    appContext?.let { context ->
                        context.startService(LiveCallAudioService.pauseIntent(context, strings.currentLanguage))
                    }
                    _uiState.update {
                        it.copy(
                            sessionActive = session?.status != "stopped",
                            statusText = strings.paused,
                            audioStatus = strings.paused,
                            errorText = "",
                        )
                    }
                }
                .onFailure { error -> _uiState.update { it.copy(errorText = strings.pauseLiveCallFailed(error.message.orEmpty())) } }
        }
    }

    fun resumeSession(apiClient: ApiClient) {
        val sessionId = _uiState.value.sessionId
        if (sessionId.isBlank()) return
        viewModelScope.launch {
            runCatching { apiClient.resumeSession(sessionId) }
                .onSuccess { session ->
                    appContext?.let { context ->
                        context.startService(LiveCallAudioService.resumeIntent(context, strings.currentLanguage))
                    }
                    _uiState.update {
                        it.copy(
                            sessionActive = session?.status != "stopped",
                            statusText = strings.continued,
                            audioStatus = strings.continued,
                            errorText = "",
                        )
                    }
                }
                .onFailure { error -> _uiState.update { it.copy(errorText = strings.resumeLiveCallFailed(error.message.orEmpty())) } }
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
                    asrRecoveryStatus = strings.asrDiagnosticsRefreshed(),
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
                            asrRecoveryStatus = strings.asrRecoverySent(checkpoints.size),
                            errorText = "",
                        )
                    }
                }
                .onFailure { error ->
                    _uiState.update { it.copy(errorText = strings.asrCheckpointRecoveryFailed(error.message.orEmpty())) }
                }
        }
    }

    fun sendTranscript(apiClient: ApiClient, text: String, speaker: String = "remote", final: Boolean = true) {
        val sessionId = _uiState.value.sessionId
        val trimmed = text.trim()
        if (sessionId.isBlank() || trimmed.isBlank()) return
        val agent = _uiState.value.agent
        val model = _uiState.value.model
        viewModelScope.launch {
            try {
                apiClient.sendTranscript(sessionId, trimmed, final, speaker, agent, model)
                _uiState.update { it.copy(statusText = strings.transcriptSent(final), errorText = "") }
            } catch (error: Exception) {
                _uiState.update { it.copy(errorText = strings.sendTranscriptFailed(error.message.orEmpty())) }
            }
        }
    }

    fun startAudio(context: Context, apiClient: ApiClient) {
        val sessionId = _uiState.value.sessionId
        if (sessionId.isBlank()) {
            _uiState.update { it.copy(errorText = strings.createOrSelectLiveCallFirst) }
            return
        }
        if (audioStreamer?.isRunning == true) return
        appContext = context.applicationContext
        runCatching {
            val intent = LiveCallAudioService.startIntent(
                context.applicationContext,
                apiClient.baseUrl,
                apiClient.token,
                sessionId,
                strings.currentLanguage,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.applicationContext.startForegroundService(intent)
            else context.applicationContext.startService(intent)
        }.onSuccess {
            _uiState.update { it.copy(audioRunning = true, audioStatus = strings.backgroundMicServiceStarted, errorText = "") }
            return
        }
        val streamer = LiveCallAudioStreamer(apiClient, viewModelScope)
        audioStreamer = streamer
        _uiState.update { it.copy(audioRunning = true, audioStatus = strings.startingMic, errorText = "") }
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
                if (context != null) context.applicationContext.startService(LiveCallAudioService.stopIntent(context.applicationContext, strings.currentLanguage))
            }
        }
        _uiState.update { it.copy(audioRunning = false, audioStatus = "") }
    }

    private fun subscribeEvents(
        apiClient: ApiClient,
        sessionId: String,
        after: Int = 0,
        generation: Long = eventStreamGeneration,
    ) {
        if (generation != eventStreamGeneration || !_uiState.value.sessionActive) return
        lastEventCursor = EventStreamRecoveryPolicy.nextCursor(lastEventCursor, after)
        val previous = eventSource
        eventSource = null
        previous?.cancel()
        eventSource = apiClient.subscribeLiveCallEvents(
            sessionId = sessionId,
            after = lastEventCursor,
            listener = object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    if (eventSource !== this@CallViewModel.eventSource) return
                    try {
                        val event = gson.fromJson(data, LiveCallEvent::class.java)
                        reconnectAttempt = 0
                        applyEvent(event)
                    } catch (error: Exception) {
                        _uiState.update { it.copy(errorText = strings.parseLiveCallEventFailed(error.message.orEmpty())) }
                    }
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                    if (eventSource !== this@CallViewModel.eventSource) return
                    _uiState.update {
                        it.copy(errorText = t?.message ?: strings.liveCallEventStreamDisconnected)
                    }
                    scheduleEventReconnect(apiClient, sessionId, generation)
                }

                override fun onClosed(eventSource: EventSource) {
                    if (eventSource !== this@CallViewModel.eventSource) return
                    scheduleEventReconnect(apiClient, sessionId, generation)
                }
            },
        )
    }

    private fun scheduleEventReconnect(apiClient: ApiClient, sessionId: String, generation: Long) {
        if (generation != eventStreamGeneration || !_uiState.value.sessionActive || eventReconnectJob?.isActive == true) return
        val delayMs = EventStreamRecoveryPolicy.retryDelayMs(reconnectAttempt++)
        eventReconnectJob = viewModelScope.launch {
            delay(delayMs)
            if (generation != eventStreamGeneration || !_uiState.value.sessionActive) return@launch
            val catchUp = runCatching {
                apiClient.fetchLiveCallEvents(sessionId, after = lastEventCursor, limit = MAX_EVENTS)
            }
            if (catchUp.isFailure) {
                _uiState.update { it.copy(errorText = strings.liveCallReconnectFailed(catchUp.exceptionOrNull()?.message.orEmpty())) }
                eventReconnectJob = null
                scheduleEventReconnect(apiClient, sessionId, generation)
                return@launch
            }
            applyEvents(catchUp.getOrDefault(emptyList()))
            reconnectAttempt = 0
            _uiState.update { it.copy(errorText = "", statusText = strings.liveCallEventsRecovered) }
            eventReconnectJob = null
            subscribeEvents(apiClient, sessionId, lastEventCursor, generation)
        }
    }

    private fun cancelEventStream() {
        eventStreamGeneration += 1
        eventReconnectJob?.cancel()
        eventReconnectJob = null
        val previous = eventSource
        eventSource = null
        previous?.cancel()
        reconnectAttempt = 0
    }

    private fun applyEvents(events: List<LiveCallEvent>) {
        for (event in events) applyEvent(event)
    }

    private fun applyEvent(event: LiveCallEvent) {
        lastEventCursor = EventStreamRecoveryPolicy.nextCursor(lastEventCursor, event.cursor)
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
        return LiveCallQaReducer.reduce(current, event, MAX_QA_PAIRS)
    }

    private fun statusFromEvent(current: String, event: LiveCallEvent): String = when (event.type) {
        "live_call.started" -> strings.liveCallStarted
        "live_call.audio_stream.connected" -> strings.audioStreamConnected
        "live_call.audio_stream.disconnected" -> strings.audioStreamDisconnected
        "live_call.asr.provider" -> strings.asrProviderSelected
        "live_call.audio_segment" -> strings.audioSegmentReady
        "live_call.audio_checkpoint.recovered" -> strings.asrCheckpointRecovered
        "live_call.transcript.partial" -> strings.listening
        "live_call.transcript.final" -> strings.transcriptReceived
        "live_call.question.detected" -> strings.questionDetected
        "live_call.agent.thinking" -> strings.assistantThinking
        "live_call.agent.delta" -> strings.assistantAnswering
        "live_call.agent.done" -> strings.assistantAnswerReady
        "live_call.stopped" -> strings.liveCallSessionStatus("stopped")
        else -> current
    }

    override fun onCleared() {
        cancelEventStream()
        stopAudio()
        super.onCleared()
    }

    companion object {
        private const val MAX_EVENTS = 300
        private const val MAX_QA_PAIRS = 20

        private fun statusFromSession(session: Session, strings: AppStrings): String {
            return when (session.status) {
                "stopped" -> strings.liveCallSessionStatus("stopped")
                "ready", "active" -> strings.liveCallReady(session.id)
                else -> session.status.ifBlank { strings.ready }
            }
        }

        private fun eventKey(event: LiveCallEvent): String {
            return event.id.ifBlank { "${event.cursor}:${event.type}:${event.text.hashCode()}:${event.taskId}" }
        }
    }
}
