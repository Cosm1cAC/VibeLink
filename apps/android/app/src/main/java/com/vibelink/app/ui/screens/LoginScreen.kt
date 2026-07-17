package com.vibelink.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.ApiClient
import com.vibelink.app.ui.i18n.LocalAppStrings
import kotlinx.coroutines.launch

/**
 * Login / pairing screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LegacyLoginScreen(
    apiClient: ApiClient,
    onLoginSuccess: () -> Unit
) {
    var bridgeUrl by remember { mutableStateOf("http://192.168.1.10:8787") }
    var pairingToken by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val strings = LocalAppStrings.current

    Scaffold(
        topBar = {
            TopAppBar(title = { Text("VibeLink") })
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(strings.legacyLoginBridgeConnection, style = MaterialTheme.typography.titleMedium)

            OutlinedTextField(
                value = bridgeUrl,
                onValueChange = { bridgeUrl = it },
                label = { Text("Bridge URL") },
                placeholder = { Text("http://192.168.1.10:8787") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = pairingToken,
                onValueChange = { pairingToken = it },
                label = { Text(strings.legacyPairingToken) },
                placeholder = { Text(strings.legacyPairingTokenHint) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            Button(
                onClick = {
                    scope.launch {
                        loading = true
                        status = strings.legacyConnecting
                        apiClient.baseUrl = bridgeUrl.trim()
                        try {
                            val health = apiClient.checkStatus()
                            if (!health.ok) {
                                status = strings.legacyServiceUnavailable
                                return@launch
                            }
                            if (pairingToken.isNotBlank()) {
                                val login = apiClient.login(pairingToken.trim())
                                if (login.token.isNotBlank()) {
                                    apiClient.token = login.token
                                    status = strings.legacyLoginSuccess
                                    onLoginSuccess()
                                } else {
                                    status = strings.legacyInvalidToken
                                }
                            } else {
                                status = strings.legacyConnectedPrompt
                            }
                        } catch (e: Exception) {
                            status = strings.legacyConnectionFailed(e.message.orEmpty())
                        } finally {
                            loading = false
                        }
                    }
                },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (loading) CircularProgressIndicator(modifier = Modifier.size(16.dp))
                else Text(strings.legacyConnect)
            }

            if (status.isNotBlank()) {
                Text(
                    text = status,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (strings.isNegativeStatus(status) || status.contains(strings.error))
                        MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}
