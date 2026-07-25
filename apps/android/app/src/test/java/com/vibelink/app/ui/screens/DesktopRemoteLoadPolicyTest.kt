package com.vibelink.app.ui.screens

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DesktopRemoteLoadPolicyTest {
    @Test
    fun avoidsBlockingFreshObservationWhenSelectingRemoteSpace() {
        assertFalse(DesktopRemoteLoadPolicy.freshObservation(manualRefresh = false))
    }

    @Test
    fun requestsFreshObservationForExplicitRefresh() {
        assertTrue(DesktopRemoteLoadPolicy.freshObservation(manualRefresh = true))
    }

    @Test
    fun reloadsRemoteHistoryWhenReturningToTheSameConversation() {
        assertTrue(DesktopRemoteLoadPolicy.shouldReload(sameConversation = true, isDesktopRemote = true))
        assertFalse(DesktopRemoteLoadPolicy.shouldReload(sameConversation = true, isDesktopRemote = false))
    }
}
