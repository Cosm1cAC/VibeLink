package com.vibelink.app.mobile

object NotificationPermissionPolicy {
    fun shouldRequest(
        apiLevel: Int,
        permissionGranted: Boolean,
        askedBefore: Boolean,
        activityRecreated: Boolean,
    ): Boolean {
        return apiLevel >= 33 && !permissionGranted && !askedBefore && !activityRecreated
    }
}
