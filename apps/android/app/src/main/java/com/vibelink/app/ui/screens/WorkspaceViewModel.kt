package com.vibelink.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.CommandResult
import com.vibelink.app.network.GitDiffResponse
import com.vibelink.app.network.GitStatusResponse
import com.vibelink.app.network.WorkspaceFileItem
import com.vibelink.app.network.WorkspaceFileResponse
import com.vibelink.app.network.WorkspaceItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class WorkspaceViewModel : ViewModel() {
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

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private val _commandRunning = MutableStateFlow(false)
    val commandRunning: StateFlow<Boolean> = _commandRunning.asStateFlow()

    private val _gitActionRunning = MutableStateFlow(false)
    val gitActionRunning: StateFlow<Boolean> = _gitActionRunning.asStateFlow()

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

    fun clearFilePreview() {
        _selectedFile.value = null
    }

    fun applyGitFileAction(apiClient: ApiClient, path: String, action: String) {
        val workspaceId = _selectedWorkspaceId.value
        if (workspaceId.isBlank() || path.isBlank()) return
        viewModelScope.launch {
            _gitActionRunning.value = true
            _error.value = ""
            try {
                apiClient.applyGitFileAction(workspaceId, path, action)
                loadWorkspaceDetails(apiClient, workspaceId, _currentDir.value)
            } catch (error: Exception) {
                _error.value = error.message ?: "Git action failed"
            } finally {
                _gitActionRunning.value = false
            }
        }
    }

    fun applyGitAction(apiClient: ApiClient, action: String) {
        val workspaceId = _selectedWorkspaceId.value
        if (workspaceId.isBlank()) return
        viewModelScope.launch {
            _gitActionRunning.value = true
            _error.value = ""
            try {
                apiClient.applyGitAction(workspaceId, action)
                loadWorkspaceDetails(apiClient, workspaceId, _currentDir.value)
            } catch (error: Exception) {
                _error.value = error.message ?: "Git action failed"
            } finally {
                _gitActionRunning.value = false
            }
        }
    }

    fun runCommand(apiClient: ApiClient, command: String) {
        val workspaceId = _selectedWorkspaceId.value
        val trimmed = command.trim()
        if (workspaceId.isBlank() || trimmed.isBlank()) return
        viewModelScope.launch {
            _commandRunning.value = true
            _error.value = ""
            try {
                _commandResult.value = apiClient.runCommand(workspaceId, trimmed)
                loadWorkspaceDetails(apiClient, workspaceId, _currentDir.value)
            } catch (error: Exception) {
                _error.value = error.message ?: "Command failed"
            } finally {
                _commandRunning.value = false
            }
        }
    }

    private suspend fun loadWorkspaceDetails(apiClient: ApiClient, workspaceId: String, dir: String) {
        _files.value = apiClient.getWorkspaceTree(workspaceId, dir).items
        _gitStatus.value = apiClient.getGitStatus(workspaceId)
        _gitDiff.value = apiClient.getGitDiff(workspaceId)
    }
}