package com.vibelink.app.network

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals

class ApiClientConnectionBootstrapperTest {
    @Test
    fun restoresSavedConnectionBeforeNavigationContentLoads() = runBlocking {
        val apiClient = ApiClient()
        val bootstrapper = ApiClientConnectionBootstrapper {
            SavedApiConnection(
                bridgeUrl = " https://bridge.vibelink.cloud/ ",
                token = "saved-device-token",
            )
        }

        bootstrapper.initialize(apiClient)

        assertEquals("https://bridge.vibelink.cloud", apiClient.baseUrl)
        assertEquals("saved-device-token", apiClient.token)
    }

    @Test
    fun doesNotRestoreSavedTokenForExternalPairingLaunch() = runBlocking {
        val apiClient = ApiClient()
        val bootstrapper = ApiClientConnectionBootstrapper {
            SavedApiConnection(
                bridgeUrl = "https://bridge.vibelink.cloud",
                token = "old-bridge-token",
            )
        }

        bootstrapper.initialize(apiClient, restoreToken = false)

        assertEquals("https://bridge.vibelink.cloud", apiClient.baseUrl)
        assertEquals("", apiClient.token)
    }
}
