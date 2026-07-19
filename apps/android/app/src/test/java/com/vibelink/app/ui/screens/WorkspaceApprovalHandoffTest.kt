package com.vibelink.app.ui.screens

import com.vibelink.app.network.ApiException
import com.vibelink.app.network.ApprovalDecisionResponse
import com.vibelink.app.network.ApprovalRequestItem
import com.vibelink.app.network.ApprovalTaskExecutionResult
import com.vibelink.app.network.TerminalSessionInfo
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class WorkspaceApprovalHandoffTest {
    @Test
    fun extractsTerminalApprovalFromHttp428Body() {
        val error = ApiException(
            428,
            """{"error":"Terminal session requires explicit approval","approvalId":"ap-123","toolRunId":"run-456","approval":{"kind":"workspace.terminal_session"}}""",
        )

        val notice = WorkspaceApprovalHandoff.noticeFromException(error)

        assertNotNull(notice)
        assertEquals("ap-123", notice.approvalId)
        assertEquals("run-456", notice.toolRunId)
        assertContains(notice.message, "Open Settings > Approvals")
    }

    @Test
    fun extractsAutomaticallyStartedTerminalFromApprovalDecision() {
        val handoff = WorkspaceApprovalHandoff.approvedTerminalFrom(
            ApprovalDecisionResponse(
                ok = true,
                resumed = true,
                approval = ApprovalRequestItem(
                    id = "ap-123",
                    kind = "workspace.terminal_session",
                    status = "approved",
                    toolRunId = "run-456",
                    workspaceId = "workspace-1",
                ),
                result = ApprovalTaskExecutionResult(
                    ok = true,
                    status = "running",
                    toolRunId = "run-456",
                    session = TerminalSessionInfo(
                        id = "run-456",
                        status = "running",
                        shell = "powershell.exe",
                        cwd = "C:\\work",
                        supportsResize = true,
                    ),
                ),
            ),
        )

        assertNotNull(handoff)
        assertEquals("run-456", handoff.toolRunId)
        assertEquals("workspace-1", handoff.workspaceId)
        assertEquals("running", handoff.session?.status)
    }

    @Test
    fun extractsWorkspaceTestApprovalFromHttp428Body() {
        val error = ApiException(
            428,
            """{"error":"Test requires explicit approval","approvalId":"ap-test","toolRunId":"run-test","approval":{"kind":"workspace.test"}}""",
        )

        val notice = WorkspaceApprovalHandoff.commandNoticeFromException(error)

        assertNotNull(notice)
        assertEquals("ap-test", notice.approvalId)
        assertEquals("run-test", notice.toolRunId)
        assertEquals("workspace.test", notice.kind)
        assertContains(notice.message, "result will return here")
    }

    @Test
    fun ignoresNonTerminalApprovalDecisions() {
        val handoff = WorkspaceApprovalHandoff.approvedTerminalFrom(
            ApprovalDecisionResponse(
                ok = true,
                approval = ApprovalRequestItem(
                    id = "ap-task",
                    kind = "agent.task",
                    status = "approved",
                    toolRunId = "run-task",
                ),
                result = ApprovalTaskExecutionResult(ok = true, id = "task-1"),
            ),
        )

        assertNull(handoff)
    }
}
