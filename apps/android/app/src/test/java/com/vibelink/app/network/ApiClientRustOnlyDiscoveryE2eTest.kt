package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assume.assumeTrue
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

        assertEquals("skill:e2e", command.id)
        assertEquals("/skill e2e", command.name)
        assertEquals("plugin", command.toolKind)
        assertEquals(true, status.ok)
        assertNotNull(status.settings)

        val request = Request.Builder().url("$baseUrl/api/openapi.json").build()
        OkHttpClient().newCall(request).execute().use { response ->
            assertEquals(200, response.code)
            assertEquals("rust", response.header("X-VibeLink-Control-Plane"))
            assertContains(response.body!!.string(), "\"openapi\": \"3.0.3\"")
        }
    }
}
