package com.vibelink.app.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AssistChip
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
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.AsrCheckpointInfo
import com.vibelink.app.network.AsrProviderInfo
import com.vibelink.app.network.ProviderDefinition
import com.vibelink.app.network.Session
import com.vibelink.app.ui.i18n.LocalAppStrings
import com.vibelink.app.ui.components.LevelIndicator
import com.vibelink.app.ui.components.QaCard
import com.vibelink.app.ui.components.TranscriptFeed
import java.io.File
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallScreen(
    apiClient: ApiClient,
    viewModel: CallViewModel,
    workspaceId: String = "",
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val strings = LocalAppStrings.current
    var transcriptInput by remember(strings.defaultTranscriptPrompt) { mutableStateOf(strings.defaultTranscriptPrompt) }
    var speaker by remember { mutableStateOf("remote") }
    var finalTranscript by remember { mutableStateOf(true) }
    var permissionMessage by remember { mutableStateOf("") }

    val micPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            permissionMessage = ""
            viewModel.startAudio(context, apiClient)
        } else {
            permissionMessage = strings.microphonePermissionDenied
        }
    }

    LaunchedEffect(Unit) {
        viewModel.load(apiClient)
    }

    DisposableEffect(Unit) {
        onDispose { viewModel.stopAudio() }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(strings.liveCallAssistant, style = MaterialTheme.typography.titleMedium)
                        Text(
                            state.statusText,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = strings.back)
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.load(apiClient) }) {
                        if (state.refreshing) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Default.Refresh, contentDescription = strings.refresh)
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (state.errorText.isNotBlank() || permissionMessage.isNotBlank()) {
                item {
                    ErrorCard(state.errorText.ifBlank { permissionMessage })
                }
            }

            item {
                SessionStrip(
                    sessions = state.sessions,
                    selectedId = state.sessionId,
                    onSelect = { viewModel.selectSession(apiClient, it.id) },
                )
            }

            item {
                AssistantOptions(
                    agent = state.agent,
                    onAgentChange = viewModel::setAgent,
                    model = state.model,
                    onModelChange = viewModel::setModel,
                    providers = state.providerRegistry.providers.filter { it.capabilities.liveCallAssistant },
                    asrProviders = state.asrProviders,
                    asrProvider = state.asrProvider,
                    onAsrProviderChange = viewModel::setAsrProvider,
                )
            }

            item {
                AsrDiagnosticsCard(
                    providers = state.asrProviders,
                    checkpoints = state.asrCheckpoints,
                    status = state.asrRecoveryStatus,
                    deviceHint = state.deviceHint,
                    onRefresh = { viewModel.refreshAsrDiagnostics(apiClient) },
                    onRecover = { viewModel.recoverAsrCheckpoints(apiClient) },
                    recoverEnabled = state.sessionId.isNotBlank(),
                )
            }

            item {
                StatusCard(state = state, workspaceId = workspaceId)
            }

            item {
                ControlCard(
                    state = state,
                    onCreate = { viewModel.createSession(apiClient, workspaceId) },
                    onStopSession = { viewModel.stopSession(apiClient) },
                    onPauseSession = { viewModel.pauseSession(apiClient) },
                    onResumeSession = { viewModel.resumeSession(apiClient) },
                    onStartMic = {
                        val granted = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                        if (granted) viewModel.startAudio(context, apiClient)
                        else micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    },
                    onStopMic = { viewModel.stopAudio() },
                )
            }

            item {
                RecordingFilesCard(context = context)
            }

            if (state.sessionId.isNotBlank()) {
                item {
                    Card(shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(strings.manualTranscript, style = MaterialTheme.typography.labelMedium)
                            OutlinedTextField(
                                value = transcriptInput,
                                onValueChange = { transcriptInput = it },
                                modifier = Modifier.fillMaxWidth(),
                                minLines = 2,
                                maxLines = 5,
                            )
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(listOf("remote", "local")) { value ->
                                    FilterChip(
                                        selected = speaker == value,
                                        onClick = { speaker = value },
                                        label = { Text(strings.speakerLabel(value)) },
                                    )
                                }
                                item {
                                    FilterChip(
                                        selected = finalTranscript,
                                        onClick = { finalTranscript = !finalTranscript },
                                        label = { Text(if (finalTranscript) strings.finalTranscript else strings.partialTranscript) },
                                    )
                                }
                            }
                            Button(
                                onClick = { viewModel.sendTranscript(apiClient, transcriptInput, speaker, finalTranscript) },
                                enabled = transcriptInput.isNotBlank(),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Icon(Icons.Default.Send, contentDescription = null)
                                Text(strings.sendTranscript)
                            }
                        }
                    }
                }
            }

            item {
                Card(shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(strings.audioLevels, style = MaterialTheme.typography.labelMedium)
                        LevelIndicator(strings.remote, state.remoteLevel)
                        LevelIndicator(strings.local, state.localLevel)
                    }
                }
            }

            item {
                TranscriptFeed(state.events)
            }

            if (state.qaPairs.isNotEmpty()) {
                item {
                    Text(strings.qa, style = MaterialTheme.typography.titleSmall)
                }
                items(state.qaPairs) { pair ->
                    QaCard(pair.question, pair.answer, pair.agentState)
                }
            }
        }
    }
}

@Composable
private fun SessionStrip(
    sessions: List<Session>,
    selectedId: String,
    onSelect: (Session) -> Unit,
) {
    val strings = LocalAppStrings.current
    Card(shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(strings.sessions, style = MaterialTheme.typography.labelMedium)
            if (sessions.isEmpty()) {
                Text(
                    strings.noLiveCallSessions,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(sessions, key = { it.id }) { session ->
                        val title = session.title.ifBlank { strings.liveCall }
                        val status = strings.liveCallSessionStatus(session.status)
                        AssistChip(
                            onClick = { onSelect(session) },
                            label = {
                                Text(
                                    listOf(title, status)
                                        .filter { it.isNotBlank() }
                                        .joinToString(" · "),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            },
                            modifier = Modifier.clickable { onSelect(session) },
                        )
                    }
                }
                selectedId.takeIf { it.isNotBlank() }?.let {
                    Text(
                        strings.selectedShortId(it),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun AssistantOptions(
    agent: String,
    onAgentChange: (String) -> Unit,
    model: String,
    onModelChange: (String) -> Unit,
    providers: List<ProviderDefinition>,
    asrProviders: List<AsrProviderInfo>,
    asrProvider: String,
    onAsrProviderChange: (String) -> Unit,
) {
    val strings = LocalAppStrings.current
    Card(shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(strings.assistant, style = MaterialTheme.typography.labelMedium)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(providers.ifEmpty { fallbackLiveCallProviders() }, key = { it.id }) { option ->
                    FilterChip(
                        selected = agent == option.id,
                        enabled = option.available,
                        onClick = { onAgentChange(option.id) },
                        label = { Text(option.label.ifBlank { option.id }) },
                    )
                }
            }
            OutlinedTextField(
                value = model,
                onValueChange = onModelChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(strings.modelOverride) },
                singleLine = true,
            )
            OutlinedTextField(
                value = asrProvider,
                onValueChange = onAsrProviderChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(strings.asrProvider) },
                singleLine = true,
                placeholder = { Text(strings.asrProviderPlaceholder) },
            )
            if (asrProviders.isNotEmpty()) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(asrProviders, key = { it.id }) { provider ->
                        FilterChip(
                            selected = asrProvider == provider.id || (asrProvider.isBlank() && provider.active),
                            enabled = provider.available,
                            onClick = { onAsrProviderChange(provider.id) },
                            label = { Text(provider.label.ifBlank { provider.id }) },
                        )
                    }
                }
            }
        }
    }
}

private fun fallbackLiveCallProviders(): List<ProviderDefinition> = listOf(
    ProviderDefinition(id = "claude", label = "Claude", available = true),
    ProviderDefinition(id = "codex", label = "Codex", available = true),
    ProviderDefinition(id = "doubao", label = "Doubao", available = true),
    ProviderDefinition(id = "zhipu", label = "GLM", available = true),
)

@Composable
private fun AsrDiagnosticsCard(
    providers: List<AsrProviderInfo>,
    checkpoints: List<AsrCheckpointInfo>,
    status: String,
    deviceHint: String,
    onRefresh: () -> Unit,
    onRecover: () -> Unit,
    recoverEnabled: Boolean,
) {
    val strings = LocalAppStrings.current
    Card(shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(strings.asrDiagnostics, style = MaterialTheme.typography.labelMedium)
                    Text(
                        strings.asrPipelineHint,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                OutlinedButton(onClick = onRefresh) {
                    Icon(Icons.Default.Refresh, contentDescription = null)
                    Text(strings.refresh)
                }
            }
            Text(deviceHint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

            if (providers.isEmpty()) {
                Text(strings.noAsrDiagnostics, style = MaterialTheme.typography.bodySmall)
            } else {
                providers.forEach { provider ->
                    val readyText = if (provider.available) strings.ready else strings.unavailable
                    val activeText = if (provider.active) strings.activeSuffix else ""
                    val diag = provider.diagnostics.orEmpty()
                    Text(
                        "${provider.label.ifBlank { provider.id }}: $readyText$activeText",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    val detail = listOfNotNull(
                        diag["mode"]?.toString()?.takeIf { it.isNotBlank() },
                        diag["modelPath"]?.toString()?.takeIf { it.isNotBlank() }?.substringAfterLast('\\')?.substringAfterLast('/'),
                    ).joinToString(" · ")
                    if (detail.isNotBlank()) {
                        Text(detail, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = onRecover, enabled = recoverEnabled) {
                    Text(strings.recover)
                }
                Text(
                    strings.checkpoints(checkpoints.size),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (status.isNotBlank()) {
                Text(status, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            checkpoints.take(3).forEach { checkpoint ->
                Text(
                    "${checkpoint.channel}: ${formatBytes(checkpoint.bytes)} · ${checkpoint.provider.ifBlank { strings.providerPending }} · ${strings.segments(checkpoint.segmentCount)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun RecordingFilesCard(context: android.content.Context) {
    var recordings by remember { mutableStateOf(loadRecordingFiles(context)) }
    var message by remember { mutableStateOf("") }
    val strings = LocalAppStrings.current

    Card(shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(strings.recordings, style = MaterialTheme.typography.labelMedium)
                    Text(
                        strings.localPcmFiles(recordings.size),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                OutlinedButton(onClick = {
                    recordings = loadRecordingFiles(context)
                    message = strings.recordingListRefreshed
                }) {
                    Icon(Icons.Default.Refresh, contentDescription = null)
                    Text(strings.refresh)
                }
            }

            if (message.isNotBlank()) {
                Text(
                    message,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (recordings.isEmpty()) {
                Text(
                    strings.noRecordings,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                recordings.take(6).forEach { file ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                file.name,
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                "${formatBytes(file.length())} - ${formatModified(file.lastModified())}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        OutlinedButton(onClick = {
                            message = if (file.delete()) {
                                strings.deleted(file.name)
                            } else {
                                strings.couldNotDelete(file.name)
                            }
                            recordings = loadRecordingFiles(context)
                        }) {
                            Text(strings.delete)
                        }
                    }
                }
                if (recordings.size > 6) {
                    Text(
                        strings.showingLatestRecordings(recordings.size),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

private fun loadRecordingFiles(context: android.content.Context): List<File> {
    val directory = context.getExternalFilesDir("live-call-recordings") ?: return emptyList()
    return directory
        .listFiles { file -> file.isFile && file.extension.equals("pcm", ignoreCase = true) }
        ?.sortedByDescending { it.lastModified() }
        .orEmpty()
}

private fun formatBytes(bytes: Long): String {
    val kb = bytes / 1024.0
    return if (kb < 1024) "%.1f KB".format(kb) else "%.1f MB".format(kb / 1024.0)
}

private fun formatModified(timestamp: Long): String =
    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(timestamp))

@Composable
private fun StatusCard(state: CallUiState, workspaceId: String) {
    val strings = LocalAppStrings.current
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(state.statusText, style = MaterialTheme.typography.bodyMedium)
            if (state.sessionId.isNotBlank()) {
                Text(
                    text = strings.sessionId(state.sessionId),
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (state.audioStatus.isNotBlank()) {
                Text(state.audioStatus, style = MaterialTheme.typography.bodySmall)
            }
            if (workspaceId.isNotBlank()) {
                Text(strings.workspaceBound, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun ControlCard(
    state: CallUiState,
    onCreate: () -> Unit,
    onStopSession: () -> Unit,
    onPauseSession: () -> Unit,
    onResumeSession: () -> Unit,
    onStartMic: () -> Unit,
    onStopMic: () -> Unit,
) {
    val strings = LocalAppStrings.current
    Card(shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(onClick = onCreate, enabled = !state.loading, modifier = Modifier.weight(1f)) {
                    if (state.loading) CircularProgressIndicator(strokeWidth = 2.dp) else Icon(Icons.Default.PlayArrow, contentDescription = null)
                    Text(strings.create)
                }
                OutlinedButton(onClick = onStopSession, enabled = state.sessionActive, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Default.Stop, contentDescription = null)
                    Text(strings.stop)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(onClick = onPauseSession, enabled = state.sessionActive, modifier = Modifier.weight(1f)) {
                    Text(strings.pause)
                }
                OutlinedButton(onClick = onResumeSession, enabled = state.sessionActive, modifier = Modifier.weight(1f)) {
                    Text(strings.resume)
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(onClick = onStartMic, enabled = state.sessionActive && !state.audioRunning, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Default.Mic, contentDescription = null)
                    Text(strings.startMic)
                }
                OutlinedButton(
                    onClick = onStopMic,
                    enabled = state.audioRunning,
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(Icons.Default.MicOff, contentDescription = null)
                    Text(strings.stopMic)
                }
            }
        }
    }
}

@Composable
private fun ErrorCard(message: String) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Text(
            text = message,
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
