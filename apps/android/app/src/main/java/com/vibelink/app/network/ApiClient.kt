package com.vibelink.app.network

import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.net.URLEncoder
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

    private suspend fun post(path: String, body: Any? = null): String = withContext(Dispatchers.IO) {
        val jsonBody = if (body != null) gson.toJson(body) else ""
        val req = Request.Builder()
            .url("$baseUrl$path")
            .apply { authHeaders().forEach { (k, v) -> addHeader(k, v) } }
            .post(jsonBody.toRequestBody(jsonType))
            .build()
        httpClient.newCall(req).execute().use { response ->
            val body = response.body?.string() ?: ""
            if (!response.isSuccessful) throw ApiException(response.code, body)
            body
        }
    }

    // ── Auth ──

    suspend fun checkStatus(): StatusResponse {
        val json = get("/api/status")
        return gson.fromJson(json, StatusResponse::class.java)
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

    suspend fun stopSession(sessionId: String) {
        post("/api/live-calls/$sessionId/stop", mapOf("reason" to "manual"))
    }

    suspend fun sendTranscript(sessionId: String, text: String, final: Boolean = true, speaker: String = "remote") {
        post("/api/live-calls/$sessionId/transcript", TranscriptBody(text, final, speaker))
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

    // ── Histories (session list + detail) ──

    suspend fun listHistories(): List<HistoryItem> {
        val json = get("/api/histories")
        return gson.fromJson(json, HistoryListResponse::class.java).items
    }

    suspend fun getHistoryDetail(provider: String, id: String): HistoryDetail {
        val json = get("/api/histories/$provider/${encode(id)}")
        return gson.fromJson(json, HistoryDetail::class.java)
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

    suspend fun getGitStatus(workspaceId: String): GitStatusResponse {
        val json = get("/api/workspaces/${encode(workspaceId)}/git/status")
        return gson.fromJson(json, GitStatusResponse::class.java)
    }

    suspend fun getGitDiff(workspaceId: String): GitDiffResponse {
        val json = get("/api/workspaces/${encode(workspaceId)}/git/diff")
        return gson.fromJson(json, GitDiffResponse::class.java)
    }

    suspend fun applyGitFileAction(workspaceId: String, path: String, action: String): GitActionResponse {
        val json = post(
            "/api/workspaces/${encode(workspaceId)}/git/file-action",
            GitFileActionRequest(action = action, path = path),
        )
        return gson.fromJson(json, GitActionResponse::class.java)
    }

    suspend fun applyGitAction(
        workspaceId: String,
        action: String,
        message: String = "",
        title: String = "",
    ): GitActionResponse {
        val json = post(
            "/api/workspaces/${encode(workspaceId)}/git/action",
            GitActionRequest(action = action, message = message, title = title),
        )
        return gson.fromJson(json, GitActionResponse::class.java)
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

class ApiException(val statusCode: Int, val body: String) : Exception("HTTP $statusCode: $body")
