package com.vibelink.app.ui.screens

import com.vibelink.app.network.ChatMessage
import com.vibelink.app.network.TaskEvent
import com.vibelink.app.network.ToolEvent
import com.vibelink.app.network.TranscriptEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MessageListReducerTest {
    @Test
    fun preservesTranscriptTurnIdsForSearchResultNavigation() {
        val messages = MessageListViewModel.messagesFromTranscript(
            listOf(TranscriptEntry(role = "assistant", text = "Match", turnId = "turn-7")),
        )

        assertEquals("turn-7", messages.single().turnId)
    }

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

    @Test
    fun editsFirstMatchingMessageByTurnId() {
        val messages = listOf(
            ChatMessage(role = "user", text = "Original", turnId = "turn-1"),
            ChatMessage(role = "user", text = "Original", turnId = "turn-2"),
        )

        val edited = MessageListViewModel.editFirstMatchingMessage(
            messages,
            target = ChatMessage(role = "user", text = "ignored", turnId = "turn-1"),
            nextText = "Updated",
        )

        assertEquals("Updated", edited[0].text)
        assertEquals("Original", edited[1].text)
    }

    @Test
    fun deletesOnlyTheFirstMatchingMessage() {
        val messages = listOf(
            ChatMessage(role = "assistant", text = "Duplicate"),
            ChatMessage(role = "assistant", text = "Duplicate"),
            ChatMessage(role = "user", text = "Keep me"),
        )

        val reduced = MessageListViewModel.deleteFirstMatchingMessage(
            messages,
            target = ChatMessage(role = "assistant", text = "Duplicate"),
        )

        assertEquals(2, reduced.size)
        assertEquals("Duplicate", reduced[0].text)
        assertEquals("Keep me", reduced[1].text)
    }

    @Test
    fun findsPreviousUserPromptForRegeneration() {
        val messages = listOf(
            ChatMessage(role = "user", text = "First prompt", turnId = "u1"),
            ChatMessage(role = "assistant", text = "First answer", turnId = "a1"),
            ChatMessage(role = "user", text = "Second prompt", turnId = "u2"),
            ChatMessage(role = "assistant", text = "Second answer", turnId = "a2"),
        )

        val prompt = MessageListViewModel.previousUserPromptForRegeneration(
            messages,
            target = ChatMessage(role = "assistant", text = "ignored", turnId = "a2"),
        )

        assertEquals("Second prompt", prompt)
    }
}
