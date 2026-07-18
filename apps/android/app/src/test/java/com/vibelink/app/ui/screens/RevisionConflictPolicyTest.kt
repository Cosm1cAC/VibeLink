package com.vibelink.app.ui.screens

import com.vibelink.app.network.PublicSettings
import com.vibelink.app.network.SettingsPatchRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class RevisionConflictPolicyTest {
    @Test
    fun mergesNonOverlappingWorkspaceFileEdits() {
        val merged = RevisionConflictPolicy.mergeWorkspaceText(
            base = "alpha\nbeta\ngamma\n",
            local = "ALPHA\nbeta\ngamma\n",
            remote = "alpha\nbeta\nGAMMA\n",
        )

        assertEquals("ALPHA\nbeta\nGAMMA\n", merged.text)
        assertFalse(merged.hasConflicts)
    }

    @Test
    fun reappliesLocalSettingsPatchToFreshServerRevision() {
        val merged = RevisionConflictPolicy.mergeSettingsForRetry(
            fresh = PublicSettings(
                revision = 4,
                defaultCwd = "C:/remote",
                hostAllowlist = listOf("remote.example"),
            ),
            local = SettingsPatchRequest(defaultCwd = "C:/local"),
        )

        assertEquals(4, merged.revision)
        assertEquals("C:/local", merged.defaultCwd)
        assertEquals(listOf("remote.example"), merged.hostAllowlist)
    }
}
