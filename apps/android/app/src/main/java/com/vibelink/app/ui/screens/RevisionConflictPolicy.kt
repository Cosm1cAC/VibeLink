package com.vibelink.app.ui.screens

import com.vibelink.app.network.PublicSettings
import com.vibelink.app.network.SettingsPatchRequest

data class WorkspaceTextMerge(
    val text: String,
    val hasConflicts: Boolean,
)

object RevisionConflictPolicy {
    fun mergeSettingsForRetry(fresh: PublicSettings, local: SettingsPatchRequest): PublicSettings = fresh.copy(
        defaultCwd = local.defaultCwd ?: fresh.defaultCwd,
        claudeCommand = local.claudeCommand ?: fresh.claudeCommand,
        codexCommand = local.codexCommand ?: fresh.codexCommand,
        doubaoCommand = local.doubaoCommand ?: fresh.doubaoCommand,
        doubaoCdpEndpoint = local.doubaoCdpEndpoint ?: fresh.doubaoCdpEndpoint,
        doubaoUrl = local.doubaoUrl ?: fresh.doubaoUrl,
        security = local.security ?: fresh.security,
        hostAllowlist = local.hostAllowlist ?: fresh.hostAllowlist,
        allowTryCloudflare = local.allowTryCloudflare ?: fresh.allowTryCloudflare,
        allowLegacyPairingTokenLogin = local.allowLegacyPairingTokenLogin ?: fresh.allowLegacyPairingTokenLogin,
        nativePush = local.nativePush?.let { patch ->
            fresh.nativePush.copy(
                provider = patch.provider,
                fcmProjectId = patch.fcmProjectId,
            )
        } ?: fresh.nativePush,
        toolEvents = local.toolEvents ?: fresh.toolEvents,
        mcp = local.mcp?.let { patch ->
            fresh.mcp.copy(
                probeTimeoutMs = patch.probeTimeoutMs ?: fresh.mcp.probeTimeoutMs,
                servers = patch.servers ?: fresh.mcp.servers,
            )
        } ?: fresh.mcp,
    )

    fun mergeWorkspaceText(base: String, local: String, remote: String): WorkspaceTextMerge {
        if (local == remote) return WorkspaceTextMerge(local, false)
        if (local == base) return WorkspaceTextMerge(remote, false)
        if (remote == base) return WorkspaceTextMerge(local, false)

        val localEdit = singleEdit(base, local)
        val remoteEdit = singleEdit(base, remote)
        if (localEdit.end <= remoteEdit.start || remoteEdit.end <= localEdit.start) {
            val merged = listOf(localEdit, remoteEdit)
                .sortedByDescending(Edit::start)
                .fold(base) { text, edit -> text.replaceRange(edit.start, edit.end, edit.replacement) }
            return WorkspaceTextMerge(merged, false)
        }

        val localText = local.trimEnd('\n')
        val remoteText = remote.trimEnd('\n')
        return WorkspaceTextMerge(
            text = "<<<<<<< This device\n$localText\n=======\n$remoteText\n>>>>>>> Latest server\n",
            hasConflicts = true,
        )
    }

    private fun singleEdit(base: String, changed: String): Edit {
        var prefix = 0
        val prefixLimit = minOf(base.length, changed.length)
        while (prefix < prefixLimit && base[prefix] == changed[prefix]) prefix += 1

        var suffix = 0
        val suffixLimit = minOf(base.length - prefix, changed.length - prefix)
        while (suffix < suffixLimit && base[base.length - suffix - 1] == changed[changed.length - suffix - 1]) suffix += 1

        return Edit(
            start = prefix,
            end = base.length - suffix,
            replacement = changed.substring(prefix, changed.length - suffix),
        )
    }

    private data class Edit(
        val start: Int,
        val end: Int,
        val replacement: String,
    )
}
