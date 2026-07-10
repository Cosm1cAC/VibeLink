package com.vibelink.app.mobile

enum class AppVisibility {
    Foreground,
    Background,
}

enum class NetworkQuality {
    Good,
    Weak,
    Offline,
}

data class MobileRuntimeInputs(
    val apiLevel: Int,
    val notificationPermissionGranted: Boolean,
    val liveCallActive: Boolean,
    val audioRunning: Boolean,
    val visibility: AppVisibility,
    val networkQuality: NetworkQuality,
    val webPushConfigured: Boolean,
    val pairedDeviceCount: Int,
)

data class MobileRuntimePolicy(
    val keepForegroundService: Boolean,
    val requestNotificationPermission: Boolean,
    val allowMicrophoneCapture: Boolean,
    val catchUpOnResume: Boolean,
    val eventPollIntervalMs: Long,
    val notificationChannel: String,
    val multiDeviceSyncEnabled: Boolean,
)

fun resolveMobileRuntimePolicy(input: MobileRuntimeInputs): MobileRuntimePolicy {
    val notificationRequired = input.apiLevel >= 33 && !input.notificationPermissionGranted
    val foregroundMic = input.liveCallActive && input.audioRunning
    val background = input.visibility == AppVisibility.Background
    val pollInterval = when (input.networkQuality) {
        NetworkQuality.Offline -> 0L
        NetworkQuality.Weak -> if (background) 15_000L else 5_000L
        NetworkQuality.Good -> if (background && input.webPushConfigured) 30_000L else 2_500L
    }
    val channel = when {
        foregroundMic -> "foreground-service"
        input.webPushConfigured && input.notificationPermissionGranted -> "bridge-push"
        else -> "poll-catchup"
    }

    return MobileRuntimePolicy(
        keepForegroundService = foregroundMic,
        requestNotificationPermission = notificationRequired,
        allowMicrophoneCapture = foregroundMic && input.networkQuality != NetworkQuality.Offline,
        catchUpOnResume = background || input.networkQuality != NetworkQuality.Good,
        eventPollIntervalMs = pollInterval,
        notificationChannel = channel,
        multiDeviceSyncEnabled = input.pairedDeviceCount > 1,
    )
}
