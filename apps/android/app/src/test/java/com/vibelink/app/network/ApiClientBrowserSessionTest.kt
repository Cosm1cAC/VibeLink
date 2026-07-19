package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals

class ApiClientBrowserSessionTest {
    @Test
    fun consumesManagedBrowserSessionContract() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"items":[{"id":"session-1","pages":[{"id":"page-1","status":"open"}]}]}"""))
            server.enqueue(json("""{"session":{"id":"session-2","status":"open","pages":[{"id":"page-2"}]}}""", 201))
            server.enqueue(json("""{"navigation":{"ok":true,"pageId":"page-2","url":"https://example.com"}}"""))
            server.enqueue(json("""{"screenshot":{"pageId":"page-2","mimeType":"image/png","bytes":3,"dataBase64":"YWJj"}}"""))
            server.enqueue(json("""{"items":[{"seq":1,"type":"session.created"}],"nextCursor":1}"""))
            server.enqueue(json("""{"session":{"id":"session-2","status":"closed"}}"""))
            server.start()
            val client = ApiClient().apply {
                baseUrl = server.url("/").toString().trimEnd('/')
                token = "test-device-token"
            }

            assertEquals("session-1", client.listBrowserSessions().single().id)
            assertEquals("session-2", client.createBrowserSession().id)
            assertEquals(true, client.navigateBrowserSession("session-2", "page-2", "https://example.com").ok)
            assertEquals("YWJj", client.captureBrowserScreenshot("session-2", "page-2").dataBase64)
            assertEquals("session.created", client.getBrowserTrace("session-2").items.single().type)
            client.closeBrowserSession("session-2")

            assertEquals("/api/browser-sessions", server.takeRequest().path)
            assertEquals("POST", server.takeRequest().method)
            assertEquals("/api/browser-sessions/session-2/navigate", server.takeRequest().path)
            assertEquals("/api/browser-sessions/session-2/screenshot", server.takeRequest().path)
            assertEquals("/api/browser-sessions/session-2/trace?after=0&limit=100", server.takeRequest().path)
            assertEquals("DELETE", server.takeRequest().method)
        }
    }

    private fun json(body: String, status: Int = 200) = MockResponse()
        .setResponseCode(status)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
