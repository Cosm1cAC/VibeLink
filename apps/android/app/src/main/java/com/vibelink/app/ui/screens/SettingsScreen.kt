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
import androidx.compose.foundation.lazy.rememberLazyListState
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
import com.vibelink.app.data.AppLanguage
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.AuditLogItem
import com.vibelink.app.network.ApprovalRequestItem
import com.vibelink.app.network.ApprovalDecisionResponse
import com.vibelink.app.network.BrowserScreenshot
import com.vibelink.app.network.BrowserSessionInfo
import com.vibelink.app.network.BrowserTraceEvent
import com.vibelink.app.network.CloudflareGuideResponse
import com.vibelink.app.network.DeviceAdminItem
import com.vibelink.app.network.DoctorResponse
import com.vibelink.app.network.McpProbeResponse
import com.vibelink.app.network.McpStatusResponse
import com.vibelink.app.network.NativePushSettingsPatch
import com.vibelink.app.network.PairingSession
import com.vibelink.app.network.PublicSettings
import com.vibelink.app.network.PushSubscriptionItem
import com.vibelink.app.network.SecuritySettings
import com.vibelink.app.network.SettingsPatchRequest
import com.vibelink.app.network.ToolEventStatsResponse
import com.vibelink.app.network.ToolEventsPruneResponse
import com.vibelink.app.ui.i18n.AppStrings
import com.vibelink.app.ui.i18n.LocalAppStrings
import com.vibelink.app.ui.i18n.appStringsFor
import com.google.gson.GsonBuilder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SettingsUiState(
    val settings: PublicSettings? = null,
    val approvals: List<ApprovalRequestItem> = emptyList(),
    val devices: List<DeviceAdminItem> = emptyList(),
    val currentDeviceId: String = "",
    val pairingSessions: List<PairingSession> = emptyList(),
    val auditLogs: List<AuditLogItem> = emptyList(),
    val mcpStatus: McpStatusResponse = McpStatusResponse(),
    val mcpProbe: McpProbeResponse? = null,
    val cloudflare: CloudflareGuideResponse = CloudflareGuideResponse(),
    val pushSubscriptions: List<PushSubscriptionItem> = emptyList(),
    val toolEventStats: ToolEventStatsResponse = ToolEventStatsResponse(),
    val toolEventPrune: ToolEventsPruneResponse? = null,
    val settingsExportText: String = "",
    val settingsImportPreview: List<String> = emptyList(),
    val doctor: DoctorResponse = DoctorResponse(),
    val browser: BrowserWorkspaceUiState = BrowserWorkspaceUiState(),
    val loading: Boolean = false,
    val saving: Boolean = false,
    val adminBusy: String = "",
    val error: String = "",
    val notice: String = "",
)

class SettingsViewModel : ViewModel() {
    private var strings: AppStrings = appStringsFor(AppLanguage.Default)
    private val _uiState = MutableStateFlow(SettingsUiState())
    val uiState: StateFlow<SettingsUiState> = _uiState.asStateFlow()

    fun setLanguage(language: AppLanguage) {
        strings = appStringsFor(language)
    }

    fun load(apiClient: ApiClient) {
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = "", notice = "") }
            try {
                val status = apiClient.checkStatus()
                val approvals = runCatching { apiClient.listApprovals(status = "pending", limit = 50) }.getOrDefault(emptyList())
                val devices = runCatching { apiClient.listDevices() }.getOrDefault(com.vibelink.app.network.DeviceListResponse())
                val pairings = runCatching { apiClient.listPairingSessions(status = "pending") }.getOrDefault(emptyList())
                val auditLogs = runCatching { apiClient.listAuditLogs(limit = 20) }.getOrDefault(emptyList())
                val mcpStatus = runCatching { apiClient.getMcpStatus() }.getOrDefault(McpStatusResponse())
                val cloudflare = runCatching { apiClient.getCloudflareGuide() }.getOrDefault(CloudflareGuideResponse())
                val pushSubscriptions = runCatching { apiClient.listPushSubscriptions() }.getOrDefault(emptyList())
                val toolEventStats = runCatching { apiClient.getToolEventStats() }.getOrDefault(ToolEventStatsResponse())
                val doctor = runCatching { apiClient.getDoctor() }.getOrDefault(DoctorResponse())
                val browserSessions = runCatching { apiClient.listBrowserSessions() }.getOrDefault(emptyList())
                val browserSelection = browserSelection(browserSessions)
                val browserTrace = browserSelection.first?.let {
                    runCatching { apiClient.getBrowserTrace(it.id).items }.getOrDefault(emptyList())
                }.orEmpty()
                _uiState.update {
                    it.copy(
                        settings = status.settings,
                        approvals = approvals,
                        devices = devices.items,
                        currentDeviceId = devices.currentDeviceId,
                        pairingSessions = pairings,
                        auditLogs = auditLogs,
                        mcpStatus = mcpStatus,
                        cloudflare = cloudflare,
                        pushSubscriptions = pushSubscriptions,
                        toolEventStats = toolEventStats,
                        doctor = doctor,
                        browser = BrowserWorkspaceUiState(
                            sessions = browserSessions,
                            sessionId = browserSelection.first?.id.orEmpty(),
                            pageId = browserSelection.second.orEmpty(),
                            trace = browserTrace,
                        ),
                        loading = false,
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(loading = false, error = strings.loadSettingsFailed.withFallback(error.message)) }
            }
        }
    }

    fun save(apiClient: ApiClient, patch: SettingsPatchRequest) {
        viewModelScope.launch {
            _uiState.update { it.copy(saving = true, error = "", notice = "") }
            try {
                val guardedPatch = patch.copy(expectedRevision = _uiState.value.settings?.revision)
                val result = apiClient.saveSettings(guardedPatch)
                _uiState.update {
                    it.copy(
                        settings = result.settings ?: it.settings,
                        saving = false,
                        notice = strings.settingsSaved,
                    )
                }
            } catch (error: com.vibelink.app.network.ApiException) {
                if (error.statusCode == 409) {
                    val fresh = runCatching { apiClient.checkStatus().settings }.getOrNull()
                    _uiState.update {
                        it.copy(
                            settings = fresh?.let { value -> RevisionConflictPolicy.mergeSettingsForRetry(value, patch) } ?: it.settings,
                            saving = false,
                            error = strings.settingsChangedElsewhere,
                        )
                    }
                } else {
                    _uiState.update { it.copy(saving = false, error = strings.saveSettingsFailed.withFallback(error.message)) }
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(saving = false, error = strings.saveSettingsFailed.withFallback(error.message)) }
            }
        }
    }

    fun decideApproval(
        apiClient: ApiClient,
        approvalId: String,
        approve: Boolean,
        onResolved: (ApprovalDecisionResponse) -> Unit = {},
    ) {
        viewModelScope.launch {
            _uiState.update { it.copy(error = "", notice = "") }
            try {
                val result = apiClient.decideApproval(
                    approvalId = approvalId,
                    approve = approve,
                    reason = if (approve) strings.androidApprovalApprovedReason else strings.androidApprovalDeniedReason,
                )
                val approvals = apiClient.listApprovals(status = "pending", limit = 50)
                _uiState.update {
                    it.copy(
                        approvals = approvals,
                        notice = if (approve) strings.approvalApproved else strings.approvalDenied,
                    )
                }
                onResolved(result)
            } catch (error: Exception) {
                _uiState.update { it.copy(error = strings.approvalActionFailed.withFallback(error.message)) }
            }
        }
    }

    fun decidePairing(apiClient: ApiClient, sessionId: String, approve: Boolean) {
        viewModelScope.launch {
            _uiState.update { it.copy(error = "", notice = "") }
            try {
                apiClient.decidePairingSession(sessionId, approve)
                val pairings = apiClient.listPairingSessions(status = "pending")
                _uiState.update {
                    it.copy(
                        pairingSessions = pairings,
                        notice = if (approve) strings.pairingApproved else strings.pairingDenied,
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(error = strings.pairingActionFailed.withFallback(error.message)) }
            }
        }
    }

    fun revokeDevice(apiClient: ApiClient, deviceId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(error = "", notice = "") }
            try {
                apiClient.revokeDevice(deviceId)
                val devices = apiClient.listDevices()
                _uiState.update {
                    it.copy(
                        devices = devices.items,
                        currentDeviceId = devices.currentDeviceId,
                        notice = strings.deviceRevoked,
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(error = strings.revokeDeviceFailed.withFallback(error.message)) }
            }
        }
    }

    fun probeMcp(apiClient: ApiClient, timeoutMs: Int) {
        viewModelScope.launch {
            _uiState.update { it.copy(adminBusy = "mcp", error = "", notice = "") }
            try {
                val result = apiClient.probeMcp(timeoutMs)
                _uiState.update {
                    it.copy(
                        mcpProbe = result,
                        mcpStatus = apiClient.getMcpStatus(),
                        adminBusy = "",
                        notice = if (result.ok) strings.mcpProbeCompleted else strings.mcpProbeFoundIssues,
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(adminBusy = "", error = strings.mcpProbeFailed.withFallback(error.message)) }
            }
        }
    }

    fun pruneToolEvents(apiClient: ApiClient, dryRun: Boolean, keepLatest: Int) {
        viewModelScope.launch {
            _uiState.update { it.copy(adminBusy = if (dryRun) "prune-preview" else "prune", error = "", notice = "") }
            try {
                val result = apiClient.pruneToolEvents(dryRun = dryRun, keepLatest = keepLatest)
                val stats = apiClient.getToolEventStats()
                _uiState.update {
                    it.copy(
                        toolEventPrune = result,
                        toolEventStats = stats,
                        adminBusy = "",
                        notice = if (dryRun) strings.toolPrunePreviewReady else strings.toolPruned,
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(adminBusy = "", error = strings.toolPruneFailed.withFallback(error.message)) }
            }
        }
    }

    fun exportSettings(apiClient: ApiClient) {
        viewModelScope.launch {
            _uiState.update { it.copy(adminBusy = "settings-export", error = "", notice = "") }
            try {
                val exported = apiClient.exportSettings()
                _uiState.update {
                    it.copy(
                        settingsExportText = settingsJson.toJson(exported),
                        adminBusy = "",
                        notice = strings.settingsExportReady,
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(adminBusy = "", error = strings.settingsExportFailed.withFallback(error.message)) }
            }
        }
    }

    fun previewImportSettings(apiClient: ApiClient, rawJson: String) {
        if (rawJson.trim().isBlank()) return
        viewModelScope.launch {
            _uiState.update { it.copy(adminBusy = "settings-import-preview", error = "", notice = "") }
            try {
                val preview = apiClient.importSettings(rawJson, dryRun = true, expectedRevision = _uiState.value.settings?.revision)
                _uiState.update {
                    it.copy(
                        settingsImportPreview = preview.changedKeys,
                        adminBusy = "",
                        notice = strings.settingsImportPreviewReady,
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(adminBusy = "", error = strings.settingsImportPreviewFailed.withFallback(error.message)) }
            }
        }
    }

    fun applyImportSettings(apiClient: ApiClient, rawJson: String) {
        if (rawJson.trim().isBlank()) return
        viewModelScope.launch {
            _uiState.update { it.copy(adminBusy = "settings-import", error = "", notice = "") }
            try {
                val imported = apiClient.importSettings(rawJson, dryRun = false, expectedRevision = _uiState.value.settings?.revision)
                _uiState.update {
                    it.copy(
                        settings = imported.settings ?: it.settings,
                        settingsImportPreview = imported.changedKeys,
                        adminBusy = "",
                        notice = strings.settingsImported,
                    )
                }
                load(apiClient)
            } catch (error: com.vibelink.app.network.ApiException) {
                if (error.statusCode == 409) {
                    val fresh = runCatching { apiClient.checkStatus().settings }.getOrNull()
                    _uiState.update {
                        it.copy(
                            settings = fresh ?: it.settings,
                            adminBusy = "",
                            error = strings.settingsChangedElsewhere,
                        )
                    }
                } else {
                    _uiState.update { it.copy(adminBusy = "", error = strings.settingsImportFailed.withFallback(error.message)) }
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(adminBusy = "", error = strings.settingsImportFailed.withFallback(error.message)) }
            }
        }
    }

    fun registerNativePushToken(apiClient: ApiClient, provider: String, token: String) {
        if (token.trim().isBlank()) return
        viewModelScope.launch {
            _uiState.update { it.copy(adminBusy = "native-push", error = "", notice = "") }
            try {
                apiClient.registerNativePushToken(provider = provider.trim().ifBlank { "fcm" }, token = token.trim())
                val subscriptions = apiClient.listPushSubscriptions()
                _uiState.update {
                    it.copy(
                        pushSubscriptions = subscriptions,
                        adminBusy = "",
                        notice = strings.nativePushTokenRegistered,
                    )
                }
            } catch (error: Exception) {
                _uiState.update { it.copy(adminBusy = "", error = strings.nativePushRegistrationFailed.withFallback(error.message)) }
            }
        }
    }

    fun rotateCurrentDevice(apiClient: ApiClient) {
        viewModelScope.launch {
            _uiState.update { it.copy(error = "", notice = "") }
            runCatching { apiClient.rotateCurrentDevice() }
                .onSuccess { _uiState.update { it.copy(notice = strings.currentDeviceTokenRotated) } }
                .onFailure { error -> _uiState.update { it.copy(error = strings.rotateDeviceTokenFailed.withFallback(error.message)) } }
        }
    }

    fun refreshBrowser(apiClient: ApiClient) = browserAction("refresh") {
        updateBrowserSelection(apiClient)
    }

    fun createBrowserSession(apiClient: ApiClient) = browserAction("create") {
        val created = apiClient.createBrowserSession()
        updateBrowserSelection(apiClient, created.id, created.pages.firstOrNull()?.id.orEmpty())
    }

    fun selectBrowserSession(apiClient: ApiClient, sessionId: String) = browserAction("select") {
        updateBrowserSelection(apiClient, sessionId, "")
    }

    fun selectBrowserPage(pageId: String) {
        _uiState.update { it.copy(browser = it.browser.copy(pageId = pageId, screenshot = null)) }
    }

    fun navigateBrowser(apiClient: ApiClient, address: String) = browserAction("navigate") {
        val browser = _uiState.value.browser
        apiClient.navigateBrowserSession(browser.sessionId, browser.pageId, address.trim())
        val screenshot = apiClient.captureBrowserScreenshot(browser.sessionId, browser.pageId)
        updateBrowserSelection(apiClient, browser.sessionId, browser.pageId, screenshot)
    }

    fun captureBrowserScreenshot(apiClient: ApiClient) = browserAction("screenshot") {
        val browser = _uiState.value.browser
        val screenshot = apiClient.captureBrowserScreenshot(browser.sessionId, browser.pageId)
        _uiState.update { it.copy(browser = it.browser.copy(screenshot = screenshot)) }
    }

    fun createBrowserPage(apiClient: ApiClient) = browserAction("page") {
        val browser = _uiState.value.browser
        val page = apiClient.createBrowserPage(browser.sessionId)
        updateBrowserSelection(apiClient, browser.sessionId, page.id)
    }

    fun closeBrowserSession(apiClient: ApiClient) = browserAction("close") {
        val id = _uiState.value.browser.sessionId
        apiClient.closeBrowserSession(id)
        updateBrowserSelection(apiClient)
    }

    private fun browserAction(key: String, action: suspend () -> Unit) {
        viewModelScope.launch {
            _uiState.update { it.copy(browser = it.browser.copy(busy = key, error = "")) }
            runCatching { action() }
                .onFailure { error -> _uiState.update { it.copy(browser = it.browser.copy(error = error.message.orEmpty())) } }
            _uiState.update { it.copy(browser = it.browser.copy(busy = "")) }
        }
    }

    private suspend fun updateBrowserSelection(
        apiClient: ApiClient,
        preferredSessionId: String = "",
        preferredPageId: String = "",
        screenshot: BrowserScreenshot? = null,
    ) {
        val sessions = apiClient.listBrowserSessions()
        val (selected, pageId) = browserSelection(sessions, preferredSessionId, preferredPageId)
        val trace = selected?.let { apiClient.getBrowserTrace(it.id).items }.orEmpty()
        _uiState.update {
            it.copy(browser = it.browser.copy(
                sessions = sessions,
                sessionId = selected?.id.orEmpty(),
                pageId = pageId.orEmpty(),
                screenshot = screenshot,
                trace = trace,
            ))
        }
    }

    private fun browserSelection(
        sessions: List<BrowserSessionInfo>,
        preferredSessionId: String = "",
        preferredPageId: String = "",
    ): Pair<BrowserSessionInfo?, String?> {
        val session = sessions.firstOrNull { it.id == preferredSessionId } ?: sessions.firstOrNull()
        val pages = session?.pages.orEmpty().filter { it.status != "closed" }
        val page = pages.firstOrNull { it.id == preferredPageId } ?: pages.firstOrNull()
        return session to page?.id
    }
}

data class BrowserWorkspaceUiState(
    val sessions: List<BrowserSessionInfo> = emptyList(),
    val sessionId: String = "",
    val pageId: String = "",
    val screenshot: BrowserScreenshot? = null,
    val trace: List<BrowserTraceEvent> = emptyList(),
    val busy: String = "",
    val error: String = "",
)

private val settingsJson = GsonBuilder().setPrettyPrinting().create()

object SettingsSectionTarget {
    private const val sectionsBeforeApprovals = 7

    fun pendingApprovalsIndex(hasError: Boolean, hasNotice: Boolean): Int {
        return sectionsBeforeApprovals + (if (hasError) 1 else 0) + (if (hasNotice) 1 else 0)
    }

}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    apiClient: ApiClient,
    viewModel: SettingsViewModel,
    language: AppLanguage,
    initialSection: String = "",
    onApprovalDecision: (ApprovalDecisionResponse) -> Unit = {},
    onLanguageChange: (AppLanguage) -> Unit,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val settings = state.settings
    val strings = LocalAppStrings.current
    val listState = rememberLazyListState()
    var sectionPositioned by remember(initialSection) { mutableStateOf(false) }

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
    var trustedWorkspaces by remember { mutableStateOf("") }
    var hostAllowlist by remember { mutableStateOf("") }
    var allowTryCloudflare by remember { mutableStateOf(true) }
    var allowLegacyPairingTokenLogin by remember { mutableStateOf(false) }
    var notificationEmail by remember { mutableStateOf("") }
    var nativePushProviderSetting by remember { mutableStateOf("fcm") }
    var nativePushProjectId by remember { mutableStateOf("") }
    var nativePushServiceAccountJson by remember { mutableStateOf("") }
    var toolRetentionDays by remember { mutableStateOf("30") }
    var toolKeepLatest by remember { mutableStateOf("5000") }
    var toolAutoPrune by remember { mutableStateOf(true) }
    var toolPruneInterval by remember { mutableStateOf("360") }
    var mcpProbeTimeout by remember { mutableStateOf("10000") }
    var nativePushProvider by remember { mutableStateOf("fcm") }
    var nativePushToken by remember { mutableStateOf("") }
    var settingsImportText by remember { mutableStateOf("") }
    var openAiKey by remember { mutableStateOf("") }
    var anthropicKey by remember { mutableStateOf("") }
    var zhipuKey by remember { mutableStateOf("") }

    LaunchedEffect(strings.currentLanguage) {
        viewModel.setLanguage(strings.currentLanguage)
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
        trustedWorkspaces = settings.security.trustedWorkspaces.joinToString("\n")
        hostAllowlist = settings.hostAllowlist.joinToString("\n")
        allowTryCloudflare = settings.allowTryCloudflare
        allowLegacyPairingTokenLogin = settings.allowLegacyPairingTokenLogin
        nativePushProviderSetting = settings.nativePush.provider.ifBlank { "fcm" }
        nativePushProjectId = settings.nativePush.fcmProjectId
        toolRetentionDays = settings.toolEvents.retentionDays.toString()
        toolKeepLatest = settings.toolEvents.keepLatest.toString()
        toolAutoPrune = settings.toolEvents.autoPrune
        toolPruneInterval = settings.toolEvents.autoPruneIntervalMinutes.toString()
        mcpProbeTimeout = settings.mcp.probeTimeoutMs.toString()
    }

    LaunchedEffect(initialSection, state.loading, settings, state.error, state.notice) {
        if (initialSection == "approvals" && !sectionPositioned && !state.loading && settings != null) {
            listState.scrollToItem(
                SettingsSectionTarget.pendingApprovalsIndex(
                    hasError = state.error.isNotBlank(),
                    hasNotice = state.notice.isNotBlank(),
                ),
            )
            sectionPositioned = true
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(strings.settings) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = strings.back)
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.load(apiClient) }) {
                        if (state.loading) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Default.Refresh, contentDescription = strings.refresh)
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
                                        trustedWorkspaces = linesFromText(trustedWorkspaces),
                                    ),
                                    hostAllowlist = linesFromText(hostAllowlist),
                                    allowTryCloudflare = allowTryCloudflare,
                                    allowLegacyPairingTokenLogin = allowLegacyPairingTokenLogin,
                                    notificationEmail = notificationEmail.trim().ifBlank { null },
                                    nativePush = NativePushSettingsPatch(
                                        provider = nativePushProviderSetting,
                                        fcmProjectId = nativePushProjectId,
                                        fcmServiceAccountJson = nativePushServiceAccountJson.trim().ifBlank { null },
                                    ),
                                    toolEvents = com.vibelink.app.network.ToolEventsSettings(
                                        retentionDays = intFromText(toolRetentionDays, 30),
                                        keepLatest = intFromText(toolKeepLatest, 5000),
                                        autoPrune = toolAutoPrune,
                                        autoPruneIntervalMinutes = intFromText(toolPruneInterval, 360),
                                    ),
                                    mcp = com.vibelink.app.network.McpSettingsPatch(
                                        probeTimeoutMs = intFromText(mcpProbeTimeout, 10000),
                                    ),
                                    apiKeys = buildApiKeys(openAiKey, anthropicKey, zhipuKey),
                                ),
                            )
                            nativePushServiceAccountJson = ""
                        },
                        enabled = !state.saving,
                    ) {
                        if (state.saving) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Default.Save, contentDescription = strings.save)
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
                    state = listState,
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
                        SectionCard(title = strings.language) {
                            Text(strings.displayLanguage, style = MaterialTheme.typography.labelMedium)
                            Spacer(Modifier.height(8.dp))
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(listOf(AppLanguage.Chinese, AppLanguage.English)) { option ->
                                    FilterChip(
                                        selected = language == option,
                                        onClick = { onLanguageChange(option) },
                                        label = {
                                            Text(if (option == AppLanguage.Chinese) strings.chinese else strings.english)
                                        },
                                    )
                                }
                            }
                        }
                    }

                    item {
                        BrowserWorkspaceSection(
                            state = state.browser,
                            onRefresh = { viewModel.refreshBrowser(apiClient) },
                            onCreateSession = { viewModel.createBrowserSession(apiClient) },
                            onCloseSession = { viewModel.closeBrowserSession(apiClient) },
                            onSelectSession = { viewModel.selectBrowserSession(apiClient, it) },
                            onSelectPage = viewModel::selectBrowserPage,
                            onCreatePage = { viewModel.createBrowserPage(apiClient) },
                            onNavigate = { viewModel.navigateBrowser(apiClient, it) },
                            onScreenshot = { viewModel.captureBrowserScreenshot(apiClient) },
                        )
                    }

                    item {
                        SectionCard(title = strings.text("运行时", "Runtime")) {
                            OutlinedTextField(
                                value = defaultCwd,
                                onValueChange = { defaultCwd = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("默认工作目录", "Default working directory")) },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = codexCommand,
                                onValueChange = { codexCommand = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("Codex 命令", "Codex command")) },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = claudeCommand,
                                onValueChange = { claudeCommand = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("Claude 命令", "Claude command")) },
                                singleLine = true,
                            )
                        }
                    }

                    item {
                        SectionCard(title = strings.text("豆包桥接", "Doubao Bridge")) {
                            OutlinedTextField(
                                value = doubaoCommand,
                                onValueChange = { doubaoCommand = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("豆包命令", "Doubao command")) },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = doubaoEndpoint,
                                onValueChange = { doubaoEndpoint = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("CDP 端点", "CDP endpoint")) },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = doubaoUrl,
                                onValueChange = { doubaoUrl = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("豆包 URL", "Doubao URL")) },
                                singleLine = true,
                            )
                        }
                    }

                    item {
                        SectionCard(title = strings.text("智能体安全", "Agent Security")) {
                            Text(strings.text("沙盒", "Sandbox"), style = MaterialTheme.typography.labelMedium)
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
                            Text(strings.text("审批策略", "Approval policy"), style = MaterialTheme.typography.labelMedium)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(approvalOptions) { value ->
                                    FilterChip(
                                        selected = approvalPolicy == value,
                                        onClick = { approvalPolicy = value },
                                        label = { Text(value) },
                                    )
                                }
                            }
                            ToggleRow(strings.text("允许网络访问", "Allow network access"), networkAccess) { networkAccess = it }
                            ToggleRow(strings.text("要求可信工作区", "Require trusted workspace"), requireTrustedWorkspace) { requireTrustedWorkspace = it }
                            ToggleRow(strings.text("危险命令需要审批", "Require dangerous-command approval"), requireDangerousApproval) { requireDangerousApproval = it }
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = trustedWorkspaces,
                                onValueChange = { trustedWorkspaces = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("可信工作区", "Trusted workspaces")) },
                                minLines = 2,
                                maxLines = 5,
                                singleLine = false,
                            )
                        }
                    }

                    item {
                        SectionCard(title = strings.text("访问与通知", "Access & Notifications")) {
                            OutlinedTextField(
                                value = hostAllowlist,
                                onValueChange = { hostAllowlist = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("主机允许列表", "Host allowlist")) },
                                minLines = 2,
                                maxLines = 5,
                                singleLine = false,
                            )
                            ToggleRow(strings.text("允许 Cloudflare Tunnel 主机", "Allow Cloudflare tunnel hosts"), allowTryCloudflare) { allowTryCloudflare = it }
                            ToggleRow(strings.text("允许旧 Token 登录", "Allow legacy token login"), allowLegacyPairingTokenLogin) { allowLegacyPairingTokenLogin = it }
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = notificationEmail,
                                onValueChange = { notificationEmail = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(if (settings?.notificationEmailConfigured == true) strings.text("通知邮箱已保存；留空则保留", "Notification email saved; leave blank to keep") else strings.text("通知邮箱", "Notification email")) },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            CloudflareCard(state.cloudflare)
                            Spacer(Modifier.height(10.dp))
                            Text(strings.text("原生推送", "Native push"), style = MaterialTheme.typography.labelMedium)
                            Spacer(Modifier.height(6.dp))
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(listOf("fcm", "none")) { value ->
                                    FilterChip(
                                        selected = nativePushProviderSetting == value,
                                        onClick = { nativePushProviderSetting = value },
                                        label = { Text(value.uppercase()) },
                                    )
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = nativePushProjectId,
                                onValueChange = { nativePushProjectId = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("FCM 项目 ID", "FCM project id")) },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = nativePushServiceAccountJson,
                                onValueChange = { nativePushServiceAccountJson = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(if (settings?.nativePush?.configured == true) strings.text("FCM 服务账号已保存；留空则保留", "FCM service account saved; leave blank to keep") else strings.text("FCM 服务账号 JSON", "FCM service account JSON")) },
                                minLines = 2,
                                maxLines = 5,
                                singleLine = false,
                            )
                            MutedText(
                                if (settings?.nativePush?.configured == true) {
                                    "FCM configured for ${settings.nativePush.fcmProjectId.ifBlank { "service-account project" }}."
                                } else {
                                    "Register Android tokens below; configure FCM here for native delivery."
                                }
                            )
                            Spacer(Modifier.height(10.dp))
                            NativePushCard(
                                subscriptions = state.pushSubscriptions,
                                provider = nativePushProvider,
                                token = nativePushToken,
                                busy = state.adminBusy == "native-push",
                                onProviderChange = { nativePushProvider = it },
                                onTokenChange = { nativePushToken = it },
                                onRegister = {
                                    viewModel.registerNativePushToken(apiClient, nativePushProvider, nativePushToken)
                                    nativePushToken = ""
                                },
                            )
                        }
                    }

                    item {
                        SectionCard(title = strings.text("API 密钥", "API Keys")) {
                            KeyField(
                                label = if (settings?.hasOpenAIKey == true) strings.text("OpenAI 密钥已保存；留空则保留", "OpenAI key saved; leave blank to keep") else strings.text("OpenAI 密钥", "OpenAI key"),
                                value = openAiKey,
                                onValueChange = { openAiKey = it },
                            )
                            Spacer(Modifier.height(8.dp))
                            KeyField(
                                label = if (settings?.hasAnthropicKey == true) strings.text("Anthropic 密钥已保存；留空则保留", "Anthropic key saved; leave blank to keep") else strings.text("Anthropic 密钥", "Anthropic key"),
                                value = anthropicKey,
                                onValueChange = { anthropicKey = it },
                            )
                            Spacer(Modifier.height(8.dp))
                            KeyField(
                                label = if (settings?.hasZhipuKey == true) strings.text("智谱密钥已保存；留空则保留", "Zhipu key saved; leave blank to keep") else strings.text("智谱密钥", "Zhipu key"),
                                value = zhipuKey,
                                onValueChange = { zhipuKey = it },
                            )
                        }
                    }

                    item {
                        SectionCard(title = strings.text("待审批", "Pending Approvals")) {
                            if (state.approvals.isEmpty()) {
                                Text(
                                    strings.text("暂无待审批请求。", "No pending approvals."),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            } else {
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    state.approvals.forEach { approval ->
                                        ApprovalCard(
                                            approval = approval,
                                            onApprove = {
                                                viewModel.decideApproval(apiClient, approval.id, approve = true, onResolved = onApprovalDecision)
                                            },
                                            onDeny = {
                                                viewModel.decideApproval(apiClient, approval.id, approve = false, onResolved = onApprovalDecision)
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    }

                    item {
                        SectionCard(title = strings.text("设备与配对", "Devices & Pairing")) {
                            if (state.devices.isEmpty()) {
                                MutedText(strings.text("暂无已注册的配对设备。", "No paired devices are registered."))
                            } else {
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    state.devices.take(8).forEach { device ->
                                        DeviceCard(
                                            device = device,
                                            currentDeviceId = state.currentDeviceId,
                                            onRevoke = { viewModel.revokeDevice(apiClient, device.id) },
                                        )
                                    }
                                }
                            }
                            OutlinedButton(onClick = { viewModel.rotateCurrentDevice(apiClient) }, modifier = Modifier.fillMaxWidth()) {
                                Text(strings.text("轮换当前设备 token", "Rotate current device token"))
                            }
                            Spacer(Modifier.height(10.dp))
                            Text(strings.text("配对请求", "Pairing requests"), style = MaterialTheme.typography.labelMedium)
                            Spacer(Modifier.height(6.dp))
                            if (state.pairingSessions.isEmpty()) {
                                MutedText(strings.text("暂无待处理配对会话。", "No pending pairing sessions."))
                            } else {
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    state.pairingSessions.take(5).forEach { session ->
                                        PairingSessionCard(
                                            session = session,
                                            onApprove = { viewModel.decidePairing(apiClient, session.id, approve = true) },
                                            onDeny = { viewModel.decidePairing(apiClient, session.id, approve = false) },
                                        )
                                    }
                                }
                            }
                        }
                    }

                    item {
                        SectionCard(title = strings.text("MCP 与诊断", "MCP & Diagnostics")) {
                            Text(
                                "${state.mcpStatus.enabled}/${state.mcpStatus.configured} MCP servers enabled / ${state.mcpStatus.cachedTools} cached tools",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (state.mcpStatus.servers.isNotEmpty()) {
                                Spacer(Modifier.height(8.dp))
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    state.mcpStatus.servers.take(5).forEach { server ->
                                        McpServerRow(server.name.ifBlank { server.id }, server.type, server.enabled)
                                    }
                                }
                            }
                            Spacer(Modifier.height(10.dp))
                            OutlinedTextField(
                                value = mcpProbeTimeout,
                                onValueChange = { mcpProbeTimeout = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("MCP 探测超时（毫秒）", "MCP probe timeout ms")) },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            Button(
                                onClick = { viewModel.probeMcp(apiClient, intFromText(mcpProbeTimeout, 10000)) },
                                enabled = state.adminBusy.isBlank(),
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text(if (state.adminBusy == "mcp") strings.text("探测中", "Probing") else strings.text("探测 MCP", "Probe MCP")) }
                            state.mcpProbe?.let { probe ->
                                Spacer(Modifier.height(8.dp))
                                McpProbeSummary(probe)
                            }
                            Spacer(Modifier.height(10.dp))
                            Text(
                                text = if (state.doctor.ok) "Doctor checks passed" else "Doctor has ${state.doctor.failures.size} failure(s) and ${state.doctor.warnings.size} warning(s)",
                                style = MaterialTheme.typography.bodySmall,
                                color = if (state.doctor.ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                            )
                            val checks = (state.doctor.failures + state.doctor.warningChecks).take(6)
                            if (checks.isNotEmpty()) {
                                Spacer(Modifier.height(8.dp))
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    checks.forEach { check -> DoctorCheckRow(check.label, check.detail, check.severity) }
                                }
                            }
                        }
                    }

                    item {
                        SectionCard(title = strings.text("工具事件保留", "Tool Event Retention")) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                OutlinedTextField(
                                    value = toolRetentionDays,
                                    onValueChange = { toolRetentionDays = it },
                                    modifier = Modifier.weight(1f),
                                    label = { Text(strings.text("天数", "Days")) },
                                    singleLine = true,
                                )
                                OutlinedTextField(
                                    value = toolKeepLatest,
                                    onValueChange = { toolKeepLatest = it },
                                    modifier = Modifier.weight(1f),
                                    label = { Text(strings.text("保留最新", "Keep latest")) },
                                    singleLine = true,
                                )
                            }
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = toolPruneInterval,
                                onValueChange = { toolPruneInterval = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("自动清理间隔（分钟）", "Auto-prune interval minutes")) },
                                singleLine = true,
                            )
                            ToggleRow(strings.text("自动清理旧工具事件", "Auto prune old tool events"), toolAutoPrune) { toolAutoPrune = it }
                            ToolEventStatsCard(state.toolEventStats, state.toolEventPrune)
                            Spacer(Modifier.height(8.dp))
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                item {
                                    OutlinedButton(
                                        onClick = { viewModel.pruneToolEvents(apiClient, dryRun = true, keepLatest = intFromText(toolKeepLatest, 5000)) },
                                        enabled = state.adminBusy.isBlank(),
                                    ) { Text(if (state.adminBusy == "prune-preview") strings.text("检查中", "Checking") else strings.text("预览清理", "Preview prune")) }
                                }
                                item {
                                    OutlinedButton(
                                        onClick = { viewModel.pruneToolEvents(apiClient, dryRun = false, keepLatest = intFromText(toolKeepLatest, 5000)) },
                                        enabled = state.adminBusy.isBlank(),
                                    ) { Text(if (state.adminBusy == "prune") strings.text("清理中", "Pruning") else strings.text("立即清理", "Prune now")) }
                                }
                            }
                        }
                    }

                    item {
                        SectionCard(title = strings.text("设置导入 / 导出", "Settings Import / Export")) {
                            Button(
                                onClick = { viewModel.exportSettings(apiClient) },
                                enabled = state.adminBusy.isBlank(),
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text(if (state.adminBusy == "settings-export") strings.text("导出中", "Exporting") else strings.text("导出设置", "Export settings")) }
                            if (state.settingsExportText.isNotBlank()) {
                                Spacer(Modifier.height(8.dp))
                                OutlinedTextField(
                                    value = state.settingsExportText,
                                    onValueChange = {},
                                    modifier = Modifier.fillMaxWidth(),
                                    label = { Text(strings.text("导出 JSON", "Export JSON")) },
                                    minLines = 4,
                                    maxLines = 8,
                                    singleLine = false,
                                    readOnly = true,
                                )
                            }
                            Spacer(Modifier.height(10.dp))
                            OutlinedTextField(
                                value = settingsImportText,
                                onValueChange = { settingsImportText = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(strings.text("导入 JSON", "Import JSON")) },
                                minLines = 4,
                                maxLines = 8,
                                singleLine = false,
                            )
                            if (state.settingsImportPreview.isNotEmpty()) {
                                Spacer(Modifier.height(6.dp))
                                MutedText(strings.text("变更：", "Changes: ") + state.settingsImportPreview.joinToString(", "))
                            }
                            Spacer(Modifier.height(8.dp))
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                item {
                                    OutlinedButton(
                                        onClick = { viewModel.previewImportSettings(apiClient, settingsImportText) },
                                        enabled = state.adminBusy.isBlank() && settingsImportText.trim().isNotBlank(),
                                    ) { Text(if (state.adminBusy == "settings-import-preview") strings.text("检查中", "Checking") else strings.text("预览导入", "Preview import")) }
                                }
                                item {
                                    Button(
                                        onClick = { viewModel.applyImportSettings(apiClient, settingsImportText) },
                                        enabled = state.adminBusy.isBlank() && settingsImportText.trim().isNotBlank(),
                                    ) { Text(if (state.adminBusy == "settings-import") strings.text("导入中", "Importing") else strings.text("导入", "Import")) }
                                }
                            }
                        }
                    }

                    item {
                        SectionCard(title = strings.text("审计日志", "Audit Log")) {
                            if (state.auditLogs.isEmpty()) {
                                MutedText(strings.text("暂无审计条目。", "No audit entries yet."))
                            } else {
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    state.auditLogs.take(8).forEach { item -> AuditLogRow(item) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun String.withFallback(message: String?): String = message?.takeIf { it.isNotBlank() } ?: this

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
    val strings = LocalAppStrings.current
    Card(
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                approval.title.ifBlank { approval.kind.ifBlank { strings.text("审批", "Approval") } },
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
                    Text(strings.text("批准", "Approve"))
                }
                OutlinedButton(onClick = onDeny) {
                    Icon(Icons.Default.Close, contentDescription = null)
                    Text(strings.text("拒绝", "Deny"))
                }
            }
        }
    }
}

@Composable
private fun DeviceCard(
    device: DeviceAdminItem,
    currentDeviceId: String,
    onRevoke: () -> Unit,
) {
    val strings = LocalAppStrings.current
    Card(
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = device.label.ifBlank { device.id.take(8) },
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (device.id == currentDeviceId) {
                    Text(strings.text("当前", "current"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
                val revoked = device.revokedAt.isNotBlank()
                Text(
                    text = when {
                        revoked -> strings.text("已撤销", "revoked")
                        device.expired -> strings.text("已过期", "expired")
                        else -> strings.text("活跃", "active")
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = if (revoked || device.expired) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                )
            }
            MutedText(listOf(device.lastSeenAt.ifBlank { strings.text("从未在线", "never seen") }, device.expiresAt.ifBlank { strings.text("无过期时间", "no expiry") }).joinToString(" / "))
            OutlinedButton(
                onClick = onRevoke,
                enabled = device.id != currentDeviceId && device.revokedAt.isBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(strings.text("撤销", "Revoke")) }
        }
    }
}

@Composable
private fun PairingSessionCard(
    session: PairingSession,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
) {
    val strings = LocalAppStrings.current
    Card(
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(session.label.ifBlank { session.id.take(8) }, style = MaterialTheme.typography.bodyMedium)
            MutedText(session.status.ifBlank { strings.text("待处理", "pending") })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onApprove, modifier = Modifier.weight(1f)) { Text(strings.text("批准", "Approve")) }
                OutlinedButton(onClick = onDeny, modifier = Modifier.weight(1f)) { Text(strings.text("拒绝", "Deny")) }
            }
        }
    }
}

@Composable
private fun McpServerRow(name: String, type: String, enabled: Boolean) {
    val strings = LocalAppStrings.current
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(name, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(type.ifBlank { "stdio" }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(if (enabled) strings.text("已启用", "enabled") else strings.text("已停用", "disabled"), style = MaterialTheme.typography.labelSmall, color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun CloudflareCard(guide: CloudflareGuideResponse) {
    Card(
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (guide.registered || !guide.publicHost) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.errorContainer,
        ),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                text = when {
                    guide.tunnelDetected -> "Cloudflare Tunnel"
                    guide.publicHost -> "Public host"
                    else -> "Local/private host"
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            MutedText(listOf(guide.host.ifBlank { "local" }, if (guide.registered) "registered" else "not registered").joinToString(" / "))
            guide.warnings.take(2).forEach { warning -> MutedText(warning) }
            guide.steps.take(3).forEach { step -> MutedText(step) }
        }
    }
}

@Composable
private fun NativePushCard(
    subscriptions: List<PushSubscriptionItem>,
    provider: String,
    token: String,
    busy: Boolean,
    onProviderChange: (String) -> Unit,
    onTokenChange: (String) -> Unit,
    onRegister: () -> Unit,
) {
    val strings = LocalAppStrings.current
    val nativeCount = subscriptions.count { it.kind == "native" }
    val webCount = subscriptions.count { it.kind == "web" }
    Card(
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(strings.pushDelivery, style = MaterialTheme.typography.bodyMedium)
            MutedText(strings.text("$webCount 个 Web Push / $nativeCount 个原生 token", "$webCount Web Push / $nativeCount native token(s)"))
            subscriptions.filter { it.kind == "native" }.take(3).forEach { item ->
                MutedText("${item.provider.ifBlank { "native" }} ${item.platform.ifBlank { "android" }} ${item.tokenPreview.ifBlank { item.updatedAt }}")
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = provider,
                    onValueChange = onProviderChange,
                    modifier = Modifier.weight(0.42f),
                    label = { Text(strings.provider) },
                    singleLine = true,
                )
                OutlinedTextField(
                    value = token,
                    onValueChange = onTokenChange,
                    modifier = Modifier.weight(0.58f),
                    label = { Text(strings.token) },
                    singleLine = true,
                )
            }
            Button(
                onClick = onRegister,
                enabled = !busy && token.trim().isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (busy) strings.text("正在注册", "Registering") else strings.text("注册原生 token", "Register native token")) }
        }
    }
}

@Composable
private fun McpProbeSummary(probe: McpProbeResponse) {
    val strings = LocalAppStrings.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = if (probe.ok) strings.text("MCP 探测已就绪", "MCP probe ready") else strings.text("MCP 探测需要处理", "MCP probe needs attention"),
            style = MaterialTheme.typography.bodySmall,
            color = if (probe.ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
        )
        MutedText(strings.text("${probe.enabled}/${probe.configured} 已启用 / ${probe.tools.size} 个工具", "${probe.enabled}/${probe.configured} enabled / ${probe.tools.size} tools"))
        probe.results.take(5).forEach { result ->
            val server = result.server?.name?.ifBlank { result.server.id }.orEmpty().ifBlank { "MCP server" }
            val status = result.status.ifBlank { if (result.ok) "ok" else "failed" }
            MutedText("$server: $status${if (result.error.isNotBlank()) " / ${result.error}" else ""}")
        }
    }
}

@Composable
private fun ToolEventStatsCard(stats: ToolEventStatsResponse, prune: ToolEventsPruneResponse?) {
    val strings = LocalAppStrings.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        MutedText(strings.text("${stats.count} 个事件 / 游标 ${stats.minCursor}-${stats.maxCursor}", "${stats.count} events / cursor ${stats.minCursor}-${stats.maxCursor}"))
        MutedText(strings.text("保留 ${stats.retention.retentionDays} 天 / 保留最新 ${stats.retention.keepLatest} 条 / 下次 ${stats.autoPrune.nextRunAt.ifBlank { "manual" }}", "${stats.retention.retentionDays}d retention / keep ${stats.retention.keepLatest} / next ${stats.autoPrune.nextRunAt.ifBlank { "manual" }}"))
        prune?.let {
            MutedText(strings.text("${if (it.dryRun) "预览" else "已应用"}：${it.prunable} 条可清理 / ${it.deleted} 条已删除", "${if (it.dryRun) "Preview" else "Applied"}: ${it.prunable} prunable / ${it.deleted} deleted"))
        }
    }
}

@Composable
private fun DoctorCheckRow(label: String, detail: String, severity: String) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(label.ifBlank { "Check" }, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            detail,
            style = MaterialTheme.typography.labelSmall,
            color = if (severity == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun AuditLogRow(item: AuditLogItem) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(item.type.ifBlank { "event" }, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(if (item.success) "ok" else "failed", style = MaterialTheme.typography.labelSmall, color = if (item.success) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
        }
        val detail = listOf(item.at, item.path, item.reason).filter { it.isNotBlank() }.joinToString(" / ")
        if (detail.isNotBlank()) MutedText(detail)
    }
}

@Composable
private fun MutedText(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
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

private fun linesFromText(text: String): List<String> {
    return text.split('\n', ',', ';')
        .map { it.trim() }
        .filter { it.isNotBlank() }
}

private fun intFromText(text: String, fallback: Int): Int {
    return text.trim().toIntOrNull() ?: fallback
}

private val sandboxOptions = listOf("read-only", "workspace-write", "danger-full-access")
private val approvalOptions = listOf("on-request", "on-failure", "untrusted", "strict", "never")
