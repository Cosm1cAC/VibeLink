package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals

class ApiClientSearchTest {
    @Test
    fun sendsSearchScopePaginationAndFilters() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(jsonResponse("""{"items":[],"nextCursor":""}"""))
            server.start()
            val client = ApiClient().apply {
                baseUrl = server.url("/").toString().trimEnd('/')
                token = "test-device-token"
            }

            client.search(
                query = "hello world",
                scope = "messages",
                limit = 25,
                cursor = "50",
                tag = "urgent tag",
                favorite = true,
            )

            assertEquals(
                "/api/search?q=hello+world&scope=messages&limit=25&cursor=50&tag=urgent+tag&favorite=1",
                server.takeRequest().path,
            )
        }
    }

    private fun jsonResponse(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
