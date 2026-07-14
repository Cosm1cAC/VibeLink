package com.vibelink.app.mobile

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class IncomingSharedContentTest {
    @Test
    fun keepsBinaryStreamsOutOfComposerText() {
        val content = IncomingSharedContent(
            text = "Review this screenshot",
            streamUris = listOf("content://camera/shared-image"),
            mimeType = "image/png",
        )

        assertEquals("Review this screenshot", content.composerText)
        assertEquals(listOf("content://camera/shared-image"), content.streamUris)
        assertTrue(content.hasAttachments)
        assertFalse(content.isEmpty)
    }
}
