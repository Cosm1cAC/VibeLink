package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ApiClientThreadStateTest {
    @Test
    fun patchThreadSerializesExpectedRevision() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(jsonResponse("""{"version":1,"items":{},"forks":[]}"""))
            server.start()
            val client = testClient(server)

            client.patchThread("history:codex:abc", ThreadPatch(favorite = true), expectedRevision = 7)

            val request = server.takeRequest()
            assertEquals("/api/thread-state", request.path)
            val body = request.body.readUtf8()
            assertTrue(body.contains("\"expectedRevision\":7"), body)
            assertTrue(body.contains("\"favorite\":true"), body)
        }
    }

    @Test
    fun patchThreadsSerializesExpectedRevisionsAndTagOperations() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(jsonResponse("""{"version":1,"items":{},"forks":[]}"""))
            server.start()
            val client = testClient(server)

            client.patchThreads(
                listOf(
                    ThreadPatchRequest(
                        key = "history:codex:a",
                        patch = ThreadPatch(addTags = listOf("work")),
                        expectedRevision = 2,
                    ),
                    ThreadPatchRequest(
                        key = "history:codex:b",
                        patch = ThreadPatch(removeTags = listOf("old")),
                        expectedRevision = 3,
                    ),
                ),
            )

            val request = server.takeRequest()
            assertEquals("/api/thread-state/batch", request.path)
            val body = request.body.readUtf8()
            assertTrue(body.contains("\"updates\""), body)
            assertTrue(body.contains("\"expectedRevision\":2"), body)
            assertTrue(body.contains("\"expectedRevision\":3"), body)
            assertTrue(body.contains("\"addTags\":[\"work\"]"), body)
            assertTrue(body.contains("\"removeTags\":[\"old\"]"), body)
        }
    }

    @Test
    fun conflictResponseExposesStatusCode() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(jsonResponse("""{"error":"Thread state conflict.","code":"THREAD_STATE_CONFLICT"}""", code = 409))
            server.start()
            val client = testClient(server)

            val error = assertFailsWith<ApiException> {
                client.patchThread("history:codex:abc", ThreadPatch(favorite = true), expectedRevision = 1)
            }

            assertEquals(409, error.statusCode)
        }
    }

    private fun testClient(server: MockWebServer): ApiClient = ApiClient().apply {
        baseUrl = server.url("/").toString().trimEnd('/')
        token = "test-device-token"
    }

    private fun jsonResponse(body: String, code: Int = 200): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
