package com.vibelink.app.ui.screens

import com.vibelink.app.network.ConversationItem
import kotlin.test.Test
import kotlin.test.assertEquals

class SessionListTagsFilterTest {
    @Test
    fun queryMatchesTags() {
        val items = listOf(
            ConversationItem(key = "history:codex:a", title = "Alpha", tags = listOf("work")),
            ConversationItem(key = "history:codex:b", title = "Beta", tags = listOf("personal")),
        )

        val result = SessionListFilterPolicy.filter(items, query = "work")

        assertEquals(listOf("history:codex:a"), result.map { it.key })
    }

    @Test
    fun selectedTagsRequireAllTags() {
        val items = listOf(
            ConversationItem(key = "history:codex:a", tags = listOf("work", "urgent")),
            ConversationItem(key = "history:codex:b", tags = listOf("work")),
            ConversationItem(key = "history:codex:c", tags = listOf("urgent")),
        )

        val result = SessionListFilterPolicy.filter(items, selectedTags = setOf("work", "urgent"))

        assertEquals(listOf("history:codex:a"), result.map { it.key })
    }

    @Test
    fun tagFilterComposesWithFavoritesAndArchivedState() {
        val items = listOf(
            ConversationItem(key = "history:codex:a", tags = listOf("work"), favorite = true, archived = false),
            ConversationItem(key = "history:codex:b", tags = listOf("work"), favorite = false, archived = false),
            ConversationItem(key = "history:codex:c", tags = listOf("work"), favorite = true, archived = true),
        )

        val result = SessionListFilterPolicy.filter(
            items,
            selectedTags = setOf("work"),
            showFavorites = true,
            showArchived = false,
        )

        assertEquals(listOf("history:codex:a"), result.map { it.key })
    }
}
