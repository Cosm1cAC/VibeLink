package com.vibelink.app.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileResiliencePolicyTest {
    @Test
    fun keepsForegroundMicrophoneCaptureAliveOnWeakBackgroundNetwork() {
        val policy = resolveMobileRuntimePolicy(
            MobileRuntimeInputs(
                apiLevel = 35,
                notificationPermissionGranted = true,
                liveCallActive = true,
                audioRunning = true,
                visibility = AppVisibility.Background,
                networkQuality = NetworkQuality.Weak,
                webPushConfigured = true,
                pairedDeviceCount = 2,
            ),
        )

        assertTrue(policy.keepForegroundService)
        assertTrue(policy.allowMicrophoneCapture)
        assertTrue(policy.catchUpOnResume)
        assertEquals(15_000L, policy.eventPollIntervalMs)
        assertEquals("foreground-service", policy.notificationChannel)
        assertTrue(policy.multiDeviceSyncEnabled)
    }

    @Test
    fun requestsNotificationPermissionAndSuspendsStreamingWhenOffline() {
        val policy = resolveMobileRuntimePolicy(
            MobileRuntimeInputs(
                apiLevel = 35,
                notificationPermissionGranted = false,
                liveCallActive = true,
                audioRunning = true,
                visibility = AppVisibility.Background,
                networkQuality = NetworkQuality.Offline,
                webPushConfigured = false,
                pairedDeviceCount = 1,
            ),
        )

        assertTrue(policy.keepForegroundService)
        assertTrue(policy.requestNotificationPermission)
        assertFalse(policy.allowMicrophoneCapture)
        assertEquals(0L, policy.eventPollIntervalMs)
        assertEquals("foreground-service", policy.notificationChannel)
        assertFalse(policy.multiDeviceSyncEnabled)
    }
}
