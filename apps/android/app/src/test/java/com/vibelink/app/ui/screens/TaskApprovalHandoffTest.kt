package com.vibelink.app.ui.screens

import com.vibelink.app.network.ApiException
import com.vibelink.app.network.TaskCreateResponse
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertNotNull

class TaskApprovalHandoffTest {
    @Test
    fun extractsApprovalIdFromHttp428Body() {
        val message = TaskApprovalHandoff.messageFor(
            ApiException(428, "{\"error\":\"requires explicit approval\",\"approvalId\":\"ap-123\"}"),
        )

        assertContains(message, "ap-123")
        assertContains(message, "Settings > Approvals")
        assertContains(message, "retry")
    }

    @Test
    fun detectsApprovalResponseWithoutTaskId() {
        val notice = TaskApprovalHandoff.noticeFromResponse(
            TaskCreateResponse(error = "Command requires approval", approvalId = "ap-456"),
        )

        assertNotNull(notice)
        assertContains(notice.message, "ap-456")
    }
}
