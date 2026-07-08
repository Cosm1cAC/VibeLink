package com.vibelink.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ApprovalRequestItem
import com.vibelink.app.network.PublicSettings
import com.vibelink.app.network.SecuritySettings
import com.vibelink.app.network.SettingsPatchRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SettingsUiState(
    val settings: PublicSettings? = null,
    val approvals: List<ApprovalRequestItem> = emptyList(),
    val loading: Boolean = false,
    val saving: Boolean = false,
    val error: String = "",
    val notice: String = "",
)

class SettingsViewModel : ViewModel() {
    private val _uiState = MutableStateFlow(SettingsUiState())
    val uiState: StateFlow<SettingsUiState> = _uiState.asStateFlow()

    fun load(apiClient: ApiClient) {
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = "", notice = "") }
            try {
                val status = apiClient.checkStatus()
                val approvals = runCatching { apiClient.listApprovals(status = "pending", limit = 50) }.getOrDefault(emptyList())
                _uiState.update {
                    it.copy(
                        settings = status.settings,
                        approvals = approvals,
                        loading = false,
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(loading = false, error = error.message ?: "Failed to load settings") }
            }
        }
    }

    fun save(apiClient: ApiClient, patch: SettingsPatchRequest) {
        viewModelScope.launch {
            _uiState.update { it.copy(saving = true, error = "", notice = "") }
            try {
                val result = apiClient.saveSettings(patch)
                _uiState.update {
                    it.copy(
                        settings = result.settings ?: it.settings,
                        saving = false,
                        notice = "Settings saved.",
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(saving = false, error = error.message ?: "Failed to save settings") }
            }
        }
    }

    fun decideApproval(apiClient: ApiClient, approvalId: String, approve: Boolean) {
        viewModelScope.launch {
            _uiState.update { it.copy(error = "", notice = "") }
            try {
                apiClient.decideApproval(
                    approvalId = approvalId,
                    approve = approve,
                    reason = if (approve) "Approved from Android." else "Denied from Android.",
                )
                val approvals = apiClient.listApprovals(status = "pending", limit = 50)
                _uiState.update {
                    it.copy(
                        approvals = approvals,
                        notice = if (approve) "Approval accepted." else "Approval denied.",
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(error = error.message ?: "Approval decision failed") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    apiClient: ApiClient,
    viewModel: SettingsViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val settings = state.settings

    var defaultCwd by remember { mutableStateOf("") }
    var codexCommand by remember { mutableStateOf("auto") }
    var claudeCommand by remember { mutableStateOf("claude") }
    var doubaoCommand by remember { mutableStateOf("auto") }
    var doubaoEndpoint by remember { mutableStateOf("http://127.0.0.1:9222") }
    var doubaoUrl by remember { mutableStateOf("https://www.doubao.com/chat/") }
    var sandboxMode by remember { mutableStateOf("workspace-write") }
    var approvalPolicy by remember { mutableStateOf("on-request") }
    var networkAccess by remember { mutableStateOf(true) }
    var requireTrustedWorkspace by remember { mutableStateOf(true) }
    var requireDangerousApproval by remember { mutableStateOf(true) }
    var openAiKey by remember { mutableStateOf("") }
    var anthropicKey by remember { mutableStateOf("") }
    var zhipuKey by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        viewModel.load(apiClient)
    }

    LaunchedEffect(settings) {
        if (settings == null) return@LaunchedEffect
        defaultCwd = settings.defaultCwd
        codexCommand = settings.codexCommand.ifBlank { "auto" }
        claudeCommand = settings.claudeCommand.ifBlank { "claude" }
        doubaoCommand = settings.doubaoCommand.ifBlank { "auto" }
        doubaoEndpoint = settings.doubaoCdpEndpoint.ifBlank { "http://127.0.0.1:9222" }
        doubaoUrl = settings.doubaoUrl.ifBlank { "https://www.doubao.com/chat/" }
        sandboxMode = settings.security.sandboxMode.ifBlank { "workspace-write" }
        approvalPolicy = settings.security.approvalPolicy.ifBlank { "on-request" }
        networkAccess = settings.security.networkAccess
        requireTrustedWorkspace = settings.security.requireTrustedWorkspace
        requireDangerousApproval = settings.security.requireDangerousCommandApproval
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.load(apiClient) }) {
                        if (state.loading) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    IconButton(
                        onClick = {
                            viewModel.save(
                                apiClient,
                                SettingsPatchRequest(
                                    defaultCwd = defaultCwd,
                                    codexCommand = codexCommand,
                                    claudeCommand = claudeCommand,
                                    doubaoCommand = doubaoCommand,
                                    doubaoCdpEndpoint = doubaoEndpoint,
                                    doubaoUrl = doubaoUrl,
                                    security = SecuritySettings(
                                        sandboxMode = sandboxMode,
                                        approvalPolicy = approvalPolicy,
                                        networkAccess = networkAccess,
                                        requireTrustedWorkspace = requireTrustedWorkspace,
                                        requireDangerousCommandApproval = requireDangerousApproval,
                                    ),
                                    apiKeys = buildApiKeys(openAiKey, anthropicKey, zhipuKey),
                                ),
                            )
                        },
                        enabled = !state.saving,
                    ) {
                        if (state.saving) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Default.Save, contentDescription = "Save settings")
                    }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            if (state.loading && settings == null) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (state.error.isNotBlank()) {
                        item { NoticeCard(state.error, isError = true) }
                    }
                    if (state.notice.isNotBlank()) {
                        item { NoticeCard(state.notice, isError = false) }
                    }

                    item {
                        SectionCard(title = "Runtime") {
                            OutlinedTextField(
                                value = defaultCwd,
                                onValueChange = { defaultCwd = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text("Default working directory") },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = codexCommand,
                                onValueChange = { codexCommand = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text("Codex command") },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = claudeCommand,
                                onValueChange = { claudeCommand = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text("Claude command") },
                                singleLine = true,
                            )
                        }
                    }

                    item {
                        SectionCard(title = "Doubao Bridge") {
                            OutlinedTextField(
                                value = doubaoCommand,
                                onValueChange = { doubaoCommand = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text("Doubao command") },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = doubaoEndpoint,
                                onValueChange = { doubaoEndpoint = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text("CDP endpoint") },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = doubaoUrl,
                                onValueChange = { doubaoUrl = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text("Doubao URL") },
                                singleLine = true,
                            )
                        }
                    }

                    item {
                        SectionCard(title = "Agent Security") {
                            Text("Sandbox", style = MaterialTheme.typography.labelMedium)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(sandboxOptions) { value ->
                                    FilterChip(
                                        selected = sandboxMode == value,
                                        onClick = { sandboxMode = value },
                                        label = { Text(value) },
                                    )
                                }
                            }
                            Spacer(Modifier.height(10.dp))
                            Text("Approval policy", style = MaterialTheme.typography.labelMedium)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(approvalOptions) { value ->
                                    FilterChip(
                                        selected = approvalPolicy == value,
                                        onClick = { approvalPolicy = value },
                                        label = { Text(value) },
                                    )
                                }
                            }
                            ToggleRow("Allow network access", networkAccess) { networkAccess = it }
                            ToggleRow("Require trusted workspace", requireTrustedWorkspace) { requireTrustedWorkspace = it }
                            ToggleRow("Require dangerous-command approval", requireDangerousApproval) { requireDangerousApproval = it }
                        }
                    }

                    item {
                        SectionCard(title = "API Keys") {
                            KeyField(
                                label = if (settings?.hasOpenAIKey == true) "OpenAI key saved; leave blank to keep" else "OpenAI key",
                                value = openAiKey,
                                onValueChange = { openAiKey = it },
                            )
                            Spacer(Modifier.height(8.dp))
                            KeyField(
                                label = if (settings?.hasAnthropicKey == true) "Anthropic key saved; leave blank to keep" else "Anthropic key",
                                value = anthropicKey,
                                onValueChange = { anthropicKey = it },
                            )
                            Spacer(Modifier.height(8.dp))
                            KeyField(
                                label = if (settings?.hasZhipuKey == true) "Zhipu key saved; leave blank to keep" else "Zhipu key",
                                value = zhipuKey,
                                onValueChange = { zhipuKey = it },
                            )
                        }
                    }

                    item {
                        SectionCard(title = "Pending Approvals") {
                            if (state.approvals.isEmpty()) {
                                Text(
                                    "No pending approvals.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            } else {
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    state.approvals.forEach { approval ->
                                        ApprovalCard(
                                            approval = approval,
                                            onApprove = { viewModel.decideApproval(apiClient, approval.id, approve = true) },
                                            onDeny = { viewModel.decideApproval(apiClient, approval.id, approve = false) },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(shape = RoundedCornerShape(8.dp)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(10.dp))
            content()
        }
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun KeyField(label: String, value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        visualTransformation = PasswordVisualTransformation(),
        singleLine = true,
    )
}

@Composable
private fun ApprovalCard(
    approval: ApprovalRequestItem,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
) {
    Card(
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                approval.title.ifBlank { approval.kind.ifBlank { "Approval" } },
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val body = approval.reason.ifBlank {
                approval.request?.entries?.joinToString("\n") { "${it.key}: ${it.value}" }.orEmpty()
            }
            if (body.isNotBlank()) {
                Text(
                    body,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 5,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onApprove) {
                    Icon(Icons.Default.Check, contentDescription = null)
                    Text("Approve")
                }
                OutlinedButton(onClick = onDeny) {
                    Icon(Icons.Default.Close, contentDescription = null)
                    Text("Deny")
                }
            }
        }
    }
}

@Composable
private fun NoticeCard(message: String, isError: Boolean) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (isError) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer,
        ),
    ) {
        Text(
            text = message,
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            color = if (isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

private fun buildApiKeys(openAi: String, anthropic: String, zhipu: String): Map<String, String>? {
    val keys = buildMap {
        if (openAi.trim().isNotBlank()) put("openai", openAi.trim())
        if (anthropic.trim().isNotBlank()) put("anthropic", anthropic.trim())
        if (zhipu.trim().isNotBlank()) put("zhipu", zhipu.trim())
    }
    return keys.ifEmpty { null }
}

private val sandboxOptions = listOf("read-only", "workspace-write", "danger-full-access")
private val approvalOptions = listOf("on-request", "on-failure", "untrusted", "strict", "never")
