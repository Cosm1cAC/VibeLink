package com.vibelink.app.audio

import com.vibelink.app.network.ApiClient
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class LiveCallControlCoordinatorTest {
    @Test
    fun pauseSynchronizesServerBeforePausingLocalAudio() = runBlocking {
        val calls = mutableListOf<String>()
        val coordinator = LiveCallControlCoordinator(
            remote = RecordingRemoteControl(calls),
            local = RecordingLocalControl(calls),
        )

        coordinator.pause("session-1")

        assertEquals(listOf("remote.pause:session-1", "local.pause"), calls)
    }

    @Test
    fun apiRemoteControlPausesTheServerSessionWithAuthentication() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(200).setBody("""{"session":{"id":"session-1","status":"paused"}}"""))
            val apiClient = ApiClient(
                baseUrl = server.url("/").toString().trimEnd('/'),
                token = "secret-token",
            )

            ApiLiveCallRemoteControl(apiClient).pause("session-1")

            val request = server.takeRequest()
            assertEquals("/api/live-calls/session-1/pause", request.path)
            assertEquals("Bearer secret-token", request.getHeader("Authorization"))
        }
    }

    @Test
    fun failedServerPauseDoesNotPauseLocalAudio() = runBlocking {
        val calls = mutableListOf<String>()
        val coordinator = LiveCallControlCoordinator(
            remote = object : LiveCallRemoteControl {
                override suspend fun pause(sessionId: String) {
                    calls += "remote.pause:$sessionId"
                    error("bridge unavailable")
                }

                override suspend fun resume(sessionId: String) = Unit
                override suspend fun stop(sessionId: String) = Unit
            },
            local = RecordingLocalControl(calls),
        )

        assertFailsWith<IllegalStateException> { coordinator.pause("session-1") }

        assertEquals(listOf("remote.pause:session-1"), calls)
    }
}

private class RecordingRemoteControl(
    private val calls: MutableList<String>,
) : LiveCallRemoteControl {
    override suspend fun pause(sessionId: String) {
        calls += "remote.pause:$sessionId"
    }

    override suspend fun resume(sessionId: String) {
        calls += "remote.resume:$sessionId"
    }

    override suspend fun stop(sessionId: String) {
        calls += "remote.stop:$sessionId"
    }
}

private class RecordingLocalControl(
    private val calls: MutableList<String>,
) : LiveCallLocalControl {
    override fun pause() {
        calls += "local.pause"
    }

    override fun resume() {
        calls += "local.resume"
    }

    override fun stop() {
        calls += "local.stop"
    }
}
