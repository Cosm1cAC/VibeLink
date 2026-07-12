package com.vibelink.app.network

data class SavedApiConnection(
    val bridgeUrl: String,
    val token: String,
)

class ApiClientConnectionBootstrapper(
    private val loadConnection: suspend () -> SavedApiConnection,
) {
    suspend fun initialize(apiClient: ApiClient, restoreToken: Boolean = true) {
        val connection = loadConnection()
        val bridgeUrl = connection.bridgeUrl.trim().trimEnd('/')
        if (bridgeUrl.isNotBlank()) apiClient.baseUrl = bridgeUrl
        apiClient.token = if (restoreToken) connection.token else ""
    }
}
