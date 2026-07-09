package com.vibelink.app.data

import kotlin.test.Test
import kotlin.test.assertEquals

class SettingsStorePromptHistoryCodecTest {
    @Test
    fun promptHistoryCodecRoundTripsMultiLinePrompts() {
        val items = listOf("Review changes", "Line one\nLine two")

        val encoded = PromptHistoryCodec.encode(items)
        val decoded = PromptHistoryCodec.decode(encoded)

        assertEquals(items, decoded)
    }

    @Test
    fun promptHistoryPrependsDeduplicatesAndCapsItems() {
        val existing = (1..12).map { "prompt-$it" }
        val next = PromptHistoryCodec.prepend(existing, "prompt-5")

        assertEquals("prompt-5", next.first())
        assertEquals(12, next.size)
        assertEquals(1, next.count { it == "prompt-5" })
    }
}
