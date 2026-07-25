package com.vibelink.app.ui.screens

import com.vibelink.app.network.DesktopConversation
import com.vibelink.app.network.DesktopRemoteState
import com.vibelink.app.network.DesktopSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals

class SessionListViewModelTest {
    @Test
    fun exposesDesktopConversationBeforeFirstNetworkLoad() {
        val conversations = SessionListViewModel().conversations.value

        assertEquals(listOf("desktop:current"), conversations.map { it.key })
    }

    @Test
    fun exposesObservedDesktopConversationsAsRemoteTargets() {
        val state = DesktopRemoteState(
            updatedAt = "2026-07-25T04:30:00Z",
            desktop = DesktopSnapshot(
                conversations = listOf(
                    DesktopConversation(index = 2, title = "Work project", running = true),
                    DesktopConversation(index = 4, rawName = "Research"),
                ),
            ),
        )

        val items = SessionListViewModel.desktopConversationItems(state, excludedIndices = setOf(4))

        assertEquals(listOf("desktop:conversation:2"), items.map { it.key })
        assertEquals("desktop", items.single().kind)
        assertEquals(2, items.single().desktopIndex)
        assertEquals(true, items.single().desktopLinked)
        assertEquals("running", items.single().status)
    }
}
