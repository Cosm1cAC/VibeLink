package com.vibelink.app.ui.screens

import com.vibelink.app.network.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MessageListScrollTargetTest {
    @Test
    fun findsMessageByTurnId() {
        val messages = listOf(
            ChatMessage(id = "a", turnId = "turn-a"),
            ChatMessage(id = "b", turnId = "turn-b"),
        )

        assertEquals(1, MessageListScrollTarget.findMessageIndex(messages, "turn-b"))
    }

    @Test
    fun fallsBackToMessageId() {
        val messages = listOf(
            ChatMessage(id = "a", turnId = ""),
            ChatMessage(id = "b", turnId = ""),
        )

        assertEquals(1, MessageListScrollTarget.findMessageIndex(messages, "b"))
    }

    @Test
    fun returnsNullWhenTargetIsBlankOrMissing() {
        val messages = listOf(ChatMessage(id = "a", turnId = "turn-a"))

        assertNull(MessageListScrollTarget.findMessageIndex(messages, ""))
        assertNull(MessageListScrollTarget.findMessageIndex(messages, "missing"))
    }
}
