package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import kotlin.test.Test
import kotlin.test.assertEquals

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

        assertEquals("skill:e2e", command.id)
        assertEquals("/skill e2e", command.name)
        assertEquals("plugin", command.toolKind)
    }
}
