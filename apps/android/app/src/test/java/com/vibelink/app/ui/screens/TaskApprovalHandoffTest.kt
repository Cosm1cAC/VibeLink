package com.vibelink.app.ui.screens

import com.vibelink.app.network.ApiException
import com.vibelink.app.network.ApprovalDecisionResponse
import com.vibelink.app.network.ApprovalTaskExecutionResult
import com.vibelink.app.network.ApprovalTaskResult
import com.vibelink.app.network.TaskCreateResponse
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class TaskApprovalHandoffTest {
    @Test
    fun extractsApprovalIdFromHttp428Body() {
        val error = ApiException(428, "{\"error\":\"requires explicit approval\",\"approvalId\":\"ap-123\"}")
        val notice = TaskApprovalHandoff.noticeFromException(error)
        val message = TaskApprovalHandoff.messageFor(error)

        assertNotNull(notice)
        assertContains(notice.message, "ap-123")
        assertContains(message, "ap-123")
        assertContains(message, "Settings > Approvals")
        assertContains(message, "starts this task automatically")
    }

    @Test
    fun detectsApprovalResponseWithoutTaskId() {
        val notice = TaskApprovalHandoff.noticeFromResponse(
            TaskCreateResponse(error = "Command requires approval", approvalId = "ap-456"),
        )

        assertNotNull(notice)
        assertContains(notice.message, "ap-456")
    }

    @Test
    fun extractsAutomaticallyStartedTaskFromApprovalDecision() {
        val handoff = TaskApprovalHandoff.approvedTaskFrom(
            ApprovalDecisionResponse(
                ok = true,
                resumed = true,
                result = ApprovalTaskExecutionResult(
                    ok = true,
                    id = "task-123",
                    status = "running",
                    task = ApprovalTaskResult(
                        id = "task-123",
                        agent = "codex",
                        title = "Android task",
                        cwd = "C:\\work",
                        status = "running",
                        sessionId = "session-456",
                    ),
                ),
            ),
        )

        assertNotNull(handoff)
        assertEquals("task-123", handoff.id)
        assertEquals("session-456", handoff.sessionId)
        assertEquals("codex", handoff.agent)
    }
}
