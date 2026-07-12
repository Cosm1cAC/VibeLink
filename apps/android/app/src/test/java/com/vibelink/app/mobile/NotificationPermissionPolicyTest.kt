package com.vibelink.app.mobile

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NotificationPermissionPolicyTest {
    @Test
    fun requestsOnlyOnFirstFreshLaunchWhenPermissionIsMissing() {
        assertTrue(
            NotificationPermissionPolicy.shouldRequest(
                apiLevel = 35,
                permissionGranted = false,
                askedBefore = false,
                activityRecreated = false,
            ),
        )
        assertFalse(NotificationPermissionPolicy.shouldRequest(35, false, true, false))
        assertFalse(NotificationPermissionPolicy.shouldRequest(35, false, false, true))
        assertFalse(NotificationPermissionPolicy.shouldRequest(32, false, false, false))
        assertFalse(NotificationPermissionPolicy.shouldRequest(35, true, false, false))
    }
}
