package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals

class ApiClientEventCatchUpTest {
    @Test
    fun requestsToolAndLiveCallEventsAfterLastSeenCursor() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(jsonResponse("""{"items":[{"id":"tool-42","cursor":42}]}"""))
            server.enqueue(jsonResponse("""{"items":[{"id":"call-18","cursor":18}]}"""))
            server.start()
            val client = ApiClient().apply {
                baseUrl = server.url("/").toString().trimEnd('/')
                token = "test-device-token"
            }

            assertEquals(42, client.fetchToolEvents(taskId = "task-a", after = 41, limit = 50).single().cursor)
            assertEquals(18, client.fetchLiveCallEvents(sessionId = "call-a", after = 17, limit = 75).single().cursor)

            assertEquals("/api/tool-events?taskId=task-a&after=41&limit=50", server.takeRequest().path)
            assertEquals("/api/live-calls/call-a/events/catch-up?after=17&limit=75", server.takeRequest().path)
        }
    }

    private fun jsonResponse(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
