package com.vibelink.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ApiException
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.CommandDefinition
import com.vibelink.app.network.DesktopConversation
import com.vibelink.app.network.DesktopRemoteState
import com.vibelink.app.network.HistoryItem
import com.vibelink.app.network.TaskSummary
import com.vibelink.app.network.ThreadFork
import com.vibelink.app.network.ThreadPatch
import com.vibelink.app.network.ThreadPatchRequest
import com.vibelink.app.network.ThreadStateResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import com.vibelink.app.network.SearchResult
import com.vibelink.app.ui.i18n.AppStrings
import com.vibelink.app.ui.i18n.appStringsFor
import com.vibelink.app.data.AppLanguage

/**
 * ViewModel for the conversation list.
 *
 * Android intentionally follows the web client contract here:
 * histories + running tasks + manual thread-state + Codex Desktop visibility.
 */
class SessionListViewModel : ViewModel() {
    private var strings: AppStrings = appStringsFor(AppLanguage.Default)
    private var lastApiClient: ApiClient? = null
    private var searchJob: Job? = null
    private var searchGeneration = 0L

    fun setLanguage(language: AppLanguage) {
        strings = appStringsFor(language)
    }
    private val _searchResults = MutableStateFlow<List<SearchResult>>(emptyList())
    val searchResults: StateFlow<List<SearchResult>> = _searchResults.asStateFlow()

    private val _searchLoading = MutableStateFlow(false)
    val searchLoading: StateFlow<Boolean> = _searchLoading.asStateFlow()

    private val _searchAppending = MutableStateFlow(false)
    val searchAppending: StateFlow<Boolean> = _searchAppending.asStateFlow()

    private val _searchError = MutableStateFlow("")
    val searchError: StateFlow<String> = _searchError.asStateFlow()

    private val _searchNextCursor = MutableStateFlow("")
    val searchNextCursor: StateFlow<String> = _searchNextCursor.asStateFlow()

    private val _searchScope = MutableStateFlow("all")
    val searchScope: StateFlow<String> = _searchScope.asStateFlow()

    private val _selectedSearchTag = MutableStateFlow("")
    val selectedSearchTag: StateFlow<String> = _selectedSearchTag.asStateFlow()

    private val _selectedTags = MutableStateFlow<Set<String>>(emptySet())
    val selectedTags: StateFlow<Set<String>> = _selectedTags.asStateFlow()

    private val _availableTags = MutableStateFlow<List<String>>(emptyList())
    val availableTags: StateFlow<List<String>> = _availableTags.asStateFlow()

    private val _selectedConversationKeys = MutableStateFlow<Set<String>>(emptySet())
    val selectedConversationKeys: StateFlow<Set<String>> = _selectedConversationKeys.asStateFlow()

    private val _commands = MutableStateFlow<List<CommandDefinition>>(emptyList())
    val commands: StateFlow<List<CommandDefinition>> = _commands.asStateFlow()

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
                _commands.value = runCatching { apiClient.listCommands() }.getOrDefault(_commands.value)
                val snapshot = loadSessionListSnapshot(
                    loadHistories = apiClient::listHistories,
                    loadTasks = apiClient::listTasks,
                    loadThreadState = apiClient::getThreadState,
                    loadDesktop = { apiClient.getDesktopRemoteStatus(fresh = isRefresh) },
                )

                _desktopStatus.value = desktopStatusText(snapshot.desktop, strings)
                _allConversations.value = buildConversationItems(
                    snapshot.histories,
                    snapshot.tasks,
                    snapshot.threadState,
                    snapshot.desktop,
                )
                updateAvailableTags()
                applyFilters()
            } catch (error: Exception) {
                _error.value = error.message ?: strings.loadChatsFailed
            } finally {
                _loading.value = false
                _refreshing.value = false
            }
        }
    }

    fun setQuery(value: String) {
        _query.value = value
        applyFilters()
        scheduleSearch()
    }

    fun setSearchScope(value: String) {
        if (_searchScope.value == value) return
        _searchScope.value = value
        scheduleSearch()
    }

    fun setSearchTag(value: String) {
        val clean = value.trim()
        if (_selectedSearchTag.value == clean && _selectedTags.value == setOf(clean).filter { it.isNotBlank() }.toSet()) return
        _selectedSearchTag.value = clean
        _selectedTags.value = setOf(clean).filter { it.isNotBlank() }.toSet()
        applyFilters()
        scheduleSearch()
    }

    fun toggleTagFilter(tag: String) {
        val clean = tag.trim()
        if (clean.isBlank()) return
        val next = _selectedTags.value.toMutableSet().apply {
            val existing = firstOrNull { it.equals(clean, ignoreCase = true) }
            if (existing == null) add(clean) else remove(existing)
        }
        _selectedTags.value = next
        _selectedSearchTag.value = if (next.size == 1) next.first() else ""
        applyFilters()
        scheduleSearch()
    }

    fun clearTagFilters() {
        if (_selectedTags.value.isEmpty() && _selectedSearchTag.value.isBlank()) return
        _selectedTags.value = emptySet()
        _selectedSearchTag.value = ""
        applyFilters()
        scheduleSearch()
    }

    fun loadMoreSearch(apiClient: ApiClient) {
        lastApiClient = apiClient
        val cursor = _searchNextCursor.value
        if (_query.value.trim().length < 2 || cursor.isBlank() || _searchAppending.value || _searchLoading.value) return
        searchJob?.cancel()
        runSearch(cursor = cursor, append = true)
    }

    fun setShowArchived(value: Boolean) {
        _showArchived.value = value
        applyFilters()
    }

    fun setShowFavorites(value: Boolean) {
        _showFavorites.value = value
        applyFilters()
        scheduleSearch()
    }

    fun patchConversation(apiClient: ApiClient, item: ConversationItem, patch: ThreadPatch) {
        if (!SessionListBatchEditPolicy.isBatchEditable(item)) return
        viewModelScope.launch {
            _error.value = ""
            try {
                val state = apiClient.patchThread(item.key, patch, expectedRevision = item.revision)
                applyThreadStateUpdate(state)
            } catch (error: ApiException) {
                if (error.statusCode == 409) {
                    _error.value = strings.conversationChangedElsewhere
                    load(apiClient, isRefresh = true)
                } else {
                    _error.value = error.message ?: strings.updateConversationFailed
                }
            } catch (error: Exception) {
                _error.value = error.message ?: strings.updateConversationFailed
            }
        }
    }

    fun toggleConversationSelection(item: ConversationItem) {
        if (!SessionListBatchEditPolicy.isBatchEditable(item)) return
        _selectedConversationKeys.value = _selectedConversationKeys.value.toMutableSet().apply {
            if (!add(item.key)) remove(item.key)
        }
    }

    fun clearSelection() {
        _selectedConversationKeys.value = emptySet()
    }

    fun selectVisibleManagedConversations() {
        _selectedConversationKeys.value = _conversations.value
            .filter(SessionListBatchEditPolicy::isBatchEditable)
            .map { it.key }
            .toSet()
    }

    fun batchSetFavorite(apiClient: ApiClient, favorite: Boolean) {
        batchPatchConversations(apiClient, SessionListBatchEditPolicy.buildSetFavoriteUpdates(selectedConversations(), favorite))
    }

    fun batchAddTags(apiClient: ApiClient, tags: List<String>) {
        batchPatchConversations(apiClient, SessionListBatchEditPolicy.buildAddTagsUpdates(selectedConversations(), tags))
    }

    fun batchRemoveTags(apiClient: ApiClient, tags: List<String>) {
        batchPatchConversations(apiClient, SessionListBatchEditPolicy.buildRemoveTagsUpdates(selectedConversations(), tags))
    }

    private fun selectedConversations(): List<ConversationItem> {
        val keys = _selectedConversationKeys.value
        return _allConversations.value.filter { it.key in keys }
    }

    private fun batchPatchConversations(apiClient: ApiClient, updates: List<ThreadPatchRequest>) {
        if (updates.isEmpty()) return
        viewModelScope.launch {
            _error.value = ""
            try {
                val state = apiClient.patchThreads(updates)
                applyThreadStateUpdate(state)
                clearSelection()
            } catch (error: ApiException) {
                if (error.statusCode == 409) {
                    _error.value = strings.someConversationsChangedElsewhere
                    clearSelection()
                    load(apiClient, isRefresh = true)
                } else {
                    _error.value = error.message ?: strings.batchUpdateConversationFailed
                }
            } catch (error: Exception) {
                _error.value = error.message ?: strings.batchUpdateConversationFailed
            }
        }
    }

    fun forkConversation(apiClient: ApiClient, item: ConversationItem, title: String) {
        if (item.kind == "desktop" || item.kind == "new") return
        val cleanTitle = title.trim().ifBlank { strings.forkTitle(item.title) }
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
                updateAvailableTags()
                applyFilters()
            } catch (error: Exception) {
                _error.value = error.message ?: strings.forkConversationFailed
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
                title = history?.title?.ifBlank { task.title } ?: task.title.ifBlank { strings.agentTask(providerLabel(task.agent)) },
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
            revision = meta.revision,
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
        val title = desktopSnapshot?.windowTitle?.ifBlank { strings.codexDesktopRemoteTitle } ?: strings.codexDesktopRemoteTitle
        val preview = when {
            ready && pendingCount > 0 -> "$pendingCount queued message(s)"
            ready -> "Connected. Tap to sync the visible Codex transcript."
            desktopSnapshot?.found == true -> desktopSnapshot.reason.ifBlank { "Codex window found but composer is not ready." }
            else -> desktopReasonLabel(desktopSnapshot?.reason, strings)
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

    private fun applyThreadStateUpdate(state: ThreadStateResponse) {
        _allConversations.value = _allConversations.value.map { current ->
            val meta = state.items[current.key]
            if (meta == null) current else current.copy(
                title = meta.title.ifBlank { current.title },
                group = meta.group.ifBlank { current.group },
                pinned = meta.pinned,
                archived = meta.archived,
                tags = meta.tags,
                favorite = meta.favorite,
                revision = meta.revision,
                updatedAt = latestOf(current.updatedAt, meta.updatedAt),
            )
        }
        updateAvailableTags()
        applyFilters()
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

    private fun updateAvailableTags() {
        _availableTags.value = _allConversations.value
            .flatMap { it.tags }
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .distinctBy { it.lowercase() }
            .sortedWith(String.CASE_INSENSITIVE_ORDER)
        _selectedTags.value = _selectedTags.value.filter { selected ->
            _availableTags.value.any { it.equals(selected, ignoreCase = true) }
        }.toSet()
        if (_selectedSearchTag.value.isNotBlank() && _availableTags.value.none { it.equals(_selectedSearchTag.value, ignoreCase = true) }) {
            _selectedSearchTag.value = ""
        }
    }

    private fun scheduleSearch() {
        searchJob?.cancel()
        searchGeneration += 1
        val generation = searchGeneration
        if (_query.value.trim().length < 2) {
            clearSearchState()
            return
        }
        searchJob = viewModelScope.launch {
            delay(250)
            if (generation != searchGeneration) return@launch
            runSearch(cursor = "", append = false)
        }
    }

    private fun clearSearchState() {
        _searchResults.value = emptyList()
        _searchError.value = ""
        _searchNextCursor.value = ""
        _searchLoading.value = false
        _searchAppending.value = false
    }

    private fun runSearch(cursor: String, append: Boolean) {
        val apiClient = lastApiClient ?: return
        val query = _query.value.trim()
        if (query.length < 2) {
            clearSearchState()
            return
        }

        searchGeneration += 1
        val generation = searchGeneration
        val scope = _searchScope.value
        val tag = _selectedSearchTag.value
        val favorite = _showFavorites.value

        viewModelScope.launch {
            if (append) _searchAppending.value = true else _searchLoading.value = true
            _searchError.value = ""
            try {
                val response = apiClient.search(
                    query = query,
                    scope = scope,
                    cursor = cursor,
                    tag = tag,
                    favorite = favorite,
                )
                if (generation != searchGeneration ||
                    query != _query.value.trim() ||
                    scope != _searchScope.value ||
                    tag != _selectedSearchTag.value ||
                    favorite != _showFavorites.value
                ) {
                    return@launch
                }
                _searchResults.value = if (append) {
                    dedupeSearchResults(_searchResults.value + response.items)
                } else {
                    response.items
                }
                _searchNextCursor.value = response.nextCursor
            } catch (error: Exception) {
                if (generation == searchGeneration) _searchError.value = error.message ?: strings.searchFailed
            } finally {
                if (generation == searchGeneration) {
                    if (append) _searchAppending.value = false else _searchLoading.value = false
                }
            }
        }
    }

    private fun applyFilters() {
        _conversations.value = filterSessionConversations(
            items = _allConversations.value,
            query = _query.value,
            showArchived = _showArchived.value,
            showFavorites = _showFavorites.value,
            tag = _selectedSearchTag.value,
            selectedTags = _selectedTags.value,
        )
    }

    companion object {
        fun sessionKey(provider: String, id: String): String = "$provider:$id"
        fun threadKeyFor(provider: String, sessionId: String): String = "history:$provider:$sessionId"

        fun dedupeSearchResults(items: List<SearchResult>): List<SearchResult> {
            val seen = linkedSetOf<String>()
            return items.filter { result ->
                seen.add(listOf(result.kind, result.id, result.turnId, result.path).joinToString(":"))
            }
        }

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

        private fun desktopStatusText(value: DesktopRemoteState?, strings: AppStrings): String {
            val desktop = value?.desktop ?: return strings.codexRemoteUnchecked
            return when {
                desktop.ready -> strings.codexRemoteReady
                desktop.found -> strings.codexRemoteWithReason(desktopReasonLabel(desktop.reason.ifBlank { "window found" }, strings))
                else -> strings.codexRemoteDisconnected
            }
        }

        private fun desktopReasonLabel(reason: String?, strings: AppStrings): String {
            val value = reason.orEmpty()
            return when {
                value.isBlank() -> strings.codexDesktopDisconnected
                value.equals("window found", ignoreCase = true) -> strings.codexDesktopFound
                value.contains("window was not found", ignoreCase = true) -> strings.codexDesktopWindowMissing
                value.contains("not connected", ignoreCase = true) -> strings.codexDesktopDisconnected
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
