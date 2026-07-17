package com.vibelink.app.ui.screens

import com.vibelink.app.network.CommandAction
import com.vibelink.app.network.CommandDefinition
import com.vibelink.app.network.SearchResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class SessionDiscoveryModelTest {
    @Test
    fun routesMessageSearchResultsBackToTheirOwningConversation() {
        val target = resolveSearchResultTarget(
            SearchResult(
                kind = "message",
                id = "session-42",
                provider = "codex",
                title = "Search controls",
                snippet = "matching turn",
                turnId = "turn-7",
            ),
        )

        val resolved = assertIs<SearchResultTarget.Conversation>(target)
        val conversation = resolved.item
        assertEquals("history:codex:session-42", conversation.key)
        assertEquals("history", conversation.kind)
        assertEquals("session-42", conversation.sessionId)
        assertEquals("turn-7", resolved.targetTurnId)
    }

    @Test
    fun routesFileSearchResultsToTheExactWorkspaceFile() {
        val target = resolveSearchResultTarget(
            SearchResult(
                kind = "file",
                id = "workspace-1:docs/plan.md",
                workspaceId = "workspace-1",
                path = "docs/plan.md",
                title = "docs/plan.md",
            ),
        )

        val file = assertIs<SearchResultTarget.WorkspaceFile>(target)
        assertEquals("workspace-1", file.workspaceId)
        assertEquals("docs/plan.md", file.path)
    }

    @Test
    fun resolvesRegistryActionsInsteadOfHardCodedCommandIds() {
        val navigate = resolveSessionCommand(
            CommandDefinition(
                id = "custom.workspace",
                name = "Workspace",
                action = CommandAction(type = "navigate", route = "workspace"),
            ),
        )
        val create = resolveSessionCommand(
            CommandDefinition(
                id = "custom.new",
                name = "Create",
                action = CommandAction(type = "new-session"),
            ),
        )
        val refresh = resolveSessionCommand(
            CommandDefinition(
                id = "custom.refresh",
                name = "Reload",
                action = CommandAction(type = "refresh"),
            ),
        )

        assertEquals(SessionCommand.Navigate("workspace"), navigate)
        assertEquals(SessionCommand.NewSession, create)
        assertEquals(SessionCommand.Refresh, refresh)
    }

    @Test
    fun searchCommandMovesFocusToGlobalSearchWhileUnsafeActionsStayDisabled() {
        val search = resolveSessionCommand(
            CommandDefinition(
                id = "search.global",
                name = "Search everywhere",
                action = CommandAction(type = "search"),
            ),
        )
        val workspaceCommand = resolveSessionCommand(
            CommandDefinition(
                id = "workspace.command",
                name = "Run Workspace command",
                action = CommandAction(type = "workspace-command"),
            ),
        )

        assertEquals(SessionCommand.FocusSearch, search)
        assertIs<SessionCommand.Disabled>(workspaceCommand)
    }

    @Test
    fun localSessionFiltersUseTagsFavoritesAndSearchableTagText() {
        val sessions = listOf(
            com.vibelink.app.network.ConversationItem(
                key = "history:codex:one",
                title = "Release notes",
                tags = listOf("Urgent", "mobile"),
                favorite = true,
            ),
            com.vibelink.app.network.ConversationItem(
                key = "history:codex:two",
                title = "Backlog",
                tags = listOf("later"),
            ),
        )

        assertEquals(
            listOf("history:codex:one"),
            filterSessionConversations(
                items = sessions,
                query = "mobile",
                showArchived = false,
                showFavorites = true,
                tag = "urgent",
            ).map { it.key },
        )
    }
}
