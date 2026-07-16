package com.vibelink.app.network

import com.google.gson.annotations.SerializedName

// ── API Models ──

// ── Auth / Status ──

data class PublicSettings(
    @SerializedName("hasOpenAIKey") val hasOpenAIKey: Boolean = false,
    @SerializedName("hasAnthropicKey") val hasAnthropicKey: Boolean = false,
    @SerializedName("hasZhipuKey") val hasZhipuKey: Boolean = false,
    @SerializedName("defaultCwd") val defaultCwd: String = "",
    @SerializedName("permissionMode") val permissionMode: String = "",
    @SerializedName("codexCommand") val codexCommand: String = "",
    @SerializedName("claudeCommand") val claudeCommand: String = "",
    @SerializedName("doubaoCommand") val doubaoCommand: String = "",
    @SerializedName("doubaoCdpEndpoint") val doubaoCdpEndpoint: String = "",
    @SerializedName("doubaoUrl") val doubaoUrl: String = "",
    val security: SecuritySettings = SecuritySettings(),
    @SerializedName("hostAllowlist") val hostAllowlist: List<String> = emptyList(),
    @SerializedName("allowTryCloudflare") val allowTryCloudflare: Boolean = true,
    @SerializedName("allowLegacyPairingTokenLogin") val allowLegacyPairingTokenLogin: Boolean = false,
    @SerializedName("notificationEmailConfigured") val notificationEmailConfigured: Boolean = false,
    @SerializedName("webPush") val webPush: WebPushSettings = WebPushSettings(),
    @SerializedName("nativePush") val nativePush: NativePushSettings = NativePushSettings(),
    @SerializedName("toolEvents") val toolEvents: ToolEventsSettings = ToolEventsSettings(),
    val mcp: McpSettings = McpSettings(),
)

data class SecuritySettings(
    @SerializedName("sandboxMode") val sandboxMode: String = "workspace-write",
    @SerializedName("approvalPolicy") val approvalPolicy: String = "on-request",
    @SerializedName("networkAccess") val networkAccess: Boolean = true,
    @SerializedName("requireTrustedWorkspace") val requireTrustedWorkspace: Boolean = true,
    @SerializedName("requireDangerousCommandApproval") val requireDangerousCommandApproval: Boolean = true,
    @SerializedName("trustedWorkspaces") val trustedWorkspaces: List<String> = emptyList(),
)

data class WebPushSettings(
    val enabled: Boolean = false,
    @SerializedName("publicKey") val publicKey: String = "",
)

data class NativePushSettings(
    val provider: String = "fcm",
    @SerializedName("fcmProjectId") val fcmProjectId: String = "",
    val configured: Boolean = false,
)

data class ToolEventsSettings(
    @SerializedName("retentionDays") val retentionDays: Int = 30,
    @SerializedName("keepLatest") val keepLatest: Int = 5000,
    @SerializedName("autoPrune") val autoPrune: Boolean = true,
    @SerializedName("autoPruneIntervalMinutes") val autoPruneIntervalMinutes: Int = 360,
)

data class McpSettings(
    @SerializedName("probeTimeoutMs") val probeTimeoutMs: Int = 10000,
    val servers: List<McpServerInfo> = emptyList(),
)

data class McpSettingsPatch(
    @SerializedName("probeTimeoutMs") val probeTimeoutMs: Int? = null,
    val servers: List<McpServerInfo>? = null,
)

data class NativePushSettingsPatch(
    val provider: String = "fcm",
    @SerializedName("fcmProjectId") val fcmProjectId: String = "",
    @SerializedName("fcmServiceAccountJson") val fcmServiceAccountJson: String? = null,
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

data class PairingSession(
    val id: String = "",
    val code: String = "",
    val status: String = "",
    val label: String = "",
)

data class CreatePairingSessionResponse(
    val ok: Boolean = false,
    val session: PairingSession? = null,
    val pairingUrl: String = "",
)

data class PairingStatusResponse(
    val ok: Boolean = false,
    val session: PairingSession? = null,
)

data class PairingSessionListResponse(
    val items: List<PairingSession> = emptyList(),
)

data class ClaimPairingResponse(
    val ok: Boolean = false,
    val token: String = "",
    val device: DeviceInfo? = null,
    val session: PairingSession? = null,
    val settings: PublicSettings? = null,
)

data class StatusResponse(
    val ok: Boolean = false,
    val status: String = "",
    val settings: PublicSettings? = null,
    @SerializedName("providerRegistry") val providerRegistry: ProviderRegistryResponse = ProviderRegistryResponse(),
    val tasks: List<TaskSummary> = emptyList(),
    val workspaces: List<WorkspaceItem> = emptyList(),
    val network: List<NetworkAddress> = emptyList(),
)

data class DeviceListResponse(
    val items: List<DeviceAdminItem> = emptyList(),
    @SerializedName("currentDeviceId") val currentDeviceId: String = "",
)

data class DeviceAdminItem(
    val id: String = "",
    val label: String = "",
    @SerializedName("createdAt") val createdAt: String = "",
    @SerializedName("lastSeenAt") val lastSeenAt: String = "",
    @SerializedName("revokedAt") val revokedAt: String = "",
    @SerializedName("expiresAt") val expiresAt: String = "",
    @SerializedName("rotatedAt") val rotatedAt: String = "",
    val expired: Boolean = false,
)

data class AuditLogListResponse(
    val items: List<AuditLogItem> = emptyList(),
)

data class AuditLogItem(
    val cursor: Int = 0,
    val type: String = "",
    val at: String = "",
    @SerializedName("deviceId") val deviceId: String = "",
    val ip: String = "",
    @SerializedName("userAgent") val userAgent: String = "",
    val method: String = "",
    val path: String = "",
    val success: Boolean = false,
    val reason: String = "",
    val target: String = "",
    val meta: Map<String, Any?>? = null,
)

data class McpStatusResponse(
    val ok: Boolean = false,
    val configured: Int = 0,
    val enabled: Int = 0,
    val servers: List<McpServerInfo> = emptyList(),
    @SerializedName("cachedTools") val cachedTools: Int = 0,
    @SerializedName("probeTimeoutMs") val probeTimeoutMs: Int = 0,
    @SerializedName("toolRunId") val toolRunId: String = "",
)

data class McpProbeResponse(
    val ok: Boolean = false,
    val configured: Int = 0,
    val enabled: Int = 0,
    val probed: Int = 0,
    val results: List<McpProbeResult> = emptyList(),
    val tools: List<McpToolInfo> = emptyList(),
    @SerializedName("toolRunId") val toolRunId: String = "",
)

data class McpProbeResult(
    val ok: Boolean = false,
    val status: String = "",
    val error: String = "",
    @SerializedName("toolCount") val toolCount: Int = 0,
    val server: McpServerInfo? = null,
)

data class McpToolInfo(
    val name: String = "",
    @SerializedName("fullName") val fullName: String = "",
    val title: String = "",
    val description: String = "",
)

data class McpServerInfo(
    val id: String = "",
    val name: String = "",
    val type: String = "",
    val enabled: Boolean = false,
    val command: String = "",
    val args: List<String> = emptyList(),
    val cwd: String = "",
    val url: String = "",
    @SerializedName("envKeys") val envKeys: List<String> = emptyList(),
    @SerializedName("headerKeys") val headerKeys: List<String> = emptyList(),
)

data class DoctorResponse(
    val ok: Boolean = false,
    val checks: List<DoctorCheck> = emptyList(),
    val failures: List<DoctorCheck> = emptyList(),
    @SerializedName("warningChecks") val warningChecks: List<DoctorCheck> = emptyList(),
    val warnings: List<DoctorCheck> = emptyList(),
    @SerializedName("generatedAt") val generatedAt: String = "",
    @SerializedName("toolRunId") val toolRunId: String = "",
)

data class DoctorCheck(
    val id: String = "",
    val ok: Boolean = false,
    val label: String = "",
    val detail: String = "",
    val severity: String = "",
)

data class CloudflareGuideResponse(
    val host: String = "",
    @SerializedName("publicHost") val publicHost: Boolean = false,
    @SerializedName("tunnelDetected") val tunnelDetected: Boolean = false,
    val registered: Boolean = false,
    @SerializedName("listeningOnAllInterfaces") val listeningOnAllInterfaces: Boolean = false,
    val allowlist: List<String> = emptyList(),
    @SerializedName("accessRecommended") val accessRecommended: Boolean = false,
    val warnings: List<String> = emptyList(),
    val steps: List<String> = emptyList(),
)

data class ToolEventStatsResponse(
    val count: Int = 0,
    @SerializedName("minCursor") val minCursor: Int = 0,
    @SerializedName("maxCursor") val maxCursor: Int = 0,
    @SerializedName("oldestAt") val oldestAt: String = "",
    @SerializedName("newestAt") val newestAt: String = "",
    val retention: ToolEventsSettings = ToolEventsSettings(),
    @SerializedName("autoPrune") val autoPrune: ToolEventAutoPruneState = ToolEventAutoPruneState(),
)

data class ToolEventAutoPruneState(
    @SerializedName("nextRunAt") val nextRunAt: String = "",
    val error: String = "",
)

data class ToolEventsPruneRequest(
    val dryRun: Boolean = true,
    @SerializedName("keepLatest") val keepLatest: Int = 5000,
)

data class ToolEventsPruneResponse(
    val dryRun: Boolean = true,
    val cutoff: String = "",
    @SerializedName("keepLatest") val keepLatest: Int = 0,
    val prunable: Int = 0,
    val deleted: Int = 0,
)

data class SettingsExportResponse(
    val kind: String = "",
    val version: Int = 0,
    @SerializedName("exportedAt") val exportedAt: String = "",
    val settings: Map<String, Any?> = emptyMap(),
)

data class SettingsImportResponse(
    val ok: Boolean = false,
    val dryRun: Boolean = false,
    @SerializedName("changedKeys") val changedKeys: List<String> = emptyList(),
    val settings: PublicSettings? = null,
)

data class PushSubscriptionListResponse(
    val items: List<PushSubscriptionItem> = emptyList(),
)

data class PushSubscriptionItem(
    val id: String = "",
    @SerializedName("deviceId") val deviceId: String = "",
    val endpoint: String = "",
    val kind: String = "",
    val provider: String = "",
    val platform: String = "",
    @SerializedName("appId") val appId: String = "",
    @SerializedName("installationId") val installationId: String = "",
    @SerializedName("tokenPreview") val tokenPreview: String = "",
    @SerializedName("createdAt") val createdAt: String = "",
    @SerializedName("updatedAt") val updatedAt: String = "",
)

data class NativePushTokenRequest(
    val provider: String = "fcm",
    val token: String,
    val platform: String = "android",
    @SerializedName("appId") val appId: String = "com.vibelink.app",
    @SerializedName("installationId") val installationId: String = "",
)

data class PushSubscriptionResponse(
    val ok: Boolean = false,
    val subscription: PushSubscriptionItem = PushSubscriptionItem(),
)

data class NetworkAddress(
    val name: String = "",
    val address: String = "",
    val url: String = "",
)

data class SimpleOk(
    val ok: Boolean = false,
)

data class AttachmentUploadResponse(
    val ok: Boolean = false,
    val id: String = "",
    val name: String = "",
    @SerializedName("relativePath") val relativePath: String = "",
    val path: String = "",
    val url: String = "",
    val kind: String = "",
    val markdown: String = "",
    @SerializedName("mimeType") val mimeType: String = "",
    val size: Long = 0,
    val preview: String = "",
)

// Provider registry / model catalog

data class ProviderRegistryResponse(
    val version: Int = 0,
    @SerializedName("defaultProvider") val defaultProvider: String = "codex",
    val providers: List<ProviderDefinition> = emptyList(),
    @SerializedName("generatedAt") val generatedAt: String = "",
)

data class ProviderDefinition(
    val id: String = "",
    val label: String = "",
    val kind: String = "",
    val available: Boolean = false,
    val status: String = "",
    val reason: String = "",
    @SerializedName("defaultModel") val defaultModel: String = "",
    val models: List<ModelDefinition> = emptyList(),
    @SerializedName("reasoningEfforts") val reasoningEfforts: List<String> = emptyList(),
    val capabilities: ProviderCapabilities = ProviderCapabilities(),
)

data class ModelDefinition(
    val id: String = "",
    val label: String = "",
    val default: Boolean = false,
)

data class ProviderCapabilities(
    @SerializedName("modelOverride") val modelOverride: Boolean = true,
    @SerializedName("reasoningEffort") val reasoningEffort: Boolean = true,
    val resume: Boolean = false,
    @SerializedName("liveCallAssistant") val liveCallAssistant: Boolean = false,
    @SerializedName("browserBridge") val browserBridge: Boolean = false,
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
    @SerializedName("agentTaskId") val agentTaskId: String = "",
    @SerializedName("asrProvider") val asrProvider: String = "",
    @SerializedName("createdAt") val createdAt: String = "",
    @SerializedName("updatedAt") val updatedAt: String = "",
    @SerializedName("startedAt") val startedAt: String = "",
    @SerializedName("stoppedAt") val stoppedAt: String = "",
    val remote: LevelData? = null,
    val local: LevelData? = null,
)

data class CreateSessionResponse(
    val ok: Boolean = false,
    val session: Session? = null,
)

data class SessionListResponse(
    val items: List<Session> = emptyList(),
)

data class AsrProviderListResponse(
    val items: List<AsrProviderInfo> = emptyList(),
)

data class AsrProviderInfo(
    val id: String = "",
    val label: String = "",
    val available: Boolean = false,
    val active: Boolean = false,
    val diagnostics: Map<String, Any?>? = null,
)

data class AsrCheckpointListResponse(
    val items: List<AsrCheckpointInfo> = emptyList(),
)

data class AsrCheckpointRecoverResponse(
    val ok: Boolean = false,
    val items: List<AsrCheckpointInfo> = emptyList(),
)

data class AsrCheckpointInfo(
    val channel: String = "",
    val path: String = "",
    val bytes: Long = 0,
    val provider: String = "",
    @SerializedName("requestedProvider") val requestedProvider: String = "",
    @SerializedName("fallbackFromProvider") val fallbackFromProvider: String = "",
    @SerializedName("segmentCount") val segmentCount: Int = 0,
    val exists: Boolean = false,
)

data class LiveCallEvent(
    val question: String = "",
    @SerializedName("questionId") val questionId: String = "",
    @SerializedName("questionCursor") val questionCursor: Int = 0,
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
    val provider: String = "",
    @SerializedName("segmentIndex") val segmentIndex: Int = 0,
    @SerializedName("durationMs") val durationMs: Long = 0,
    @SerializedName("speechMs") val speechMs: Long = 0,
    val bytes: Long = 0,
    val encoding: String = "",
    @SerializedName("sampleRate") val sampleRate: Int = 0,
    val channels: Int = 0,
)

data class LiveCallEventsResponse(
    val items: List<LiveCallEvent> = emptyList(),
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
    val agent: String = "",
    val model: String = "",
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

data class TaskCreateRequest(
    val prompt: String,
    val cwd: String = "",
    val agent: String = "codex",
    val model: String = "",
    val title: String = "",
    val mode: String = "new",
    val sessionId: String = "",
    val reasoningEffort: String = "",
    val security: SecuritySettings? = null,
)

data class TaskCreateResponse(
    val id: String = "",
    val status: String = "",
    @SerializedName("toolRunId") val toolRunId: String = "",
    val error: String = "",
    @SerializedName("approvalId") val approvalId: String = "",
    val approval: ApprovalRequestItem? = null,
)

data class TaskInputRequest(val text: String)

data class TaskInputResponse(
    val ok: Boolean = false,
    val error: String = "",
)

data class TaskStopResponse(
    val ok: Boolean = false,
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

data class WorkspaceFileMutationRequest(
    val action: String,
    val path: String,
    val text: String = "",
    @SerializedName("nextPath") val nextPath: String = "",
)

data class WorkspaceFileMutationResponse(
    val ok: Boolean = false,
    val action: String = "",
    val workspace: WorkspaceItem? = null,
    val path: String = "",
    @SerializedName("previousPath") val previousPath: String = "",
    @SerializedName("absolutePath") val absolutePath: String = "",
    val size: Long = 0,
    @SerializedName("updatedAt") val updatedAt: String = "",
    val text: String = "",
    val binary: Boolean = false,
)

data class WorkspaceWorktreeRequest(
    @SerializedName("branchName") val branchName: String,
    @SerializedName("baseRef") val baseRef: String = "HEAD",
    val title: String = "",
    val path: String = "",
    val root: String = "",
)

data class WorkspaceWorktreeResponse(
    val ok: Boolean = false,
    val workspace: WorkspaceItem = WorkspaceItem(),
    @SerializedName("branchName") val branchName: String = "",
    val path: String = "",
    @SerializedName("toolRunId") val toolRunId: String = "",
)

data class TerminalStartRequest(
    val shell: String = "",
    val mode: String = "auto",
    val cols: Int = 100,
    val rows: Int = 30,
)

data class TerminalSessionInfo(
    val id: String = "",
    val mode: String = "",
    val shell: String = "",
    val cwd: String = "",
    val pid: Int = 0,
    val status: String = "",
    @SerializedName("startedAt") val startedAt: String = "",
    @SerializedName("endedAt") val endedAt: String = "",
    @SerializedName("exitCode") val exitCode: Int? = null,
    val signal: String = "",
    @SerializedName("supportsStdin") val supportsStdin: Boolean = false,
    @SerializedName("supportsResize") val supportsResize: Boolean = false,
    @SerializedName("supportsAnsi") val supportsAnsi: Boolean = false,
)

data class TerminalStartResponse(
    val ok: Boolean = false,
    val status: String = "",
    val session: TerminalSessionInfo? = null,
    @SerializedName("toolRunId") val toolRunId: String = "",
)

data class TerminalSessionResponse(
    val session: TerminalSessionInfo? = null,
)

data class TerminalInputRequest(val text: String)

data class TerminalResizeRequest(
    val cols: Int,
    val rows: Int,
)

data class TerminalStopRequest(val reason: String = "Stopped from Android")

data class TerminalMutationResponse(
    val ok: Boolean = false,
    val session: TerminalSessionInfo? = null,
    val error: String = "",
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
    val test: TestSummary? = null,
)

data class TestSummary(
    val ok: Boolean = false,
    val passed: Int = 0,
    val failed: Int = 0,
    val failures: List<String> = emptyList(),
    val log: String = "",
)


data class GitFileActionRequest(
    val action: String,
    val path: String,
    val patch: String = "",
)

data class GitActionRequest(
    val action: String,
    val message: String = "",
    val title: String = "",
    @SerializedName("branchName") val branchName: String = "",
    @SerializedName("baseRef") val baseRef: String = "HEAD",
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
    val kind: String = "",         // "task" | "history" | "fork" | "desktop" | "new"
    val id: String = "",
    val provider: String = "",
    val title: String = "",
    val cwd: String = "",
    val status: String = "",       // "running" | "completed" | "failed" | "history" | "desktop"
    @SerializedName("updatedAt") val updatedAt: String = "",
    @SerializedName("sessionId") val sessionId: String = "",
    val preview: String = "",
    @SerializedName("sourceKey") val sourceKey: String = "",
    @SerializedName("sourceId") val sourceId: String = "",
    val group: String = "",
    val pinned: Boolean = false,
    val archived: Boolean = false,
    @SerializedName("desktopIndex") val desktopIndex: Int? = null,
    @SerializedName("desktopTitle") val desktopTitle: String = "",
    @SerializedName("desktopLinked") val desktopLinked: Boolean = false,
)

/**
 * Rendered chat message with optional tool calls.
 */
data class ChatMessage(
    val role: String = "",         // "user" | "assistant" | "system" | "error"
    val text: String = "",
    val id: String = "",
    @SerializedName("turnId") val turnId: String = "",
    @SerializedName("taskId") val taskId: String = "",
    val streaming: Boolean = false,
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
    val permission: String = "",
    val risk: String = "",
    val description: String = "",
    val cursor: Int = 0,
    @SerializedName("approvalRequired") val approvalRequired: Boolean = false,
)

data class ToolOutputEvent(
    val cursor: Int = 0,
    val stream: String = "",
    val text: String = "",
)

// Thread state / conversation management

data class ThreadStateResponse(
    val version: Int = 0,
    val items: Map<String, ThreadMeta> = emptyMap(),
    val forks: List<ThreadFork> = emptyList(),
)

data class ThreadMeta(
    val key: String = "",
    val title: String = "",
    val group: String = "",
    val pinned: Boolean = false,
    val archived: Boolean = false,
    @SerializedName("updatedAt") val updatedAt: String = "",
)

data class ThreadPatch(
    val title: String? = null,
    val group: String? = null,
    val pinned: Boolean? = null,
    val archived: Boolean? = null,
    val provider: String? = null,
    val sessionId: String? = null,
    val meta: Map<String, Any?>? = null,
)

data class ThreadPatchRequest(
    val key: String,
    val patch: ThreadPatch,
)

data class ThreadFork(
    val id: String = "",
    @SerializedName("sourceKey") val sourceKey: String = "",
    @SerializedName("sourceId") val sourceId: String = "",
    val provider: String = "",
    val title: String = "",
    val cwd: String = "",
    val group: String = "",
    val pinned: Boolean = false,
    val archived: Boolean = false,
    @SerializedName("createdAt") val createdAt: String = "",
    @SerializedName("updatedAt") val updatedAt: String = "",
)

data class ThreadForkRequest(
    @SerializedName("sourceKey") val sourceKey: String,
    @SerializedName("sourceId") val sourceId: String,
    val provider: String,
    val title: String,
    val cwd: String = "",
)

data class ThreadForkResponse(
    val fork: ThreadFork = ThreadFork(),
    val state: ThreadStateResponse = ThreadStateResponse(),
)

// Codex Desktop Remote

data class DesktopRemoteState(
    val ok: Boolean = false,
    val mode: String = "",
    val active: Boolean = false,
    val desktop: DesktopSnapshot? = null,
    val items: List<DesktopRemoteQueueItem> = emptyList(),
    @SerializedName("pendingCount") val pendingCount: Int = 0,
    @SerializedName("updatedAt") val updatedAt: String = "",
)

data class DesktopSnapshot(
    val ok: Boolean = false,
    val found: Boolean = false,
    val ready: Boolean = false,
    @SerializedName("composerReady") val composerReady: Boolean = false,
    @SerializedName("canAttemptSend") val canAttemptSend: Boolean = false,
    val reason: String = "",
    val minimized: Boolean = false,
    @SerializedName("sidebarHasRunning") val sidebarHasRunning: Boolean = false,
    @SerializedName("sidebarRunningCount") val sidebarRunningCount: Int = 0,
    @SerializedName("windowTitle") val windowTitle: String = "",
    @SerializedName("visibleTranscript") val visibleTranscript: List<DesktopTranscriptEntry> = emptyList(),
    val conversations: List<DesktopConversation> = emptyList(),
    val projects: List<DesktopProject> = emptyList(),
    @SerializedName("updatedAt") val updatedAt: String = "",
)

data class DesktopTranscriptEntry(
    val role: String = "",
    val text: String = "",
)

data class DesktopConversation(
    val index: Int = 0,
    val title: String = "",
    @SerializedName("rawName") val rawName: String = "",
    @SerializedName("projectTitle") val projectTitle: String = "",
    val running: Boolean = false,
)

data class DesktopProject(
    val index: Int = 0,
    val title: String = "",
)

data class DesktopRemoteQueueItem(
    val id: String = "",
    val text: String = "",
    val status: String = "",
    val error: String = "",
    val attempts: Int = 0,
    @SerializedName("createdAt") val createdAt: String = "",
    @SerializedName("updatedAt") val updatedAt: String = "",
    @SerializedName("sentAt") val sentAt: String = "",
)

data class DesktopRemoteTarget(
    @SerializedName("desktopIndex") val desktopIndex: Int? = null,
    @SerializedName("desktopTitle") val desktopTitle: String = "",
    @SerializedName("desktopProjectTitle") val desktopProjectTitle: String = "",
)

data class DesktopRemoteMessageRequest(
    val text: String,
    @SerializedName("settingsPolicy") val settingsPolicy: String = "useExisting",
    val target: DesktopRemoteTarget? = null,
)

data class DesktopRemoteMessageResponse(
    val ok: Boolean = false,
    val item: DesktopRemoteQueueItem? = null,
    val state: DesktopRemoteState? = null,
)

data class DesktopFocusRequest(val index: Int)

data class DesktopFocusResponse(
    val ok: Boolean = false,
    val action: String = "",
    val error: String = "",
    val index: Int = 0,
    val desktop: DesktopSnapshot? = null,
)

// Approvals and tool run detail

data class ApprovalListResponse(
    val items: List<ApprovalRequestItem> = emptyList(),
)

data class ApprovalRequestItem(
    val id: String = "",
    val kind: String = "",
    val title: String = "",
    val reason: String = "",
    val status: String = "",
    @SerializedName("toolRunId") val toolRunId: String = "",
    @SerializedName("workspaceId") val workspaceId: String = "",
    val request: Map<String, Any?>? = null,
    val risk: Map<String, Any?>? = null,
    @SerializedName("createdAt") val createdAt: String = "",
    @SerializedName("updatedAt") val updatedAt: String = "",
)

data class ApprovalDecisionRequest(
    val decision: String,
    val reason: String = "",
)

data class ApprovalTaskResult(
    val id: String = "",
    val agent: String = "",
    val title: String = "",
    val cwd: String = "",
    val status: String = "",
    @SerializedName("sessionId") val sessionId: String = "",
)

data class ApprovalTaskExecutionResult(
    val ok: Boolean = false,
    val id: String = "",
    val status: String = "",
    @SerializedName("toolRunId") val toolRunId: String = "",
    val session: TerminalSessionInfo? = null,
    val task: ApprovalTaskResult? = null,
)

data class ApprovalDecisionResponse(
    val ok: Boolean = false,
    val approval: ApprovalRequestItem? = null,
    val resumed: Boolean = false,
    val result: ApprovalTaskExecutionResult? = null,
    val error: String = "",
)

data class ToolRunDetailResponse(
    val toolRun: Map<String, Any?>? = null,
    val events: List<ToolEvent> = emptyList(),
)

data class SettingsPatchRequest(
    @SerializedName("defaultCwd") val defaultCwd: String? = null,
    @SerializedName("claudeCommand") val claudeCommand: String? = null,
    @SerializedName("codexCommand") val codexCommand: String? = null,
    @SerializedName("doubaoCommand") val doubaoCommand: String? = null,
    @SerializedName("doubaoCdpEndpoint") val doubaoCdpEndpoint: String? = null,
    @SerializedName("doubaoUrl") val doubaoUrl: String? = null,
    val security: SecuritySettings? = null,
    @SerializedName("hostAllowlist") val hostAllowlist: List<String>? = null,
    @SerializedName("allowTryCloudflare") val allowTryCloudflare: Boolean? = null,
    @SerializedName("allowLegacyPairingTokenLogin") val allowLegacyPairingTokenLogin: Boolean? = null,
    @SerializedName("notificationEmail") val notificationEmail: String? = null,
    @SerializedName("nativePush") val nativePush: NativePushSettingsPatch? = null,
    @SerializedName("toolEvents") val toolEvents: ToolEventsSettings? = null,
    val mcp: McpSettingsPatch? = null,
    val apiKeys: Map<String, String>? = null,
)

data class SettingsPatchResponse(
    val ok: Boolean = false,
    val settings: PublicSettings? = null,
    val error: String = "",
)
