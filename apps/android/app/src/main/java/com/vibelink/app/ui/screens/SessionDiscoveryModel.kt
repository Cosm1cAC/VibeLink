package com.vibelink.app.ui.screens

import com.vibelink.app.network.CommandDefinition
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.SearchResult
import com.vibelink.app.network.ThreadPatch
import com.vibelink.app.network.ThreadPatchRequest
import com.vibelink.app.ui.ConversationRoute

sealed interface SearchResultTarget {
    data class Conversation(val item: ConversationItem, val targetTurnId: String = "") : SearchResultTarget
    data class WorkspaceFile(val workspaceId: String, val path: String) : SearchResultTarget
    data class Unsupported(val reason: String) : SearchResultTarget
}

sealed interface SessionCommand {
    data class Navigate(val route: String) : SessionCommand
    data object NewSession : SessionCommand
    data object Refresh : SessionCommand
    data object FocusSearch : SessionCommand
    data class Disabled(val reason: String) : SessionCommand
}

private val allowedSessionRoutes = setOf(
    "sessionList",
    "call",
    "workspace",
    "review",
    "settings",
    "settings?section=approvals",
)

fun resolveSearchResultTarget(result: SearchResult): SearchResultTarget {
    if (ConversationRoute.isFileSearchResult(result)) {
        return if (result.workspaceId.isBlank() || result.path.isBlank()) {
            SearchResultTarget.Unsupported("Workspace file location is unavailable")
        } else {
            SearchResultTarget.WorkspaceFile(result.workspaceId, result.path)
        }
    }
    val conversation = ConversationRoute.conversationFromSearchResult(result)
        ?: return SearchResultTarget.Unsupported("This result type cannot be opened on Android")
    return SearchResultTarget.Conversation(
        item = conversation,
        targetTurnId = if (result.kind == "message") result.turnId else "",
    )
}

fun resolveSessionCommand(command: CommandDefinition): SessionCommand {
    val action = command.action
    return when (action.type) {
        "navigate" -> if (action.route in allowedSessionRoutes) {
            SessionCommand.Navigate(action.route)
        } else {
            SessionCommand.Disabled("This destination is not available on Android")
        }
        "new-session" -> SessionCommand.NewSession
        "refresh" -> SessionCommand.Refresh
        "search" -> SessionCommand.FocusSearch
        "thread-patch" -> SessionCommand.Disabled("Select a session before using this command")
        "workspace-command" -> SessionCommand.Disabled("Open Workspace to run this command")
        else -> SessionCommand.Disabled("Open a conversation to use this command")
    }
}

fun filterSessionCommands(
    commands: List<CommandDefinition>,
    query: String,
): List<CommandDefinition> {
    val needle = query.trim().removePrefix("/").lowercase()
    if (needle.isBlank()) return commands
    return commands.filter { command ->
        listOf(
            command.id,
            command.name,
            command.description,
            command.usage,
            command.toolKind,
            command.ui.label,
            command.ui.detail,
        ).joinToString(" ").lowercase().contains(needle)
    }
}

fun filterSessionConversations(
    items: List<ConversationItem>,
    query: String,
    showArchived: Boolean,
    showFavorites: Boolean,
    tag: String,
    selectedTags: Set<String> = emptySet(),
): List<ConversationItem> {
    val tags = selectedTags + setOf(tag).filter { it.isNotBlank() }
    return SessionListFilterPolicy.filter(
        items = items,
        query = query,
        showArchived = showArchived,
        showFavorites = showFavorites,
        selectedTags = tags,
    )
}

object SessionListFilterPolicy {
    fun filter(
        items: List<ConversationItem>,
        query: String = "",
        showArchived: Boolean = false,
        showFavorites: Boolean = false,
        selectedTags: Set<String> = emptySet(),
    ): List<ConversationItem> {
        val needle = query.trim().lowercase()
        val requestedTags = selectedTags.map { it.trim().lowercase() }.filter { it.isNotBlank() }.toSet()
        return items
        .filter { item -> item.kind == "desktop" || if (showArchived) item.archived else !item.archived }
        .filter { item -> !showFavorites || item.favorite }
        .filter { item ->
            requestedTags.isEmpty() || item.tags.map { it.trim().lowercase() }.toSet().containsAll(requestedTags)
        }
        .filter { item ->
            needle.isBlank() || listOf(
                item.title,
                item.provider,
                item.cwd,
                item.sessionId,
                item.preview,
                item.group,
                item.tags.joinToString(" "),
            ).joinToString(" ").lowercase().contains(needle)
        }
    }
}

object SessionListBatchEditPolicy {
    fun isBatchEditable(item: ConversationItem): Boolean {
        return item.key.isNotBlank() && item.kind != "desktop" && item.kind != "new"
    }

    fun buildSetFavoriteUpdates(
        items: List<ConversationItem>,
        favorite: Boolean,
    ): List<ThreadPatchRequest> = editableUpdates(items) { ThreadPatch(favorite = favorite) }

    fun buildAddTagsUpdates(
        items: List<ConversationItem>,
        tags: List<String>,
    ): List<ThreadPatchRequest> {
        val cleaned = cleanTags(tags)
        if (cleaned.isEmpty()) return emptyList()
        return editableUpdates(items) { ThreadPatch(addTags = cleaned) }
    }

    fun buildRemoveTagsUpdates(
        items: List<ConversationItem>,
        tags: List<String>,
    ): List<ThreadPatchRequest> {
        val cleaned = cleanTags(tags)
        if (cleaned.isEmpty()) return emptyList()
        return editableUpdates(items) { ThreadPatch(removeTags = cleaned) }
    }

    private fun editableUpdates(
        items: List<ConversationItem>,
        patch: (ConversationItem) -> ThreadPatch,
    ): List<ThreadPatchRequest> = items
        .filter(::isBatchEditable)
        .map { item -> ThreadPatchRequest(item.key, patch(item), item.revision) }

    private fun cleanTags(tags: List<String>): List<String> = tags
        .map(String::trim)
        .filter(String::isNotBlank)
        .distinctBy(String::lowercase)
}
