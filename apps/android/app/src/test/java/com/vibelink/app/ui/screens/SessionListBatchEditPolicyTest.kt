package com.vibelink.app.ui.screens

import com.vibelink.app.network.ConversationItem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class SessionListBatchEditPolicyTest {
    @Test
    fun desktopAndNewItemsAreNotBatchEditable() {
        assertFalse(SessionListBatchEditPolicy.isBatchEditable(ConversationItem(kind = "desktop")))
        assertFalse(SessionListBatchEditPolicy.isBatchEditable(ConversationItem(kind = "new")))
    }

    @Test
    fun batchFavoriteBuildsUpdatesWithCurrentRevision() {
        val updates = SessionListBatchEditPolicy.buildSetFavoriteUpdates(
            listOf(
                ConversationItem(key = "history:codex:a", kind = "history", revision = 4),
                ConversationItem(key = "desktop:current", kind = "desktop", revision = 9),
            ),
            favorite = true,
        )

        assertEquals(1, updates.size)
        assertEquals("history:codex:a", updates.single().key)
        assertEquals(4, updates.single().expectedRevision)
        assertEquals(true, updates.single().patch.favorite)
    }

    @Test
    fun batchAddTagsUsesMergeOperation() {
        val updates = SessionListBatchEditPolicy.buildAddTagsUpdates(
            listOf(ConversationItem(key = "history:codex:a", kind = "history", revision = 2)),
            tags = listOf("work"),
        )

        assertEquals(listOf("work"), updates.single().patch.addTags)
        assertEquals(null, updates.single().patch.tags)
    }

    @Test
    fun batchRemoveTagsUsesMergeOperation() {
        val updates = SessionListBatchEditPolicy.buildRemoveTagsUpdates(
            listOf(ConversationItem(key = "history:codex:a", kind = "history", revision = 3)),
            tags = listOf("old"),
        )

        assertEquals(listOf("old"), updates.single().patch.removeTags)
        assertEquals(null, updates.single().patch.tags)
    }
}
