package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
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
        val auditLogs = client.listAuditLogs()
        val histories = client.listHistories()
        val searchResults = client.search("rust-only", record = false)
        val tasks = client.listTasks()
        val toolEvents = client.fetchToolEvents("task")
        val approvals = client.listApprovals()
        val pairingSessions = client.listPairingSessions()
        val threadState = client.getThreadState()
        val eventAcks = client.listEventAcks("task")
        val cloudflareGuide = client.getCloudflareGuide()
        val pushSubscriptions = client.listPushSubscriptions("native")
        val review = client.createReview(ReviewCreateRequest("workspace", "feature/android-review", "Android Rust-only review"))
        val reviews = client.listReviews()

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
        assertEquals(true, auditLogs.any { it.type == "settings.export" })
        assertEquals(0, histories.size)
        assertEquals(0, searchResults.items.size)
        assertEquals(0, tasks.size)
        assertEquals(0, toolEvents.size)
        assertEquals(0, approvals.size)
        assertEquals(0, pairingSessions.size)
        assertEquals(0, threadState.items.size)
        assertEquals(0, eventAcks.size)
        assertEquals("127.0.0.1", cloudflareGuide.host)
        assertEquals(false, cloudflareGuide.publicHost)
        assertEquals(true, cloudflareGuide.steps.isNotEmpty())
        assertEquals(true, pushSubscriptions.any { it.kind == "native" })
        assertEquals("Android Rust-only review", review.title)
        assertEquals(true, reviews.any { it.id == review.id })

        val request = Request.Builder().url("$baseUrl/api/openapi.json").build()
        OkHttpClient().newCall(request).execute().use { response ->
            assertEquals(200, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            assertContains(response.body!!.string(), "\"openapi\": \"3.0.3\"")
        }

        val artifactId = "11111111-1111-4111-8111-111111111111.txt"
        val authenticatedClient = OkHttpClient()
        val pushKeyRequest = Request.Builder()
            .url("$baseUrl/api/push/public-key")
            .header("Authorization", "Bearer $token")
            .build()
        authenticatedClient.newCall(pushKeyRequest).execute().use { response ->
            assertEquals(200, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            assertContains(response.body!!.string(), "\"publicKey\":\"push-key\"")
        }
        val jsonMediaType = "application/json".toMediaType()
        val pushRegisterRequest = Request.Builder()
            .url("$baseUrl/api/push/subscriptions")
            .header("Authorization", "Bearer $token")
            .post("""{"subscription":{"endpoint":"https://push.example/android-e2e","keys":{"p256dh":"key"}}}""".toRequestBody(jsonMediaType))
            .build()
        val registeredPushId = authenticatedClient.newCall(pushRegisterRequest).execute().use { response ->
            assertEquals(201, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            val body = response.body!!.string()
            assertContains(body, "\"ok\":true")
            Regex(""""id":"([^"]+)"""").find(body)!!.groupValues[1]
        }
        val nativePushRequest = Request.Builder()
            .url("$baseUrl/api/push/native-token")
            .header("Authorization", "Bearer $token")
            .post("""{"provider":"fcm","token":"native-token-android-e2e","platform":"android","appId":"app","installationId":"install"}""".toRequestBody(jsonMediaType))
            .build()
        authenticatedClient.newCall(nativePushRequest).execute().use { response ->
            assertEquals(201, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            assertContains(response.body!!.string(), "\"kind\":\"native\"")
        }
        val nativePushListRequest = Request.Builder()
            .url("$baseUrl/api/push/subscriptions?kind=native")
            .header("Authorization", "Bearer $token")
            .build()
        authenticatedClient.newCall(nativePushListRequest).execute().use { response ->
            assertEquals(200, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            assertContains(response.body!!.string(), "\"kind\":\"native\"")
        }
        val pushDeleteRequest = Request.Builder()
            .url("$baseUrl/api/push/subscriptions/$registeredPushId")
            .header("Authorization", "Bearer $token")
            .delete()
            .build()
        authenticatedClient.newCall(pushDeleteRequest).execute().use { response ->
            assertEquals(200, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            assertContains(response.body!!.string(), "\"ok\":true")
        }
        val toolRunsRequest = Request.Builder()
            .url("$baseUrl/api/tool-runs")
            .header("Authorization", "Bearer $token")
            .build()
        authenticatedClient.newCall(toolRunsRequest).execute().use { response ->
            assertEquals(200, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            assertContains(response.body!!.string(), "\"items\":[]")
        }
        val terminalSessionsRequest = Request.Builder()
            .url("$baseUrl/api/terminal-sessions")
            .header("Authorization", "Bearer $token")
            .build()
        authenticatedClient.newCall(terminalSessionsRequest).execute().use { response ->
            assertEquals(200, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            assertContains(response.body!!.string(), "\"items\":[]")
        }
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
