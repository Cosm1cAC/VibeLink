package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals

class ApiClientDesktopRemoteObservationsTest {
    @Test
    fun readsRustOwnedDesktopObservationRouteWithCursorBounds() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"items":[{"type":"desktop.snapshot","cursor":7,"observedAt":"2026-07-24T00:00:00.000Z","hash":"h","desktop":{"ready":true}}]}"""))
            server.start()
            val client = ApiClient().apply {
                baseUrl = server.url("/").toString().trimEnd('/')
                token = "test-device-token"
            }

            val observations = client.getDesktopRemoteObservations(after = 4, limit = 25)

            assertEquals(7, observations.items.single().cursor)
            assertEquals("desktop.snapshot", observations.items.single().type)
            val request = server.takeRequest()
            assertEquals("/api/desktop-remote/observations?after=4&limit=25", request.path)
            assertEquals("Bearer test-device-token", request.getHeader("Authorization"))
        }
    }

    private fun json(body: String) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)
}
