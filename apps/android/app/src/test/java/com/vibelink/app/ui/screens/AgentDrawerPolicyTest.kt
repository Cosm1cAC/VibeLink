package com.vibelink.app.ui.screens

import com.vibelink.app.network.ConversationItem
import kotlin.test.Test
import kotlin.test.assertEquals

class AgentDrawerPolicyTest {
    @Test
    fun separatesDesktopRemoteFromAgentConversations() {
        val conversations = listOf(
            ConversationItem(key = "desktop", kind = "desktop", title = "Codex Desktop remote"),
            ConversationItem(key = "task", kind = "task", title = "Agent task"),
            ConversationItem(key = "history", kind = "history", title = "Agent history"),
        )

        assertEquals(
            listOf("desktop"),
            AgentDrawerPolicy.filterAndSort(conversations, "", ConversationSpace.Remote).map { it.key },
        )
        assertEquals(
            listOf("task", "history"),
            AgentDrawerPolicy.filterAndSort(conversations, "", ConversationSpace.Agent).map { it.key },
        )
    }

    @Test
    fun keepsSelectionsIndependentWhenSwitchingSpaces() {
        val remote = ConversationItem(key = "desktop", kind = "desktop")
        val agent = ConversationItem(key = "task", kind = "task")

        val state = ConversationSpaceState()
            .select(ConversationSpace.Remote, remote, "remote-turn")
            .select(ConversationSpace.Agent, agent, "agent-turn")

        assertEquals(remote, state.selectionFor(ConversationSpace.Remote).conversation)
        assertEquals("remote-turn", state.selectionFor(ConversationSpace.Remote).targetTurnId)
        assertEquals(agent, state.selectionFor(ConversationSpace.Agent).conversation)
        assertEquals("agent-turn", state.selectionFor(ConversationSpace.Agent).targetTurnId)
    }

    @Test
    fun putsPinnedConversationsBeforeRecentConversations() {
        val conversations = listOf(
            ConversationItem(key = "older", title = "Older", updatedAt = "2026-07-18T08:00:00Z"),
            ConversationItem(key = "recent", title = "Recent", updatedAt = "2026-07-20T08:00:00Z"),
            ConversationItem(key = "pinned", title = "Pinned", updatedAt = "2026-07-17T08:00:00Z", pinned = true),
        )

        assertEquals(
            listOf("pinned", "recent", "older"),
            AgentDrawerPolicy.filterAndSort(conversations, "").map { it.key },
        )
    }

    @Test
    fun searchesTitlesProvidersAndWorkingDirectoriesCaseInsensitively() {
        val conversations = listOf(
            ConversationItem(key = "title", title = "Android shell"),
            ConversationItem(key = "provider", title = "Review", provider = "Claude"),
            ConversationItem(key = "cwd", title = "Workspace", cwd = "C:/Projects/VibeLink"),
        )

        assertEquals(listOf("title"), AgentDrawerPolicy.filterAndSort(conversations, "ANDROID").map { it.key })
        assertEquals(listOf("provider"), AgentDrawerPolicy.filterAndSort(conversations, "claude").map { it.key })
        assertEquals(listOf("cwd"), AgentDrawerPolicy.filterAndSort(conversations, "projects").map { it.key })
    }
}
