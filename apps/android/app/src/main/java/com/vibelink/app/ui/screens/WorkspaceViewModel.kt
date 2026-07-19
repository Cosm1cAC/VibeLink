package com.vibelink.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ApiException
import com.vibelink.app.network.ApprovalDecisionResponse
import com.vibelink.app.network.CommandResult
import com.vibelink.app.network.GitDiffResponse
import com.vibelink.app.network.GitStatusResponse
import com.vibelink.app.network.TerminalSessionInfo
import com.vibelink.app.network.ToolEvent
import com.vibelink.app.network.WorkspaceFileItem
import com.vibelink.app.network.WorkspaceFileResponse
import com.vibelink.app.network.WorkspaceItem
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class WorkspaceTerminalUiState(
    val sessionId: String = "",
    val status: String = "idle",
    val mode: String = "",
    val shell: String = "",
    val cwd: String = "",
    val output: String = "",
    val cursor: Int = 0,
    val supportsResize: Boolean = false,
)

class WorkspaceViewModel : ViewModel() {
    private var resiliencePaused = false
    private val _workspaces = MutableStateFlow<List<WorkspaceItem>>(emptyList())
    val workspaces: StateFlow<List<WorkspaceItem>> = _workspaces.asStateFlow()

    private val _selectedWorkspaceId = MutableStateFlow("")
    val selectedWorkspaceId: StateFlow<String> = _selectedWorkspaceId.asStateFlow()

    private val _currentDir = MutableStateFlow("")
    val currentDir: StateFlow<String> = _currentDir.asStateFlow()

    private val _files = MutableStateFlow<List<WorkspaceFileItem>>(emptyList())
    val files: StateFlow<List<WorkspaceFileItem>> = _files.asStateFlow()

    private val _selectedFile = MutableStateFlow<WorkspaceFileResponse?>(null)
    val selectedFile: StateFlow<WorkspaceFileResponse?> = _selectedFile.asStateFlow()

    private val _gitStatus = MutableStateFlow<GitStatusResponse?>(null)
    val gitStatus: StateFlow<GitStatusResponse?> = _gitStatus.asStateFlow()

    private val _gitDiff = MutableStateFlow<GitDiffResponse?>(null)
    val gitDiff: StateFlow<GitDiffResponse?> = _gitDiff.asStateFlow()

    private val _commandResult = MutableStateFlow<CommandResult?>(null)
    val commandResult: StateFlow<CommandResult?> = _commandResult.asStateFlow()

    private val _testResult = MutableStateFlow<CommandResult?>(null)
    val testResult: StateFlow<CommandResult?> = _testResult.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private val _commandRunning = MutableStateFlow(false)
    val commandRunning: StateFlow<Boolean> = _commandRunning.asStateFlow()

    private val _gitActionRunning = MutableStateFlow(false)
    val gitActionRunning: StateFlow<Boolean> = _gitActionRunning.asStateFlow()

    private val _terminal = MutableStateFlow(WorkspaceTerminalUiState())
    val terminal: StateFlow<WorkspaceTerminalUiState> = _terminal.asStateFlow()

    private val _pendingApproval = MutableStateFlow<WorkspaceApprovalNotice?>(null)
    val pendingApproval: StateFlow<WorkspaceApprovalNotice?> = _pendingApproval.asStateFlow()

    private var terminalPollJob: Job? = null

    fun setResiliencePaused(paused: Boolean) {
        if (resiliencePaused == paused) return
        resiliencePaused = paused
        if (paused) {
            terminalPollJob?.cancel()
            terminalPollJob = null
        }
    }

    private val _error = MutableStateFlow("")
    val error: StateFlow<String> = _error.asStateFlow()

    fun load(apiClient: ApiClient, isRefresh: Boolean = false) {
        viewModelScope.launch {
            if (isRefresh) _refreshing.value = true else _loading.value = true
            _error.value = ""
            try {
                val items = apiClient.listWorkspaces()
                _workspaces.value = items
                val selected = items.firstOrNull { it.id == _selectedWorkspaceId.value } ?: items.firstOrNull()
                _selectedWorkspaceId.value = selected?.id.orEmpty()
                if (selected != null) loadWorkspaceDetails(apiClient, selected.id, _currentDir.value)
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to load workspaces"
            } finally {
                _loading.value = false
                _refreshing.value = false
            }
        }
    }

    fun selectWorkspace(apiClient: ApiClient, workspaceId: String) {
        if (workspaceId == _selectedWorkspaceId.value) return
        viewModelScope.launch {
            terminalPollJob?.cancel()
            _terminal.value = WorkspaceTerminalUiState()
            _pendingApproval.value = null
            _selectedWorkspaceId.value = workspaceId
            _currentDir.value = ""
            _selectedFile.value = null
            _error.value = ""
            _refreshing.value = true
            try {
                loadWorkspaceDetails(apiClient, workspaceId, "")
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to load workspace"
            } finally {
                _refreshing.value = false
            }
        }
    }

    fun refreshSelected(apiClient: ApiClient) {
        val workspaceId = _selectedWorkspaceId.value
        if (workspaceId.isBlank()) {
            load(apiClient, isRefresh = true)
            return
        }
        viewModelScope.launch {
            _refreshing.value = true
            _error.value = ""
            try {
                loadWorkspaceDetails(apiClient, workspaceId, _currentDir.value)
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to refresh workspace"
            } finally {
                _refreshing.value = false
            }
        }
    }

    fun openDirectory(apiClient: ApiClient, path: String) {
        val workspaceId = _selectedWorkspaceId.value
        if (workspaceId.isBlank()) return
        viewModelScope.launch {
            _refreshing.value = true
            _error.value = ""
            try {
                _currentDir.value = path
                _selectedFile.value = null
                loadWorkspaceDetails(apiClient, workspaceId, path)
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to open directory"
            } finally {
                _refreshing.value = false
            }
        }
    }

    fun openParentDirectory(apiClient: ApiClient) {
        val current = _currentDir.value.trim('/').trim()
        if (current.isBlank()) return
        val parent = current.substringBeforeLast('/', "")
        openDirectory(apiClient, parent)
    }

    fun openFile(apiClient: ApiClient, path: String) {
        val workspaceId = _selectedWorkspaceId.value
        if (workspaceId.isBlank()) return
        viewModelScope.launch {
            _error.value = ""
            try {
                _selectedFile.value = apiClient.getWorkspaceFile(workspaceId, path)
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to open file"
            }
        }
    }

    fun openFileReference(apiClient: ApiClient, reference: String) {
        val rawPath = reference.trim().replace('\\', '/').replace(Regex(":\\d+$"), "")
        if (rawPath.isBlank()) return
        viewModelScope.launch {
            _refreshing.value = true
            _error.value = ""
            try {
                val items = _workspaces.value.ifEmpty {
                    apiClient.listWorkspaces().also { _workspaces.value = it }
                }
                val selected = items.firstOrNull { it.id == _selectedWorkspaceId.value }
                    ?: items.firstOrNull { workspace ->
                        val root = workspace.path.replace('\\', '/').trimEnd('/')
                        root.isNotBlank() && rawPath.startsWith("$root/")
                    }
                    ?: items.firstOrNull()
                val workspaceId = selected?.id.orEmpty()
                if (workspaceId.isBlank()) return@launch

                val root = selected?.path.orEmpty().replace('\\', '/').trimEnd('/')
                val relativePath = if (root.isNotBlank() && rawPath.startsWith("$root/")) {
                    rawPath.removePrefix("$root/")
                } else {
                    rawPath.trimStart('/')
                }
                _selectedWorkspaceId.value = workspaceId
                _currentDir.value = relativePath.substringBeforeLast('/', "")
                _selectedFile.value = apiClient.getWorkspaceFile(workspaceId, relativePath)
                loadWorkspaceDetails(apiClient, workspaceId, _currentDir.value)
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to open file reference"
            } finally {
                _refreshing.value = false
            }
        }
    }

    fun openSearchFile(apiClient: ApiClient, workspaceId: String, path: String) {
        val cleanPath = path.trim().replace('\\', '/').trimStart('/')
        if (workspaceId.isBlank() || cleanPath.isBlank()) return
        _selectedWorkspaceId.value = workspaceId
        _currentDir.value = cleanPath.substringBeforeLast('/', "")
        viewModelScope.launch {
            _refreshing.value = true
            _error.value = ""
            try {
                val items = _workspaces.value.ifEmpty {
                    apiClient.listWorkspaces().also { _workspaces.value = it }
                }
                val workspace = items.firstOrNull { it.id == workspaceId }
                    ?: error("The workspace for this search result is no longer available")
                _selectedFile.value = apiClient.getWorkspaceFile(workspace.id, cleanPath)
                loadWorkspaceDetails(apiClient, workspace.id, _currentDir.value)
            } catch (error: Exception) {
                _error.value = error.message ?: "Failed to open search result"
            } finally {
                _refreshing.value = false
            }
        }
    }

    fun clearFilePreview() {
        _selectedFile.value = null
    }

    fun mutateFile(apiClient: ApiClient, action: String, path: String, text: String = "", nextPath: String = "") {
        val workspaceId = _selectedWorkspaceId.value
        if (workspaceId.isBlank() || path.trim().isBlank()) return
        val baseFile = _selectedFile.value?.takeIf { it.path == path.trim() }
        viewModelScope.launch {
            _refreshing.value = true
            _error.value = ""
            try {
                val result = apiClient.mutateWorkspaceFile(
                    workspaceId = workspaceId,
                    action = action,
                    path = path.trim(),
                    text = text,
                    nextPath = nextPath.trim(),
                    expectedRevision = baseFile?.revision?.takeIf { it.isNotBlank() },
                    requireAbsent = action == "write" && baseFile == null,
                )
                _selectedFile.value = when (result.action) {
                    "delete" -> null
                    else -> apiClient.getWorkspaceFile(workspaceId, result.path)
                }
                loadWorkspaceDetails(apiClient, workspaceId, _currentDir.value)
            } catch (error: ApiException) {
                if (error.statusCode == 409) {
                    val latest = runCatching { apiClient.getWorkspaceFile(workspaceId, path.trim()) }.getOrNull()
                    _selectedFile.value = if (action == "write" && baseFile != null && latest != null) {
                        val merged = RevisionConflictPolicy.mergeWorkspaceText(baseFile.text, text, latest.text)
                        latest.copy(text = merged.text)
                    } else {
                        latest
                    }
                    runCatching { loadWorkspaceDetails(apiClient, workspaceId, _currentDir.value) }
                    _error.value = "File changed on another device. Latest content was refreshed and local edits were preserved for review."
                } else {
                    _error.value = error.message ?: "Workspace file action failed"
                }
            } catch (error: Exception) {
                _error.value = error.message ?: "Workspace file action failed"
            } finally {
                _refreshing.value = false
            }
        }
    }

    fun createWorktree(apiClient: ApiClient, branchName: String, baseRef: String = "HEAD", title: String = "") {
        val workspaceId = _selectedWorkspaceId.value
        val trimmedBranch = branchName.trim()
        if (workspaceId.isBlank() || trimmedBranch.isBlank()) return
        viewModelScope.launch {
            _gitActionRunning.value = true
            _error.value = ""
            try {
                val result = apiClient.createWorkspaceWorktree(
                    workspaceId = workspaceId,
                    branchName = trimmedBranch,
                    baseRef = baseRef.trim().ifBlank { "HEAD" },
                    title = title.trim(),
                )
                val items = apiClient.listWorkspaces()
                _workspaces.value = items
                val nextWorkspaceId = result.workspace.id.ifBlank { workspaceId }
                _selectedWorkspaceId.value = nextWorkspaceId
                _currentDir.value = ""
                _selectedFile.value = null
                loadWorkspaceDetails(apiClient, nextWorkspaceId, "")
            } catch (error: Exception) {
                _error.value = error.message ?: "Worktree creation failed"
            } finally {
                _gitActionRunning.value = false
            }
        }
    }

    fun applyGitFileAction(apiClient: ApiClient, path: String, action: String, patch: String = "") {
        val workspaceId = _selectedWorkspaceId.value
        if (workspaceId.isBlank() || path.isBlank()) return
        viewModelScope.launch {
            _gitActionRunning.value = true
            _error.value = ""
            try {
                apiClient.applyGitFileAction(workspaceId, path, action, patch)
                loadWorkspaceDetails(apiClient, workspaceId, _currentDir.value)
            } catch (error: Exception) {
                _error.value = error.message ?: "Git action failed"
            } finally {
                _gitActionRunning.value = false
            }
        }
    }

    fun applyGitAction(
        apiClient: ApiClient,
        action: String,
        message: String = "",
        title: String = "",
        branchName: String = "",
        baseRef: String = "HEAD",
    ) {
        val workspaceId = _selectedWorkspaceId.value
        if (workspaceId.isBlank()) return
        viewModelScope.launch {
            _gitActionRunning.value = true
            _error.value = ""
            try {
                apiClient.applyGitAction(
                    workspaceId,
                    action,
                    message = message,
                    title = title,
                    branchName = branchName,
                    baseRef = baseRef,
                )
                loadWorkspaceDetails(apiClient, workspaceId, _currentDir.value)
            } catch (error: Exception) {
                _error.value = error.message ?: "Git action failed"
            } finally {
                _gitActionRunning.value = false
            }
        }
    }

    fun runCommand(apiClient: ApiClient, command: String, kind: String = "command") {
        val workspaceId = _selectedWorkspaceId.value
        val trimmed = command.trim()
        if (workspaceId.isBlank() || trimmed.isBlank()) return
        viewModelScope.launch {
            _commandRunning.value = true
            _error.value = ""
            _pendingApproval.value = null
            try {
                val result = apiClient.runCommand(workspaceId, trimmed, kind = kind)
                if (kind == "test") _testResult.value = result else _commandResult.value = result
                loadWorkspaceDetails(apiClient, workspaceId, _currentDir.value)
            } catch (error: ApiException) {
                val notice = WorkspaceApprovalHandoff.commandNoticeFromException(error)
                if (notice == null) {
                    _error.value = error.message ?: "Command failed"
                } else {
                    _pendingApproval.value = notice
                    _error.value = notice.message
                }
            } catch (error: Exception) {
                _error.value = error.message ?: "Command failed"
            } finally {
                _commandRunning.value = false
            }
        }
    }

    fun startTerminal(apiClient: ApiClient, shell: String = "", mode: String = "auto") {
        val workspaceId = _selectedWorkspaceId.value
        if (workspaceId.isBlank()) return
        viewModelScope.launch {
            _error.value = ""
            _pendingApproval.value = null
            try {
                val result = apiClient.startTerminalSession(workspaceId, shell = shell.trim(), mode = mode)
                val sessionId = result.toolRunId.ifBlank { result.session?.id.orEmpty() }
                if (sessionId.isBlank()) error("Terminal session did not return an id")
                _terminal.value = terminalState(result.session, sessionId, output = "")
                pollTerminal(apiClient, sessionId)
            } catch (error: ApiException) {
                val notice = WorkspaceApprovalHandoff.noticeFromException(error)
                if (notice == null) {
                    _error.value = error.message ?: "Terminal session failed to start"
                } else {
                    _pendingApproval.value = notice
                    _terminal.value = WorkspaceTerminalUiState(
                        sessionId = notice.toolRunId,
                        status = "approval_required",
                    )
                    _error.value = notice.message
                }
            } catch (error: Exception) {
                _error.value = error.message ?: "Terminal session failed to start"
            }
        }
    }

    fun applyApprovalDecision(apiClient: ApiClient, response: ApprovalDecisionResponse): Boolean {
        val approvalKind = response.approval?.kind.orEmpty()
        if (approvalKind in setOf("workspace.command", "workspace.test")) {
            val approval = response.approval ?: return false
            val pending = _pendingApproval.value
            if (pending != null && pending.approvalId != approval.id) return false
            _pendingApproval.value = null
            if (approval.status == "denied") {
                _error.value = "Command approval ${approval.id.take(8)} was denied."
                return true
            }
            val result = response.result
            if (result == null) {
                _error.value = response.error.ifBlank { "Approved command did not return a result." }
                return true
            }
            val commandResult = CommandResult(
                ok = result.ok,
                workspace = result.workspace,
                cwd = result.cwd,
                command = result.command,
                stdout = result.stdout,
                stderr = result.stderr,
                exitCode = result.exitCode,
                test = result.test,
            )
            if (approvalKind == "workspace.test") _testResult.value = commandResult else _commandResult.value = commandResult
            _error.value = ""
            viewModelScope.launch { runCatching { loadWorkspaceDetails(apiClient, _selectedWorkspaceId.value, _currentDir.value) } }
            return true
        }
        if (!WorkspaceApprovalHandoff.isTerminalDecision(response)) return false
        val approval = response.approval ?: return false
        val pending = _pendingApproval.value
        if (pending != null && pending.approvalId != approval.id) return false
        if (approval.workspaceId.isNotBlank() && approval.workspaceId != _selectedWorkspaceId.value) return false

        if (approval.status == "denied") {
            _pendingApproval.value = null
            _terminal.value = WorkspaceTerminalUiState()
            _error.value = "Terminal approval ${approval.id.take(8)} was denied."
            return true
        }

        val handoff = WorkspaceApprovalHandoff.approvedTerminalFrom(response)
        if (handoff == null) {
            _error.value = response.error.ifBlank { "Approved terminal did not return a session." }
            return true
        }

        _pendingApproval.value = null
        _error.value = ""
        _terminal.value = terminalState(
            session = handoff.session,
            sessionId = handoff.toolRunId,
            output = "",
            fallbackStatus = handoff.status,
        )
        pollTerminal(apiClient, handoff.toolRunId)
        return true
    }

    fun sendTerminalInput(apiClient: ApiClient, text: String) {
        val sessionId = _terminal.value.sessionId
        if (sessionId.isBlank() || text.isBlank()) return
        viewModelScope.launch {
            _error.value = ""
            try {
                apiClient.sendTerminalInput(sessionId, if (text.endsWith("\n")) text else "$text\n")
            } catch (error: Exception) {
                _error.value = error.message ?: "Terminal input failed"
            }
        }
    }

    fun resizeTerminal(apiClient: ApiClient, cols: Int, rows: Int) {
        val sessionId = _terminal.value.sessionId
        if (sessionId.isBlank()) return
        viewModelScope.launch {
            try {
                apiClient.resizeTerminalSession(sessionId, cols.coerceIn(20, 400), rows.coerceIn(5, 200))
            } catch (error: Exception) {
                _error.value = error.message ?: "Terminal resize failed"
            }
        }
    }

    fun stopTerminal(apiClient: ApiClient) {
        val sessionId = _terminal.value.sessionId
        if (sessionId.isBlank()) return
        viewModelScope.launch {
            try {
                apiClient.stopTerminalSession(sessionId)
                refreshTerminal(apiClient, sessionId)
            } catch (error: Exception) {
                _error.value = error.message ?: "Terminal stop failed"
            }
        }
    }

    private fun pollTerminal(apiClient: ApiClient, sessionId: String) {
        terminalPollJob?.cancel()
        terminalPollJob = viewModelScope.launch {
            while (isActive && _terminal.value.sessionId == sessionId) {
                refreshTerminal(apiClient, sessionId)
                if (_terminal.value.status !in setOf("running", "starting", "pending")) break
                delay(700)
            }
        }
    }

    private suspend fun refreshTerminal(apiClient: ApiClient, sessionId: String) {
        val current = _terminal.value
        val detail = apiClient.getToolRun(sessionId, after = current.cursor)
        val events = detail.events.sortedBy { it.cursor }
        val cursor = events.maxOfOrNull { it.cursor } ?: current.cursor
        val output = appendTerminalOutput(current.output, events)
        val session = runCatching { apiClient.getTerminalSession(sessionId).session }.getOrNull()
        val toolStatus = detail.toolRun?.get("status")?.toString().orEmpty()
        _terminal.value = terminalState(
            session = session,
            sessionId = sessionId,
            output = output,
            cursor = cursor,
            fallbackStatus = toolStatus.ifBlank { current.status },
        )
    }

    override fun onCleared() {
        terminalPollJob?.cancel()
        super.onCleared()
    }

    private suspend fun loadWorkspaceDetails(apiClient: ApiClient, workspaceId: String, dir: String) {
        _files.value = apiClient.getWorkspaceTree(workspaceId, dir).items
        _gitStatus.value = apiClient.getGitStatus(workspaceId)
        _gitDiff.value = apiClient.getGitDiff(workspaceId)
    }
}

private fun terminalState(
    session: TerminalSessionInfo?,
    sessionId: String,
    output: String,
    cursor: Int = 0,
    fallbackStatus: String = "running",
): WorkspaceTerminalUiState = WorkspaceTerminalUiState(
    sessionId = sessionId,
    status = session?.status?.ifBlank { fallbackStatus } ?: fallbackStatus,
    mode = session?.mode.orEmpty(),
    shell = session?.shell.orEmpty(),
    cwd = session?.cwd.orEmpty(),
    output = output,
    cursor = cursor,
    supportsResize = session?.supportsResize == true,
)

private fun appendTerminalOutput(current: String, events: List<ToolEvent>): String {
    val appended = events
        .asSequence()
        .filter { it.type == "tool.output" }
        .joinToString(separator = "") { it.text }
    return (current + appended).takeLast(100_000)
}
