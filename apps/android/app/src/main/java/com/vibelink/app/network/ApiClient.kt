package com.vibelink.app.network

import com.google.gson.Gson
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.net.URLEncoder
import java.io.InputStream
import okio.BufferedSink
import okio.source
import java.util.concurrent.TimeUnit

/**
 * VibeLink API client.
 * Wraps OkHttp for REST calls and SSE subscriptions.
 */
class ApiClient(
    var baseUrl: String = "http://127.0.0.1:8787",
    var token: String = ""
) {
    private val gson = Gson()
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    private val httpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .build()
    }

    private val sseClient: OkHttpClient by lazy {
        httpClient.newBuilder()
            .readTimeout(0, TimeUnit.SECONDS)
            .build()
    }

    // ── HTTP helpers ──

    private fun authHeaders() = if (token.isNotBlank())
        mapOf("Authorization" to "Bearer $token") else emptyMap()

    private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("$baseUrl$path")
            .apply { authHeaders().forEach { (k, v) -> addHeader(k, v) } }
            .get()
            .build()
        httpClient.newCall(req).execute().use { response ->
            val body = response.body?.string() ?: ""
            if (!response.isSuccessful) throw ApiException(response.code, body)
            body
        }
    }

    private suspend fun post(
        path: String,
        body: Any? = null,
        extraHeaders: Map<String, String> = emptyMap(),
    ): String = withContext(Dispatchers.IO) {
        val jsonBody = if (body != null) gson.toJson(body) else ""
        val req = Request.Builder()
            .url("$baseUrl$path")
            .apply { authHeaders().forEach { (k, v) -> addHeader(k, v) } }
            .apply { extraHeaders.forEach { (k, v) -> addHeader(k, v) } }
            .post(jsonBody.toRequestBody(jsonType))
            .build()
        httpClient.newCall(req).execute().use { response ->
            val body = response.body?.string() ?: ""
            if (!response.isSuccessful) throw ApiException(response.code, body)
            body
        }
    }

    private suspend fun postRaw(path: String, body: Any? = null): String = post(path, body)

    private suspend fun patch(path: String, body: Any? = null): String = withContext(Dispatchers.IO) {
        val jsonBody = if (body != null) gson.toJson(body) else ""
        val req = Request.Builder()
            .url("$baseUrl$path")
            .apply { authHeaders().forEach { (k, v) -> addHeader(k, v) } }
            .patch(jsonBody.toRequestBody(jsonType))
            .build()
        httpClient.newCall(req).execute().use { response ->
            val responseBody = response.body?.string() ?: ""
            if (!response.isSuccessful) throw ApiException(response.code, responseBody)
            responseBody
        }
    }

    // ── Auth ──

    suspend fun checkStatus(): StatusResponse {
        val json = get("/api/status")
        return gson.fromJson(json, StatusResponse::class.java)
    }

    suspend fun getDoctor(): DoctorResponse {
        val json = get("/api/doctor")
        return gson.fromJson(json, DoctorResponse::class.java)
    }

    suspend fun getMcpStatus(): McpStatusResponse {
        val json = get("/api/mcp/status")
        return gson.fromJson(json, McpStatusResponse::class.java)
    }

    suspend fun probeMcp(timeoutMs: Int = 10000): McpProbeResponse {
        val json = post("/api/mcp/probe", mapOf("timeoutMs" to timeoutMs))
        return gson.fromJson(json, McpProbeResponse::class.java)
    }

    suspend fun getCloudflareGuide(): CloudflareGuideResponse {
        val json = get("/api/cloudflare/guide")
        return gson.fromJson(json, CloudflareGuideResponse::class.java)
    }

    suspend fun getToolEventStats(): ToolEventStatsResponse {
        val json = get("/api/tool-events/stats")
        return gson.fromJson(json, ToolEventStatsResponse::class.java)
    }

    suspend fun pruneToolEvents(dryRun: Boolean = true, keepLatest: Int = 5000): ToolEventsPruneResponse {
        val json = post("/api/tool-events/prune", ToolEventsPruneRequest(dryRun = dryRun, keepLatest = keepLatest))
        return gson.fromJson(json, ToolEventsPruneResponse::class.java)
    }

    suspend fun exportSettings(): SettingsExportResponse {
        val json = get("/api/settings/export")
        return gson.fromJson(json, SettingsExportResponse::class.java)
    }

    suspend fun importSettings(
        rawJson: String,
        dryRun: Boolean = false,
        expectedRevision: Int? = null,
    ): SettingsImportResponse {
        val payload = JsonParser.parseString(rawJson).asJsonObject
        if (dryRun) payload.addProperty("dryRun", true)
        expectedRevision?.let { payload.addProperty("expectedRevision", it) }
        val headers = expectedRevision?.let { mapOf("If-Match" to "\"vibelink:settings:$it\"") }.orEmpty()
        val json = post("/api/settings/import${if (dryRun) "?dryRun=1" else ""}", payload, headers)
        return gson.fromJson(json, SettingsImportResponse::class.java)
    }

    suspend fun listPushSubscriptions(kind: String = ""): List<PushSubscriptionItem> {
        val query = if (kind.isBlank()) "" else "?kind=${encode(kind)}"
        val json = get("/api/push/subscriptions$query")
        return gson.fromJson(json, PushSubscriptionListResponse::class.java).items
    }

    suspend fun registerNativePushToken(
        provider: String,
        token: String,
        platform: String = "android",
        appId: String = "com.vibelink.app",
        installationId: String = "",
    ): PushSubscriptionResponse {
        val json = post(
            "/api/push/native-token",
            NativePushTokenRequest(
                provider = provider,
                token = token,
                platform = platform,
                appId = appId,
                installationId = installationId,
            ),
        )
        return gson.fromJson(json, PushSubscriptionResponse::class.java)
    }

    suspend fun listDevices(): DeviceListResponse {
        val json = get("/api/devices")
        return gson.fromJson(json, DeviceListResponse::class.java)
    }

    suspend fun revokeDevice(deviceId: String): SimpleOk {
        val json = post("/api/devices/${encode(deviceId)}/revoke", emptyMap<String, String>())
        return gson.fromJson(json, SimpleOk::class.java)
    }

    suspend fun listAuditLogs(limit: Int = 20): List<AuditLogItem> {
        val json = get("/api/audit-log?limit=$limit")
        return gson.fromJson(json, AuditLogListResponse::class.java).items
    }

    suspend fun uploadAttachment(
        bytes: ByteArray,
        fileName: String,
        mimeType: String = "application/octet-stream",
        relativePath: String = "",
    ): AttachmentUploadResponse = withContext(Dispatchers.IO) {
        uploadAttachment(
            input = bytes.inputStream(),
            contentLength = bytes.size.toLong(),
            fileName = fileName,
            mimeType = mimeType,
            relativePath = relativePath,
        )
    }

    suspend fun search(
        query: String,
        scope: String = "all",
        limit: Int = 50,
        cursor: String = "",
        tag: String = "",
        favorite: Boolean = false,
        sort: String = "relevance",
        order: String = "desc",
        record: Boolean = true,
    ): SearchResponse {
        val cursorParam = if (cursor.isBlank()) "" else "&cursor=${encode(cursor)}"
        val tagParam = if (tag.isBlank()) "" else "&tag=${encode(tag)}"
        val favoriteParam = if (favorite) "&favorite=1" else ""
        val recordParam = if (record) "" else "&record=0"
        val json = get("/api/search?q=${encode(query)}&scope=${encode(scope)}&limit=$limit$cursorParam$tagParam$favoriteParam&sort=${encode(sort)}&order=${encode(order)}$recordParam")
        return gson.fromJson(json, SearchResponse::class.java)
    }

    suspend fun listSavedSearches(): List<SavedSearch> =
        gson.fromJson(get("/api/search/saved"), SavedSearchListResponse::class.java).items

    suspend fun saveSearch(request: SavedSearchRequest): SavedSearch =
        gson.fromJson(post("/api/search/saved", request), SavedSearch::class.java)

    suspend fun deleteSavedSearch(id: String): SimpleOk =
        gson.fromJson(delete("/api/search/saved/${encode(id)}"), SimpleOk::class.java)

    suspend fun listSearchHistory(limit: Int = 30): List<SearchHistoryItem> =
        gson.fromJson(get("/api/search/history?limit=$limit"), SearchHistoryListResponse::class.java).items

    suspend fun deleteSearchHistory(id: String): SimpleOk =
        gson.fromJson(delete("/api/search/history/${encode(id)}"), SimpleOk::class.java)

    suspend fun clearSearchHistory(): SimpleOk =
        gson.fromJson(delete("/api/search/history"), SimpleOk::class.java)

    suspend fun listCommands(filter: String = ""): List<CommandDefinition> {
        val suffix = if (filter.isBlank()) "" else "?filter=${encode(filter)}"
        return gson.fromJson(get("/api/command-registry$suffix"), CommandRegistryResponse::class.java).items
    }

    suspend fun listReviews(): List<ReviewSession> = gson.fromJson(get("/api/reviews"), ReviewListResponse::class.java).items

    suspend fun createReview(request: ReviewCreateRequest): ReviewSession = gson.fromJson(post("/api/reviews", request), ReviewSession::class.java)

    suspend fun getReview(id: String): ReviewSession = gson.fromJson(get("/api/reviews/${encode(id)}"), ReviewSession::class.java)

    suspend fun addReviewComment(id: String, request: ReviewCommentRequest): ReviewSession = gson.fromJson(post("/api/reviews/${encode(id)}/comments", request), ReviewSession::class.java)

    suspend fun updateReview(id: String, patch: Map<String, Any?>): ReviewSession = gson.fromJson(patch("/api/reviews/${encode(id)}", patch), ReviewSession::class.java)

    private suspend fun delete(path: String): String = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("$baseUrl$path")
            .apply { authHeaders().forEach { (k, v) -> addHeader(k, v) } }
            .delete()
            .build()
        httpClient.newCall(req).execute().use { response ->
            val body = response.body?.string() ?: ""
            if (!response.isSuccessful) throw ApiException(response.code, body)
            body
        }
    }

    suspend fun rotateCurrentDevice(): DeviceTokenRotationResponse {
        val json = post("/api/devices/current/rotate", emptyMap<String, String>())
        return gson.fromJson(json, DeviceTokenRotationResponse::class.java)
    }

    suspend fun rotateDevice(deviceId: String): DeviceTokenRotationResponse {
        val json = post("/api/devices/${encode(deviceId)}/rotate", emptyMap<String, String>())
        return gson.fromJson(json, DeviceTokenRotationResponse::class.java)
    }

    suspend fun revokePushSubscription(subscriptionId: String): SimpleOk {
        val json = delete("/api/push/subscriptions/${encode(subscriptionId)}")
        return gson.fromJson(json, SimpleOk::class.java)
    }

    suspend fun getTaskChanges(taskId: String): TaskChangesResponse {
        val json = get("/api/tasks/${encode(taskId)}/changes")
        return gson.fromJson(json, TaskChangesResponse::class.java)
    }

    suspend fun getWorkspaceContext(workspaceId: String, request: Map<String, Any?> = emptyMap()): WorkspaceContextResponse {
        val json = post("/api/workspaces/${encode(workspaceId)}/context", request)
        return gson.fromJson(json, WorkspaceContextResponse::class.java)
    }

    suspend fun createWorkspace(name: String, path: String, allowedRoot: String = ""): WorkspaceItem {
        val json = post("/api/workspaces", mapOf("name" to name, "path" to path, "allowedRoot" to allowedRoot))
        return gson.fromJson(json, WorkspaceCreateResponse::class.java).workspace
    }

    suspend fun uploadAttachment(
        input: InputStream,
        contentLength: Long,
        fileName: String,
        mimeType: String = "application/octet-stream",
        relativePath: String = "",
    ): AttachmentUploadResponse = withContext(Dispatchers.IO) {
        val contentType = mimeType.ifBlank { "application/octet-stream" }.toMediaType()
        val body = object : RequestBody() {
            override fun contentType() = contentType
            override fun contentLength() = contentLength
            override fun writeTo(sink: BufferedSink) {
                input.use { source -> sink.writeAll(source.source()) }
            }
        }
        val req = Request.Builder()
            .url("$baseUrl/api/attachments")
            .apply { authHeaders().forEach { (k, v) -> addHeader(k, v) } }
            .addHeader("X-File-Name", encode(fileName.ifBlank { "attachment" }))
            .apply { if (relativePath.isNotBlank()) addHeader("X-Relative-Path", encode(relativePath)) }
            .post(body)
            .build()
        httpClient.newCall(req).execute().use { response ->
            val body = response.body?.string() ?: ""
            if (!response.isSuccessful) throw ApiException(response.code, body)
            gson.fromJson(body, AttachmentUploadResponse::class.java)
        }
    }

    suspend fun getProviderRegistry(fresh: Boolean = false): ProviderRegistryResponse {
        val json = get("/api/provider-registry${if (fresh) "?fresh=1" else ""}")
        return gson.fromJson(json, ProviderRegistryResponse::class.java)
    }

    suspend fun saveSettings(patch: SettingsPatchRequest): SettingsPatchResponse {
        val headers = patch.expectedRevision?.let { mapOf("If-Match" to "\"vibelink:settings:$it\"") }.orEmpty()
        val json = post("/api/settings", patch, headers)
        return gson.fromJson(json, SettingsPatchResponse::class.java)
    }

    suspend fun login(pairingToken: String): LoginResponse {
        val json = post("/api/login", mapOf("pairingToken" to pairingToken))
        return gson.fromJson(json, LoginResponse::class.java)
    }

    suspend fun createPairingSession(deviceLabel: String = "Android"): CreatePairingSessionResponse {
        val json = post("/api/pairing-sessions", mapOf("deviceLabel" to deviceLabel))
        return gson.fromJson(json, CreatePairingSessionResponse::class.java)
    }

    suspend fun getPairingSession(sessionId: String): PairingStatusResponse {
        val json = get("/api/pairing-sessions/${encode(sessionId)}")
        return gson.fromJson(json, PairingStatusResponse::class.java)
    }

    suspend fun listPairingSessions(status: String = "pending"): List<PairingSession> {
        val json = get("/api/pairing-sessions?status=${encode(status)}")
        return gson.fromJson(json, PairingSessionListResponse::class.java).items
    }

    suspend fun decidePairingSession(sessionId: String, approve: Boolean): PairingStatusResponse {
        val action = if (approve) "approve" else "deny"
        val json = post("/api/pairing-sessions/${encode(sessionId)}/$action", emptyMap<String, String>())
        return gson.fromJson(json, PairingStatusResponse::class.java)
    }

    suspend fun claimPairingSession(sessionId: String, code: String, deviceLabel: String = "Android"): ClaimPairingResponse {
        val json = post("/api/pairing-sessions/${encode(sessionId)}/claim", mapOf(
            "code" to code,
            "deviceLabel" to deviceLabel,
        ))
        return gson.fromJson(json, ClaimPairingResponse::class.java)
    }

    // ── Live Calls ──

    suspend fun createSession(
        title: String = "Live Call",
        source: String = "android",
        workspaceId: String = "",
        asrProvider: String = "",
        agent: String = "claude",
        model: String = "",
    ): Session? {
        val body = mutableMapOf<String, String>("title" to title, "source" to source)
        if (workspaceId.isNotBlank()) body["workspaceId"] = workspaceId
        if (asrProvider.isNotBlank()) body["asrProvider"] = asrProvider
        if (agent.isNotBlank()) body["agent"] = agent
        if (model.isNotBlank()) body["model"] = model
        val json = post("/api/live-calls", body)
        return gson.fromJson(json, CreateSessionResponse::class.java).session
    }

    suspend fun listSessions(): List<Session> {
        val json = get("/api/live-calls")
        return gson.fromJson(json, SessionListResponse::class.java).items
    }

    suspend fun listAsrProviders(): List<AsrProviderInfo> {
        val json = get("/api/live-calls/asr-providers")
        return gson.fromJson(json, AsrProviderListResponse::class.java).items
    }

    suspend fun listAsrCheckpoints(sessionId: String): List<AsrCheckpointInfo> {
        val json = get("/api/live-calls/${encode(sessionId)}/asr-checkpoints")
        return gson.fromJson(json, AsrCheckpointListResponse::class.java).items
    }

    suspend fun recoverAsrCheckpoints(sessionId: String): List<AsrCheckpointInfo> {
        val json = post("/api/live-calls/${encode(sessionId)}/asr-recover", mapOf("reason" to "android"))
        return gson.fromJson(json, AsrCheckpointRecoverResponse::class.java).items
    }

    suspend fun fetchLiveCallEvents(sessionId: String, after: Int = 0, limit: Int = 300): List<LiveCallEvent> {
        val json = get("/api/live-calls/${encode(sessionId)}/events/catch-up?after=$after&limit=$limit")
        return gson.fromJson(json, LiveCallEventsResponse::class.java).items
    }

    suspend fun stopSession(sessionId: String) {
        post("/api/live-calls/$sessionId/stop", mapOf("reason" to "manual"))
    }

    suspend fun pauseSession(sessionId: String): Session? {
        val json = post("/api/live-calls/$sessionId/pause", mapOf("reason" to "android"))
        return gson.fromJson(json, CreateSessionResponse::class.java).session
    }

    suspend fun resumeSession(sessionId: String): Session? {
        val json = post("/api/live-calls/$sessionId/resume", mapOf("reason" to "android"))
        return gson.fromJson(json, CreateSessionResponse::class.java).session
    }

    suspend fun sendTranscript(
        sessionId: String,
        text: String,
        final: Boolean = true,
        speaker: String = "remote",
        agent: String = "",
        model: String = "",
    ) {
        post("/api/live-calls/$sessionId/transcript", TranscriptBody(text, final, speaker, agent, model))
    }

    suspend fun sendLevel(sessionId: String, channel: String = "remote", rms: Double = 0.0, peak: Double = 0.0) {
        post("/api/live-calls/$sessionId/level", mapOf(
            "channel" to channel, "rms" to rms, "peak" to peak
        ))
    }

    fun liveCallAudioRequest(sessionId: String): Request {
        val wsBase = when {
            baseUrl.startsWith("https://") -> baseUrl.replaceFirst("https://", "wss://")
            baseUrl.startsWith("http://") -> baseUrl.replaceFirst("http://", "ws://")
            else -> baseUrl
        }.trimEnd('/')
        return Request.Builder()
            .url("$wsBase/api/live-calls/${encode(sessionId)}/audio")
            .apply { authHeaders().forEach { (k, v) -> addHeader(k, v) } }
            .build()
    }

    // ── Tasks ──

    suspend fun listTasks(): List<TaskSummary> {
        val json = get("/api/tasks")
        return gson.fromJson(json, TaskListResponse::class.java).items
    }

    suspend fun getTask(taskId: String): TaskDetail {
        val json = get("/api/tasks/$taskId")
        return gson.fromJson(json, TaskDetail::class.java)
    }

    suspend fun createTask(
        prompt: String,
        cwd: String = "",
        agent: String = "codex",
        model: String = "",
        title: String = "",
        mode: String = "new",
        sessionId: String = "",
        reasoningEffort: String = "",
        security: SecuritySettings? = null,
    ): TaskCreateResponse {
        val json = postRaw(
            "/api/tasks",
            TaskCreateRequest(
                prompt = prompt,
                cwd = cwd,
                agent = agent,
                model = model,
                title = title,
                mode = mode,
                sessionId = sessionId,
                reasoningEffort = reasoningEffort,
                security = security,
            ),
        )
        return gson.fromJson(json, TaskCreateResponse::class.java)
    }

    suspend fun sendTaskInput(taskId: String, text: String): TaskInputResponse {
        val json = post("/api/tasks/${encode(taskId)}/input", TaskInputRequest(text))
        return gson.fromJson(json, TaskInputResponse::class.java)
    }

    suspend fun stopTask(taskId: String): TaskStopResponse {
        val json = post("/api/tasks/${encode(taskId)}/stop", mapOf("reason" to "android"))
        return gson.fromJson(json, TaskStopResponse::class.java)
    }

    // ── Histories (session list + detail) ──

    suspend fun listHistories(): List<HistoryItem> {
        val json = get("/api/histories")
        return gson.fromJson(json, HistoryListResponse::class.java).items
    }

    suspend fun getHistoryDetail(provider: String, id: String): HistoryDetail {
        val json = get("/api/histories/$provider/${encode(id)}")
        return gson.fromJson(json, HistoryDetail::class.java)
    }

    suspend fun getThreadState(): ThreadStateResponse {
        val json = get("/api/thread-state")
        return gson.fromJson(json, ThreadStateResponse::class.java)
    }

    suspend fun patchThread(key: String, patch: ThreadPatch, expectedRevision: Int? = null): ThreadStateResponse {
        val json = post("/api/thread-state", ThreadPatchRequest(key, patch, expectedRevision))
        return gson.fromJson(json, ThreadStateResponse::class.java)
    }

    suspend fun patchThreads(updates: List<ThreadPatchRequest>): ThreadStateResponse {
        val json = post("/api/thread-state/batch", mapOf("updates" to updates))
        return gson.fromJson(json, ThreadStateResponse::class.java)
    }

    suspend fun createThreadFork(
        sourceKey: String,
        sourceId: String,
        provider: String,
        title: String,
        cwd: String = "",
    ): ThreadForkResponse {
        val json = post(
            "/api/thread-state/forks",
            ThreadForkRequest(
                sourceKey = sourceKey,
                sourceId = sourceId,
                provider = provider,
                title = title,
                cwd = cwd,
            ),
        )
        return gson.fromJson(json, ThreadForkResponse::class.java)
    }

    // Codex Desktop Remote

    suspend fun getDesktopRemoteStatus(fresh: Boolean = false): DesktopRemoteState {
        val json = get("/api/desktop-remote/status${if (fresh) "?fresh=1" else ""}")
        return gson.fromJson(json, DesktopRemoteState::class.java)
    }

    suspend fun sendDesktopRemoteMessage(text: String, target: DesktopRemoteTarget? = null): DesktopRemoteMessageResponse {
        val json = post(
            "/api/desktop-remote/messages",
            DesktopRemoteMessageRequest(text = text, target = target),
        )
        return gson.fromJson(json, DesktopRemoteMessageResponse::class.java)
    }

    suspend fun focusDesktopConversation(index: Int): DesktopFocusResponse {
        val json = post("/api/desktop-remote/focus", DesktopFocusRequest(index))
        return gson.fromJson(json, DesktopFocusResponse::class.java)
    }

    suspend fun retryDesktopRemote(): DesktopRemoteState {
        val json = post("/api/desktop-remote/retry", emptyMap<String, String>())
        return gson.fromJson(json, DesktopRemoteState::class.java)
    }

    suspend fun clearDesktopRemote(): DesktopRemoteState {
        val json = post("/api/desktop-remote/clear", emptyMap<String, String>())
        return gson.fromJson(json, DesktopRemoteState::class.java)
    }

    // Workspace / Git

    suspend fun listWorkspaces(): List<WorkspaceItem> {
        val json = get("/api/workspaces")
        return gson.fromJson(json, WorkspaceListResponse::class.java).items
    }

    suspend fun getWorkspaceTree(workspaceId: String, dir: String = ""): WorkspaceTreeResponse {
        val json = get("/api/workspaces/${encode(workspaceId)}/tree?dir=${encode(dir)}")
        return gson.fromJson(json, WorkspaceTreeResponse::class.java)
    }

    suspend fun getWorkspaceFile(workspaceId: String, path: String): WorkspaceFileResponse {
        val json = get("/api/workspaces/${encode(workspaceId)}/file?path=${encode(path)}")
        return gson.fromJson(json, WorkspaceFileResponse::class.java)
    }

    suspend fun mutateWorkspaceFile(
        workspaceId: String,
        action: String,
        path: String,
        text: String = "",
        nextPath: String = "",
        expectedRevision: String? = null,
        requireAbsent: Boolean = false,
    ): WorkspaceFileMutationResponse {
        val headers = when {
            !expectedRevision.isNullOrBlank() -> mapOf("If-Match" to "\"vibelink:workspace-file:$expectedRevision\"")
            requireAbsent -> mapOf("If-None-Match" to "*")
            else -> emptyMap()
        }
        val json = post(
            "/api/workspaces/${encode(workspaceId)}/file",
            WorkspaceFileMutationRequest(
                action = action,
                path = path,
                text = text,
                nextPath = nextPath,
                expectedRevision = expectedRevision,
            ),
            headers,
        )
        return gson.fromJson(json, WorkspaceFileMutationResponse::class.java)
    }

    suspend fun createWorkspaceWorktree(
        workspaceId: String,
        branchName: String,
        baseRef: String = "HEAD",
        title: String = "",
        path: String = "",
        root: String = "",
    ): WorkspaceWorktreeResponse {
        val json = post(
            "/api/workspaces/${encode(workspaceId)}/worktrees",
            WorkspaceWorktreeRequest(
                branchName = branchName,
                baseRef = baseRef,
                title = title,
                path = path,
                root = root,
            ),
        )
        return gson.fromJson(json, WorkspaceWorktreeResponse::class.java)
    }

    suspend fun getGitStatus(workspaceId: String): GitStatusResponse {
        val json = get("/api/workspaces/${encode(workspaceId)}/git/status")
        return gson.fromJson(json, GitStatusResponse::class.java)
    }

    suspend fun getGitDiff(workspaceId: String): GitDiffResponse {
        val json = get("/api/workspaces/${encode(workspaceId)}/git/diff")
        return gson.fromJson(json, GitDiffResponse::class.java)
    }

    suspend fun applyGitFileAction(workspaceId: String, path: String, action: String, patch: String = ""): GitActionResponse {
        val json = post(
            "/api/workspaces/${encode(workspaceId)}/git/file-action",
            GitFileActionRequest(action = action, path = path, patch = patch),
        )
        return gson.fromJson(json, GitActionResponse::class.java)
    }

    suspend fun applyGitAction(
        workspaceId: String,
        action: String,
        message: String = "",
        title: String = "",
        branchName: String = "",
        baseRef: String = "HEAD",
    ): GitActionResponse {
        val json = post(
            "/api/workspaces/${encode(workspaceId)}/git/action",
            GitActionRequest(
                action = action,
                message = message,
                title = title,
                branchName = branchName,
                baseRef = baseRef,
            ),
        )
        return gson.fromJson(json, GitActionResponse::class.java)
    }

    suspend fun startTerminalSession(
        workspaceId: String,
        shell: String = "",
        mode: String = "auto",
        cols: Int = 100,
        rows: Int = 30,
    ): TerminalStartResponse {
        val json = post(
            "/api/workspaces/${encode(workspaceId)}/terminal-session",
            TerminalStartRequest(shell = shell, mode = mode, cols = cols, rows = rows),
        )
        return gson.fromJson(json, TerminalStartResponse::class.java)
    }

    suspend fun getTerminalSession(toolRunId: String): TerminalSessionResponse {
        val json = get("/api/terminal-sessions/${encode(toolRunId)}")
        return gson.fromJson(json, TerminalSessionResponse::class.java)
    }

    suspend fun sendTerminalInput(toolRunId: String, text: String): TerminalMutationResponse {
        val json = post(
            "/api/terminal-sessions/${encode(toolRunId)}/input",
            TerminalInputRequest(text = text),
        )
        return gson.fromJson(json, TerminalMutationResponse::class.java)
    }

    suspend fun resizeTerminalSession(toolRunId: String, cols: Int, rows: Int): TerminalMutationResponse {
        val json = post(
            "/api/terminal-sessions/${encode(toolRunId)}/resize",
            TerminalResizeRequest(cols = cols, rows = rows),
        )
        return gson.fromJson(json, TerminalMutationResponse::class.java)
    }

    suspend fun stopTerminalSession(toolRunId: String, reason: String = "Stopped from Android"): TerminalMutationResponse {
        val json = post(
            "/api/tool-runs/${encode(toolRunId)}/stop",
            TerminalStopRequest(reason = reason),
        )
        return gson.fromJson(json, TerminalMutationResponse::class.java)
    }

    suspend fun runCommand(
        workspaceId: String,
        command: String,
        kind: String = "command",
        timeoutMs: Long = 120000,
    ): CommandResult {
        val json = post(
            "/api/workspaces/${encode(workspaceId)}/command",
            CommandRequest(command = command, kind = kind, timeoutMs = timeoutMs),
        )
        return gson.fromJson(json, CommandResult::class.java)
    }
    // ── Tool Events ──

    suspend fun fetchToolEvents(taskId: String, after: Int = 0, limit: Int = 500): List<ToolEvent> {
        val json = get("/api/tool-events?taskId=${encode(taskId)}&after=$after&limit=$limit")
        return gson.fromJson(json, ToolEventListResponse::class.java).items
    }

    suspend fun getToolRun(toolRunId: String, after: Int = 0, limit: Int = 1000): ToolRunDetailResponse {
        val json = get("/api/tool-runs/${encode(toolRunId)}?after=$after&limit=$limit")
        return gson.fromJson(json, ToolRunDetailResponse::class.java)
    }

    suspend fun listApprovals(status: String = "pending", limit: Int = 50): List<ApprovalRequestItem> {
        val json = get("/api/approvals?status=${encode(status)}&limit=$limit")
        return gson.fromJson(json, ApprovalListResponse::class.java).items
    }

    suspend fun decideApproval(approvalId: String, approve: Boolean, reason: String = "Decision from Android"): ApprovalDecisionResponse {
        val json = post(
            "/api/approvals/${encode(approvalId)}/decision",
            ApprovalDecisionRequest(decision = if (approve) "approve" else "deny", reason = reason),
        )
        return gson.fromJson(json, ApprovalDecisionResponse::class.java)
    }

    // ── SSE (Live Call Events) ──

    fun subscribeLiveCallEvents(
        sessionId: String,
        after: Int = 0,
        listener: EventSourceListener
    ): EventSource {
        val url = "$baseUrl/api/live-calls/${encode(sessionId)}/events?after=$after" +
                (if (token.isNotBlank()) "&token=${encode(token)}" else "")
        val req = Request.Builder()
            .url(url)
            .get()
            .build()
        val factory = EventSources.createFactory(sseClient)
        return factory.newEventSource(req, listener)
    }

    // ── SSE (Task Events) ──

    fun subscribeTaskEvents(
        taskId: String,
        after: Int = 0,
        listener: EventSourceListener
    ): EventSource {
        val url = "$baseUrl/api/tasks/${encode(taskId)}/events?after=$after" +
                (if (token.isNotBlank()) "&token=${encode(token)}" else "")
        val req = Request.Builder()
            .url(url)
            .get()
            .build()
        val factory = EventSources.createFactory(sseClient)
        return factory.newEventSource(req, listener)
    }

    // ── SSE (Tool Events) ──

    fun subscribeToolEvents(
        taskId: String? = null,
        workspaceId: String? = null,
        after: Int = 0,
        listener: EventSourceListener
    ): EventSource {
        val params = mutableListOf("after=$after")
        taskId?.let { params.add("taskId=${encode(it)}") }
        workspaceId?.let { params.add("workspaceId=${encode(it)}") }
        val url = "$baseUrl/api/tool-events?stream=1&${params.joinToString("&")}" +
                (if (token.isNotBlank()) "&token=${encode(token)}" else "")
        val req = Request.Builder()
            .url(url)
            .get()
            .build()
        val factory = EventSources.createFactory(sseClient)
        return factory.newEventSource(req, listener)
    }
}

class ApiException(val statusCode: Int, val body: String) : Exception(apiExceptionMessage(statusCode, body))

private fun apiExceptionMessage(statusCode: Int, body: String): String {
    val serverMessage = runCatching {
        JsonParser.parseString(body).asJsonObject
            .get("error")
            ?.takeIf { !it.isJsonNull }
            ?.asString
            .orEmpty()
    }.getOrDefault("")
    return "HTTP $statusCode: ${serverMessage.ifBlank { body.ifBlank { "Request failed" } }}"
}
