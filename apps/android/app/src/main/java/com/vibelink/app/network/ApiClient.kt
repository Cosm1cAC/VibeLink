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

    // ── HTTP helpers ──

    private fun authHeaders() = if (token.isNotBlank())
        mapOf("Authorization" to "Bearer $token") else emptyMap()

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

    // ── Live Calls ──

    suspend fun createSession(title: String = "Live Call", source: String = "android"): Session? {
        val json = post("/api/live-calls", mapOf("title" to title, "source" to source))
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
        val json = get("/api/histories/$provider/${java.net.URLEncoder.encode(id, "UTF-8")}")
        return gson.fromJson(json, HistoryDetail::class.java)
    }

    // ── Tool Events ──

    suspend fun fetchToolEvents(taskId: String, after: Int = 0, limit: Int = 500): List<ToolEvent> {
        val json = get("/api/tool-events?taskId=${java.net.URLEncoder.encode(taskId, "UTF-8")}&after=$after&limit=$limit")
        return gson.fromJson(json, ToolEventListResponse::class.java).items
    }

    // ── SSE (Live Call Events) ──

    fun subscribeLiveCallEvents(
        sessionId: String,
        after: Int = 0,
        listener: EventSourceListener
    ): EventSource {
        val url = "$baseUrl/api/live-calls/$sessionId/events?after=$after" +
                (if (token.isNotBlank()) "&token=${token}" else "")
        val req = Request.Builder()
            .url(url)
            .get()
            .build()
        val factory = EventSources.createFactory(httpClient)
        return factory.newEventSource(req, listener)
    }

    // ── SSE (Task Events) ──

    fun subscribeTaskEvents(
        taskId: String,
        after: Int = 0,
        listener: EventSourceListener
    ): EventSource {
        val url = "$baseUrl/api/tasks/$taskId/events?after=$after" +
                (if (token.isNotBlank()) "&token=${token}" else "")
        val req = Request.Builder()
            .url(url)
            .get()
            .build()
        val factory = EventSources.createFactory(httpClient)
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
        taskId?.let { params.add("taskId=$it") }
        workspaceId?.let { params.add("workspaceId=$it") }
        val url = "$baseUrl/api/tool-events?stream=1&${params.joinToString("&")}" +
                (if (token.isNotBlank()) "&token=${token}" else "")
        val req = Request.Builder()
            .url(url)
            .get()
            .build()
        val factory = EventSources.createFactory(httpClient)
        return factory.newEventSource(req, listener)
    }
}

class ApiException(val statusCode: Int, val body: String) : Exception("HTTP $statusCode: $body")
