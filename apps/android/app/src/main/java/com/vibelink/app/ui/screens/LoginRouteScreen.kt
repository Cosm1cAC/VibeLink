package com.vibelink.app.ui.screens

import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.ui.Modifier
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
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
    var bridgeUrl by remember { mutableStateOf("http://192.168.1.10:8787") }
    var pairingToken by remember { mutableStateOf("") }
    var pairingSessionId by remember { mutableStateOf("") }
    var pairingCode by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("Loading saved connection") }
    var loading by remember { mutableStateOf(false) }
    var scannerOpen by remember { mutableStateOf(false) }
    val strings = LocalAppStrings.current
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
        status = "已扫描配对二维码。请在 VibeLink 中确认此设备，并保持本页打开。"
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
            else status = "已保存连接不可用。"
        } catch (error: Exception) {
            status = "已保存 Token 连接失败：${error.message}"
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
                status = "配对状态：$currentStatus。验证码：$pairingCode"
                if (current?.status == "approved") {
                    val claim = apiClient.claimPairingSession(pairingSessionId, pairingCode, "VibeLink Android")
                    if (claim.token.isNotBlank()) {
                        persistLogin(bridgeUrl.trim(), claim.token)
                        pairingSessionId = ""
                    }
                }
                if (current?.status == "denied" || current?.status == "expired") pairingSessionId = ""
            } catch (error: Exception) {
                status = "配对检查失败：${error.message}"
            }
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text("VibeLink") }) }) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(strings.bridgeConnection, style = MaterialTheme.typography.titleMedium)

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
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = pairingToken,
                onValueChange = { pairingToken = it },
                label = { Text(strings.pairingToken) },
                placeholder = { Text(strings.legacyTokenPlaceholder) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )

            Button(
                onClick = {
                    scope.launch {
                        loading = true
                        status = "正在连接"
                        val url = bridgeUrl.trim().trimEnd('/')
                        apiClient.baseUrl = url
                        try {
                            val login = apiClient.login(pairingToken.trim())
                            if (login.token.isNotBlank()) {
                                persistLogin(url, login.token)
                            } else {
                                status = "登录失败：设备 Token 为空。"
                            }
                        } catch (error: Exception) {
                            status = "登录失败：${error.message}"
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
                                status = "请在 VibeLink 中批准此设备，并保持本页打开。验证码：${session.code}"
                            } else {
                                status = "配对请求失败：会话为空。"
                            }
                        } catch (error: Exception) {
                            status = "配对请求失败：${error.message}"
                        } finally {
                            loading = false
                        }
                    }
                },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(strings.createPairingRequest) }

            if (pairingSessionId.isNotBlank()) {
                Text("配对 ID：${pairingSessionId.take(8)} / 验证码：$pairingCode", style = MaterialTheme.typography.bodySmall)
            }

            if (status.isNotBlank()) {
                Text(
                    text = status,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (
                        status.contains("failed", ignoreCase = true) ||
                        status.contains("denied", ignoreCase = true) ||
                        status.contains("失败") ||
                        status.contains("拒绝")
                    ) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
    }
}
