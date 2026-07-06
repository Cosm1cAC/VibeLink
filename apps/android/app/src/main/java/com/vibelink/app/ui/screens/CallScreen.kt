package com.vibelink.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.LiveCallEvent
import com.vibelink.app.ui.components.LevelIndicator
import com.vibelink.app.ui.components.QaCard
import com.vibelink.app.ui.components.TranscriptFeed
import kotlinx.coroutines.launch

data class QaPair(
    val question: String = "",
    val answer: String = "",
    val agentState: String = "idle" // idle | thinking | streaming | done
)

/**
 * Live Call screen: create/stop session, view transcript, levels, Q&A.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallScreen(
    apiClient: ApiClient,
    onLogout: () -> Unit
) {
    var sessionId by remember { mutableStateOf("") }
    var sessionActive by remember { mutableStateOf(false) }
    var events by remember { mutableStateOf<List<LiveCallEvent>>(emptyList()) }
    var qaPairs by remember { mutableStateOf<List<QaPair>>(emptyList()) }
    var remoteLevel by remember { mutableStateOf(0.0) }
    var localLevel by remember { mutableStateOf(0.0) }
    var statusText by remember { mutableStateOf("") }
    var errorText by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // Mock question input
    var questionInput by remember { mutableStateOf("请介绍一下你自己") }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Live Call") },
                actions = {
                    TextButton(onClick = onLogout) { Text("断开") }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            // Status
            if (sessionActive) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer
                    )
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(10.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text("通话中 ($sessionId)", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }

            // Controls
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        scope.launch {
                            loading = true; errorText = ""
                            try {
                                val s = apiClient.createSession()
                                if (s != null) {
                                    sessionId = s.id; sessionActive = true
                                    events = emptyList(); qaPairs = emptyList()
                                    statusText = "Session ${s.id.take(8)}…"
                                }
                            } catch (e: Exception) {
                                errorText = "创建失败: ${e.message}"
                            } finally { loading = false }
                        }
                    },
                    enabled = !sessionActive && !loading
                ) { Text("创建通话") }

                Button(
                    onClick = {
                        scope.launch {
                            try {
                                apiClient.stopSession(sessionId)
                                sessionActive = false
                                statusText = "已停止"
                            } catch (e: Exception) {
                                errorText = "停止失败: ${e.message}"
                            }
                        }
                    },
                    enabled = sessionActive,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error
                    )
                ) { Text("停止通话") }
            }

            if (errorText.isNotBlank()) {
                Text(errorText, color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall)
            }

            // Level meters
            if (sessionActive) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("音频电平", style = MaterialTheme.typography.labelMedium)
                        LevelIndicator("远程", remoteLevel)
                        LevelIndicator("本地", localLevel)
                    }
                }
            }

            // Send mock question
            if (sessionActive) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("模拟问题", style = MaterialTheme.typography.labelMedium)
                        OutlinedTextField(
                            value = questionInput,
                            onValueChange = { questionInput = it },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                        )
                        Button(onClick = {
                            scope.launch {
                                try {
                                    apiClient.sendTranscript(sessionId, questionInput, true)
                                    statusText = "问题已发送"
                                } catch (e: Exception) {
                                    errorText = "发送失败: ${e.message}"
                                }
                            }
                        }) { Text("发送问题") }
                    }
                }
            }

            // Transcript feed
            TranscriptFeed(events)

            // Q&A cards
            qaPairs.forEach { pair ->
                QaCard(pair.question, pair.answer, pair.agentState)
            }
        }
    }
}
