package com.vibelink.app.ui

import com.vibelink.app.network.ConversationItem
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
}
