package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assume.assumeTrue
import java.net.URLEncoder
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class ApiClientRustOnlyDiscoveryE2eTest {
    @Test
    fun consumesCommandRegistryFromRustOnlyServer() = runBlocking {
        val baseUrl = System.getenv("VIBELINK_RUST_ONLY_E2E_URL").orEmpty()
        val token = System.getenv("VIBELINK_RUST_ONLY_E2E_TOKEN").orEmpty()
        assumeTrue("rust-only E2E server is not configured", baseUrl.isNotBlank() && token.isNotBlank())

        val client = ApiClient().apply {
            this.baseUrl = baseUrl
            this.token = token
        }
        val command = client.listCommands("e2e").single()
        val status = client.checkStatus()
        val providerRegistry = client.getProviderRegistry()
        val doctor = client.getDoctor()
        val devices = client.listDevices()
        val settingsExport = client.exportSettings()
        val workspaces = client.listWorkspaces()

        assertEquals("skill:e2e", command.id)
        assertEquals("/skill e2e", command.name)
        assertEquals("plugin", command.toolKind)
        assertEquals(true, status.ok)
        assertNotNull(status.settings)
        assertEquals(2, providerRegistry.version)
        assertEquals("codex", providerRegistry.defaultProvider)
        assertEquals(listOf("codex", "claude", "doubao", "zhipu"), providerRegistry.providers.map { it.id })
        assertEquals(true, doctor.checks.isNotEmpty())
        assertEquals(true, doctor.generatedAt.isNotBlank())
        assertEquals("device", devices.currentDeviceId)
        assertEquals(listOf("device"), devices.items.map { it.id })
        assertEquals("vibelink.settings.export", settingsExport.kind)
        assertEquals(false, settingsExport.settings.containsKey("pairingToken"))
        assertEquals(listOf("workspace"), workspaces.map { it.id })

        val request = Request.Builder().url("$baseUrl/api/openapi.json").build()
        OkHttpClient().newCall(request).execute().use { response ->
            assertEquals(200, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            assertContains(response.body!!.string(), "\"openapi\": \"3.0.3\"")
        }

        val artifactId = "11111111-1111-4111-8111-111111111111.txt"
        val authenticatedClient = OkHttpClient()
        listOf(
            "/api/artifacts/$artifactId" to "\"id\":\"$artifactId\"",
            "/api/attachments/$artifactId" to "hello from rust artifact",
        ).forEach { (path, expected) ->
            val authenticatedRequest = Request.Builder()
                .url("$baseUrl$path")
                .header("Authorization", "Bearer $token")
                .build()
            authenticatedClient.newCall(authenticatedRequest).execute().use { response ->
                assertEquals(200, response.code, path)
                assertEquals("rust", response.header("X-VibeLink-Control-Plane"), path)
                assertContains(response.body!!.string(), expected)
            }
        }
        val filePath = System.getenv("VIBELINK_RUST_ONLY_E2E_FILE").orEmpty()
        val fileRequest = Request.Builder()
            .url("$baseUrl/api/files?path=${URLEncoder.encode(filePath, "UTF-8")}")
            .header("Authorization", "Bearer $token")
            .build()
        authenticatedClient.newCall(fileRequest).execute().use { response ->
            assertEquals(200, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            assertContains(response.body!!.string(), "hello from rust file")
        }
        val desktopRequest = Request.Builder()
            .url("$baseUrl/api/desktop-remote/observations?after=0&limit=1")
            .header("Authorization", "Bearer $token")
            .build()
        authenticatedClient.newCall(desktopRequest).execute().use { response ->
            assertEquals(200, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            assertContains(response.body!!.string(), "\"ready\":true")
        }
    }
}
