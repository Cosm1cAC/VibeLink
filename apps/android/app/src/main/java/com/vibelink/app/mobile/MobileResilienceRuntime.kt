package com.vibelink.app.mobile

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class MobileResilienceRuntime(context: Context) : DefaultLifecycleObserver {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val _policy = MutableStateFlow(currentPolicy())
    val policy: StateFlow<MobileRuntimePolicy> = _policy

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = refresh()
        override fun onLost(network: Network) = refresh()
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = refresh()
    }

    override fun onStart(owner: LifecycleOwner) {
        connectivity.registerDefaultNetworkCallback(callback)
        refresh(AppVisibility.Foreground)
    }

    override fun onStop(owner: LifecycleOwner) {
        runCatching { connectivity.unregisterNetworkCallback(callback) }
        refresh(AppVisibility.Background)
    }

    fun dispose() {
        runCatching { connectivity.unregisterNetworkCallback(callback) }
    }

    private fun refresh(visibility: AppVisibility = AppVisibility.Foreground) {
        _policy.value = currentPolicy(visibility)
    }

    private fun currentPolicy(visibility: AppVisibility = AppVisibility.Foreground): MobileRuntimePolicy {
        val caps = connectivity.activeNetwork?.let(connectivity::getNetworkCapabilities)
        val quality = when {
            caps == null -> NetworkQuality.Offline
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_CONGESTED) -> NetworkQuality.Good
            else -> NetworkQuality.Weak
        }
        return resolveMobileRuntimePolicy(
            MobileRuntimeInputs(
                apiLevel = android.os.Build.VERSION.SDK_INT,
                notificationPermissionGranted = true,
                liveCallActive = false,
                audioRunning = false,
                visibility = visibility,
                networkQuality = quality,
                webPushConfigured = false,
                pairedDeviceCount = 1,
            ),
        )
    }
}
