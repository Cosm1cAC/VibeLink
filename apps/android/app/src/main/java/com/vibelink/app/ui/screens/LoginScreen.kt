package com.vibelink.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.ApiClient
import kotlinx.coroutines.launch

/**
 * Login / pairing screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(
    apiClient: ApiClient,
    onLoginSuccess: () -> Unit
) {
    var bridgeUrl by remember { mutableStateOf("http://192.168.1.10:8787") }
    var pairingToken by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

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
            Text("Bridge 连接", style = MaterialTheme.typography.titleMedium)

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
                label = { Text("配对 Token") },
                placeholder = { Text("从 Settings 获取") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            Button(
                onClick = {
                    scope.launch {
                        loading = true
                        status = "连接中…"
                        apiClient.baseUrl = bridgeUrl.trim()
                        try {
                            val health = apiClient.checkStatus()
                            if (!health.ok) {
                                status = "服务不可用"
                                return@launch
                            }
                            if (pairingToken.isNotBlank()) {
                                val login = apiClient.login(pairingToken.trim())
                                if (login.token.isNotBlank()) {
                                    apiClient.token = login.token
                                    status = "登录成功"
                                    onLoginSuccess()
                                } else {
                                    status = "登录失败：token 无效"
                                }
                            } else {
                                status = "已连接到服务，输入配对 Token 登录"
                            }
                        } catch (e: Exception) {
                            status = "连接失败: ${e.message}"
                        } finally {
                            loading = false
                        }
                    }
                },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (loading) CircularProgressIndicator(modifier = Modifier.size(16.dp))
                else Text("连接")
            }

            if (status.isNotBlank()) {
                Text(
                    text = status,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (status.contains("失败") || status.contains("错误"))
                        MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}
