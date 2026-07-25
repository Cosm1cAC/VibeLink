package com.vibelink.app.ui.screens

import com.vibelink.app.network.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class DesktopRemoteMessagePolicyTest {
    @Test
    fun queueStatusDoesNotReplaceDesktopConversationHistory() {
        val transcript = listOf(ChatMessage(role = "assistant", text = "Desktop reply"))
        val status = ChatMessage(role = "system", text = "Remote queue failed")

        assertEquals(transcript, DesktopRemoteMessagePolicy.displayedMessages(transcript, status))
    }

    @Test
    fun statusIsShownOnlyWhenDesktopConversationIsEmpty() {
        val status = ChatMessage(role = "system", text = "Codex Desktop not connected")

        assertEquals(listOf(status), DesktopRemoteMessagePolicy.displayedMessages(emptyList(), status))
    }
}
