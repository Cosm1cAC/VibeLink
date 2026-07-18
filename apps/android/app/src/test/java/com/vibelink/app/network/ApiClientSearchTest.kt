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
                sort = "updatedAt",
                order = "asc",
            )

            assertEquals(
                "/api/search?q=hello+world&scope=messages&limit=25&cursor=50&tag=urgent+tag&favorite=1&sort=updatedAt&order=asc",
                server.takeRequest().path,
            )
        }
    }

    @Test
    fun managesSavedSearchesAndHistory() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(jsonResponse("""{"items":[{"id":"saved-1","name":"Recent"}]}"""))
            server.enqueue(jsonResponse("""{"id":"saved-2","name":"Files","query":"alpha"}"""))
            server.enqueue(jsonResponse("""{"items":[{"id":"history-1","query":"alpha"}]}"""))
            server.start()
            val client = ApiClient().apply {
                baseUrl = server.url("/").toString().trimEnd('/')
                token = "test-device-token"
            }

            assertEquals("saved-1", client.listSavedSearches().single().id)
            assertEquals(
                "saved-2",
                client.saveSearch(SavedSearchRequest(name = "Files", query = "alpha", scope = "files")).id,
            )
            assertEquals("history-1", client.listSearchHistory().single().id)
            assertEquals("/api/search/saved", server.takeRequest().path)
            assertEquals("/api/search/saved", server.takeRequest().path)
            assertEquals("/api/search/history?limit=30", server.takeRequest().path)
        }
    }

    private fun jsonResponse(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
