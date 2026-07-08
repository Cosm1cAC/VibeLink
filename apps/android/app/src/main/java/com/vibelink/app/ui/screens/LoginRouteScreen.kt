package com.vibelink.app.ui.screens

import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.vibelink.app.data.SettingsStore
import com.vibelink.app.network.ApiClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(
    apiClient: ApiClient,
    settingsStore: SettingsStore,
    initialPairingUri: String? = null,
    onLoginSuccess: () -> Unit,
) {
    var bridgeUrl by remember { mutableStateOf("http://192.168.1.10:8787") }
    var pairingToken by remember { mutableStateOf("") }
    var pairingSessionId by remember { mutableStateOf("") }
    var pairingCode by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("Loading saved connection") }
    var loading by remember { mutableStateOf(false) }
    var scannerOpen by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun persistLogin(url: String, token: String) {
        settingsStore.setBridgeUrl(url)
        settingsStore.setToken(token)
        apiClient.baseUrl = url
        apiClient.token = token
        onLoginSuccess()
    }

    suspend fun applyPairingUri(raw: String): Boolean {
        val uri = Uri.parse(raw)
        val server = uri.getQueryParameter("server").orEmpty().trim().trimEnd('/')
        val session = uri.getQueryParameter("session").orEmpty()
        val code = uri.getQueryParameter("code").orEmpty()
        if (uri.scheme != "vibelink" || uri.host != "pair" || server.isBlank() || session.isBlank() || code.isBlank()) {
            status = "Invalid VibeLink pairing QR."
            return false
        }

        bridgeUrl = server
        apiClient.baseUrl = server
        settingsStore.setBridgeUrl(server)
        pairingSessionId = session
        pairingCode = code
        status = "Scanned pairing QR. Confirm this device in VibeLink, then keep this screen open."
        return true
    }

    LaunchedEffect(Unit) {
        initialPairingUri?.let { raw ->
            if (applyPairingUri(raw)) return@LaunchedEffect
        }

        bridgeUrl = settingsStore.bridgeUrl.first()
        val savedToken = settingsStore.getTokenSync()
        if (savedToken.isBlank()) {
            status = "Scan the VibeLink QR code or enter a pairing token."
            return@LaunchedEffect
        }

        apiClient.baseUrl = bridgeUrl.trim()
        apiClient.token = savedToken
        try {
            if (apiClient.checkStatus().ok) onLoginSuccess()
            else status = "Saved connection is unavailable."
        } catch (error: Exception) {
            status = "Saved token could not connect: ${error.message}"
            apiClient.token = ""
        }
    }

    LaunchedEffect(pairingSessionId, pairingCode) {
        if (pairingSessionId.isBlank() || pairingCode.isBlank()) return@LaunchedEffect
        while (pairingSessionId.isNotBlank()) {
            delay(2000)
            try {
                val current = apiClient.getPairingSession(pairingSessionId).session
                val currentStatus = current?.status ?: "unknown"
                status = "Pairing status: $currentStatus. Code: $pairingCode"
                if (current?.status == "approved") {
                    val claim = apiClient.claimPairingSession(pairingSessionId, pairingCode, "VibeLink Android")
                    if (claim.token.isNotBlank()) {
                        persistLogin(bridgeUrl.trim(), claim.token)
                        pairingSessionId = ""
                    }
                }
                if (current?.status == "denied" || current?.status == "expired") pairingSessionId = ""
            } catch (error: Exception) {
                status = "Pairing check failed: ${error.message}"
            }
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text("VibeLink") }) }) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Bridge connection", style = MaterialTheme.typography.titleMedium)

            Button(
                onClick = { scannerOpen = !scannerOpen },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (scannerOpen) "Close scanner" else "Scan QR code") }

            if (scannerOpen) {
                PairingQrScanner(
                    onCodeScanned = { raw ->
                        scannerOpen = false
                        scope.launch { applyPairingUri(raw) }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }

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
                label = { Text("Pairing token") },
                placeholder = { Text("Legacy token from bridge settings") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            Button(
                onClick = {
                    scope.launch {
                        loading = true
                        status = "Connecting"
                        val url = bridgeUrl.trim().trimEnd('/')
                        apiClient.baseUrl = url
                        try {
                            val login = apiClient.login(pairingToken.trim())
                            if (login.token.isNotBlank()) {
                                settingsStore.setPairingToken(pairingToken.trim())
                                persistLogin(url, login.token)
                            } else {
                                status = "Login failed: empty device token."
                            }
                        } catch (error: Exception) {
                            status = "Login failed: ${error.message}"
                        } finally {
                            loading = false
                        }
                    }
                },
                enabled = !loading && pairingToken.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (loading) CircularProgressIndicator(modifier = Modifier.padding(2.dp)) else Text("Connect with token")
            }

            OutlinedButton(
                onClick = {
                    scope.launch {
                        loading = true
                        val url = bridgeUrl.trim().trimEnd('/')
                        apiClient.baseUrl = url
                        settingsStore.setBridgeUrl(url)
                        try {
                            val created = apiClient.createPairingSession("VibeLink Android")
                            val session = created.session
                            if (session != null) {
                                pairingSessionId = session.id
                                pairingCode = session.code
                                status = "Approve this device in VibeLink, then keep this screen open. Code: ${session.code}"
                            } else {
                                status = "Pairing request failed: empty session."
                            }
                        } catch (error: Exception) {
                            status = "Pairing request failed: ${error.message}"
                        } finally {
                            loading = false
                        }
                    }
                },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Create pairing request") }

            if (pairingSessionId.isNotBlank()) {
                Text("Pairing ID: ${pairingSessionId.take(8)} / Code: $pairingCode", style = MaterialTheme.typography.bodySmall)
            }

            if (status.isNotBlank()) {
                Text(
                    text = status,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (status.contains("failed", ignoreCase = true) || status.contains("denied", ignoreCase = true)) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
    }
}