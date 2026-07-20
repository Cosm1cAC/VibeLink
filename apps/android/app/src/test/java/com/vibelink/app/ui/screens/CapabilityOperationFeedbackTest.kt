package com.vibelink.app.ui.screens

import com.vibelink.app.network.ApiException
import kotlin.test.Test
import kotlin.test.assertEquals

class CapabilityOperationFeedbackTest {
    @Test
    fun distinguishesApprovalFromRegularFailures() {
        assertEquals("Approval required. Approval approval-7 is pending in Settings > Approvals.", CapabilityOperationFeedback.message(ApiException(428, """{"error":"Approval required.","approvalId":"approval-7"}""")))
        assertEquals("Offline", CapabilityOperationFeedback.message(IllegalStateException("Offline")))
    }
}
