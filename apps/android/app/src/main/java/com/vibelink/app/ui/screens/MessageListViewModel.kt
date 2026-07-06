package com.vibelink.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vibelink.app.network.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener

/**
 * ViewModel for the message list (chat detail) screen.
 * Loads messages from a history or task, subscribes to SSE for live updates.
 */
class MessageListViewModel : ViewModel() {

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

    private var taskEventSource: EventSource? = null
    private var toolEventSource: EventSource? = null
    private var pollJob: Job? = null

    private var loadSequence = 0L

    /**
     * Load conversation detail for a history or task item.
     */
    fun loadConversation(
        apiClient: ApiClient,
        conversation: ConversationItem,
    ) {
        stopStreaming()
        loadSequence++
        val seq = loadSequence

        viewModelScope.launch {
            _loading.value = true
            _error.value = ""
            _running.value = false
            _title.value = conversation.title

            if (conversation.kind == "task") {
                try {
                    val task = apiClient.getTask(conversation.id)
                    if (seq != loadSequence) return@launch

                    // Load history messages if a sessionId exists
                    val historyMessages = if (task.sessionId.isNotBlank()) {
                        loadHistoryMessages(apiClient, task.agent ?: conversation.provider, task.sessionId)
                    } else emptyList()

                    // Generate messages from task events
                    val taskMessages = if (historyMessages.isEmpty() || task.status == "running") {
                        messagesFromEvents(task.events)
                    } else emptyList()

                    val nextMessages = if (taskMessages.isNotEmpty()) {
                        mergeMessages(historyMessages, taskMessages)
                    } else historyMessages

                    _messages.value = nextMessages.ifEmpty {
                        listOf(ChatMessage(role = "system", text = "Task started. Waiting for output."))
                    }
                    _running.value = task.status == "running"

                    // Subscribe to live events if running
                    if (task.status == "running") {
                        followRunningTask(apiClient, task)
                    }
                } catch (e: Exception) {
                    _error.value = e.message ?: "Failed to load task"
                }
            } else {
                // History item
                try {
                    val detail = apiClient.getHistoryDetail(conversation.provider, conversation.sessionId.ifBlank { conversation.id })
                    if (seq != loadSequence) return@launch

                    val entries = messagesFromTranscript(detail.transcript)
                        .ifEmpty { messagesFromHistoryEntries(detail.entries) }

                    _messages.value = entries.ifEmpty {
                        listOf(ChatMessage(role = "system", text = "No messages in this history."))
                    }
                    _running.value = false
                } catch (e: Exception) {
                    _error.value = e.message ?: "Failed to load history"
                }
            }
            _loading.value = false
        }
    }

    /**
     * Subscribe to SSE for a running task.
     */
    private fun followRunningTask(apiClient: ApiClient, task: TaskDetail) {
        // Polling fallback
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
                } catch (_: Exception) { }
            }
        }

        // SSE for task events
        val cursor = task.events.maxOfOrNull { it.cursor } ?: 0
        taskEventSource = apiClient.subscribeTaskEvents(task.id, after = cursor, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                try {
                    val gson = com.google.gson.Gson()
                    val event = gson.fromJson(data, TaskEvent::class.java)
                    appendTaskEvents(listOf(event))

                    // If task exited, stop
                    if (event.type == "system" && event.text?.contains("Exited") == true) {
                        _running.value = false
                        stopStreaming()
                    }
                } catch (_: Exception) { }
            }
        })
    }

    /**
     * Subscribe to tool events for a task.
     */
    fun followToolEvents(apiClient: ApiClient, conversationId: String) {
        toolEventSource = apiClient.subscribeToolEvents(
            taskId = conversationId,
            after = 0,
            listener = object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    try {
                        val gson = com.google.gson.Gson()
                        val event = gson.fromJson(data, ToolEvent::class.java)
                        appendToolEvent(event)
                    } catch (_: Exception) { }
                }
            }
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

    override fun onCleared() {
        super.onCleared()
        stopStreaming()
    }

    // ── Internal helpers ──

    private suspend fun loadHistoryMessages(apiClient: ApiClient, provider: String, sessionId: String): List<ChatMessage> {
        if (provider.isBlank() || sessionId.isBlank()) return emptyList()
        return try {
            val detail = apiClient.getHistoryDetail(provider, sessionId)
            messagesFromTranscript(detail.transcript)
        } catch (_: Exception) { emptyList() }
    }

    private fun appendTaskEvents(events: List<TaskEvent>) {
        val newMessages = messagesFromEvents(events)
        if (newMessages.isEmpty()) return
        _messages.value = mergeMessages(_messages.value, newMessages)
    }

    private fun appendToolEvent(event: ToolEvent) {
        // For simplicity, rebuild tool events into messages periodically
        // Real implementation would properly merge tool call cards
    }

    companion object {
        /**
         * Generate ChatMessage list from raw TaskEvents (matching Web logic).
         */
        fun messagesFromEvents(events: List<TaskEvent>): List<ChatMessage> {
            return events
                .mapNotNull { event ->
                    val role = taskEventRole(event)
                    val text = event.text ?: ""
                    if (text.isBlank() || role == "debug") return@mapNotNull null
                    ChatMessage(role = role, text = text)
                }
        }

        private fun taskEventRole(event: TaskEvent): String {
            return when (event.type) {
                "stdin" -> "user"
                "error" -> "error"
                "stderr" -> {
                    val text = event.text ?: ""
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
                else -> "log"
            }
        }

        fun messagesFromTranscript(transcript: List<TranscriptEntry>): List<ChatMessage> {
            return transcript.mapNotNull { entry ->
                val text = entry.text?.trim() ?: return@mapNotNull null
                if (text.isBlank()) return@mapNotNull null
                ChatMessage(
                    role = if (entry.role == "user") "user" else "assistant",
                    text = text,
                )
            }
        }

        fun messagesFromHistoryEntries(entries: List<Map<String, Any?>>): List<ChatMessage> {
            return entries.mapNotNull { entry ->
                val role = entry["role"] as? String ?: return@mapNotNull null
                val text = entry["text"] as? String ?: return@mapNotNull null
                if (text.isBlank()) return@mapNotNull null
                ChatMessage(role = role, text = text)
            }
        }

        fun mergeMessages(current: List<ChatMessage>, incoming: List<ChatMessage>): List<ChatMessage> {
            val merged = current.toMutableList()
            merged.addAll(incoming)
            return merged
        }
    }
}
