package com.vibelink.app.ui.screens

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Unarchive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.ThreadPatch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(
    apiClient: ApiClient,
    viewModel: SessionListViewModel,
    onSelectConversation: (ConversationItem) -> Unit,
    onNewConversation: () -> Unit,
    onLogout: () -> Unit,
    onOpenLiveCall: () -> Unit,
    onOpenWorkspace: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val conversations by viewModel.conversations.collectAsState()
    val query by viewModel.query.collectAsState()
    val showArchived by viewModel.showArchived.collectAsState()
    val desktopStatus by viewModel.desktopStatus.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val refreshing by viewModel.refreshing.collectAsState()
    val error by viewModel.error.collectAsState()

    var topMenuOpen by remember { mutableStateOf(false) }
    var renameTarget by remember { mutableStateOf<ConversationItem?>(null) }
    var renameText by remember { mutableStateOf("") }
    var forkTarget by remember { mutableStateOf<ConversationItem?>(null) }
    var forkText by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        viewModel.load(apiClient)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("VibeLink", style = MaterialTheme.typography.titleMedium)
                        Text(
                            text = desktopStatus,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = onNewConversation) {
                        Icon(Icons.Default.Add, contentDescription = "New chat")
                    }
                    IconButton(onClick = { viewModel.load(apiClient, isRefresh = true) }) {
                        if (refreshing) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                        }
                    }
                    IconButton(onClick = onOpenLiveCall) {
                        Icon(Icons.Default.Chat, contentDescription = "Live Call")
                    }
                    IconButton(onClick = onOpenWorkspace) {
                        Icon(Icons.Default.Folder, contentDescription = "Workspace")
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                    Box {
                        IconButton(onClick = { topMenuOpen = true }) {
                            Icon(Icons.Default.MoreVert, contentDescription = "More")
                        }
                        DropdownMenu(expanded = topMenuOpen, onDismissRequest = { topMenuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text(if (showArchived) "Show active chats" else "Show archived") },
                                onClick = {
                                    topMenuOpen = false
                                    viewModel.setShowArchived(!showArchived)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Log out") },
                                onClick = {
                                    topMenuOpen = false
                                    onLogout()
                                },
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = viewModel::setQuery,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                label = { Text("Search chats") },
                singleLine = true,
            )

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AssistChip(
                    onClick = { viewModel.setShowArchived(!showArchived) },
                    label = { Text(if (showArchived) "Archived" else "Active") },
                    leadingIcon = {
                        Icon(
                            imageVector = if (showArchived) Icons.Default.Unarchive else Icons.Default.Archive,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                    },
                )
                AssistChip(
                    onClick = { viewModel.load(apiClient, isRefresh = true) },
                    label = { Text("Sync now") },
                )
            }

            Box(modifier = Modifier.fillMaxSize()) {
                when {
                    loading && conversations.isEmpty() -> {
                        CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                    }
                    error.isNotBlank() && conversations.isEmpty() -> {
                        EmptyOrErrorState(
                            title = "Could not load chats",
                            body = error,
                            actionText = "Retry",
                            onAction = { viewModel.load(apiClient) },
                            modifier = Modifier.align(Alignment.Center),
                        )
                    }
                    conversations.isEmpty() -> {
                        EmptyOrErrorState(
                            title = if (showArchived) "No archived chats" else "No chats yet",
                            body = if (showArchived) "Archived conversations will appear here." else "Start a VibeLink Agent task or sync Codex Remote.",
                            actionText = "New chat",
                            onAction = onNewConversation,
                            modifier = Modifier.align(Alignment.Center),
                        )
                    }
                    else -> {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            items(items = conversations, key = { it.key }) { item ->
                                ConversationCard(
                                    item = item,
                                    onClick = { onSelectConversation(item) },
                                    onRename = {
                                        renameTarget = item
                                        renameText = item.title
                                    },
                                    onPin = {
                                        viewModel.patchConversation(apiClient, item, ThreadPatch(pinned = !item.pinned))
                                    },
                                    onArchive = {
                                        viewModel.patchConversation(apiClient, item, ThreadPatch(archived = !item.archived))
                                    },
                                    onFork = {
                                        forkTarget = item
                                        forkText = "${item.title} fork"
                                    },
                                )
                            }
                        }
                    }
                }

                if (refreshing && conversations.isNotEmpty()) {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth().align(Alignment.TopCenter))
                }
            }
        }
    }

    renameTarget?.let { target ->
        TextInputDialog(
            title = "Rename chat",
            value = renameText,
            onValueChange = { renameText = it },
            confirmText = "Save",
            onDismiss = { renameTarget = null },
            onConfirm = {
                viewModel.patchConversation(apiClient, target, ThreadPatch(title = renameText.trim()))
                renameTarget = null
            },
        )
    }

    forkTarget?.let { target ->
        TextInputDialog(
            title = "Fork chat",
            value = forkText,
            onValueChange = { forkText = it },
            confirmText = "Fork",
            onDismiss = { forkTarget = null },
            onConfirm = {
                viewModel.forkConversation(apiClient, target, forkText)
                forkTarget = null
            },
        )
    }
}

@Composable
private fun ConversationCard(
    item: ConversationItem,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onPin: () -> Unit,
    onArchive: () -> Unit,
    onFork: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val isRunning = item.status == "running"
    val statusColor = when (item.status) {
        "running" -> MaterialTheme.colorScheme.secondary
        "failed", "error" -> MaterialTheme.colorScheme.error
        "desktop" -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val providerLabel = providerLabel(item)

    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (item.kind == "desktop") {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surface
            },
        ),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = item.title.ifBlank { "Untitled chat" },
                        style = MaterialTheme.typography.bodyLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = listOf(providerLabel, item.group, item.cwd)
                            .filter { it.isNotBlank() }
                            .joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (item.pinned) {
                    Icon(
                        Icons.Default.PushPin,
                        contentDescription = "Pinned",
                        tint = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.size(16.dp),
                    )
                }
                Text(
                    text = statusLabel(item),
                    style = MaterialTheme.typography.labelSmall,
                    color = statusColor,
                    fontFamily = FontFamily.Monospace,
                )
                if (item.kind != "desktop") {
                    Box {
                        IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(36.dp)) {
                            Icon(Icons.Default.MoreVert, contentDescription = "Chat actions")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("Rename") },
                                leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                                onClick = {
                                    menuOpen = false
                                    onRename()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(if (item.pinned) "Unpin" else "Pin") },
                                leadingIcon = { Icon(Icons.Default.PushPin, contentDescription = null) },
                                onClick = {
                                    menuOpen = false
                                    onPin()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Fork") },
                                leadingIcon = { Icon(Icons.Default.ContentCopy, contentDescription = null) },
                                onClick = {
                                    menuOpen = false
                                    onFork()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(if (item.archived) "Restore" else "Archive") },
                                leadingIcon = {
                                    Icon(
                                        if (item.archived) Icons.Default.Unarchive else Icons.Default.Archive,
                                        contentDescription = null,
                                    )
                                },
                                onClick = {
                                    menuOpen = false
                                    onArchive()
                                },
                            )
                        }
                    }
                }
            }

            val preview = item.preview.ifBlank {
                when {
                    item.desktopLinked -> "Linked to visible Codex Desktop conversation."
                    item.kind == "fork" -> "Forked from ${item.sourceId.ifBlank { "source chat" }}."
                    isRunning -> "Running now."
                    else -> ""
                }
            }
            if (preview.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = preview,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            val timeAgo = formatTimeAgo(item.updatedAt)
            if (timeAgo.isNotBlank() || item.desktopTitle.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (item.desktopTitle.isNotBlank()) {
                        AssistChip(onClick = {}, label = { Text("Codex: ${item.desktopTitle}", maxLines = 1) })
                    }
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
}

@Composable
private fun TextInputDialog(
    title: String,
    value: String,
    onValueChange: (String) -> Unit,
    confirmText: String,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = value.isNotBlank()) {
                Text(confirmText)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

@Composable
private fun EmptyOrErrorState(
    title: String,
    body: String,
    actionText: String,
    onAction: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(
            body,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedButton(onClick = onAction) {
            Text(actionText)
        }
    }
}

private fun providerLabel(item: ConversationItem): String = when (item.provider) {
    "codex" -> if (item.kind == "desktop") "Codex Remote" else "Codex"
    "claude" -> "Claude"
    "doubao" -> "Doubao"
    "zhipu" -> "GLM"
    else -> item.provider.ifBlank { "Agent" }
}

private fun statusLabel(item: ConversationItem): String = when (item.status) {
    "running" -> "running"
    "failed", "error" -> "error"
    "history" -> "history"
    "fork" -> "fork"
    "desktop" -> "remote"
    "completed" -> "done"
    else -> item.status.ifBlank { item.kind }
}

private fun formatTimeAgo(iso: String?): String {
    if (iso.isNullOrBlank()) return ""
    val instant = try {
        java.time.Instant.parse(iso)
    } catch (_: Exception) {
        return ""
    }
    val diff = java.time.Duration.between(instant, java.time.Instant.now())
    return when {
        diff.isNegative -> "now"
        diff.toMinutes() < 1 -> "now"
        diff.toMinutes() < 60 -> "${diff.toMinutes()}m"
        diff.toHours() < 24 -> "${diff.toHours()}h"
        diff.toDays() < 7 -> "${diff.toDays()}d"
        else -> "${diff.toDays() / 7}w"
    }
}
