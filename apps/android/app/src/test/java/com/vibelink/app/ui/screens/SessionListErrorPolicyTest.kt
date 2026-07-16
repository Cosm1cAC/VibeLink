package com.vibelink.app.ui.screens

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SessionListErrorPolicyTest {
    @Test
    fun showsRefreshErrorWhenCachedConversationsRemainVisible() {
        assertTrue(SessionListErrorPolicy.showCachedContentError("Network unavailable", conversationCount = 3))
    }

    @Test
    fun leavesEmptyStateResponsibleForInitialLoadErrors() {
        assertFalse(SessionListErrorPolicy.showCachedContentError("Network unavailable", conversationCount = 0))
        assertFalse(SessionListErrorPolicy.showCachedContentError("", conversationCount = 3))
    }
}
