package com.vibelink.app.ui.screens

import kotlin.test.Test
import kotlin.test.assertEquals

class SessionListViewModelTest {
    @Test
    fun exposesDesktopConversationBeforeFirstNetworkLoad() {
        val conversations = SessionListViewModel().conversations.value

        assertEquals(listOf("desktop:current"), conversations.map { it.key })
    }
}
