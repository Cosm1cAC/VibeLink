package com.vibelink.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ApiException
import com.vibelink.app.network.ApprovalDecisionResponse
import com.vibelink.app.network.ChatMessage
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.DesktopRemoteState
import com.vibelink.app.network.DesktopRemoteTarget
import com.vibelink.app.network.DesktopTranscriptEntry
import com.vibelink.app.network.DesktopFocusResponse
import com.vibelink.app.network.ProviderRegistryResponse
import com.vibelink.app.network.TaskDetail
import com.vibelink.app.network.TaskCreateResponse
import com.vibelink.app.network.TaskEvent
import com.vibelink.app.network.ToolCallSummary
import com.vibelink.app.network.ToolEvent
import com.vibelink.app.network.ToolOutputEvent
import com.vibelink.app.network.ThreadPatch
import com.vibelink.app.network.TaskChangesResponse
import com.vibelink.app.mobile.EventStreamRecoveryPolicy
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener

data class PendingApprovalState(
    val approvalId: String,
    val message: String,
)

private fun messageOperationKey(message: ChatMessage): String = when {
    message.turnId.isNotBlank() -> "turn:${message.turnId}"
    message.id.isNotBlank() -> "id:${message.id}"
    else -> "text:${message.role}:${message.text.trim()}"
}

class MessageListViewModel : ViewModel() {
    private var resiliencePaused = false

    private val gson = Gson()

    private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
    val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow("")
    val error: StateFlow<String> = _error.asStateFlow()

    private val _title = MutableStateFlow("")
    val title: StateFlow<String> = _title.asStateFlow()

    private val _running = MutableStateFlow(false)
    val running: StateFlow<Boolean> = _running.asStateFlow()

    private val _sending = MutableStateFlow(false)
    val sending: StateFlow<Boolean> = _sending.asStateFlow()

    private val _currentTaskId = MutableStateFlow("")
    val currentTaskId: StateFlow<String> = _currentTaskId.asStateFlow()

    private val _remoteReady = MutableStateFlow(false)
    val remoteReady: StateFlow<Boolean> = _remoteReady.asStateFlow()

    private val _remoteStatus = MutableStateFlow("")
    val remoteStatus: StateFlow<String> = _remoteStatus.asStateFlow()

    private val _providerRegistry = MutableStateFlow(ProviderRegistryResponse())
    val providerRegistry: StateFlow<ProviderRegistryResponse> = _providerRegistry.asStateFlow()

    private val _pendingApproval = MutableStateFlow<PendingApprovalState?>(null)
    val pendingApproval: StateFlow<PendingApprovalState?> = _pendingApproval.asStateFlow()
    private val _taskChanges = MutableStateFlow<TaskChangesResponse?>(null)
    val taskChanges: StateFlow<TaskChangesResponse?> = _taskChanges.asStateFlow()

    private var taskEventSource: EventSource? = null
    private var toolEventSource: EventSource? = null
    private var pollJob: Job? = null
    private var taskReconnectJob: Job? = null
    private var toolReconnectJob: Job? = null
    private var streamGeneration = 0L
    private var taskCursor = 0
    private var toolCursor = 0
    private var taskReconnectAttempt = 0
    private var toolReconnectAttempt = 0
    private var loadSequence = 0L
    private var activeConversation: ConversationItem? = null
    private var persistenceApiClient: ApiClient? = null
    private val seenTaskEvents = mutableSetOf<String>()
    private val seenToolEvents = mutableSetOf<String>()
    private val toolEventsByRun = linkedMapOf<String, MutableList<ToolEvent>>()
    private val eventAckCursors = mutableMapOf<String, Int>()

    private fun acknowledgeConsumedEvent(apiClient: ApiClient, streamId: String, cursor: Int, eventId: String = "") {
        if (streamId.isBlank() || cursor <= (eventAckCursors[streamId] ?: 0)) return
        viewModelScope.launch {
            var expected = eventAckCursors[streamId] ?: 0
            runCatching { apiClient.acknowledgeEvent(streamId, cursor, expected, eventId) }
                .recoverCatching { error ->
                    if (error !is ApiException || error.statusCode != 409) throw error
                    expected = runCatching {
                        JsonParser.parseString(error.body).asJsonObject.getAsJsonObject("current")?.get("cursor")?.asInt ?: 0
                    }.getOrDefault(0)
                    eventAckCursors[streamId] = expected
                    if (cursor <= expected) null else apiClient.acknowledgeEvent(streamId, cursor, expected, eventId)
                }
                .onSuccess { ack -> eventAckCursors[streamId] = ack?.cursor ?: maxOf(expected, cursor) }
        }
    }

    fun loadConversation(apiClient: ApiClient, conversation: ConversationItem) {
        stopStreaming()
        persistenceApiClient = apiClient
        activeConversation = conversation
        loadSequence += 1
        val seq = loadSequence
        seenTaskEvents.clear()
        seenToolEvents.clear()
        toolEventsByRun.clear()
        taskCursor = 0
        toolCursor = 0

        viewModelScope.launch {
            _loading.value = true
            _error.value = ""
            _running.value = false
            _sending.value = false
            _currentTaskId.value = if (conversation.kind == "task") conversation.id else ""
            _pendingApproval.value = null
            _taskChanges.value = null
            _remoteReady.value = false
            _remoteStatus.value = ""
            _title.value = conversation.title.ifBlank { titleForKind(conversation.kind) }

            try {
                loadProviderRegistry(apiClient)
                when (conversation.kind) {
                    "new" -> {
                        _messages.value = emptyList()
                    }
                    "desktop" -> loadDesktopRemote(apiClient, seq, fresh = true)
                    "task" -> loadTask(apiClient, conversation, seq)
                    "fork" -> loadFork(apiClient, conversation, seq)
                    else -> loadHistory(apiClient, conversation, seq)
                }
                if (conversation.id.isNotBlank()) _taskChanges.value = apiClient.getTaskChanges(conversation.id)
                applyPersistedMessageOverrides(apiClient, conversation.key)
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to load conversation"
            } finally {
                if (seq == loadSequence) _loading.value = false
            }
        }
    }

    fun ensureConversationLoaded(apiClient: ApiClient, conversation: ConversationItem) {
        if (activeConversation?.key == conversation.key) return
        loadConversation(apiClient, conversation)
    }

    fun refresh(apiClient: ApiClient) {
        val conversation = activeConversation ?: return
        loadConversation(apiClient, conversation)
    }

    fun setResiliencePaused(paused: Boolean) {
        if (resiliencePaused == paused) return
        resiliencePaused = paused
        if (paused) stopStreaming() else persistenceApiClient?.let { refresh(it) }
    }

    fun retryDesktop(apiClient: ApiClient) {
        viewModelScope.launch {
            _error.value = ""
            try {
                applyDesktopState(apiClient.retryDesktopRemote(), "Retry requested.")
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to retry Codex Remote queue"
            }
        }
    }

    fun clearDesktopQueue(apiClient: ApiClient) {
        viewModelScope.launch {
            _error.value = ""
            try {
                applyDesktopState(apiClient.clearDesktopRemote(), "Queue cleared.")
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to clear Codex Remote queue"
            }
        }
    }

    fun sendPrompt(
        apiClient: ApiClient,
        prompt: String,
        agent: String,
        model: String = "",
        reasoningEffort: String = "",
        cwd: String = "",
    ) {
        val conversation = activeConversation ?: return
        val trimmed = prompt.trim()
        if (trimmed.isBlank() || _sending.value) return
        viewModelScope.launch {
            _sending.value = true
            _error.value = ""
            _messages.value = appendDisplayMessages(_messages.value, ChatMessage(role = "user", text = trimmed))
            try {
                when {
                    conversation.kind == "desktop" -> sendDesktopRemote(apiClient, conversation, trimmed)
                    conversation.kind == "task" && _running.value && conversation.id.isNotBlank() -> {
                        val result = apiClient.sendTaskInput(conversation.id, trimmed)
                        if (!result.ok) appendError("The running CLI task did not accept live input. Wait for this turn to finish, then continue.")
                    }
                    else -> createOrResumeTask(apiClient, conversation, trimmed, agent, model, reasoningEffort, cwd)
                }
            } catch (error: ApiException) {
                val notice = TaskApprovalHandoff.noticeFromException(error)
                if (notice != null) appendApprovalNotice(notice)
                else appendError(TaskApprovalHandoff.messageFor(error))
            } catch (error: Exception) {
                appendError(error.message ?: "Failed to send prompt")
            } finally {
                _sending.value = false
            }
        }
    }

    fun applyApprovalDecision(apiClient: ApiClient, response: ApprovalDecisionResponse): Boolean {
        val approval = response.approval ?: return false
        val pending = _pendingApproval.value ?: return false
        if (pending.approvalId != approval.id) return false

        if (approval.status == "denied") {
            _pendingApproval.value = null
            appendSystem("Approval ${approval.id.take(8)} was denied.")
            return true
        }

        val handoff = TaskApprovalHandoff.approvedTaskFrom(response)
        if (handoff == null) {
            if (response.error.isNotBlank()) appendError(response.error)
            return true
        }

        val conversation = activeConversation ?: return true
        _pendingApproval.value = null
        _error.value = ""
        _messages.value = _messages.value.filterNot { message ->
            message.role == "error" && message.text.contains(approval.id)
        }
        _currentTaskId.value = handoff.id
        _running.value = handoff.status == "running"
        activeConversation = conversation.copy(
            kind = "task",
            id = handoff.id,
            provider = handoff.agent.ifBlank { conversation.provider.ifBlank { "codex" } },
            title = handoff.title.ifBlank { conversation.title },
            cwd = handoff.cwd.ifBlank { conversation.cwd },
            status = handoff.status,
            sessionId = handoff.sessionId,
        )
        appendSystem("Task ${handoff.id.take(8)} started after approval.")

        viewModelScope.launch {
            runCatching { apiClient.getTask(handoff.id) }
                .onSuccess { task ->
                    _currentTaskId.value = task.id
                    _running.value = task.status == "running"
                    appendTaskEvents(task.events)
                    if (task.status == "running") {
                        followRunningTask(apiClient, task)
                        followToolEvents(apiClient, task.id)
                    }
                }
                .onFailure { error -> appendError(error.message ?: "Failed to load approved task") }
        }
        return true
    }

    fun editMessage(target: ChatMessage, nextText: String) {
        val trimmed = nextText.trim()
        _messages.value = editFirstMatchingMessage(_messages.value, target, trimmed)
        persistMessageOverride(target, deleted = false, text = trimmed)
    }

    fun deleteMessage(target: ChatMessage) {
        _messages.value = deleteFirstMatchingMessage(_messages.value, target)
        persistMessageOverride(target, deleted = true)
    }

    fun regenerateMessage(
        apiClient: ApiClient,
        target: ChatMessage,
        agent: String,
        model: String = "",
        reasoningEffort: String = "",
        cwd: String = "",
    ) {
        val prompt = previousUserPromptForRegeneration(_messages.value, target)
        if (prompt.isBlank()) {
            appendError("No earlier user message is available to regenerate from.")
            return
        }
        _messages.value = deleteFirstMatchingMessage(_messages.value, target)
        persistMessageOverride(target, deleted = true)
        sendPrompt(apiClient, prompt, agent, model, reasoningEffort, cwd)
    }

    private fun persistMessageOverride(target: ChatMessage, deleted: Boolean, text: String = "") {
        val key = activeConversation?.key ?: return
        val messageKey = messageOperationKey(target)
        viewModelScope.launch {
            runCatching {
                val client = persistenceApiClient ?: return@runCatching
                val current = client.getThreadState().items[key]?.messageOverrides.orEmpty()
                val next = current.filterNot { item -> (item as? Map<*, *>)?.get("key")?.toString() == messageKey } +
                    mapOf("key" to messageKey, "deleted" to deleted, "text" to text)
                client.patchThread(key, ThreadPatch(meta = mapOf("messageOverrides" to next)))
            }
        }
    }

    private suspend fun applyPersistedMessageOverrides(apiClient: ApiClient, key: String) {
        val overrides = apiClient.getThreadState().items[key]?.messageOverrides.orEmpty()
        val byKey = overrides.mapNotNull { item ->
            (item as? Map<*, *>)?.let { map ->
                val messageKey = map["key"]?.toString().orEmpty()
                if (messageKey.isBlank()) null else messageKey to map
            }
        }.toMap()
        _messages.value = _messages.value.flatMap { message ->
            val override = byKey[messageOperationKey(message)] ?: return@flatMap listOf(message)
            if (override["deleted"] == true || override["deleted"]?.toString() == "true") emptyList()
            else listOf(message.copy(text = override["text"]?.toString().orEmpty(), streaming = false))
        }
    }

    fun stopCurrentTask(apiClient: ApiClient) {
        val taskId = _currentTaskId.value.ifBlank { activeConversation?.id.orEmpty() }
        if (taskId.isBlank()) return
        viewModelScope.launch {
            _error.value = ""
            try {
                apiClient.stopTask(taskId)
                _running.value = false
                appendSystem("Stop requested.")
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to stop task"
            }
        }
    }

    fun followToolEvents(apiClient: ApiClient, taskId: String) {
        if (taskId.isBlank()) return
        subscribeToolEvents(apiClient, taskId, streamGeneration)
    }

    private fun subscribeToolEvents(apiClient: ApiClient, taskId: String, generation: Long) {
        if (generation != streamGeneration) return
        val previous = toolEventSource
        toolEventSource = null
        previous?.cancel()
        toolEventSource = apiClient.subscribeToolEvents(
            taskId = taskId,
            after = toolCursor,
            listener = object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    if (eventSource !== this@MessageListViewModel.toolEventSource) return
                    runCatching {
                        val event = gson.fromJson(data, ToolEvent::class.java)
                        toolReconnectAttempt = 0
                        appendToolEvent(event)
                    }
                }

                override fun onClosed(eventSource: EventSource) {
                    if (eventSource !== this@MessageListViewModel.toolEventSource) return
                    scheduleToolReconnect(apiClient, taskId, generation)
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: okhttp3.Response?) {
                    if (eventSource !== this@MessageListViewModel.toolEventSource) return
                    scheduleToolReconnect(apiClient, taskId, generation)
                }
            },
        )
    }

    private fun scheduleToolReconnect(apiClient: ApiClient, taskId: String, generation: Long) {
        if (generation != streamGeneration || !_running.value || toolReconnectJob?.isActive == true) return
        val delayMs = EventStreamRecoveryPolicy.retryDelayMs(toolReconnectAttempt++)
        toolReconnectJob = viewModelScope.launch {
            delay(delayMs)
            if (generation != streamGeneration || !_running.value) return@launch
            runCatching { apiClient.fetchToolEvents(taskId = taskId, after = toolCursor) }
                .onSuccess { events -> events.forEach(::appendToolEvent) }
            toolReconnectJob = null
            subscribeToolEvents(apiClient, taskId, generation)
        }
    }

    fun stopStreaming() {
        streamGeneration += 1
        val previousTaskSource = taskEventSource
        taskEventSource = null
        previousTaskSource?.cancel()
        val previousToolSource = toolEventSource
        toolEventSource = null
        previousToolSource?.cancel()
        pollJob?.cancel()
        pollJob = null
        taskReconnectJob?.cancel()
        taskReconnectJob = null
        toolReconnectJob?.cancel()
        toolReconnectJob = null
        taskReconnectAttempt = 0
        toolReconnectAttempt = 0
    }

    private suspend fun loadProviderRegistry(apiClient: ApiClient) {
        runCatching { apiClient.getProviderRegistry() }
            .onSuccess { registry -> _providerRegistry.value = registry }
    }

    override fun onCleared() {
        stopStreaming()
        super.onCleared()
    }

    private suspend fun loadTask(apiClient: ApiClient, conversation: ConversationItem, seq: Long) {
        val task = apiClient.getTask(conversation.id)
        if (seq != loadSequence) return
        val historyMessages = if (task.sessionId.isNotBlank()) {
            loadHistoryMessages(apiClient, task.agent.ifBlank { conversation.provider }, task.sessionId)
        } else {
            emptyList()
        }
        seenTaskEvents.addAll(task.events.map(::taskEventKey))
        val taskMessages = if (historyMessages.isEmpty() || task.status == "running") messagesFromEvents(task.events) else emptyList()
        _messages.value = mergeMessages(historyMessages, taskMessages).ifEmpty {
            listOf(ChatMessage(role = "system", text = "Task started. Waiting for output."))
        }
        _currentTaskId.value = task.id
        _running.value = task.status == "running"
        if (task.status == "running") {
            followRunningTask(apiClient, task)
            followToolEvents(apiClient, task.id)
        }
    }

    private suspend fun loadHistory(apiClient: ApiClient, conversation: ConversationItem, seq: Long) {
        val detail = apiClient.getHistoryDetail(conversation.provider, conversation.sessionId.ifBlank { conversation.id })
        if (seq != loadSequence) return
        _messages.value = messagesFromTranscript(detail.transcript)
            .ifEmpty { messagesFromHistoryEntries(detail.entries) }
            .ifEmpty { listOf(ChatMessage(role = "system", text = "No messages in this history.")) }
        _currentTaskId.value = detail.toolTaskId
        _running.value = false
    }

    private suspend fun loadFork(apiClient: ApiClient, conversation: ConversationItem, seq: Long) {
        val sourceId = conversation.sourceId.ifBlank { conversation.sessionId }
        val historyMessages = loadHistoryMessages(apiClient, conversation.provider, sourceId)
        if (seq != loadSequence) return
        _messages.value = historyMessages.ifEmpty {
            listOf(ChatMessage(role = "system", text = "Fork created. The next message will continue from the source context."))
        }
        _running.value = false
    }

    private suspend fun loadDesktopRemote(apiClient: ApiClient, seq: Long, fresh: Boolean) {
        val state = apiClient.getDesktopRemoteStatus(fresh = fresh)
        if (seq != loadSequence) return
        applyDesktopState(state)
    }

    private fun applyDesktopState(state: DesktopRemoteState, notice: String = "") {
        val desktop = state.desktop
        _remoteReady.value = desktop?.ready == true
        _running.value = state.active || state.pendingCount > 0 || desktop?.sidebarHasRunning == true
        _remoteStatus.value = when {
            desktop?.ready == true -> "Codex Desktop ready"
            desktop?.found == true -> desktop.reason.ifBlank { "Codex window found" }
            else -> desktop?.reason?.ifBlank { "Codex Desktop not connected" } ?: "Codex Desktop not connected"
        }
        _title.value = desktop?.windowTitle?.ifBlank { _title.value } ?: _title.value.ifBlank { "Codex Desktop Remote" }
        val transcriptMessages = messagesFromDesktopTranscript(desktop?.visibleTranscript.orEmpty())
        val queueMessages = state.items.takeLast(6).map { item ->
            val suffix = if (item.error.isNotBlank()) ": ${item.error}" else ""
            ChatMessage(role = "system", text = "Remote queue ${item.status}$suffix")
        }
        val statusMessage = ChatMessage(role = "system", text = notice.ifBlank { _remoteStatus.value })
        _messages.value = (transcriptMessages + queueMessages).ifEmpty { listOf(statusMessage) }
    }

    private suspend fun createOrResumeTask(
        apiClient: ApiClient,
        conversation: ConversationItem,
        prompt: String,
        agent: String,
        model: String,
        reasoningEffort: String,
        cwdOverride: String,
    ) {
        val resumeSessionId = when (conversation.kind) {
            "history" -> conversation.sessionId.ifBlank { conversation.id }
            "fork" -> conversation.sourceId.ifBlank { conversation.sessionId }
            "task" -> conversation.sessionId
            else -> ""
        }
        val mode = if (resumeSessionId.isNotBlank()) "resume" else "new"
        val resolvedAgent = agent.ifBlank { conversation.provider.ifBlank { "codex" } }
        val resolvedCwd = cwdOverride.ifBlank { conversation.cwd }
        val response = apiClient.createTask(
            prompt = prompt,
            cwd = resolvedCwd,
            agent = resolvedAgent,
            model = model.trim(),
            title = conversation.title.ifBlank { prompt.take(80) },
            mode = mode,
            sessionId = resumeSessionId,
            reasoningEffort = reasoningEffort.trim(),
        )
        TaskApprovalHandoff.noticeFromResponse(response)?.let { notice ->
            appendApprovalNotice(notice)
            return
        }
        if (response.id.isBlank()) {
            appendError(response.error.ifBlank { "Task was created but no task id was returned." })
            return
        }
        _pendingApproval.value = null
        _currentTaskId.value = response.id
        _running.value = true
        val nextConversation = conversation.copy(
            kind = "task",
            id = response.id,
            provider = agent.ifBlank { conversation.provider.ifBlank { "codex" } },
            status = response.status.ifBlank { "running" },
            sessionId = resumeSessionId,
            title = conversation.title.ifBlank { prompt.take(80) },
        )
        activeConversation = nextConversation
        appendSystem("Task ${response.id.take(8)} started.")
        runCatching {
            val task = apiClient.getTask(response.id)
            _currentTaskId.value = task.id
            _running.value = task.status == "running"
            appendTaskEvents(task.events)
            if (task.status == "running") {
                followRunningTask(apiClient, task)
                followToolEvents(apiClient, task.id)
            }
        }
    }

    private suspend fun sendDesktopRemote(apiClient: ApiClient, conversation: ConversationItem, prompt: String) {
        val target = if (conversation.desktopIndex != null) {
            DesktopRemoteTarget(
                desktopIndex = conversation.desktopIndex,
                desktopTitle = conversation.desktopTitle,
            )
        } else {
            null
        }
        if (target != null) {
            val focusResult = runCatching { apiClient.focusDesktopConversation(target.desktopIndex ?: 0) }
            val validation = DesktopRemoteSendPolicy.validateFocus(
                target = target,
                response = focusResult.getOrNull(),
                failure = focusResult.exceptionOrNull(),
            )
            if (!validation.canSend) {
                appendError(validation.message)
                return
            }
        }
        val result = apiClient.sendDesktopRemoteMessage(prompt, target)
        if (result.state != null) {
            applyDesktopState(result.state, "Sent to Codex Desktop.")
        } else {
            appendSystem("Queued for Codex Desktop.")
        }
    }

    private fun followRunningTask(apiClient: ApiClient, task: TaskDetail) {
        val generation = streamGeneration
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (true) {
                delay(1800)
                try {
                    val latest = apiClient.getTask(task.id)
                    appendTaskEvents(latest.events)
                    _running.value = latest.status == "running"
                    if (latest.status != "running") {
                        stopStreaming()
                        break
                    }
                } catch (_: Exception) {
                    // SSE remains the primary channel. Polling failures are surfaced on explicit refresh.
                }
            }
        }

        taskCursor = EventStreamRecoveryPolicy.nextCursor(taskCursor, task.events.maxOfOrNull { it.cursor } ?: 0)
        subscribeTaskEvents(apiClient, task.id, generation)
    }

    private fun subscribeTaskEvents(apiClient: ApiClient, taskId: String, generation: Long) {
        if (generation != streamGeneration || !_running.value) return
        val previous = taskEventSource
        taskEventSource = null
        previous?.cancel()
        taskEventSource = apiClient.subscribeTaskEvents(taskId, after = taskCursor, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                if (eventSource !== this@MessageListViewModel.taskEventSource) return
                runCatching {
                    val event = gson.fromJson(data, TaskEvent::class.java)
                    taskReconnectAttempt = 0
                    appendTaskEvents(listOf(event))
                    if (event.type == "system" && event.text.contains("Exited")) {
                        _running.value = false
                        stopStreaming()
                    }
                }
            }

            override fun onClosed(eventSource: EventSource) {
                if (eventSource !== this@MessageListViewModel.taskEventSource) return
                scheduleTaskReconnect(apiClient, taskId, generation)
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: okhttp3.Response?) {
                if (eventSource !== this@MessageListViewModel.taskEventSource) return
                scheduleTaskReconnect(apiClient, taskId, generation)
            }
        })
    }

    private fun scheduleTaskReconnect(apiClient: ApiClient, taskId: String, generation: Long) {
        if (generation != streamGeneration || !_running.value || taskReconnectJob?.isActive == true) return
        val delayMs = EventStreamRecoveryPolicy.retryDelayMs(taskReconnectAttempt++)
        taskReconnectJob = viewModelScope.launch {
            delay(delayMs)
            if (generation != streamGeneration || !_running.value) return@launch
            taskReconnectJob = null
            subscribeTaskEvents(apiClient, taskId, generation)
        }
    }

    private suspend fun loadHistoryMessages(apiClient: ApiClient, provider: String, sessionId: String): List<ChatMessage> {
        if (provider.isBlank() || sessionId.isBlank()) return emptyList()
        return try {
            val detail = apiClient.getHistoryDetail(provider, sessionId)
            messagesFromTranscript(detail.transcript).ifEmpty { messagesFromHistoryEntries(detail.entries) }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun appendTaskEvents(events: List<TaskEvent>) {
        events.forEach { event -> taskCursor = EventStreamRecoveryPolicy.nextCursor(taskCursor, event.cursor) }
        val fresh = events.filter { seenTaskEvents.add(taskEventKey(it)) }
        val newMessages = messagesFromEvents(fresh)
        if (newMessages.isNotEmpty()) _messages.value = mergeMessages(_messages.value, newMessages)
        val taskId = _currentTaskId.value.ifBlank { activeConversation?.id.orEmpty() }
        events.maxByOrNull { it.cursor }?.takeIf { taskId.isNotBlank() }?.let { event ->
            persistenceApiClient?.let { acknowledgeConsumedEvent(it, "task:$taskId", taskCursor, event.id) }
        }
    }

    private fun appendToolEvent(event: ToolEvent) {
        toolCursor = EventStreamRecoveryPolicy.nextCursor(toolCursor, event.cursor)
        if (!seenToolEvents.add(toolEventKey(event))) return
        val runId = event.toolRunId.ifBlank { (event.payload.orEmpty()["toolRunId"] as? String).orEmpty() }.ifBlank { event.id }
        if (runId.isBlank()) return
        val events = toolEventsByRun.getOrPut(runId) { mutableListOf() }
        events.add(event)
        events.sortBy { it.cursor }
        persistenceApiClient?.let { acknowledgeConsumedEvent(it, "tool-event:$runId", event.cursor, event.id) }
        renderToolEvents()
    }

    private fun renderToolEvents() {
        val toolCalls = toolEventsByRun.map { (runId, events) ->
            toolCallFromEvents(runId, events)
        }.sortedBy { it.cursor }
        if (toolCalls.isEmpty()) return
        _messages.value = attachToolCallsToActiveAssistant(_messages.value, toolCalls)
    }

    private fun appendSystem(text: String) {
        if (text.isBlank()) return
        _messages.value = appendDisplayMessages(_messages.value, ChatMessage(role = "system", text = text))
    }

    private fun appendError(text: String) {
        if (text.isBlank()) return
        _messages.value = appendDisplayMessages(_messages.value, ChatMessage(role = "error", text = text))
        _error.value = text
    }

    private fun appendApprovalNotice(notice: ApprovalNotice) {
        _pendingApproval.value = PendingApprovalState(notice.approvalId, notice.message)
        appendError(notice.message)
    }

    companion object {
        fun messagesFromEvents(events: List<TaskEvent>): List<ChatMessage> {
            return events.mapNotNull { event ->
                val role = taskEventRole(event)
                val rawText = event.text
                val text = if (role == "assistant") rawText else rawText.trim()
                if (text.isBlank() || role == "debug") return@mapNotNull null
                ChatMessage(
                    role = role,
                    text = text,
                    id = event.id.ifBlank { "event:${event.cursor}:${event.type}" },
                    turnId = event.id.ifBlank { "event:${event.cursor}" },
                    streaming = role == "assistant",
                )
            }
        }

        fun messagesFromDesktopTranscript(entries: List<DesktopTranscriptEntry>): List<ChatMessage> {
            return entries.mapNotNull { entry ->
                val text = entry.text.trim()
                if (text.isBlank()) return@mapNotNull null
                ChatMessage(role = normalizeRole(entry.role), text = text)
            }
        }

        fun messagesFromTranscript(transcript: List<com.vibelink.app.network.TranscriptEntry>): List<ChatMessage> {
            return transcript.mapNotNull { entry ->
                val text = entry.text.trim()
                if (text.isBlank()) return@mapNotNull null
                ChatMessage(
                    role = normalizeRole(entry.role),
                    text = text,
                    turnId = entry.turnId,
                )
            }
        }

        fun messagesFromHistoryEntries(entries: List<Map<String, Any?>>): List<ChatMessage> {
            return entries.mapNotNull { entry ->
                val role = entry["role"] as? String ?: return@mapNotNull null
                val text = entry["text"] as? String ?: return@mapNotNull null
                if (text.isBlank()) return@mapNotNull null
                ChatMessage(role = normalizeRole(role), text = text)
            }
        }

        fun mergeMessages(current: List<ChatMessage>, incoming: List<ChatMessage>): List<ChatMessage> {
            if (incoming.isEmpty()) return current
            val merged = current.toMutableList()
            for (message in incoming) {
                val last = merged.lastOrNull()
                if (last != null && canMergeAssistantText(last, message)) {
                    merged[merged.lastIndex] = last.copy(
                        text = listOf(last.text, message.text).filter { it.isNotBlank() }.joinToString(""),
                        streaming = last.streaming || message.streaming,
                        turnId = last.turnId.ifBlank { message.turnId },
                        taskId = last.taskId.ifBlank { message.taskId },
                    )
                } else {
                    merged += message
                }
            }
            return merged
        }

        fun attachToolCallsToActiveAssistant(current: List<ChatMessage>, toolCalls: List<ToolCallSummary>): List<ChatMessage> {
            if (toolCalls.isEmpty()) return current
            val withoutPreviousToolSync = current.filterNot { it.text.isBlank() && it.toolCalls.isNotEmpty() }
            val targetIndex = withoutPreviousToolSync.indexOfLast { message ->
                message.role == "assistant" && (message.text.isNotBlank() || message.streaming || message.toolCalls.isNotEmpty())
            }
            if (targetIndex < 0) {
                return withoutPreviousToolSync + ChatMessage(
                    role = "assistant",
                    id = "tools:${toolCalls.joinToString(",") { it.id }}",
                    toolCalls = toolCalls,
                    toolCallCount = toolCalls.size,
                )
            }
            return withoutPreviousToolSync.mapIndexed { index, message ->
                if (index != targetIndex) message else {
                    val mergedCalls = mergeToolCalls(message.toolCalls, toolCalls)
                    message.copy(toolCalls = mergedCalls, toolCallCount = mergedCalls.size)
                }
            }
        }

        fun appendDisplayMessages(current: List<ChatMessage>, message: ChatMessage): List<ChatMessage> {
            val seed = current.filterNot {
                it.role == "system" &&
                    (it.text.startsWith("Start a VibeLink Agent task") || it.text == "No messages in this history.")
            }
            return seed + message
        }

        fun editFirstMatchingMessage(current: List<ChatMessage>, target: ChatMessage, nextText: String): List<ChatMessage> {
            val trimmed = nextText.trim()
            if (trimmed.isBlank()) return current
            var edited = false
            return current.map { message ->
                if (edited || !sameMessageForOperation(message, target)) message else {
                    edited = true
                    message.copy(text = trimmed, streaming = false)
                }
            }
        }

        fun deleteFirstMatchingMessage(current: List<ChatMessage>, target: ChatMessage): List<ChatMessage> {
            var deleted = false
            return current.filter { message ->
                if (deleted || !sameMessageForOperation(message, target)) true else {
                    deleted = true
                    false
                }
            }
        }

        fun previousUserPromptForRegeneration(current: List<ChatMessage>, target: ChatMessage): String {
            val targetIndex = current.indexOfFirst { sameMessageForOperation(it, target) }
            val earlier = if (targetIndex >= 0) current.take(targetIndex) else current
            return earlier.asReversed()
                .firstOrNull { it.role == "user" && it.text.isNotBlank() }
                ?.text
                ?.trim()
                .orEmpty()
        }

        private fun canMergeAssistantText(previous: ChatMessage, next: ChatMessage): Boolean {
            return previous.role == "assistant" &&
                next.role == "assistant" &&
                previous.toolCalls.isEmpty() &&
                next.toolCalls.isEmpty() &&
                previous.text.isNotBlank() &&
                next.text.isNotBlank()
        }

        private fun sameMessageForOperation(message: ChatMessage, target: ChatMessage): Boolean {
            if (message.role != target.role) return false
            if (message.turnId.isNotBlank() && target.turnId.isNotBlank()) return message.turnId == target.turnId
            if (message.id.isNotBlank() && target.id.isNotBlank()) return message.id == target.id
            return normalizeMessageText(message.text) == normalizeMessageText(target.text)
        }

        private fun normalizeMessageText(text: String): String {
            return text.trim().replace(Regex("\\s+"), " ")
        }

        private fun mergeToolCalls(existing: List<ToolCallSummary>, incoming: List<ToolCallSummary>): List<ToolCallSummary> {
            val byId = linkedMapOf<String, ToolCallSummary>()
            (existing + incoming).forEachIndexed { index, tool ->
                val key = tool.id.ifBlank { "tool:$index:${tool.name}:${tool.cursor}" }
                byId[key] = tool
            }
            return byId.values.sortedBy { it.cursor }
        }

        fun toolCallFromEvents(runId: String, events: List<ToolEvent>): ToolCallSummary {
            val sorted = events.sortedBy { it.cursor }
            val created = sorted.firstOrNull { it.type == "tool.created" } ?: sorted.firstOrNull()
            val started = sorted.firstOrNull { it.type == "tool.started" }
            val terminal = sorted.lastOrNull {
                it.type == "tool.completed" ||
                    it.type == "tool.failed" ||
                    it.type == "tool.error" ||
                    it.type == "tool.cancelled"
            }
            val approval = sorted.firstOrNull { it.type == "approval.required" }
            val createdPayload = created?.payload.orEmpty()
            val startedPayload = started?.payload.orEmpty()
            val name = (createdPayload["toolName"] as? String)
                ?: (createdPayload["name"] as? String)
                ?: (created?.type?.takeIf { it.isNotBlank() })
                ?: runId.ifBlank { "tool" }
            val input = (createdPayload["input"] as? Map<String, Any?>)
                ?: (startedPayload["input"] as? Map<String, Any?>)
                ?: createdPayload.ifEmpty { startedPayload }
            val outputEvents = sorted
                .filter { it.type == "tool.output" }
                .map { event ->
                    val payload = event.payload.orEmpty()
                    ToolOutputEvent(
                        cursor = event.cursor,
                        stream = (payload["stream"] as? String).orEmpty().ifBlank { "stdout" },
                        text = (payload["text"] as? String).orEmpty().ifBlank { event.text },
                    )
                }
            val output = outputEvents.joinToString(separator = "") { it.text }.ifBlank {
                val result = terminal?.payload.orEmpty()["result"]
                when (result) {
                    is String -> result
                    is Map<*, *> -> result["stdout"] as? String ?: result["stderr"] as? String ?: result.toString()
                    null -> terminal?.text.orEmpty()
                    else -> result.toString()
                }
            }
            val kind = (createdPayload["kind"] as? String)
                ?: (input["kind"] as? String)
                ?: when {
                    name.contains("git", ignoreCase = true) -> "git"
                    name.contains("command", ignoreCase = true) || name.contains("test", ignoreCase = true) -> "shell"
                    else -> "tool"
                }

            return ToolCallSummary(
                id = runId,
                name = name,
                label = (createdPayload["label"] as? String).orEmpty().ifBlank { name },
                kind = kind,
                status = toolEventStatus(sorted),
                input = input,
                output = output,
                outputEvents = outputEvents,
                permission = (createdPayload["permission"] as? String).orEmpty(),
                risk = (createdPayload["risk"] as? String).orEmpty(),
                description = (createdPayload["description"] as? String).orEmpty(),
                cursor = sorted.maxOfOrNull { it.cursor } ?: 0,
                approvalRequired = approval != null,
            )
        }

        private fun toolEventStatus(events: List<ToolEvent>): String {
            val types = events.map { it.type }
            return when {
                types.any { it == "tool.failed" || it == "tool.error" || it == "approval.denied" } -> "failed"
                types.any { it == "approval.expired" } -> "expired"
                types.any { it == "tool.cancelled" } -> "cancelled"
                types.any { it == "tool.cancel_requested" } -> "cancelling"
                types.any { it == "tool.completed" } -> "done"
                types.any { it == "approval.required" } -> "approval_required"
                types.any { it == "tool.started" || it == "tool.output" } -> "running"
                else -> "queued"
            }
        }

        private fun normalizeRole(role: String): String = when (role.lowercase()) {
            "user", "human" -> "user"
            "assistant", "agent", "model" -> "assistant"
            "error" -> "error"
            else -> "system"
        }

        private fun taskEventRole(event: TaskEvent): String {
            return when (event.type) {
                "stdin" -> "user"
                "error" -> "error"
                "stderr" -> {
                    val text = event.text
                    if (text.contains("ERROR", ignoreCase = true) ||
                        text.contains("error:", ignoreCase = true) ||
                        text.contains("spawn") ||
                        text.contains("ENOENT") ||
                        text.contains("EPERM") ||
                        text.contains("EACCES") ||
                        text.contains("permission denied", ignoreCase = true)
                    ) "error" else "debug"
                }
                "system" -> "system"
                "json", "stdout" -> "assistant"
                else -> "system"
            }
        }

        private fun taskEventKey(event: TaskEvent): String {
            return event.id.ifBlank { "${event.cursor}:${event.type}:${event.text.hashCode()}" }
        }

        private fun toolEventKey(event: ToolEvent): String {
            return event.id.ifBlank { "${event.cursor}:${event.type}:${event.toolRunId}:${event.text.hashCode()}" }
        }

        private fun titleForKind(kind: String): String = when (kind) {
            "new" -> "New VibeLink Agent task"
            "desktop" -> "Codex Desktop Remote"
            "fork" -> "Forked chat"
            else -> "Chat"
        }

    }
}

data class ApprovalNotice(
    val approvalId: String,
    val message: String,
)

data class ApprovedTaskHandoff(
    val id: String,
    val status: String,
    val agent: String,
    val title: String,
    val cwd: String,
    val sessionId: String,
)

object TaskApprovalHandoff {
    fun noticeFromResponse(response: TaskCreateResponse): ApprovalNotice? {
        val approvalId = response.approvalId.ifBlank { response.approval?.id.orEmpty() }
        if (approvalId.isBlank()) return null
        return ApprovalNotice(approvalId, approvalMessage(approvalId, response.error))
    }

    fun noticeFromException(error: ApiException): ApprovalNotice? {
        if (error.statusCode != 428) return null
        val json = parseObject(error.body)
        val approvalId = stringMember(json, "approvalId").ifBlank {
            stringMember(json?.getAsJsonObject("approval"), "id")
        }
        val reason = stringMember(json, "error")
        return ApprovalNotice(approvalId, approvalMessage(approvalId, reason))
    }

    fun messageFor(error: ApiException): String {
        return noticeFromException(error)?.message ?: error.body.ifBlank { "HTTP ${error.statusCode}" }
    }

    fun approvedTaskFrom(response: ApprovalDecisionResponse): ApprovedTaskHandoff? {
        val result = response.result ?: return null
        if (!response.ok || !result.ok) return null
        val task = result.task
        val id = task?.id.orEmpty().ifBlank { result.id }
        if (id.isBlank()) return null
        return ApprovedTaskHandoff(
            id = id,
            status = task?.status.orEmpty().ifBlank { result.status.ifBlank { "running" } },
            agent = task?.agent.orEmpty(),
            title = task?.title.orEmpty(),
            cwd = task?.cwd.orEmpty(),
            sessionId = task?.sessionId.orEmpty(),
        )
    }

    private fun approvalMessage(approvalId: String, reason: String): String {
        val idSuffix = if (approvalId.isBlank()) "" else " ($approvalId)"
        val reasonPrefix = reason.ifBlank { "This action needs approval." }
        return "$reasonPrefix Approval required$idSuffix. Open Settings > Approvals; approving starts this task automatically."
    }

    private fun parseObject(raw: String): JsonObject? {
        return runCatching { JsonParser.parseString(raw).asJsonObject }.getOrNull()
    }

    private fun stringMember(json: JsonObject?, key: String): String {
        return runCatching { json?.get(key)?.takeIf { !it.isJsonNull }?.asString.orEmpty() }.getOrDefault("")
    }
}

data class DesktopFocusValidation(
    val canSend: Boolean,
    val message: String = "",
)

object DesktopRemoteSendPolicy {
    fun validateFocus(
        target: DesktopRemoteTarget?,
        response: DesktopFocusResponse?,
        failure: Throwable? = null,
    ): DesktopFocusValidation {
        if (target == null) return DesktopFocusValidation(canSend = true)
        if (failure != null) {
            return DesktopFocusValidation(
                canSend = false,
                message = "Blocked send: unable to confirm Codex Desktop conversation ${targetLabel(target)}. ${failure.message.orEmpty()}".trim(),
            )
        }
        if (response?.ok == true) return DesktopFocusValidation(canSend = true)
        val reason = response?.error?.ifBlank { response.action }?.ifBlank { "focus request failed" } ?: "focus request failed"
        return DesktopFocusValidation(
            canSend = false,
            message = "Blocked send: unable to confirm Codex Desktop conversation ${targetLabel(target)}. $reason",
        )
    }

    private fun targetLabel(target: DesktopRemoteTarget): String {
        return target.desktopTitle.ifBlank { "#${target.desktopIndex ?: 0}" }
    }
}
