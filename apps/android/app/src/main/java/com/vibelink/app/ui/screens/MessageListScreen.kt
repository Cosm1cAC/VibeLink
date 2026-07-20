package com.vibelink.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.text.method.LinkMovementMethod
import android.widget.TextView
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.AttachmentUploadResponse
import com.vibelink.app.network.ChatMessage
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.ProviderDefinition
import com.vibelink.app.network.ProviderRegistryResponse
import com.vibelink.app.ui.components.ToolCallCardList
import com.vibelink.app.ui.i18n.LocalAppStrings
import coil.compose.AsyncImage
import io.noties.markwon.Markwon
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

object ComposerLayoutPolicy {
    fun showSupplementalContent(imeVisible: Boolean): Boolean = !imeVisible
}

object MessageListScrollTarget {
    fun findMessageIndex(messages: List<ChatMessage>, targetTurnId: String): Int? {
        val target = targetTurnId.trim()
        if (target.isBlank()) return null
        return messages.indexOfFirst { it.turnId == target }
            .takeIf { it >= 0 }
            ?: messages.indexOfFirst { it.id == target }.takeIf { it >= 0 }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageListScreen(
    apiClient: ApiClient,
    viewModel: MessageListViewModel,
    conversation: ConversationItem?,
    onOpenDrawer: () -> Unit,
    onNewConversation: () -> Unit,
    onOpenApprovals: () -> Unit = {},
    onOpenLiveCall: () -> Unit = {},
    onOpenFileReference: (String) -> Unit = {},
    promptHistory: List<String> = emptyList(),
    onRememberPrompt: (String) -> Unit = {},
    onClearPromptHistory: () -> Unit = {},
    initialAttachmentUris: List<String> = emptyList(),
    onInitialAttachmentsConsumed: () -> Unit = {},
    workspaceId: String = "",
    targetTurnId: String = "",
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
    val taskChanges by viewModel.taskChanges.collectAsState()
    val strings = LocalAppStrings.current

    var prompt by remember(conversation?.key) {
        mutableStateOf(if (conversation?.key?.startsWith("share:") == true) conversation.preview else "")
    }
    var activeAgent by remember(conversation?.key) { mutableStateOf(conversation?.provider?.takeIf { it.isNotBlank() } ?: "codex") }
    var model by remember(conversation?.key) { mutableStateOf("") }
    var reasoningEffort by remember(conversation?.key) { mutableStateOf("") }
    var cwd by remember(conversation?.key) { mutableStateOf(conversation?.cwd.orEmpty()) }
    var showOptions by remember { mutableStateOf(false) }
    var attachmentStatus by remember(conversation?.key) { mutableStateOf("") }
    var attachmentUploading by remember(conversation?.key) { mutableStateOf(false) }
    var workspaceContext by remember(conversation?.key, workspaceId) { mutableStateOf("") }
    var runtimeMenuOpen by remember { mutableStateOf(false) }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var consumedTargetTurnId by remember(conversation?.key, targetTurnId) { mutableStateOf("") }
    val isDesktopRemote = conversation?.kind == "desktop"
    val selectableProviders = remember(providerRegistry) { providersForComposer(providerRegistry) }
    val canSend = prompt.trim().isNotBlank() && !sending && conversation != null
    suspend fun uploadAttachmentNow(uri: Uri) {
        attachmentUploading = true
        attachmentStatus = strings.uploadingAttachment
        try {
            val upload = uploadAttachmentUri(context, apiClient, uri)
            val attachmentText = MessageContentUtils.attachmentPromptText(
                name = upload.name,
                markdown = upload.markdown,
                preview = upload.preview,
            )
            prompt = listOf(prompt.trim(), attachmentText).filter { it.isNotBlank() }.joinToString("\n\n")
            attachmentStatus = strings.attached(upload.name.ifBlank { strings.file })
        } catch (error: Exception) {
            attachmentStatus = error.message ?: strings.attachmentUploadFailed
        } finally {
            attachmentUploading = false
        }
    }
    fun uploadAttachment(uri: Uri) {
        scope.launch { uploadAttachmentNow(uri) }
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) uploadAttachment(uri)
    }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) uploadAttachment(uri)
    }

    LaunchedEffect(conversation?.key) {
        if (conversation != null) viewModel.ensureConversationLoaded(apiClient, conversation)
    }

    LaunchedEffect(workspaceId) {
        if (workspaceId.isBlank()) return@LaunchedEffect
        workspaceContext = runCatching { apiClient.getWorkspaceContext(workspaceId).context }.getOrDefault("")
    }

    LaunchedEffect(workspaceContext, conversation?.key) {
        if (workspaceContext.isNotBlank() && prompt.isBlank()) prompt = workspaceContext
    }

    LaunchedEffect(conversation?.key, initialAttachmentUris) {
        if (conversation == null || initialAttachmentUris.isEmpty()) return@LaunchedEffect
        initialAttachmentUris.forEach { rawUri -> uploadAttachmentNow(Uri.parse(rawUri)) }
        onInitialAttachmentsConsumed()
    }

    LaunchedEffect(messages.size, targetTurnId) {
        if (messages.isEmpty()) return@LaunchedEffect
        val targetIndex = MessageListScrollTarget.findMessageIndex(messages, targetTurnId)
        if (targetIndex != null && consumedTargetTurnId != targetTurnId) {
            listState.animateScrollToItem(targetIndex)
            consumedTargetTurnId = targetTurnId
        } else if (targetTurnId.isBlank()) {
            listState.animateScrollToItem(messages.lastIndex)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(title.ifBlank { strings.chat }, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                        val subtitle = when {
                            isDesktopRemote && remoteStatus.isNotBlank() -> remoteStatus
                            running && currentTaskId.isNotBlank() -> "running · ${currentTaskId.take(8)}"
                            running -> strings.running
                            conversation?.kind == "new" -> strings.vibelinkAgent
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
                    IconButton(onClick = onOpenDrawer) {
                        Icon(Icons.Default.Menu, contentDescription = strings.text("打开导航", "Open navigation"))
                    }
                },
                actions = {
                    IconButton(onClick = onNewConversation) {
                        Icon(Icons.Default.Add, contentDescription = strings.newChat)
                    }
                    Box {
                        IconButton(onClick = { runtimeMenuOpen = true }) {
                            Icon(Icons.Default.MoreVert, contentDescription = strings.more)
                        }
                        DropdownMenu(expanded = runtimeMenuOpen, onDismissRequest = { runtimeMenuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text(strings.refresh) },
                                leadingIcon = { Icon(Icons.Default.Refresh, contentDescription = null) },
                                onClick = { runtimeMenuOpen = false; viewModel.refresh(apiClient) },
                            )
                            if (isDesktopRemote) {
                                DropdownMenuItem(
                                    text = { Text(strings.retryRemoteQueue) },
                                    leadingIcon = { Icon(Icons.Default.Replay, contentDescription = null) },
                                    onClick = { runtimeMenuOpen = false; viewModel.retryDesktop(apiClient) },
                                )
                                DropdownMenuItem(
                                    text = { Text(strings.clearRemoteQueue) },
                                    leadingIcon = { Icon(Icons.Default.Clear, contentDescription = null) },
                                    onClick = { runtimeMenuOpen = false; viewModel.clearDesktopQueue(apiClient) },
                                )
                            }
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
                    attachmentUploading = attachmentUploading,
                    attachmentStatus = attachmentStatus,
                    onPickImage = { imagePicker.launch("image/*") },
                    onPickFile = { filePicker.launch("*/*") },
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
                        Text(strings.loading, style = MaterialTheme.typography.bodySmall)
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
                                )
                            }
                        }
                        if (error.isNotBlank() && pendingApproval == null) {
                            item {
                                ErrorBanner(error, onOpenApprovals = onOpenApprovals)
                            }
                        }
                        taskChanges?.let { changes ->
                            if (changes.items.isNotEmpty() || changes.changes.isNotEmpty()) item {
                                TaskChangesCard(changes)
                            }
                        }
                        itemsIndexed(messages, key = { index, message -> "$index:${message.role}:${message.text.hashCode()}:${message.toolCalls.size}" }) { _, message ->
                            MessageBubble(
                                message = message,
                                apiBaseUrl = apiClient.baseUrl,
                                authToken = apiClient.token,
                                compact = isDesktopRemote,
                                onEdit = viewModel::editMessage,
                                onDelete = viewModel::deleteMessage,
                                onRegenerate = { target ->
                                    viewModel.regenerateMessage(
                                        apiClient = apiClient,
                                        target = target,
                                        agent = activeAgent,
                                        model = model,
                                        reasoningEffort = reasoningEffort,
                                        cwd = cwd,
                                    )
                                },
                                onOpenFileReference = onOpenFileReference,
                            )
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
    attachmentUploading: Boolean,
    attachmentStatus: String,
    onPickImage: () -> Unit,
    onPickFile: () -> Unit,
    running: Boolean,
    sending: Boolean,
    canSend: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    val strings = LocalAppStrings.current
    val density = LocalDensity.current
    val imeVisible = WindowInsets.ime.getBottom(density) > 0
    val showSupplementalContent = ComposerLayoutPolicy.showSupplementalContent(imeVisible)
    Surface(modifier = Modifier.imePadding(), tonalElevation = 3.dp) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (showSupplementalContent && !isDesktopRemote) {
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
            } else if (showSupplementalContent) {
                AssistChip(onClick = {}, label = { Text(strings.codexRemoteCurrentSettings) })
            }

            if (showSupplementalContent && !isDesktopRemote) {
                Text(strings.quickCommands, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(PromptCommandCatalog.commands, key = { it.id }) { command ->
                        AssistChip(
                            onClick = { onPromptChange(PromptCommandCatalog.applyCommand(prompt, command)) },
                            label = { Text(command.label) },
                        )
                    }
                }
            }

            if (showSupplementalContent && !isDesktopRemote && promptHistory.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(strings.recentPrompts, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = onClearPromptHistory) { Text(strings.clear) }
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

            if (showSupplementalContent && showOptions && !isDesktopRemote) {
                val provider = providerRegistry.providers.firstOrNull { it.id == activeAgent }
                val models = provider?.models.orEmpty()
                val efforts = provider?.reasoningEfforts.orEmpty().ifEmpty { listOf("", "low", "medium", "high", "xhigh") }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (provider?.capabilities?.modelOverride == false) {
                        AssistChip(onClick = {}, label = { Text(strings.model(models.firstOrNull()?.label ?: strings.providerDefault)) })
                    } else {
                        if (models.isNotEmpty()) {
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(models, key = { it.id.ifBlank { "default" } }) { option ->
                                    FilterChip(
                                        selected = model == option.id || (model.isBlank() && option.default),
                                        onClick = { onModelChange(option.id) },
                                        label = { Text(option.label.ifBlank { option.id.ifBlank { strings.defaultOption } }) },
                                    )
                                }
                            }
                        }
                        OutlinedTextField(
                            value = model,
                            onValueChange = onModelChange,
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text(strings.modelOverride) },
                            singleLine = true,
                        )
                    }
                    if (provider?.capabilities?.reasoningEffort != false) {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(efforts, key = { it.ifBlank { "default" } }) { effort ->
                                FilterChip(
                                    selected = reasoningEffort == effort || (reasoningEffort.isBlank() && effort.isBlank()),
                                    onClick = { onReasoningEffortChange(effort) },
                                    label = { Text(effort.ifBlank { strings.defaultEffort }) },
                                )
                            }
                        }
                    }
                    OutlinedTextField(
                        value = cwd,
                        onValueChange = onCwdChange,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(strings.workingDirectory) },
                        singleLine = true,
                    )
                }
            }

            if (showSupplementalContent && !isDesktopRemote) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onPickImage, enabled = !attachmentUploading) {
                        Icon(Icons.Default.Image, contentDescription = strings.attachImage)
                    }
                    IconButton(onClick = onPickFile, enabled = !attachmentUploading) {
                        Icon(Icons.Default.AttachFile, contentDescription = strings.attachFile)
                    }
                    IconButton(onClick = onToggleOptions) {
                        Icon(Icons.Default.Tune, contentDescription = strings.composerOptions)
                    }
                    IconButton(onClick = onOpenLiveCall) {
                        Icon(Icons.Default.Mic, contentDescription = strings.openLiveCall)
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = prompt,
                    onValueChange = onPromptChange,
                    modifier = Modifier.weight(1f).heightIn(min = 56.dp, max = 140.dp),
                    placeholder = { Text(if (isDesktopRemote) strings.sendToCodexDesktop else strings.messageVibeLinkAgent) },
                    minLines = 1,
                    maxLines = 5,
                )
                Button(
                    onClick = onSend,
                    enabled = canSend,
                    modifier = Modifier.size(56.dp),
                    contentPadding = PaddingValues(0.dp),
                ) {
                    if (sending) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = strings.send)
                    }
                }
            }

            if (attachmentStatus.isNotBlank()) {
                Text(
                    text = attachmentStatus,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (attachmentUploading) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (running && !isDesktopRemote) {
                OutlinedButton(onClick = onStop, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Default.Stop, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text(strings.stopCurrentTask)
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(
    message: ChatMessage,
    apiBaseUrl: String,
    authToken: String,
    compact: Boolean,
    onEdit: (ChatMessage, String) -> Unit,
    onDelete: (ChatMessage) -> Unit,
    onRegenerate: (ChatMessage) -> Unit,
    onOpenFileReference: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current
    val strings = LocalAppStrings.current
    var expanded by remember(message.role, message.text, message.toolCalls.size) { mutableStateOf(true) }
    var menuOpen by remember { mutableStateOf(false) }
    var editing by remember(message.role, message.text, message.turnId, message.id) { mutableStateOf(false) }
    var editDraft by remember(message.role, message.text, message.turnId, message.id) { mutableStateOf(message.text) }
    var artifactPreview by remember(message.role, message.text) { mutableStateOf<MessageContentUtils.ContentLink?>(null) }
    val artifactApiClient = remember(apiBaseUrl, authToken) { ApiClient(baseUrl = apiBaseUrl, token = authToken) }
    val isUser = message.role == "user"
    val isSystem = message.role == "system"
    val isError = message.role == "error"
    val canEdit = isUser && message.text.isNotBlank()
    val canRegenerate = message.role == "assistant" && message.text.isNotBlank()
    val canDelete = !isSystem && !isError
    val containerColor = when {
        isError -> MaterialTheme.colorScheme.errorContainer
        isSystem -> MaterialTheme.colorScheme.surfaceVariant
        isUser -> MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.18f)
        else -> MaterialTheme.colorScheme.surface
    }
    val roleLabel = when (message.role) {
        "user" -> strings.you
        "assistant" -> strings.agent
        "error" -> strings.error
        "system" -> strings.system
        else -> message.role
    }
    val codeBlocks = remember(message.text) { MessageContentUtils.extractCodeBlocks(message.text) }
    val fileReferences = remember(message.text) { MessageContentUtils.extractFileReferences(message.text) }
    val imageLinks = remember(message.text) { MessageContentUtils.extractImageLinks(message.text) }
    val artifactLinks = remember(message.text) { MessageContentUtils.extractArtifactLinks(message.text) }

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
                        if (codeBlocks.isNotEmpty()) {
                            IconButton(
                                onClick = { copyMessage(context, codeBlocks.joinToString("\n\n"), strings.codeCopied) },
                                modifier = Modifier.size(40.dp),
                            ) {
                                Icon(Icons.Default.Code, contentDescription = strings.copyCodeBlocks, modifier = Modifier.size(18.dp))
                            }
                        }
                        if (fileReferences.isNotEmpty()) {
                            IconButton(
                                onClick = { copyMessage(context, fileReferences.joinToString("\n"), strings.fileReferencesCopied) },
                                modifier = Modifier.size(40.dp),
                            ) {
                                Icon(Icons.Default.ContentCopy, contentDescription = strings.copyFileReferences, modifier = Modifier.size(18.dp))
                            }
                        }
                        if (message.text.isNotBlank()) {
                            IconButton(
                                onClick = { copyMessage(context, message.text, strings.copied) },
                                modifier = Modifier.size(40.dp),
                            ) {
                                Icon(Icons.Default.ContentCopy, contentDescription = strings.copyMessage, modifier = Modifier.size(18.dp))
                            }
                        }
                        IconButton(
                            onClick = { expanded = !expanded },
                            modifier = Modifier.size(40.dp),
                        ) {
                            Icon(
                                if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                                contentDescription = if (expanded) strings.collapseMessage else strings.expandMessage,
                            )
                        }
                        if (canEdit || canRegenerate || canDelete) {
                            Box {
                                IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(40.dp)) {
                                    Icon(Icons.Default.MoreVert, contentDescription = strings.messageActions)
                                }
                                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                    if (canEdit) {
                                        DropdownMenuItem(
                                            text = { Text(strings.edit) },
                                            leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                                            onClick = {
                                                editDraft = message.text
                                                editing = true
                                                expanded = true
                                                menuOpen = false
                                            },
                                        )
                                    }
                                    if (canRegenerate) {
                                        DropdownMenuItem(
                                            text = { Text(strings.regenerate) },
                                            leadingIcon = { Icon(Icons.Default.Refresh, contentDescription = null) },
                                            onClick = {
                                                menuOpen = false
                                                onRegenerate(message)
                                            },
                                        )
                                    }
                                    if (canDelete) {
                                        DropdownMenuItem(
                                            text = { Text(strings.delete) },
                                            leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null) },
                                            onClick = {
                                                menuOpen = false
                                                onDelete(message)
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
            val displayText = message.text.trim()
            if (expanded) {
                if (editing) {
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = editDraft,
                        onValueChange = { editDraft = it },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 2,
                        maxLines = 8,
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { editing = false }) { Text(strings.cancel) }
                        Button(
                            onClick = {
                                onEdit(message, editDraft)
                                editing = false
                            },
                            enabled = editDraft.trim().isNotBlank(),
                        ) { Text(strings.save) }
                    }
                } else if (displayText.isNotBlank()) {
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
                if (fileReferences.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    FileReferenceChips(
                        fileReferences = fileReferences,
                        onCopy = { reference -> copyMessage(context, reference, strings.fileReferenceCopied) },
                        onOpen = onOpenFileReference,
                    )
                }
                if (imageLinks.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    ImagePreviewGallery(
                        apiBaseUrl = apiBaseUrl,
                        authToken = authToken,
                        links = imageLinks,
                        onOpen = { link -> uriHandler.openUri(resolveContentUrl(apiBaseUrl, link.url, authToken)) },
                    )
                }
                if (artifactLinks.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    ArtifactChips(
                        links = artifactLinks,
                        onOpen = { link -> artifactPreview = link },
                    )
                }
            }
        }
    }
    artifactPreview?.let { link ->
        ArtifactWorkbenchDialog(link = link, apiClient = artifactApiClient, onDismiss = { artifactPreview = null })
    }
}

@Composable
private fun ImagePreviewGallery(
    apiBaseUrl: String,
    authToken: String,
    links: List<MessageContentUtils.ContentLink>,
    onOpen: (MessageContentUtils.ContentLink) -> Unit,
) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(links.take(8), key = { it.url }) { link ->
            Card(
                onClick = { onOpen(link) },
                modifier = Modifier.size(156.dp),
                shape = RoundedCornerShape(8.dp),
            ) {
                Box {
                    AsyncImage(
                        model = coil.request.ImageRequest.Builder(LocalContext.current)
                            .data(resolveContentUrl(apiBaseUrl, link.url))
                            .addHeader("Authorization", "Bearer $authToken")
                            .build(),
                        contentDescription = link.label.ifBlank { "Image" },
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                    Surface(
                        modifier = Modifier.align(Alignment.BottomStart).fillMaxWidth(),
                        color = MaterialTheme.colorScheme.scrim.copy(alpha = 0.54f),
                    ) {
                        Text(
                            text = link.label.ifBlank { "Image" },
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ArtifactChips(
    links: List<MessageContentUtils.ContentLink>,
    onOpen: (MessageContentUtils.ContentLink) -> Unit,
) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(links.take(8), key = { it.url }) { link ->
            AssistChip(
                onClick = { onOpen(link) },
                label = { Text("${link.kind}: ${link.label}", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            )
        }
    }
}

@Composable
private fun FileReferenceChips(
    fileReferences: List<String>,
    onCopy: (String) -> Unit,
    onOpen: (String) -> Unit,
) {
    val strings = LocalAppStrings.current
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(fileReferences.take(6), key = { it }) { reference ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                AssistChip(
                    onClick = { onOpen(reference) },
                    label = { Text(reference, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                )
                IconButton(
                    onClick = { onCopy(reference) },
                    modifier = Modifier.size(40.dp),
                ) {
                    Icon(
                        Icons.Default.ContentCopy,
                        contentDescription = strings.copyFileReference,
                        modifier = Modifier.size(18.dp),
                    )
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
    val strings = LocalAppStrings.current
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
            Text(strings.agentTyping, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ChatEmptyState(
    conversation: ConversationItem?,
    onUseSuggestion: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val strings = LocalAppStrings.current
    Column(
        modifier = modifier.padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = if (conversation == null) strings.restoringChat else strings.startWithContext,
            style = MaterialTheme.typography.titleSmall,
        )
        if (conversation != null) {
            val suggestions = listOf(
                strings.suggestionSummarizeWorkspace,
                strings.suggestionReviewChanges,
                strings.suggestionPlanNextStep,
            )
            suggestions.forEach { suggestion ->
                AssistChip(onClick = { onUseSuggestion(suggestion) }, label = { Text(suggestion) })
            }
        }
    }
}

private fun copyMessage(context: Context, text: String, toast: String = "Copied") {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("VibeLink message", text))
    Toast.makeText(context, toast, Toast.LENGTH_SHORT).show()
}

private fun resolveContentUrl(baseUrl: String, rawUrl: String, token: String = ""): String {
    val trimmed = rawUrl.trim()
    if (trimmed.startsWith("http://", ignoreCase = true) || trimmed.startsWith("https://", ignoreCase = true)) return trimmed
    val base = baseUrl.trimEnd('/')
    val url = if (trimmed.startsWith('/')) "$base$trimmed" else "$base/$trimmed"
    return if (token.isBlank() || !url.contains("/api/attachments/")) url
    else url + if (url.contains('?')) "&token=${Uri.encode(token)}" else "?token=${Uri.encode(token)}"
}

private suspend fun uploadAttachmentUri(
    context: Context,
    apiClient: ApiClient,
    uri: Uri,
): AttachmentUploadResponse {
    val resolver = context.contentResolver
    val name = displayNameForUri(context, uri)
    val mimeType = resolver.getType(uri).orEmpty().ifBlank { "application/octet-stream" }
    val size = resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getLong(cursor.getColumnIndexOrThrow(OpenableColumns.SIZE)) else -1L
    } ?: -1L
    val maxBytes = 30L * 1024L * 1024L
    if (size > maxBytes) error("Attachment exceeds 30 MB limit")
    val input = resolver.openInputStream(uri) ?: error("Unable to open attachment")
    return apiClient.uploadAttachment(
        input = input,
        contentLength = size.coerceAtLeast(0L),
        fileName = name,
        mimeType = mimeType,
    )
}

@Composable
private fun TaskChangesCard(changes: com.vibelink.app.network.TaskChangesResponse) {
    val strings = LocalAppStrings.current
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(8.dp)) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(strings.taskChanges, style = MaterialTheme.typography.titleSmall)
            (changes.items.ifEmpty { changes.changes }).take(8).forEach { change ->
                val label = change["path"]?.toString() ?: change["title"]?.toString() ?: change["type"]?.toString() ?: change.toString()
                Text(label, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

private fun displayNameForUri(context: Context, uri: Uri): String {
    val resolver = context.contentResolver
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (index >= 0) return cursor.getString(index).orEmpty().ifBlank { "attachment" }
        }
    }
    return uri.lastPathSegment?.substringAfterLast('/')?.ifBlank { "attachment" } ?: "attachment"
}

@Composable
private fun ApprovalRequiredCard(
    approval: PendingApprovalState,
    onOpenApprovals: () -> Unit,
) {
    val strings = LocalAppStrings.current
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = approval.message,
                color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.bodySmall,
            )
            Button(onClick = onOpenApprovals, modifier = Modifier.fillMaxWidth()) {
                Text(strings.openApprovals)
            }
        }
    }
}

@Composable
private fun ErrorBanner(message: String, onOpenApprovals: () -> Unit) {
    val approvalRequired = message.contains("Approval required", ignoreCase = true)
    val strings = LocalAppStrings.current
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = message,
                color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.bodySmall,
            )
            if (approvalRequired) {
                OutlinedButton(onClick = onOpenApprovals, modifier = Modifier.fillMaxWidth()) {
                    Text(strings.openApprovals)
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
