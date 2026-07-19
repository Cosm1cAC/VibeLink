package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals

class ApiClientCapabilityCenterTest {
    @Test
    fun listsCapabilitiesAndRunsAutomations() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"items":[{"id":"auto-1","title":"Check","enabled":true,"schedule":{"type":"cron","value":"0 * * * *"}}]}"""))
            server.enqueue(json("""{"started":true,"automation":{"id":"auto-1"}}"""))
            server.start()
            val client = ApiClient(server.url("/").toString().trimEnd('/'), "token")
            assertEquals("auto-1", client.listCapabilities("automations").single().id)
            client.runAutomation("auto-1")
            assertEquals("/api/capabilities/automations", server.takeRequest().path)
            assertEquals("/api/automations/auto-1/run", server.takeRequest().path)
        }
    }

    private fun json(body: String) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)
}
