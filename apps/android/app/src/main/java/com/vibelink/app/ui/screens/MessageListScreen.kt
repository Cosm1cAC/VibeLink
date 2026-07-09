package com.vibelink.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.method.LinkMovementMethod
import android.widget.TextView
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ChatMessage
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.ProviderDefinition
import com.vibelink.app.network.ProviderRegistryResponse
import com.vibelink.app.ui.components.ToolCallCardList
import io.noties.markwon.Markwon
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageListScreen(
    apiClient: ApiClient,
    viewModel: MessageListViewModel,
    conversation: ConversationItem?,
    onBack: () -> Unit,
    onOpenApprovals: () -> Unit = {},
    onOpenLiveCall: () -> Unit = {},
    promptHistory: List<String> = emptyList(),
    onRememberPrompt: (String) -> Unit = {},
    onClearPromptHistory: () -> Unit = {},
) {
    val messages by viewModel.messages.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val error by viewModel.error.collectAsState()
    val title by viewModel.title.collectAsState()
    val running by viewModel.running.collectAsState()
    val sending by viewModel.sending.collectAsState()
    val currentTaskId by viewModel.currentTaskId.collectAsState()
    val remoteStatus by viewModel.remoteStatus.collectAsState()
    val providerRegistry by viewModel.providerRegistry.collectAsState()
    val pendingApproval by viewModel.pendingApproval.collectAsState()

    var prompt by remember(conversation?.key) {
        mutableStateOf(if (conversation?.key?.startsWith("share:") == true) conversation.preview else "")
    }
    var activeAgent by remember(conversation?.key) { mutableStateOf(conversation?.provider?.takeIf { it.isNotBlank() } ?: "codex") }
    var model by remember(conversation?.key) { mutableStateOf("") }
    var reasoningEffort by remember(conversation?.key) { mutableStateOf("") }
    var cwd by remember(conversation?.key) { mutableStateOf(conversation?.cwd.orEmpty()) }
    var showOptions by remember { mutableStateOf(false) }

    val listState = rememberLazyListState()
    val isDesktopRemote = conversation?.kind == "desktop"
    val selectableProviders = remember(providerRegistry) { providersForComposer(providerRegistry) }
    val canSend = prompt.trim().isNotBlank() && !sending && conversation != null

    LaunchedEffect(conversation?.key) {
        if (conversation != null) viewModel.loadConversation(apiClient, conversation)
    }

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.lastIndex)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(title.ifBlank { "Chat" }, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                        val subtitle = when {
                            isDesktopRemote && remoteStatus.isNotBlank() -> remoteStatus
                            running && currentTaskId.isNotBlank() -> "running · ${currentTaskId.take(8)}"
                            running -> "running"
                            conversation?.kind == "new" -> "VibeLink Agent"
                            else -> conversation?.provider.orEmpty()
                        }
                        if (subtitle.isNotBlank()) {
                            Text(
                                subtitle,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.refresh(apiClient) }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    if (isDesktopRemote) {
                        IconButton(onClick = { viewModel.retryDesktop(apiClient) }) {
                            Icon(Icons.Default.Replay, contentDescription = "Retry remote queue")
                        }
                        IconButton(onClick = { viewModel.clearDesktopQueue(apiClient) }) {
                            Icon(Icons.Default.Clear, contentDescription = "Clear remote queue")
                        }
                    }
                    if (running) {
                        IconButton(onClick = { viewModel.stopCurrentTask(apiClient) }) {
                            Icon(Icons.Default.Stop, contentDescription = "Stop task")
                        }
                    }
                },
            )
        },
        bottomBar = {
            if (conversation != null) {
                ComposerBar(
                    isDesktopRemote = isDesktopRemote,
                    prompt = prompt,
                    onPromptChange = { prompt = it },
                    activeAgent = activeAgent,
                    onAgentChange = { activeAgent = it },
                    model = model,
                    onModelChange = { model = it },
                    reasoningEffort = reasoningEffort,
                    onReasoningEffortChange = { reasoningEffort = it },
                    cwd = cwd,
                    onCwdChange = { cwd = it },
                    showOptions = showOptions,
                    providerRegistry = providerRegistry,
                    providers = selectableProviders,
                    onToggleOptions = { showOptions = !showOptions },
                    onOpenLiveCall = onOpenLiveCall,
                    promptHistory = promptHistory,
                    onUseHistoryPrompt = { prompt = it },
                    onClearPromptHistory = onClearPromptHistory,
                    running = running,
                    sending = sending,
                    canSend = canSend,
                    onSend = {
                        val text = prompt
                        onRememberPrompt(text)
                        prompt = ""
                        viewModel.sendPrompt(
                            apiClient = apiClient,
                            prompt = text,
                            agent = activeAgent,
                            model = model,
                            reasoningEffort = reasoningEffort,
                            cwd = cwd,
                        )
                    },
                    onStop = { viewModel.stopCurrentTask(apiClient) },
                )
            }
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            when {
                loading && messages.isEmpty() -> {
                    Column(
                        modifier = Modifier.align(Alignment.Center),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        CircularProgressIndicator()
                        Spacer(Modifier.height(8.dp))
                        Text("Loading", style = MaterialTheme.typography.bodySmall)
                    }
                }
                messages.isEmpty() -> {
                    ChatEmptyState(
                        conversation = conversation,
                        onUseSuggestion = { prompt = it },
                        modifier = Modifier.align(Alignment.Center),
                    )
                }
                else -> {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        pendingApproval?.let { approval ->
                            item {
                                ApprovalRequiredCard(
                                    approval = approval,
                                    onOpenApprovals = onOpenApprovals,
                                    onRetry = { viewModel.retryPendingApproval(apiClient) },
                                )
                            }
                        }
                        if (error.isNotBlank() && pendingApproval == null) {
                            item {
                                ErrorBanner(error, onOpenApprovals = onOpenApprovals)
                            }
                        }
                        itemsIndexed(messages, key = { index, message -> "$index:${message.role}:${message.text.hashCode()}:${message.toolCalls.size}" }) { _, message ->
                            MessageBubble(message = message, compact = isDesktopRemote)
                        }
                        if (running) {
                            item {
                                StreamingPlaceholderBubble()
                            }
                        }
                    }
                }
            }

            if (sending) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth().align(Alignment.TopCenter))
            }
        }
    }
}

@Composable
private fun ComposerBar(
    isDesktopRemote: Boolean,
    prompt: String,
    onPromptChange: (String) -> Unit,
    activeAgent: String,
    onAgentChange: (String) -> Unit,
    model: String,
    onModelChange: (String) -> Unit,
    reasoningEffort: String,
    onReasoningEffortChange: (String) -> Unit,
    cwd: String,
    onCwdChange: (String) -> Unit,
    showOptions: Boolean,
    providerRegistry: ProviderRegistryResponse,
    providers: List<ProviderDefinition>,
    onToggleOptions: () -> Unit,
    onOpenLiveCall: () -> Unit,
    promptHistory: List<String>,
    onUseHistoryPrompt: (String) -> Unit,
    onClearPromptHistory: () -> Unit,
    running: Boolean,
    sending: Boolean,
    canSend: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    Surface(tonalElevation = 3.dp) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!isDesktopRemote) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(providers, key = { it.id }) { option ->
                        FilterChip(
                            selected = activeAgent == option.id,
                            onClick = { onAgentChange(option.id) },
                            enabled = option.available,
                            label = { Text(option.label.ifBlank { option.id }) },
                        )
                    }
                }
            } else {
                AssistChip(onClick = {}, label = { Text("Codex Remote uses the current Codex Desktop settings") })
            }

            if (!isDesktopRemote) {
                Text("Quick commands", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(PromptCommandCatalog.commands, key = { it.id }) { command ->
                        AssistChip(
                            onClick = { onPromptChange(PromptCommandCatalog.applyCommand(prompt, command)) },
                            label = { Text(command.label) },
                        )
                    }
                }
            }

            if (!isDesktopRemote && promptHistory.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Recent prompts", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = onClearPromptHistory) { Text("Clear") }
                }
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(promptHistory.take(6), key = { it }) { item ->
                        AssistChip(
                            onClick = { onUseHistoryPrompt(item) },
                            label = { Text(item, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        )
                    }
                }
            }

            if (showOptions && !isDesktopRemote) {
                val provider = providerRegistry.providers.firstOrNull { it.id == activeAgent }
                val models = provider?.models.orEmpty()
                val efforts = provider?.reasoningEfforts.orEmpty().ifEmpty { listOf("", "low", "medium", "high", "xhigh") }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (provider?.capabilities?.modelOverride == false) {
                        AssistChip(onClick = {}, label = { Text("Model: ${models.firstOrNull()?.label ?: "provider default"}") })
                    } else {
                        if (models.isNotEmpty()) {
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(models, key = { it.id.ifBlank { "default" } }) { option ->
                                    FilterChip(
                                        selected = model == option.id || (model.isBlank() && option.default),
                                        onClick = { onModelChange(option.id) },
                                        label = { Text(option.label.ifBlank { option.id.ifBlank { "Default" } }) },
                                    )
                                }
                            }
                        }
                        OutlinedTextField(
                            value = model,
                            onValueChange = onModelChange,
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("Model override") },
                            singleLine = true,
                        )
                    }
                    if (provider?.capabilities?.reasoningEffort != false) {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(efforts, key = { it.ifBlank { "default" } }) { effort ->
                                FilterChip(
                                    selected = reasoningEffort == effort || (reasoningEffort.isBlank() && effort.isBlank()),
                                    onClick = { onReasoningEffortChange(effort) },
                                    label = { Text(effort.ifBlank { "Default effort" }) },
                                )
                            }
                        }
                    }
                    OutlinedTextField(
                        value = cwd,
                        onValueChange = onCwdChange,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Working directory") },
                        singleLine = true,
                    )
                }
            }

            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = prompt,
                    onValueChange = onPromptChange,
                    modifier = Modifier.weight(1f).heightIn(min = 56.dp, max = 140.dp),
                    placeholder = { Text(if (isDesktopRemote) "Send to Codex Desktop" else "Message VibeLink Agent") },
                    minLines = 1,
                    maxLines = 5,
                )
                IconButton(onClick = onToggleOptions, enabled = !isDesktopRemote) {
                    Icon(Icons.Default.Tune, contentDescription = "Composer options")
                }
                IconButton(onClick = onOpenLiveCall, enabled = !isDesktopRemote) {
                    Icon(Icons.Default.Mic, contentDescription = "Open Live Call")
                }
                Button(onClick = onSend, enabled = canSend) {
                    if (sending) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Default.Send, contentDescription = null)
                    }
                }
            }

            if (running && !isDesktopRemote) {
                OutlinedButton(onClick = onStop, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Default.Stop, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Stop current task")
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(
    message: ChatMessage,
    compact: Boolean,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var expanded by remember(message.role, message.text, message.toolCalls.size) { mutableStateOf(true) }
    val isUser = message.role == "user"
    val isSystem = message.role == "system"
    val isError = message.role == "error"
    val containerColor = when {
        isError -> MaterialTheme.colorScheme.errorContainer
        isSystem -> MaterialTheme.colorScheme.surfaceVariant
        isUser -> MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.18f)
        else -> MaterialTheme.colorScheme.surface
    }
    val roleLabel = when (message.role) {
        "user" -> "You"
        "assistant" -> "Agent"
        "error" -> "Error"
        "system" -> "System"
        else -> message.role
    }

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(if (compact) 8.dp else 10.dp),
        colors = CardDefaults.cardColors(containerColor = containerColor),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
            if (!compact || isError || isSystem || message.text.isNotBlank()) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = roleLabel,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row {
                        if (message.text.isNotBlank()) {
                            IconButton(
                                onClick = { copyMessage(context, message.text) },
                                modifier = Modifier.size(40.dp),
                            ) {
                                Icon(Icons.Default.ContentCopy, contentDescription = "Copy message", modifier = Modifier.size(18.dp))
                            }
                        }
                        IconButton(
                            onClick = { expanded = !expanded },
                            modifier = Modifier.size(40.dp),
                        ) {
                            Icon(
                                if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                                contentDescription = if (expanded) "Collapse message" else "Expand message",
                            )
                        }
                    }
                }
            }
            val displayText = message.text.trim()
            if (expanded) {
                if (displayText.isNotBlank()) {
                    if (!compact || isError || isSystem) Spacer(Modifier.height(4.dp))
                    if (compact || isError) {
                        Text(
                            text = displayText,
                            style = MaterialTheme.typography.bodyMedium,
                            lineHeight = 20.sp,
                        )
                    } else {
                        MarkdownText(text = displayText)
                    }
                }
                if (message.toolCalls.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    ToolCallCardList(toolCalls = message.toolCalls, toolCallCount = message.toolCallCount)
                }
            }
        }
    }
}

@Composable
private fun MarkdownText(text: String) {
    val context = LocalContext.current
    val textColor = MaterialTheme.colorScheme.onSurface.toArgb()
    val markwon = remember(context) {
        Markwon.builder(context)
            .usePlugin(StrikethroughPlugin.create())
            .build()
    }
    AndroidView(
        modifier = Modifier.fillMaxWidth(),
        factory = { viewContext ->
            TextView(viewContext).apply {
                setTextColor(textColor)
                textSize = 14f
                setLineSpacing(2f, 1f)
                movementMethod = LinkMovementMethod.getInstance()
            }
        },
        update = { view ->
            view.setTextColor(textColor)
            markwon.setMarkdown(view, text)
        },
    )
}

@Composable
private fun StreamingPlaceholderBubble() {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            Text("Agent is typing", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ChatEmptyState(
    conversation: ConversationItem?,
    onUseSuggestion: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = if (conversation == null) "Restoring chat" else "Start with context",
            style = MaterialTheme.typography.titleSmall,
        )
        if (conversation != null) {
            val suggestions = listOf(
                "Summarize the current workspace status",
                "Review the latest changes and risks",
                "Plan the next safe implementation step",
            )
            suggestions.forEach { suggestion ->
                AssistChip(onClick = { onUseSuggestion(suggestion) }, label = { Text(suggestion) })
            }
        }
    }
}

private fun copyMessage(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("VibeLink message", text))
    Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
}

@Composable
private fun ApprovalRequiredCard(
    approval: PendingApprovalState,
    onOpenApprovals: () -> Unit,
    onRetry: () -> Unit,
) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = approval.message,
                color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.bodySmall,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onOpenApprovals, modifier = Modifier.weight(1f)) {
                    Text("Open approvals")
                }
                OutlinedButton(onClick = onRetry, modifier = Modifier.weight(1f), enabled = approval.retry != null) {
                    Text("Retry")
                }
            }
        }
    }
}

@Composable
private fun ErrorBanner(message: String, onOpenApprovals: () -> Unit) {
    val approvalRequired = message.contains("Approval required", ignoreCase = true)
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = message,
                color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.bodySmall,
            )
            if (approvalRequired) {
                OutlinedButton(onClick = onOpenApprovals, modifier = Modifier.fillMaxWidth()) {
                    Text("Open approvals")
                }
            }
        }
    }
}

private fun providersForComposer(registry: ProviderRegistryResponse): List<ProviderDefinition> {
    return registry.providers.ifEmpty {
        listOf(
            ProviderDefinition(id = "codex", label = "Codex", available = true),
            ProviderDefinition(id = "claude", label = "Claude", available = true),
            ProviderDefinition(id = "doubao", label = "Doubao", available = true),
            ProviderDefinition(id = "zhipu", label = "GLM", available = true),
        )
    }
}
