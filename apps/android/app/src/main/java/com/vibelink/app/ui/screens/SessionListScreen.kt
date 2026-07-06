package com.vibelink.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material3.*
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ConversationItem
import kotlinx.coroutines.launch

/**
 * Session (conversation) list screen.
 * Shows merged histories + tasks as a scrollable list.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(
    apiClient: ApiClient,
    viewModel: SessionListViewModel,
    onSelectConversation: (ConversationItem) -> Unit,
    onLogout: () -> Unit,
    onOpenLiveCall: () -> Unit,
) {
    val conversations by viewModel.conversations.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val refreshing by viewModel.refreshing.collectAsState()
    val error by viewModel.error.collectAsState()
    val scope = rememberCoroutineScope()

    // Initial load
    LaunchedEffect(Unit) {
        viewModel.load(apiClient)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("会话") },
                actions = {
                    IconButton(onClick = { viewModel.load(apiClient, isRefresh = true) }) {
                        if (refreshing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(Icons.Default.Refresh, contentDescription = "刷新")
                        }
                    }
                    IconButton(onClick = onOpenLiveCall) {
                        Icon(Icons.Default.Chat, contentDescription = "Live Call")
                    }
                    IconButton(onClick = onLogout) {
                        Icon(Icons.Default.MoreVert, contentDescription = "断开")
                    }
                }
            )
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when {
                loading && conversations.isEmpty() -> {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                }
                error.isNotBlank() && conversations.isEmpty() -> {
                    Column(
                        modifier = Modifier
                            .align(Alignment.Center)
                            .padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            text = error,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(12.dp))
                        OutlinedButton(onClick = { viewModel.load(apiClient) }) {
                            Text("重试")
                        }
                    }
                }
                conversations.isEmpty() -> {
                    Text(
                        text = "暂无会话",
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                else -> {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        items(
                            items = conversations,
                            key = { it.key },
                        ) { item ->
                            ConversationCard(
                                item = item,
                                onClick = { onSelectConversation(item) },
                            )
                        }
                    }
                }
            }

            // Pull-to-refresh indicator at top
            if (refreshing && conversations.isNotEmpty()) {
                LinearProgressIndicator(
                    modifier = Modifier
                        .fillMaxWidth()
                        .align(Alignment.TopCenter),
                )
            }
        }
    }
}

@Composable
private fun ConversationCard(
    item: ConversationItem,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val isRunning = item.status == "running"
    val statusColor = when (item.status) {
        "running" -> MaterialTheme.colorScheme.secondary
        "failed", "error" -> MaterialTheme.colorScheme.error
        "history" -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.primary
    }
    val statusDot = when (item.status) {
        "running" -> "●"
        "completed" -> "✓"
        "failed", "error" -> "✗"
        "history" -> "○"
        else -> ""
    }
    val providerLabel = when (item.provider) {
        "codex" -> "OpenAI"
        "claude" -> "Anthropic"
        "zhipu" -> "Zhipu"
        else -> item.provider
    }
    val timeAgo = formatTimeAgo(item.updatedAt)

    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isRunning)
                MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.08f)
            else
                MaterialTheme.colorScheme.surface,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Title
                Text(
                    text = item.title,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )

                // Status dot
                Text(
                    text = statusDot,
                    color = statusColor,
                    style = MaterialTheme.typography.labelMedium,
                    fontFamily = FontFamily.Monospace,
                )
            }

            Spacer(Modifier.height(4.dp))

            // Preview / cwd
            if (item.preview.isNotBlank()) {
                Text(
                    text = item.preview,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            } else if (item.cwd.isNotBlank()) {
                Text(
                    text = item.cwd,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(4.dp))

            // Meta row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = providerLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (timeAgo.isNotBlank()) {
                    Text(
                        text = timeAgo,
                        style = MaterialTheme.typography.labelSmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/**
 * Format ISO timestamp to relative time string.
 */
private fun formatTimeAgo(iso: String?): String {
    if (iso.isNullOrBlank()) return ""
    val instant = try {
        java.time.Instant.parse(iso)
    } catch (_: Exception) { return "" }
    val now = java.time.Instant.now()
    val diff = java.time.Duration.between(instant, now)
    return when {
        diff.isNegative -> "just now"
        diff.toMinutes() < 1 -> "just now"
        diff.toMinutes() < 60 -> "${diff.toMinutes()}m"
        diff.toHours() < 24 -> "${diff.toHours()}h"
        diff.toDays() < 7 -> "${diff.toDays()}d"
        else -> "${diff.toDays() / 7}w"
    }
}
