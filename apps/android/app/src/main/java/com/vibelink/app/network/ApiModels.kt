package com.vibelink.app.network

import com.google.gson.annotations.SerializedName

// ── API Models ──

// ── Auth / Status ──

data class PublicSettings(
    @SerializedName("hasOpenAIKey") val hasOpenAIKey: Boolean = false,
    @SerializedName("hasAnthropicKey") val hasAnthropicKey: Boolean = false,
    @SerializedName("hasZhipuKey") val hasZhipuKey: Boolean = false,
    @SerializedName("defaultCwd") val defaultCwd: String = "",
)

data class LoginResponse(
    val ok: Boolean = false,
    val token: String = "",
    val device: DeviceInfo? = null,
    val settings: PublicSettings? = null,
)

data class DeviceInfo(
    val id: String = "",
    val label: String = "",
)

data class StatusResponse(
    val ok: Boolean = false,
    val status: String = "",
)

data class SimpleOk(
    val ok: Boolean = false,
)

// ── Live Calls ──

data class Session(
    val id: String = "",
    val status: String = "",
    val title: String = "",
    val source: String = "",
    @SerializedName("workspaceId") val workspaceId: String = "",
    @SerializedName("eventCursor") val eventCursor: Int = 0,
    @SerializedName("lastTranscript") val lastTranscript: String = "",
    @SerializedName("lastQuestion") val lastQuestion: String = "",
    @SerializedName("lastAnswer") val lastAnswer: String = "",
)

data class CreateSessionResponse(
    val ok: Boolean = false,
    val session: Session? = null,
)

data class SessionListResponse(
    val items: List<Session> = emptyList(),
)

data class LiveCallEvent(
    val question: String = "",
    val error: String = "",
    val id: String = "",
    val cursor: Int = 0,
    val type: String = "",
    val at: String = "",
    @SerializedName("sessionId") val sessionId: String = "",
    val text: String = "",
    val channel: String = "",
    val level: LevelData? = null,
    val speaker: String = "",
    val final: Boolean = false,
    @SerializedName("taskId") val taskId: String = "",
)

data class LevelData(
    val connected: Boolean = false,
    val bytes: Long = 0,
    val peak: Double = 0.0,
    val rms: Double = 0.0,
    @SerializedName("deviceName") val deviceName: String = "",
)

data class TranscriptBody(
    val text: String,
    val final: Boolean = true,
    val speaker: String = "remote",
)

// ── History (sessions) ──

data class HistoryListResponse(
    val items: List<HistoryItem> = emptyList(),
)

data class HistoryItem(
    val id: String = "",
    val provider: String = "",
    val title: String = "",
    @SerializedName("projectPath") val projectPath: String = "",
    @SerializedName("updatedAt") val updatedAt: String = "",
    val preview: String = "",
)

data class HistoryDetail(
    val id: String = "",
    val provider: String = "",
    val title: String = "",
    @SerializedName("projectPath") val projectPath: String = "",
    val transcript: List<TranscriptEntry> = emptyList(),
    val entries: List<Map<String, Any?>> = emptyList(),
    @SerializedName("sessionState") val sessionState: Map<String, Any?>? = null,
    @SerializedName("toolTaskId") val toolTaskId: String = "",
)

data class TranscriptEntry(
    val role: String = "",
    val text: String = "",
    @SerializedName("turnId") val turnId: String = "",
)

// ── Tasks ──

data class TaskListResponse(
    val items: List<TaskSummary> = emptyList(),
)

data class TaskSummary(
    val id: String = "",
    val agent: String = "",
    val title: String = "",
    val cwd: String = "",
    val status: String = "",
    @SerializedName("createdAt") val createdAt: String = "",
    @SerializedName("updatedAt") val updatedAt: String = "",
    @SerializedName("sessionId") val sessionId: String = "",
)

data class TaskDetail(
    val id: String = "",
    val agent: String = "",
    val title: String = "",
    val cwd: String = "",
    val status: String = "",
    @SerializedName("sessionId") val sessionId: String = "",
    val events: List<TaskEvent> = emptyList(),
)

data class TaskEvent(
    val id: String = "",
    val type: String = "",
    val text: String = "",
    val cursor: Int = 0,
)


// Workspace / Git

data class WorkspaceListResponse(
    val items: List<WorkspaceItem> = emptyList(),
)

data class WorkspaceItem(
    val id: String = "",
    val title: String = "",
    val path: String = "",
    @SerializedName("allowedRoot") val allowedRoot: String = "",
    @SerializedName("updatedAt") val updatedAt: String = "",
    @SerializedName("lastUsedAt") val lastUsedAt: String = "",
)

data class WorkspaceTreeResponse(
    val ok: Boolean = false,
    val workspace: WorkspaceItem? = null,
    val dir: String = "",
    val items: List<WorkspaceFileItem> = emptyList(),
)

data class WorkspaceFileItem(
    val name: String = "",
    val path: String = "",
    val type: String = "",
    val size: Long = 0,
    @SerializedName("updatedAt") val updatedAt: String = "",
)

data class WorkspaceFileResponse(
    val ok: Boolean = false,
    val workspace: WorkspaceItem? = null,
    val path: String = "",
    @SerializedName("absolutePath") val absolutePath: String = "",
    val size: Long = 0,
    @SerializedName("updatedAt") val updatedAt: String = "",
    val text: String = "",
    val binary: Boolean = false,
)


data class GitStatusResponse(
    val ok: Boolean = false,
    val workspace: WorkspaceItem? = null,
    val branch: String = "",
    val files: List<GitStatusItem> = emptyList(),
    @SerializedName("changedCount") val changedCount: Int = 0,
    val stdout: String = "",
    val stderr: String = "",
    @SerializedName("exitCode") val exitCode: Int = 0,
)

data class GitStatusItem(
    val path: String = "",
    val status: String = "",
    @SerializedName("oldPath") val oldPath: String = "",
    val additions: Int = 0,
    val deletions: Int = 0,
)

data class GitDiffResponse(
    val ok: Boolean = false,
    val workspace: WorkspaceItem? = null,
    val cwd: String = "",
    val branch: String = "",
    val files: List<GitStatusItem> = emptyList(),
    @SerializedName("changedCount") val changedCount: Int = 0,
    @SerializedName("fileCount") val fileCount: Int = 0,
    @SerializedName("lineCount") val lineCount: Int = 0,
    val diff: String = "",
    val stdout: String = "",
    val stderr: String = "",
    @SerializedName("exitCode") val exitCode: Int = 0,
)

data class CommandRequest(
    val command: String,
    val kind: String = "command",
    val timeoutMs: Long = 120000,
)

data class CommandResult(
    val ok: Boolean = false,
    val workspace: WorkspaceItem? = null,
    val cwd: String = "",
    val command: String = "",
    val stdout: String = "",
    val stderr: String = "",
    @SerializedName("exitCode") val exitCode: Int = 0,
)


data class GitFileActionRequest(
    val action: String,
    val path: String,
)

data class GitActionRequest(
    val action: String,
    val message: String = "",
    val title: String = "",
)

data class GitActionResponse(
    val ok: Boolean = false,
    val action: String = "",
    val path: String = "",
    val workspace: WorkspaceItem? = null,
    val cwd: String = "",
    val stdout: String = "",
    val stderr: String = "",
    val summary: GitDiffResponse? = null,
    @SerializedName("toolRunId") val toolRunId: String = "",
)

// ── Tool Events ──

data class ToolEventListResponse(
    val items: List<ToolEvent> = emptyList(),
)

data class ToolEvent(
    val id: String = "",
    val type: String = "",
    val cursor: Int = 0,
    @SerializedName("toolRunId") val toolRunId: String = "",
    val payload: Map<String, Any?>? = null,
    val text: String = "",
)

// ── UI Models ──

/**
 * Merged conversation item displayed in the session list.
 */
data class ConversationItem(
    val key: String = "",
    val kind: String = "",         // "task" | "history"
    val id: String = "",
    val provider: String = "",
    val title: String = "",
    val cwd: String = "",
    val status: String = "",       // "running" | "completed" | "failed" | "history"
    @SerializedName("updatedAt") val updatedAt: String = "",
    @SerializedName("sessionId") val sessionId: String = "",
    val preview: String = "",
)

/**
 * Rendered chat message with optional tool calls.
 */
data class ChatMessage(
    val role: String = "",         // "user" | "assistant" | "system" | "error"
    val text: String = "",
    val toolCalls: List<ToolCallSummary> = emptyList(),
    @SerializedName("toolCallCount") val toolCallCount: Int = 0,
)

data class ToolCallSummary(
    val id: String = "",
    val name: String = "",
    val label: String = "",
    val kind: String = "",
    val status: String = "",
    val input: Map<String, Any?>? = null,
    val output: String = "",
    @SerializedName("outputEvents") val outputEvents: List<ToolOutputEvent> = emptyList(),
)

data class ToolOutputEvent(
    val cursor: Int = 0,
    val stream: String = "",
    val text: String = "",
)
