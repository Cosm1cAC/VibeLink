package com.vibelink.app.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.ApiClient
import com.vibelink.app.ui.components.LevelIndicator
import com.vibelink.app.ui.components.QaCard
import com.vibelink.app.ui.components.TranscriptFeed

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
    var questionInput by remember { mutableStateOf("Please introduce yourself and your strongest recent project.") }
    var permissionMessage by remember { mutableStateOf("") }

    val micPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            permissionMessage = ""
            viewModel.startAudio(context, apiClient)
        } else {
            permissionMessage = "Microphone permission was denied."
        }
    }

    DisposableEffect(Unit) {
        onDispose { viewModel.stopAudio() }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Live Call") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            StatusCard(state = state, workspaceId = workspaceId)

            ControlCard(
                state = state,
                onCreate = { viewModel.createSession(apiClient, workspaceId) },
                onStopSession = { viewModel.stopSession(apiClient) },
                onStartMic = {
                    val granted = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                    if (granted) viewModel.startAudio(context, apiClient)
                    else micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                },
                onStopMic = { viewModel.stopAudio() },
            )

            if (state.errorText.isNotBlank() || permissionMessage.isNotBlank()) {
                Text(
                    text = state.errorText.ifBlank { permissionMessage },
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            if (state.sessionActive) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Audio levels", style = MaterialTheme.typography.labelMedium)
                        LevelIndicator("Mic", state.remoteLevel)
                        LevelIndicator("Local", state.localLevel)
                    }
                }

                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Manual transcript", style = MaterialTheme.typography.labelMedium)
                        OutlinedTextField(
                            value = questionInput,
                            onValueChange = { questionInput = it },
                            modifier = Modifier.fillMaxWidth(),
                            minLines = 2,
                            maxLines = 4,
                        )
                        Button(
                            onClick = { viewModel.sendMockQuestion(apiClient, questionInput) },
                            enabled = questionInput.isNotBlank(),
                        ) { Text("Send transcript") }
                    }
                }
            }

            TranscriptFeed(state.events)

            state.qaPairs.forEach { pair ->
                QaCard(pair.question, pair.answer, pair.agentState)
            }
        }
    }
}

@Composable
private fun StatusCard(state: CallUiState, workspaceId: String) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(state.statusText, style = MaterialTheme.typography.bodyMedium)
            if (state.sessionId.isNotBlank()) {
                Text(
                    text = "Session ${state.sessionId}",
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (state.audioStatus.isNotBlank()) {
                Text(state.audioStatus, style = MaterialTheme.typography.bodySmall)
            }
            if (workspaceId.isNotBlank()) {
                Text("Workspace bound", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun ControlCard(
    state: CallUiState,
    onCreate: () -> Unit,
    onStopSession: () -> Unit,
    onStartMic: () -> Unit,
    onStopMic: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(onClick = onCreate, enabled = !state.sessionActive && !state.loading, modifier = Modifier.weight(1f)) {
                    if (state.loading) CircularProgressIndicator(strokeWidth = 2.dp) else Icon(Icons.Default.PlayArrow, contentDescription = null)
                    Text("Create")
                }
                OutlinedButton(onClick = onStopSession, enabled = state.sessionActive, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Default.Stop, contentDescription = null)
                    Text("Stop")
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(onClick = onStartMic, enabled = state.sessionActive && !state.audioRunning, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Default.Mic, contentDescription = null)
                    Text("Start mic")
                }
                OutlinedButton(
                    onClick = onStopMic,
                    enabled = state.audioRunning,
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) {
                    Icon(Icons.Default.MicOff, contentDescription = null)
                    Text("Stop mic")
                }
            }
        }
    }
}
