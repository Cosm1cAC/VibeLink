package com.vibelink.app.ui.screens

import com.vibelink.app.network.DesktopFocusResponse
import com.vibelink.app.network.DesktopRemoteTarget
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DesktopRemoteSendPolicyTest {
    @Test
    fun blocksSendingWhenTargetedFocusFails() {
        val result = DesktopRemoteSendPolicy.validateFocus(
            target = DesktopRemoteTarget(desktopIndex = 2, desktopTitle = "Plan review"),
            response = DesktopFocusResponse(ok = false, error = "conversation not visible"),
        )

        assertFalse(result.canSend)
        assertContains(result.message, "Blocked")
        assertContains(result.message, "conversation not visible")
    }

    @Test
    fun allowsSendingWhenNoSpecificDesktopTargetExists() {
        val result = DesktopRemoteSendPolicy.validateFocus(target = null, response = null)

        assertTrue(result.canSend)
    }
}
