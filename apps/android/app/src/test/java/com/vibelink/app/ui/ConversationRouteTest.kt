package com.vibelink.app.ui

import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.SearchResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class ConversationRouteTest {
    @Test
    fun restoresConversationFromRouteKeyWhenPendingStateWasLost() {
        val conversation = ConversationItem(
            key = "history:codex:session/with/slashes",
            kind = "history",
            provider = "codex",
            sessionId = "session/with/slashes",
            title = "Recovered chat",
        )

        val restored = ConversationRoute.restoreConversation(
            routeKey = ConversationRoute.encodeKey(conversation.key),
            pending = null,
            conversations = listOf(conversation),
        )

        assertNotNull(restored)
        assertEquals(conversation.key, restored.key)
    }

    @Test
    fun createsShareConversationWhenSharedRouteIsRestored() {
        val restored = ConversationRoute.restoreConversation(
            routeKey = "share:123",
            pending = null,
            conversations = emptyList(),
        )

        assertNotNull(restored)
        assertEquals("new", restored.kind)
        assertEquals("Shared to VibeLink", restored.title)
    }

    @Test
    fun returnsNullForUnknownManagedRouteUntilSessionListLoads() {
        val restored = ConversationRoute.restoreConversation(
            routeKey = "history:codex:missing",
            pending = null,
            conversations = emptyList(),
        )

        assertNull(restored)
    }

    @Test
    fun mapsHistorySearchResultToConversation() {
        val conversation = ConversationRoute.conversationFromSearchResult(
            SearchResult(kind = "history", id = "session-1", provider = "codex", title = "Session", snippet = "match"),
        )

        assertNotNull(conversation)
        assertEquals("history:codex:session-1", conversation.key)
        assertEquals("history", conversation.kind)
        assertEquals("session-1", conversation.sessionId)
    }

    @Test
    fun mapsMessageSearchResultToOwningHistoryConversation() {
        val conversation = ConversationRoute.conversationFromSearchResult(
            SearchResult(kind = "message", id = "session-2", provider = "claude", title = "Chat", turnId = "turn-9"),
        )

        assertNotNull(conversation)
        assertEquals("history:claude:session-2", conversation.key)
        assertEquals("history", conversation.kind)
        assertEquals("session-2", conversation.sessionId)
    }

    @Test
    fun mapsTaskSearchResultToTaskConversation() {
        val conversation = ConversationRoute.conversationFromSearchResult(
            SearchResult(kind = "task", id = "task-1", provider = "codex", title = "Task"),
        )

        assertNotNull(conversation)
        assertEquals("task:task-1", conversation.key)
        assertEquals("task", conversation.kind)
        assertEquals("task-1", conversation.id)
    }

    @Test
    fun identifiesFileSearchResultsAsWorkspaceTargets() {
        assertEquals(true, ConversationRoute.isFileSearchResult(SearchResult(kind = "file", path = "src/Main.kt")))
        assertEquals(false, ConversationRoute.isFileSearchResult(SearchResult(kind = "message")))
    }
}
