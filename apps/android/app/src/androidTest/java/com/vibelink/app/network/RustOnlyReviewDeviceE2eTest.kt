package com.vibelink.app.network

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RustOnlyReviewDeviceE2eTest {
    @Test
    fun reviewCrudUsesRustOnlyServerFromAndroidRuntime() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val baseUrl = args.getString("baseUrl").orEmpty()
        val token = args.getString("token").orEmpty()
        assumeTrue("rust-only server instrumentation args are missing", baseUrl.isNotBlank() && token.isNotBlank())

        val client = ApiClient().apply {
            this.baseUrl = baseUrl
            this.token = token
        }

        val created = client.createReview(
            ReviewCreateRequest(
                workspaceId = "workspace",
                branch = "feature/device-review",
                title = "Device Rust-only review",
            ),
        )
        assertEquals("Device Rust-only review", created.title)
        assertEquals("open", created.status)

        val commented = client.addReviewComment(
            created.id,
            ReviewCommentRequest(
                file = "src/review.rs",
                line = 12,
                body = "Device path reached Rust review route",
                severity = "high",
            ),
        )
        assertEquals(1, commented.comments.size)
        assertEquals("high", commented.comments.single().severity)

        val resolved = client.updateReview(created.id, mapOf("status" to "resolved"))
        assertEquals("resolved", resolved.status)
        assertTrue(client.listReviews().any { it.id == created.id })
    }
}
