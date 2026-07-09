package com.vibelink.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ApiException
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener

class MessageListViewModel : ViewModel() {

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

    private var taskEventSource: EventSource? = null
    private var toolEventSource: EventSource? = null
    private var pollJob: Job? = null
    private var loadSequence = 0L
    private var activeConversation: ConversationItem? = null
    private val seenTaskEvents = mutableSetOf<String>()
    private val seenToolEvents = mutableSetOf<String>()
    private val toolEventsByRun = linkedMapOf<String, MutableList<ToolEvent>>()

    fun loadConversation(apiClient: ApiClient, conversation: ConversationItem) {
        stopStreaming()
        activeConversation = conversation
        loadSequence += 1
        val seq = loadSequence
        seenTaskEvents.clear()
        seenToolEvents.clear()
        toolEventsByRun.clear()

        viewModelScope.launch {
            _loading.value = true
            _error.value = ""
            _running.value = false
            _sending.value = false
            _currentTaskId.value = if (conversation.kind == "task") conversation.id else ""
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
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to load conversation"
            } finally {
                if (seq == loadSequence) _loading.value = false
            }
        }
    }

    fun refresh(apiClient: ApiClient) {
        val conversation = activeConversation ?: return
        loadConversation(apiClient, conversation)
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
                appendError(TaskApprovalHandoff.messageFor(error))
            } catch (error: Exception) {
                appendError(error.message ?: "Failed to send prompt")
            } finally {
                _sending.value = false
            }
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
        toolEventSource?.cancel()
        toolEventSource = apiClient.subscribeToolEvents(
            taskId = taskId,
            after = 0,
            listener = object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    runCatching {
                        val event = gson.fromJson(data, ToolEvent::class.java)
                        appendToolEvent(event)
                    }
                }
            },
        )
    }

    fun stopStreaming() {
        taskEventSource?.cancel()
        taskEventSource = null
        toolEventSource?.cancel()
        toolEventSource = null
        pollJob?.cancel()
        pollJob = null
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
        val response = apiClient.createTask(
            prompt = prompt,
            cwd = cwdOverride.ifBlank { conversation.cwd },
            agent = agent.ifBlank { conversation.provider.ifBlank { "codex" } },
            model = model.trim(),
            title = conversation.title.ifBlank { prompt.take(80) },
            mode = mode,
            sessionId = resumeSessionId,
            reasoningEffort = reasoningEffort.trim(),
        )
        TaskApprovalHandoff.noticeFromResponse(response)?.let { notice ->
            appendError(notice.message)
            return
        }
        if (response.id.isBlank()) {
            appendError(response.error.ifBlank { "Task was created but no task id was returned." })
            return
        }
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

        val cursor = task.events.maxOfOrNull { it.cursor } ?: 0
        taskEventSource?.cancel()
        taskEventSource = apiClient.subscribeTaskEvents(task.id, after = cursor, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                runCatching {
                    val event = gson.fromJson(data, TaskEvent::class.java)
                    appendTaskEvents(listOf(event))
                    if (event.type == "system" && event.text.contains("Exited")) {
                        _running.value = false
                        stopStreaming()
                    }
                }
            }
        })
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
        val fresh = events.filter { seenTaskEvents.add(taskEventKey(it)) }
        val newMessages = messagesFromEvents(fresh)
        if (newMessages.isNotEmpty()) _messages.value = mergeMessages(_messages.value, newMessages)
    }

    private fun appendToolEvent(event: ToolEvent) {
        if (!seenToolEvents.add(toolEventKey(event))) return
        val runId = event.toolRunId.ifBlank { (event.payload.orEmpty()["toolRunId"] as? String).orEmpty() }.ifBlank { event.id }
        if (runId.isBlank()) return
        val events = toolEventsByRun.getOrPut(runId) { mutableListOf() }
        events.add(event)
        events.sortBy { it.cursor }
        renderToolEvents()
    }

    private fun renderToolEvents() {
        val toolCalls = toolEventsByRun.map { (runId, events) ->
            toolCallFromEvents(runId, events)
        }.sortedBy { it.cursor }
        if (toolCalls.isEmpty()) return
        val toolMessage = ChatMessage(
            role = "assistant",
            text = "",
            toolCalls = toolCalls,
            toolCallCount = toolCalls.size,
        )
        val withoutPreviousToolSync = _messages.value.filterNot {
            it.text.isBlank() && it.toolCalls.isNotEmpty()
        }
        _messages.value = withoutPreviousToolSync + toolMessage
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

    companion object {
        fun messagesFromEvents(events: List<TaskEvent>): List<ChatMessage> {
            return events.mapNotNull { event ->
                val role = taskEventRole(event)
                val text = event.text.trim()
                if (text.isBlank() || role == "debug") return@mapNotNull null
                ChatMessage(role = role, text = text)
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
                ChatMessage(role = normalizeRole(entry.role), text = text)
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
            if (current.isEmpty()) return incoming
            if (incoming.isEmpty()) return current
            val merged = current.toMutableList()
            for (message in incoming) {
                val last = merged.lastOrNull()
                if (last != null && canMergeAssistantText(last, message)) {
                    merged[merged.lastIndex] = last.copy(text = listOf(last.text, message.text).filter { it.isNotBlank() }.joinToString(""))
                } else {
                    merged += message
                }
            }
            return merged
        }

        fun appendDisplayMessages(current: List<ChatMessage>, message: ChatMessage): List<ChatMessage> {
            val seed = current.filterNot {
                it.role == "system" &&
                    (it.text.startsWith("Start a VibeLink Agent task") || it.text == "No messages in this history.")
            }
            return seed + message
        }

        private fun canMergeAssistantText(previous: ChatMessage, next: ChatMessage): Boolean {
            return previous.role == "assistant" &&
                next.role == "assistant" &&
                previous.toolCalls.isEmpty() &&
                next.toolCalls.isEmpty() &&
                previous.text.isNotBlank() &&
                next.text.isNotBlank()
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

object TaskApprovalHandoff {
    fun noticeFromResponse(response: TaskCreateResponse): ApprovalNotice? {
        val approvalId = response.approvalId.ifBlank { response.approval?.id.orEmpty() }
        if (approvalId.isBlank()) return null
        return ApprovalNotice(approvalId, approvalMessage(approvalId, response.error))
    }

    fun messageFor(error: ApiException): String {
        if (error.statusCode != 428) return error.body.ifBlank { "HTTP ${error.statusCode}" }
        val json = parseObject(error.body)
        val approvalId = stringMember(json, "approvalId").ifBlank {
            stringMember(json?.getAsJsonObject("approval"), "id")
        }
        val reason = stringMember(json, "error")
        return approvalMessage(approvalId, reason)
    }

    private fun approvalMessage(approvalId: String, reason: String): String {
        val idSuffix = if (approvalId.isBlank()) "" else " ($approvalId)"
        val reasonPrefix = reason.ifBlank { "This action needs approval." }
        return "$reasonPrefix Approval required$idSuffix. Open Settings > Approvals, approve it, then retry this prompt."
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
