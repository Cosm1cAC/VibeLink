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

    @Test
    fun executesCapabilityLifecycleMutations() = runBlocking {
        MockWebServer().use { server ->
            repeat(8) { server.enqueue(json("""{"ok":true}""")) }
            server.start()
            val client = ApiClient(server.url("/").toString().trimEnd('/'), "token")
            client.installPlugin("demo", "Demo", "1.0.0")
            client.removePlugin("demo")
            client.createAutomation("Check", "interval", "60000", "inspect")
            client.removeAutomation("auto-1")
            client.updateCapabilityConfig("project-agents", "sha256:old", "# Rules\n")
            client.createSubagent("parent-1", "inspect", "codex")
            client.stopTask("child-1")
            client.setHookEnabled("claude:Stop", false)
            assertEquals("POST /api/capabilities/plugins", requestLine(server))
            assertEquals("DELETE /api/capabilities/plugins/demo", requestLine(server))
            assertEquals("POST /api/automations", requestLine(server))
            assertEquals("DELETE /api/automations/auto-1", requestLine(server))
            assertEquals("PATCH /api/capabilities/config/project-agents", requestLine(server))
            assertEquals("POST /api/subagents", requestLine(server))
            assertEquals("POST /api/tasks/child-1/stop", requestLine(server))
            assertEquals("PATCH /api/capabilities/hooks/claude%3AStop", requestLine(server))
        }
    }

    private fun requestLine(server: MockWebServer): String {
        val request = server.takeRequest()
        return "${request.method} ${request.path}"
    }

    private fun json(body: String) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)
}
