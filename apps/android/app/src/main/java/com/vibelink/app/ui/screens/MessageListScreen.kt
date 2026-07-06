package com.vibelink.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ChatMessage
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.ToolCallSummary
import com.vibelink.app.ui.components.ToolCallCardList

/**
 * Message list screen (chat detail).
 * Shows messages from a history or a running task, including tool cards.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageListScreen(
    apiClient: ApiClient,
    viewModel: MessageListViewModel,
    conversation: ConversationItem?,
    onBack: () -> Unit,
) {
    val messages by viewModel.messages.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val error by viewModel.error.collectAsState()
    val title by viewModel.title.collectAsState()
    val running by viewModel.running.collectAsState()

    val listState = rememberLazyListState()

    // Auto-scroll when new messages arrive
    val messageCount = messages.size
    LaunchedEffect(messageCount) {
        if (messageCount > 0 && listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index in messageCount - 3..messageCount) {
            listState.animateScrollToItem(messageCount - 1)
        }
    }

    // Load conversation when item changes
    LaunchedEffect(conversation) {
        if (conversation != null) {
            viewModel.loadConversation(apiClient, conversation)
            if (conversation.kind == "task") {
                viewModel.followToolEvents(apiClient, conversation.id)
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = title,
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                        )
                        if (running) {
                            Text(
                                text = "running",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.secondary,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
        bottomBar = {
            if (conversation != null && conversation.kind == "history") {
                Surface(
                    tonalElevation = 3.dp,
                ) {
                    Button(
                        onClick = {
                            // Future: start new task with this session as context
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                    ) {
                        Text("继续此会话")
                    }
                }
            }
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when {
                loading && messages.isEmpty() -> {
                    Column(
                        modifier = Modifier.align(Alignment.Center),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        CircularProgressIndicator()
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "加载中…",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                error.isNotBlank() && messages.isEmpty() -> {
                    Text(
                        text = error,
                        modifier = Modifier
                            .align(Alignment.Center)
                            .padding(24.dp),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                messages.isEmpty() -> {
                    Text(
                        text = "没有消息",
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                else -> {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(
                            items = messages,
                            key = { "${it.role}:${it.text.hashCode()}:${it.toolCalls.size}" },
                        ) { message ->
                            MessageBubble(message = message)
                        }

                        // Loading indicator at bottom
                        if (running) {
                            item {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 12.dp),
                                    horizontalArrangement = Arrangement.Center,
                                ) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(16.dp),
                                        strokeWidth = 2.dp,
                                    )
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        "running…",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
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

/**
 * A single message bubble, similar to the Web Message component.
 */
@Composable
private fun MessageBubble(
    message: ChatMessage,
    modifier: Modifier = Modifier,
) {
    val isUser = message.role == "user"
    val isAssistant = message.role == "assistant"
    val isSystem = message.role == "system"
    val isError = message.role == "error"

    val roleLabel = when (message.role) {
        "user" -> "You"
        "assistant" -> "Agent"
        "error" -> "Error"
        "system" -> "System"
        else -> message.role
    }

    val containerColor = when {
        isError -> MaterialTheme.colorScheme.errorContainer
        isSystem -> MaterialTheme.colorScheme.surfaceVariant
        isUser -> MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.15f)
        isAssistant -> MaterialTheme.colorScheme.surface
        else -> MaterialTheme.colorScheme.surface
    }

    val displayText = message.text.trim()

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(
            topStart = 14.dp,
            topEnd = 14.dp,
            bottomStart = if (isUser) 14.dp else 4.dp,
            bottomEnd = if (isUser) 4.dp else 14.dp,
        ),
        colors = CardDefaults.cardColors(containerColor = containerColor),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
        ) {
            // Role label
            Text(
                text = roleLabel,
                style = MaterialTheme.typography.labelSmall,
                color = when {
                    isError -> MaterialTheme.colorScheme.error
                    isSystem -> MaterialTheme.colorScheme.onSurfaceVariant
                    else -> MaterialTheme.colorScheme.primary
                },
            )

            if (displayText.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = displayText,
                    style = MaterialTheme.typography.bodyMedium,
                    lineHeight = 20.sp,
                )
            }

            // Tool calls
            if (message.toolCalls.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                ToolCallCardList(
                    toolCalls = message.toolCalls,
                    toolCallCount = message.toolCallCount,
                )
            }
        }
    }
}
