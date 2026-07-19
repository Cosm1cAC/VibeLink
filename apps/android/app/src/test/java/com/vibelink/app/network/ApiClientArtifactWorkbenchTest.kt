package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals

class ApiClientArtifactWorkbenchTest {
    @Test
    fun previewsAndMutatesArtifactsWithDigest() = runBlocking {
        MockWebServer().use { server ->
            val preview = """{"preview":{"kind":"table","digest":"sha256:one","capabilities":{"mutation":true},"document":{"type":"table","columns":["name"],"rows":[["Ada"]]}}}"""
            server.enqueue(json(preview))
            server.enqueue(json("""{"preview":{"kind":"table","digest":"sha256:two","document":{"type":"table","columns":["name"],"rows":[["Grace"]]}}}"""))
            server.start()
            val client = ApiClient().apply {
                baseUrl = server.url("/").toString().trimEnd('/')
                token = "test-device-token"
            }

            val loaded = client.previewArtifact("report.csv")
            assertEquals("Ada", loaded.document.rows.single().single())
            val saved = client.saveTableArtifact("report.csv", loaded.digest, loaded.document.copy(rows = listOf(listOf("Grace"))))
            assertEquals("sha256:two", saved.digest)
            assertEquals("/api/artifacts/report.csv/preview", server.takeRequest().path)
            val mutation = server.takeRequest()
            assertEquals("PATCH", mutation.method)
            assertEquals(true, mutation.body.readUtf8().contains("sha256:one"))
        }
    }

    private fun json(body: String) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)
}
