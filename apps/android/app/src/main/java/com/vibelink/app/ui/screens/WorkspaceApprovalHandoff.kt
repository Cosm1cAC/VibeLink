package com.vibelink.app.ui.screens

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.vibelink.app.network.ApiException
import com.vibelink.app.network.ApprovalDecisionResponse
import com.vibelink.app.network.TerminalSessionInfo

data class WorkspaceApprovalNotice(
    val approvalId: String,
    val toolRunId: String,
    val message: String,
)

data class ApprovedTerminalHandoff(
    val toolRunId: String,
    val workspaceId: String,
    val status: String,
    val session: TerminalSessionInfo?,
)

object WorkspaceApprovalHandoff {
    private const val TERMINAL_APPROVAL_KIND = "workspace.terminal_session"

    fun noticeFromException(error: ApiException): WorkspaceApprovalNotice? {
        if (error.statusCode != 428) return null
        val json = parseObject(error.body)
        val approval = objectMember(json, "approval")
        val kind = stringMember(approval, "kind")
        if (kind.isNotBlank() && kind != TERMINAL_APPROVAL_KIND) return null
        val approvalId = stringMember(json, "approvalId").ifBlank { stringMember(approval, "id") }
        if (approvalId.isBlank()) return null
        val toolRunId = stringMember(json, "toolRunId").ifBlank { stringMember(approval, "toolRunId") }
        val reason = stringMember(json, "error").ifBlank { "Terminal session needs approval." }
        return WorkspaceApprovalNotice(
            approvalId = approvalId,
            toolRunId = toolRunId,
            message = "$reason Open Settings > Approvals; approving starts and reconnects this terminal automatically.",
        )
    }

    fun approvedTerminalFrom(response: ApprovalDecisionResponse): ApprovedTerminalHandoff? {
        val approval = response.approval ?: return null
        if (!response.ok || approval.status != "approved" || approval.kind != TERMINAL_APPROVAL_KIND) return null
        val result = response.result
        if (result?.ok != true) return null
        val toolRunId = result.toolRunId.ifBlank { result.session?.id.orEmpty().ifBlank { approval.toolRunId } }
        if (toolRunId.isBlank()) return null
        return ApprovedTerminalHandoff(
            toolRunId = toolRunId,
            workspaceId = approval.workspaceId,
            status = result.session?.status.orEmpty().ifBlank { result.status.ifBlank { "running" } },
            session = result.session,
        )
    }

    fun isTerminalDecision(response: ApprovalDecisionResponse): Boolean {
        return response.approval?.kind == TERMINAL_APPROVAL_KIND
    }

    private fun parseObject(raw: String): JsonObject? {
        return runCatching { JsonParser.parseString(raw).asJsonObject }.getOrNull()
    }

    private fun objectMember(json: JsonObject?, key: String): JsonObject? {
        return runCatching { json?.getAsJsonObject(key) }.getOrNull()
    }

    private fun stringMember(json: JsonObject?, key: String): String {
        return runCatching { json?.get(key)?.takeIf { !it.isJsonNull }?.asString.orEmpty() }.getOrDefault("")
    }
}
