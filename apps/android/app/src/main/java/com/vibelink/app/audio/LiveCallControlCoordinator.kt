package com.vibelink.app.audio

import com.vibelink.app.network.ApiClient

internal interface LiveCallRemoteControl {
    suspend fun pause(sessionId: String)
    suspend fun resume(sessionId: String)
    suspend fun stop(sessionId: String)
}

internal interface LiveCallLocalControl {
    fun pause()
    fun resume()
    fun stop()
}

internal class LiveCallControlCoordinator(
    private val remote: LiveCallRemoteControl,
    private val local: LiveCallLocalControl,
) {
    suspend fun pause(sessionId: String) {
        remote.pause(sessionId)
        local.pause()
    }

    suspend fun resume(sessionId: String) {
        remote.resume(sessionId)
        local.resume()
    }

    suspend fun stop(sessionId: String) {
        remote.stop(sessionId)
        local.stop()
    }
}

internal class ApiLiveCallRemoteControl(
    private val apiClient: ApiClient,
) : LiveCallRemoteControl {
    override suspend fun pause(sessionId: String) {
        apiClient.pauseSession(sessionId)
    }

    override suspend fun resume(sessionId: String) {
        apiClient.resumeSession(sessionId)
    }

    override suspend fun stop(sessionId: String) {
        apiClient.stopSession(sessionId)
    }
}
