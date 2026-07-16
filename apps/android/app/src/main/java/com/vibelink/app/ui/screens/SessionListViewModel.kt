package com.vibelink.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.DesktopConversation
import com.vibelink.app.network.DesktopRemoteState
import com.vibelink.app.network.HistoryItem
import com.vibelink.app.network.TaskSummary
import com.vibelink.app.network.ThreadFork
import com.vibelink.app.network.ThreadPatch
import com.vibelink.app.network.ThreadStateResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import com.vibelink.app.network.SearchResult

/**
 * ViewModel for the conversation list.
 *
 * Android intentionally follows the web client contract here:
 * histories + running tasks + manual thread-state + Codex Desktop visibility.
 */
class SessionListViewModel : ViewModel() {
    private var lastApiClient: ApiClient? = null
    private var searchJob: Job? = null
    private val _searchResults = MutableStateFlow<List<SearchResult>>(emptyList())
    val searchResults: StateFlow<List<SearchResult>> = _searchResults.asStateFlow()

    private val _searchLoading = MutableStateFlow(false)
    val searchLoading: StateFlow<Boolean> = _searchLoading.asStateFlow()

    private val _searchError = MutableStateFlow("")
    val searchError: StateFlow<String> = _searchError.asStateFlow()

    private val _searchNextCursor = MutableStateFlow("")
    val searchNextCursor: StateFlow<String> = _searchNextCursor.asStateFlow()

    private val _allConversations = MutableStateFlow<List<ConversationItem>>(emptyList())

    private val _conversations = MutableStateFlow<List<ConversationItem>>(emptyList())
    val conversations: StateFlow<List<ConversationItem>> = _conversations.asStateFlow()

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    private val _showArchived = MutableStateFlow(false)
    val showArchived: StateFlow<Boolean> = _showArchived.asStateFlow()

    private val _showFavorites = MutableStateFlow(false)
    val showFavorites: StateFlow<Boolean> = _showFavorites.asStateFlow()

    private val _desktopStatus = MutableStateFlow("")
    val desktopStatus: StateFlow<String> = _desktopStatus.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow("")
    val error: StateFlow<String> = _error.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    fun load(apiClient: ApiClient, isRefresh: Boolean = false) {
        lastApiClient = apiClient
        viewModelScope.launch {
            if (isRefresh) _refreshing.value = true else _loading.value = true
            _error.value = ""
            try {
                val snapshot = loadSessionListSnapshot(
                    loadHistories = apiClient::listHistories,
                    loadTasks = apiClient::listTasks,
                    loadThreadState = apiClient::getThreadState,
                    loadDesktop = { apiClient.getDesktopRemoteStatus(fresh = isRefresh) },
                )

                _desktopStatus.value = desktopStatusText(snapshot.desktop)
                _allConversations.value = buildConversationItems(
                    snapshot.histories,
                    snapshot.tasks,
                    snapshot.threadState,
                    snapshot.desktop,
                )
                applyFilters()
            } catch (error: Exception) {
                _error.value = error.message ?: "加载会话失败"
            } finally {
                _loading.value = false
                _refreshing.value = false
            }
        }
    }

    fun setQuery(value: String) {
        _query.value = value
        applyFilters()
        searchJob?.cancel()
        if (value.trim().length < 2) {
            _searchResults.value = emptyList()
            _searchError.value = ""
            _searchNextCursor.value = ""
            _searchLoading.value = false
            return
        }
        searchJob = viewModelScope.launch {
            delay(250)
            _searchLoading.value = true
            _searchError.value = ""
            runCatching { lastApiClient?.search(value.trim()) }
                .onSuccess { response ->
                    _searchResults.value = response?.items.orEmpty()
                    _searchNextCursor.value = response?.nextCursor.orEmpty()
                }
                .onFailure { _searchError.value = it.message ?: "搜索失败" }
            _searchLoading.value = false
        }
    }

    fun setShowArchived(value: Boolean) {
        _showArchived.value = value
        applyFilters()
    }

    fun setShowFavorites(value: Boolean) {
        _showFavorites.value = value
        applyFilters()
    }

    fun patchConversation(apiClient: ApiClient, item: ConversationItem, patch: ThreadPatch) {
        if (item.kind == "desktop" || item.kind == "new") return
        viewModelScope.launch {
            _error.value = ""
            try {
                apiClient.patchThread(item.key, patch)
                _allConversations.value = _allConversations.value.map { current ->
                    if (current.key != item.key) current else current.copy(
                        title = patch.title ?: current.title,
                        group = patch.group ?: current.group,
                        pinned = patch.pinned ?: current.pinned,
                        archived = patch.archived ?: current.archived,
                        tags = patch.tags ?: current.tags,
                        favorite = patch.favorite ?: current.favorite,
                    )
                }
                applyFilters()
            } catch (error: Exception) {
                _error.value = error.message ?: "更新会话失败"
            }
        }
    }

    fun forkConversation(apiClient: ApiClient, item: ConversationItem, title: String) {
        if (item.kind == "desktop" || item.kind == "new") return
        val cleanTitle = title.trim().ifBlank { "${item.title} 分叉" }
        viewModelScope.launch {
            _error.value = ""
            try {
                val result = apiClient.createThreadFork(
                    sourceKey = item.key,
                    sourceId = item.sessionId.ifBlank { item.id },
                    provider = if (item.provider == "claude") "claude" else "codex",
                    title = cleanTitle,
                    cwd = item.cwd,
                )
                val fork = result.fork
                val forkItem = fork.toConversationItem()
                _allConversations.value = sortManaged(_allConversations.value + forkItem)
                applyFilters()
            } catch (error: Exception) {
                _error.value = error.message ?: "分叉会话失败"
            }
        }
    }

    private fun buildConversationItems(
        histories: List<HistoryItem>,
        tasks: List<TaskSummary>,
        threadState: ThreadStateResponse,
        desktopRemote: DesktopRemoteState?,
    ): List<ConversationItem> {
        val historyBySession = histories.associateBy { sessionKey(it.provider, it.id) }

        val taskGroups = linkedMapOf<String, TaskSummary>()
        for (task in tasks) {
            val key = if (task.sessionId.isNotBlank()) {
                "thread:${sessionKey(task.agent, task.sessionId)}"
            } else {
                "task:${task.id}"
            }
            val existing = taskGroups[key]
            if (existing == null || parseTime(task.updatedAt) >= parseTime(existing.updatedAt)) {
                taskGroups[key] = task
            }
        }

        val taskSessionIds = taskGroups.values
            .mapNotNull { if (it.sessionId.isNotBlank()) sessionKey(it.agent, it.sessionId) else null }
            .toSet()

        val taskItems = taskGroups.values.map { task ->
            val history = if (task.sessionId.isNotBlank()) historyBySession[sessionKey(task.agent, task.sessionId)] else null
            val staleCompletedTask = history != null &&
                task.status != "running" &&
                parseTime(history.updatedAt) > parseTime(task.updatedAt)

            ConversationItem(
                key = if (task.sessionId.isNotBlank()) "thread:${task.agent}:${task.sessionId}" else "task:${task.id}",
                kind = if (staleCompletedTask) "history" else "task",
                id = task.id,
                provider = task.agent,
                title = history?.title?.ifBlank { task.title } ?: task.title.ifBlank { "${providerLabel(task.agent)} 任务" },
                cwd = task.cwd.ifBlank { history?.projectPath.orEmpty() },
                status = if (staleCompletedTask) "history" else task.status,
                updatedAt = latestOf(task.updatedAt, history?.updatedAt),
                sessionId = task.sessionId,
                sourceId = if (staleCompletedTask) history?.id.orEmpty() else "",
                preview = history?.preview.orEmpty(),
            )
        }

        val historyItems = histories
            .filter { !taskSessionIds.contains(sessionKey(it.provider, it.id)) }
            .map { history ->
                ConversationItem(
                    key = threadKeyFor(history.provider, history.id),
                    kind = "history",
                    id = history.id,
                    provider = history.provider,
                    title = history.title.ifBlank { history.id },
                    cwd = history.projectPath,
                    status = "history",
                    updatedAt = history.updatedAt,
                    sessionId = history.id,
                    preview = history.preview,
                )
            }

        val localItems = (taskItems + historyItems)
            .map { applyThreadMeta(it, threadState) }
        val desktopMatches = desktopMatches(desktopRemote, localItems)
        val withDesktopBindings = localItems.map { item ->
            val match = desktopMatches[item.key] ?: return@map item
            item.copy(
                status = if (match.running) "running" else item.status,
                desktopIndex = match.index,
                desktopTitle = match.title,
                desktopLinked = true,
            )
        }

        val forkItems = threadState.forks.map { it.toConversationItem() }
        val desktopEntry = desktopRemote?.toConversationItem()

        return sortManaged(listOfNotNull(desktopEntry) + withDesktopBindings + forkItems)
    }

    private fun applyThreadMeta(item: ConversationItem, threadState: ThreadStateResponse): ConversationItem {
        val meta = threadState.items[item.key] ?: return item
        return item.copy(
            title = meta.title.ifBlank { item.title },
            group = meta.group.ifBlank { item.group },
            pinned = meta.pinned,
            archived = meta.archived,
            tags = meta.tags,
            favorite = meta.favorite,
            updatedAt = latestOf(item.updatedAt, meta.updatedAt),
        )
    }

    private fun desktopMatches(
        desktopRemote: DesktopRemoteState?,
        candidates: List<ConversationItem>,
    ): Map<String, DesktopConversation> {
        val conversations = desktopRemote?.desktop?.conversations.orEmpty()
        if (conversations.isEmpty() || candidates.isEmpty()) return emptyMap()
        val result = mutableMapOf<String, DesktopConversation>()
        for (desktop in conversations) {
            val normalizedDesktop = normalizeTitle(desktop.title.ifBlank { desktop.rawName })
            if (normalizedDesktop.isBlank()) continue
            val match = candidates
                .filter { it.provider == "codex" && normalizeTitle(it.title).isNotBlank() }
                .map { it to desktopMatchScore(normalizedDesktop, normalizeTitle(it.title)) }
                .filter { it.second >= 78 }
                .maxWithOrNull(compareBy<Pair<ConversationItem, Int>> { it.second }.thenBy { parseTime(it.first.updatedAt) })
                ?.first
            if (match != null) result[match.key] = desktop
        }
        return result
    }

    private fun DesktopRemoteState.toConversationItem(): ConversationItem {
        val desktopSnapshot = desktop
        val ready = desktopSnapshot?.ready == true
        val running = active || pendingCount > 0 || desktopSnapshot?.sidebarHasRunning == true
        val title = desktopSnapshot?.windowTitle?.ifBlank { "Codex Desktop 远程" } ?: "Codex Desktop 远程"
        val preview = when {
            ready && pendingCount > 0 -> "$pendingCount queued message(s)"
            ready -> "Connected. Tap to sync the visible Codex transcript."
            desktopSnapshot?.found == true -> desktopSnapshot.reason.ifBlank { "Codex window found but composer is not ready." }
            else -> desktopReasonLabel(desktopSnapshot?.reason)
        }
        return ConversationItem(
            key = "desktop:current",
            kind = "desktop",
            id = "desktop",
            provider = "codex",
            title = title,
            cwd = "",
            status = if (running) "running" else "desktop",
            updatedAt = updatedAt.ifBlank { desktopSnapshot?.updatedAt.orEmpty() },
            preview = preview,
            pinned = true,
            desktopLinked = ready,
        )
    }

    private fun ThreadFork.toConversationItem(): ConversationItem = ConversationItem(
        key = "fork:$id",
        kind = "fork",
        id = id,
        provider = provider,
        title = title.ifBlank { "Forked thread" },
        cwd = cwd,
        status = "fork",
        updatedAt = updatedAt.ifBlank { createdAt },
        sessionId = sourceId,
        sourceKey = sourceKey,
        sourceId = sourceId,
        group = group,
        pinned = pinned,
        archived = archived,
    )

    private fun applyFilters() {
        val query = _query.value.trim().lowercase()
        val showArchived = _showArchived.value
        val showFavorites = _showFavorites.value
        _conversations.value = _allConversations.value
            .filter { item ->
                item.kind == "desktop" || if (showArchived) item.archived else !item.archived
            }
            .filter { item -> !showFavorites || item.favorite }
            .filter { item ->
                if (query.isBlank()) true
                else listOf(item.title, item.provider, item.cwd, item.sessionId, item.preview, item.group)
                    .joinToString(" ")
                    .lowercase()
                    .contains(query)
            }
    }

    companion object {
        fun sessionKey(provider: String, id: String): String = "$provider:$id"
        fun threadKeyFor(provider: String, sessionId: String): String = "history:$provider:$sessionId"

        private fun providerLabel(value: String): String = when (value) {
            "codex" -> "Codex"
            "claude" -> "Claude"
            "doubao" -> "Doubao"
            "zhipu" -> "GLM"
            else -> value.ifBlank { "Agent" }
        }

        private fun sortManaged(items: List<ConversationItem>): List<ConversationItem> {
            return items.sortedWith(
            compareByDescending<ConversationItem> { it.favorite }
                .thenByDescending { it.pinned }
                    .thenBy { it.group.lowercase() }
                    .thenByDescending { parseTime(it.updatedAt) }
            )
        }

        private fun desktopStatusText(value: DesktopRemoteState?): String {
            val desktop = value?.desktop ?: return "Codex 远程：未检查"
            return when {
                desktop.ready -> "Codex 远程：已就绪"
                desktop.found -> "Codex 远程：${desktopReasonLabel(desktop.reason.ifBlank { "window found" })}"
                else -> "Codex 远程：未连接"
            }
        }

        private fun desktopReasonLabel(reason: String?): String {
            val value = reason.orEmpty()
            return when {
                value.isBlank() -> "Codex Desktop 未连接。"
                value.equals("window found", ignoreCase = true) -> "已找到窗口"
                value.contains("window was not found", ignoreCase = true) -> "未找到 Codex Desktop 窗口。"
                value.contains("not connected", ignoreCase = true) -> "Codex Desktop 未连接。"
                else -> value
            }
        }

        private fun desktopMatchScore(desktop: String, local: String): Int {
            return when {
                desktop == local -> 100
                desktop.length >= 6 && local.contains(desktop) -> 78
                local.length >= 6 && desktop.contains(local) -> 78
                else -> 0
            }
        }

        private fun normalizeTitle(value: String): String {
            return value
                .replace(Regex("(刚刚|\\d+\\s*(秒|分钟|分|小时|天|周|个月|月|年))$"), "")
                .replace(Regex("[\\s\"'`“”‘’。，、,.!?！？:：;；()[\\]{}<>《》【】\\-_/\\\\…]+"), "")
                .lowercase()
        }

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
