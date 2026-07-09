package com.vibelink.app.ui.screens

import com.vibelink.app.network.ChatMessage
import com.vibelink.app.network.TaskEvent
import com.vibelink.app.network.ToolEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MessageListReducerTest {
    @Test
    fun mergesAssistantDeltasIntoOneStreamingTurn() {
        val incoming = MessageListViewModel.messagesFromEvents(
            listOf(
                TaskEvent(id = "e1", type = "stdout", text = "Hello", cursor = 1),
                TaskEvent(id = "e2", type = "stdout", text = " world", cursor = 2),
            ),
        )

        val merged = MessageListViewModel.mergeMessages(emptyList(), incoming)

        assertEquals(1, merged.size)
        assertEquals("assistant", merged.single().role)
        assertEquals("Hello world", merged.single().text)
        assertTrue(merged.single().streaming)
    }

    @Test
    fun attachesToolCallsToLatestAssistantTurnWithoutCreatingBlankMessage() {
        val messages = listOf(
            ChatMessage(role = "user", text = "Run tests", id = "u1"),
            ChatMessage(role = "assistant", text = "I'll run them.", id = "a1", streaming = true),
        )
        val tool = MessageListViewModel.toolCallFromEvents(
            "run-1",
            listOf(
                ToolEvent(id = "t1", type = "tool.created", cursor = 1, toolRunId = "run-1", payload = mapOf("name" to "shell", "input" to mapOf("command" to "npm test"))),
                ToolEvent(id = "t2", type = "tool.completed", cursor = 2, toolRunId = "run-1", text = "ok"),
            ),
        )

        val reduced = MessageListViewModel.attachToolCallsToActiveAssistant(messages, listOf(tool))

        assertEquals(2, reduced.size)
        assertEquals("I'll run them.", reduced[1].text)
        assertEquals(listOf(tool), reduced[1].toolCalls)
        assertEquals(1, reduced[1].toolCallCount)
        assertFalse(reduced.any { it.text.isBlank() && it.toolCalls.isNotEmpty() && it !== reduced[1] })
    }
}
