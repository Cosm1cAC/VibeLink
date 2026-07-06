package com.vibelink.app.network

import com.google.gson.annotations.SerializedName

// ── API Models ──

data class PublicSettings(
    @SerializedName("hasOpenAIKey") val hasOpenAIKey: Boolean = false,
    @SerializedName("hasAnthropicKey") val hasAnthropicKey: Boolean = false,
    @SerializedName("hasZhipuKey") val hasZhipuKey: Boolean = false,
    @SerializedName("defaultCwd") val defaultCwd: String = "",
)

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

data class TranscriptBody(
    val text: String,
    val final: Boolean = true,
    val speaker: String = "remote",
)
