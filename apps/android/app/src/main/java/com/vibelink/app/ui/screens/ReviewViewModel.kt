package com.vibelink.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.GitDiffResponse
import com.vibelink.app.network.ReviewComment
import com.vibelink.app.network.ReviewCommentRequest
import com.vibelink.app.network.ReviewCreateRequest
import com.vibelink.app.network.ReviewSession
import com.vibelink.app.network.WorkspaceItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class ReviewDiffFile(
    val path: String,
    val status: String = "",
    val additions: Int = 0,
    val deletions: Int = 0,
)

class ReviewViewModel : ViewModel() {
    private val _workspaces = MutableStateFlow<List<WorkspaceItem>>(emptyList())
    val workspaces: StateFlow<List<WorkspaceItem>> = _workspaces.asStateFlow()
    private val _reviews = MutableStateFlow<List<ReviewSession>>(emptyList())
    val reviews: StateFlow<List<ReviewSession>> = _reviews.asStateFlow()
    private val _selectedWorkspace = MutableStateFlow<WorkspaceItem?>(null)
    val selectedWorkspace: StateFlow<WorkspaceItem?> = _selectedWorkspace.asStateFlow()
    private val _selectedReview = MutableStateFlow<ReviewSession?>(null)
    val selectedReview: StateFlow<ReviewSession?> = _selectedReview.asStateFlow()
    private val _diff = MutableStateFlow<GitDiffResponse?>(null)
    val diff: StateFlow<GitDiffResponse?> = _diff.asStateFlow()
    private val _severity = MutableStateFlow("all")
    val severity: StateFlow<String> = _severity.asStateFlow()
    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()
    private val _error = MutableStateFlow("")
    val error: StateFlow<String> = _error.asStateFlow()

    fun load(apiClient: ApiClient) {
        viewModelScope.launch {
            _loading.value = true
            _error.value = ""
            runCatching {
                val workspaces = apiClient.listWorkspaces()
                _workspaces.value = workspaces
                _selectedWorkspace.value = _selectedWorkspace.value?.let { current -> workspaces.firstOrNull { it.id == current.id } } ?: workspaces.firstOrNull()
                _reviews.value = apiClient.listReviews()
                _selectedWorkspace.value?.let { _diff.value = apiClient.getGitDiff(it.id) }
            }.onFailure { _error.value = it.message ?: "Failed to load reviews" }
            _loading.value = false
        }
    }

    fun selectWorkspace(apiClient: ApiClient, workspace: WorkspaceItem) {
        _selectedWorkspace.value = workspace
        viewModelScope.launch { runCatching { _diff.value = apiClient.getGitDiff(workspace.id) }.onFailure { _error.value = it.message ?: "Failed to load diff" } }
    }

    fun selectReview(apiClient: ApiClient, review: ReviewSession) {
        _selectedReview.value = review
        _selectedWorkspace.value = _workspaces.value.firstOrNull { it.id == review.workspaceId } ?: _selectedWorkspace.value
        viewModelScope.launch { runCatching { _diff.value = _selectedWorkspace.value?.let { apiClient.getGitDiff(it.id) } }.onFailure { _error.value = it.message ?: "Failed to restore review" } }
    }

    fun createReview(apiClient: ApiClient, title: String, branch: String) {
        val workspace = _selectedWorkspace.value ?: return
        viewModelScope.launch {
            _loading.value = true
            runCatching {
                val created = apiClient.createReview(ReviewCreateRequest(workspace.id, branch.trim().ifBlank { _diff.value?.branch.orEmpty() }, title.trim().ifBlank { "PR Review" }))
                val files = _diff.value?.files.orEmpty().map { mapOf("path" to it.path, "status" to it.status, "additions" to it.additions, "deletions" to it.deletions) }
                val saved = apiClient.updateReview(created.id, mapOf("files" to files))
                _selectedReview.value = saved
                _reviews.value = listOf(saved) + _reviews.value.filterNot { it.id == saved.id }
            }.onFailure { _error.value = it.message ?: "Failed to create review" }
            _loading.value = false
        }
    }

    fun addComment(apiClient: ApiClient, file: String, line: Int, body: String, severity: String) {
        val review = _selectedReview.value ?: return
        if (body.trim().isBlank()) return
        viewModelScope.launch {
            runCatching { apiClient.addReviewComment(review.id, ReviewCommentRequest(file, line, body.trim(), severity)) }
                .onSuccess { updated -> _selectedReview.value = updated; _reviews.value = _reviews.value.map { if (it.id == updated.id) updated else it } }
                .onFailure { _error.value = it.message ?: "Failed to add comment" }
        }
    }

    fun setSeverity(value: String) { _severity.value = value }

    fun visibleComments(): List<ReviewComment> {
        val filter = _severity.value
        return _selectedReview.value?.comments.orEmpty().filter { filter == "all" || it.severity == filter }
    }
}

