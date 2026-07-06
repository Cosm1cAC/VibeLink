package com.vibelink.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ConversationItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for the session (conversation) list.
 * Merges histories + tasks into a single sorted list.
 */
class SessionListViewModel : ViewModel() {

    private val _conversations = MutableStateFlow<List<ConversationItem>>(emptyList())
    val conversations: StateFlow<List<ConversationItem>> = _conversations.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow("")
    val error: StateFlow<String> = _error.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    /**
     * Load/refresh both histories and tasks, then merge into conversation list.
     */
    fun load(apiClient: ApiClient, isRefresh: Boolean = false) {
        viewModelScope.launch {
            if (isRefresh) _refreshing.value = true else _loading.value = true
            _error.value = ""
            try {
                val histories = apiClient.listHistories()
                val tasks = apiClient.listTasks()

                // Build a map from sessionKey -> history for quick lookup
                val historyBySession = mutableMapOf<String, com.vibelink.app.network.HistoryItem>()
                for (h in histories) {
                    historyBySession[sessionKey(h.provider, h.id)] = h
                }

                // Group tasks by sessionId
                val taskGroups = mutableMapOf<String, com.vibelink.app.network.TaskSummary>()
                for (t in tasks) {
                    val key = if (t.sessionId.isNotBlank()) "thread:${sessionKey(t.agent, t.sessionId)}" else "task:${t.id}"
                    val existing = taskGroups[key]
                    val taskTime = parseTime(t.updatedAt)
                    val existingTime = if (existing != null) parseTime(existing.updatedAt) else 0L
                    if (existing == null || taskTime >= existingTime) {
                        taskGroups[key] = t
                    }
                }

                // Build task items
                val taskSessionIds = taskGroups.values
                    .mapNotNull { if (it.sessionId.isNotBlank()) sessionKey(it.agent, it.sessionId) else null }
                    .toSet()

                val taskItems = taskGroups.values.map { task ->
                    val history = if (task.sessionId.isNotBlank()) {
                        historyBySession[sessionKey(task.agent, task.sessionId)]
                    } else null
                    val historyTime = if (history != null) parseTime(history.updatedAt) else 0L
                    val taskTime = parseTime(task.updatedAt)
                    val staleCompletedTask = history != null && task.status != "running" && historyTime > taskTime

                    ConversationItem(
                        key = if (task.sessionId.isNotBlank()) "thread:${task.agent}:${task.sessionId}" else "task:${task.id}",
                        kind = if (staleCompletedTask) "history" else "task",
                        id = task.id,
                        provider = task.agent,
                        title = if (staleCompletedTask) (history?.title ?: task.title) else task.title,
                        cwd = task.cwd ?: history?.projectPath ?: "",
                        status = if (staleCompletedTask) "history" else task.status,
                        updatedAt = latestOf(task.updatedAt, history?.updatedAt),
                        sessionId = task.sessionId ?: "",
                        preview = history?.preview ?: "",
                    )
                }

                // Build history items (those without a matching running task)
                val historyItems = histories
                    .filter { !taskSessionIds.contains(sessionKey(it.provider, it.id)) }
                    .map {
                        ConversationItem(
                            key = "history:${it.provider}:${it.id}",
                            kind = "history",
                            id = it.id,
                            provider = it.provider,
                            title = if (it.title.isNotBlank()) it.title else it.id,
                            cwd = it.projectPath ?: "",
                            status = "history",
                            updatedAt = it.updatedAt,
                            sessionId = it.id,
                            preview = it.preview ?: "",
                        )
                    }

                val merged = (taskItems + historyItems).sortedByDescending {
                    parseTime(it.updatedAt)
                }

                _conversations.value = merged
            } catch (e: Exception) {
                _error.value = e.message ?: "Failed to load conversations"
            } finally {
                _loading.value = false
                _refreshing.value = false
            }
        }
    }

    companion object {
        fun sessionKey(provider: String, id: String): String = "$provider::$id"

        private fun parseTime(iso: String?): Long {
            if (iso.isNullOrBlank()) return 0L
            return try {
                java.time.Instant.parse(iso).toEpochMilli()
            } catch (_: Exception) {
                try {
                    java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).apply {
                        timeZone = java.util.TimeZone.getTimeZone("UTC")
                    }.parse(iso)?.time ?: 0L
                } catch (_: Exception) {
                    0L
                }
            }
        }

        private fun latestOf(a: String?, b: String?): String {
            val aTime = parseTime(a)
            val bTime = parseTime(b)
            return if (aTime >= bTime) (a ?: b ?: "") else (b ?: a ?: "")
        }
    }
}
