package com.vibelink.app.ui.screens

import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.vibelink.app.data.SettingsStore
import com.vibelink.app.network.ApiClient
import com.vibelink.app.ui.i18n.LocalAppStrings
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(
    apiClient: ApiClient,
    settingsStore: SettingsStore,
    initialPairingUri: String? = null,
    onLoginSuccess: () -> Unit,
) {
    val strings = LocalAppStrings.current
    var bridgeUrl by rememberSaveable { mutableStateOf("http://192.168.1.10:8787") }
    var pairingToken by rememberSaveable { mutableStateOf("") }
    var pairingSessionId by rememberSaveable { mutableStateOf("") }
    var pairingCode by rememberSaveable { mutableStateOf("") }
    var status by rememberSaveable(strings.currentLanguage) { mutableStateOf(strings.loadingSavedConnection) }
    var loading by rememberSaveable { mutableStateOf(false) }
    var scannerOpen by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun persistLogin(url: String, token: String) {
        settingsStore.setBridgeUrl(url)
        settingsStore.setToken(token)
        apiClient.baseUrl = url
        apiClient.token = token
        withContext(Dispatchers.Main.immediate) { onLoginSuccess() }
    }

    suspend fun applyPairingUri(raw: String): Boolean {
        val uri = Uri.parse(raw)
        val server = uri.getQueryParameter("server").orEmpty().trim().trimEnd('/')
        val session = uri.getQueryParameter("session").orEmpty()
        val code = uri.getQueryParameter("code").orEmpty()
        if (uri.scheme != "vibelink" || uri.host != "pair" || server.isBlank() || session.isBlank() || code.isBlank()) {
            status = strings.invalidPairingQr
            return false
        }

        bridgeUrl = server
        apiClient.token = ""
        apiClient.baseUrl = server
        settingsStore.setBridgeUrl(server)
        pairingSessionId = session
        pairingCode = code
        status = strings.pairingQrScanned
        return true
    }

    LaunchedEffect(initialPairingUri) {
        initialPairingUri?.let { raw ->
            if (applyPairingUri(raw)) return@LaunchedEffect
        }

        bridgeUrl = settingsStore.bridgeUrl.first()
        val savedToken = settingsStore.getTokenSync()
        if (savedToken.isBlank()) {
            status = strings.scanPairingHint
            return@LaunchedEffect
        }

        apiClient.baseUrl = bridgeUrl.trim()
        apiClient.token = savedToken
        try {
            if (apiClient.checkStatus().ok) onLoginSuccess()
            else status = strings.savedConnectionUnavailable
        } catch (error: Exception) {
            status = strings.savedTokenConnectionFailed(error.message.orEmpty())
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
                status = strings.pairingStatus(currentStatus, pairingCode)
                if (current?.status == "approved") {
                    val claim = apiClient.claimPairingSession(pairingSessionId, pairingCode, "VibeLink Android")
                    if (claim.token.isNotBlank()) {
                        persistLogin(bridgeUrl.trim(), claim.token)
                        pairingSessionId = ""
                    }
                }
                if (current?.status == "denied" || current?.status == "expired") pairingSessionId = ""
            } catch (error: Exception) {
                status = strings.pairingCheckFailed(error.message.orEmpty())
            }
        }
    }

    val tokenFocusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current

    Scaffold(topBar = { TopAppBar(title = { Text(strings.brandName) }) }) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                modifier = Modifier
                    .widthIn(max = 560.dp)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 16.dp)
                    .semantics { paneTitle = strings.loginForm },
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
            Text(
                strings.bridgeConnection,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.semantics { heading() },
            )

            Button(
                onClick = { scannerOpen = !scannerOpen },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (scannerOpen) strings.closeScanner else strings.scanQrCode) }

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
                label = { Text(strings.bridgeUrl) },
                placeholder = { Text("http://192.168.1.10:8787") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Next,
                ),
                keyboardActions = KeyboardActions(onNext = { tokenFocusRequester.requestFocus() }),
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = pairingToken,
                onValueChange = { pairingToken = it },
                label = { Text(strings.pairingToken) },
                placeholder = { Text(strings.legacyTokenPlaceholder) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { focusManager.clearFocus() }),
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth().focusRequester(tokenFocusRequester),
            )

            Text(
                text = strings.legacyTokenNotice,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Button(
                onClick = {
                    scope.launch {
                        loading = true
                        status = strings.connecting
                        val url = bridgeUrl.trim().trimEnd('/')
                        apiClient.baseUrl = url
                        try {
                            val login = apiClient.login(pairingToken.trim())
                            if (login.token.isNotBlank()) {
                                persistLogin(url, login.token)
                            } else {
                                status = strings.loginFailedEmptyDeviceToken
                            }
                        } catch (error: Exception) {
                            status = strings.loginFailed(error.message.orEmpty())
                        } finally {
                            loading = false
                        }
                    }
                },
                enabled = !loading && pairingToken.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (loading) CircularProgressIndicator(modifier = Modifier.padding(2.dp)) else Text(strings.connectWithToken)
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
                                status = strings.approveDevicePrompt(session.code)
                            } else {
                                status = strings.pairingRequestEmpty
                            }
                        } catch (error: Exception) {
                            status = strings.pairingRequestFailed(error.message.orEmpty())
                        } finally {
                            loading = false
                        }
                    }
                },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(strings.createPairingRequest) }

            if (pairingSessionId.isNotBlank()) {
                Text(strings.pairingIdAndCode(pairingSessionId, pairingCode), style = MaterialTheme.typography.bodySmall)
            }

            if (status.isNotBlank()) {
                Text(
                    text = status,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (
                        strings.isNegativeStatus(status)
                    ) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    modifier = Modifier.semantics {
                        liveRegion = LiveRegionMode.Polite
                        paneTitle = strings.connectionStatus
                    },
                )
            }
            }
        }
    }
}
