package com.vibelink.app.ui.screens

import kotlin.test.Test
import kotlin.test.assertEquals

class SettingsSectionTargetTest {
    @Test
    fun approvalIndexAccountsForOptionalNotices() {
        assertEquals(6, SettingsSectionTarget.pendingApprovalsIndex(hasError = false, hasNotice = false))
        assertEquals(8, SettingsSectionTarget.pendingApprovalsIndex(hasError = true, hasNotice = true))
    }
}
