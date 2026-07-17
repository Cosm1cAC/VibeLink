package com.vibelink.app.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Close
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
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.Button
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.CommandDefinition
import com.vibelink.app.network.ThreadPatch
import com.vibelink.app.network.SearchResult
import com.vibelink.app.ui.i18n.AppStrings
import com.vibelink.app.ui.i18n.LocalAppStrings

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun SessionListScreen(
    apiClient: ApiClient,
    viewModel: SessionListViewModel,
    onSelectConversation: (ConversationItem) -> Unit,
    onOpenSearchResult: (SearchResult) -> Unit,
    onNewConversation: () -> Unit,
    onLogout: () -> Unit,
    onOpenLiveCall: () -> Unit,
    onOpenWorkspace: () -> Unit,
    onOpenReview: () -> Unit,
    onOpenSettings: (String) -> Unit,
) {
    val conversations by viewModel.conversations.collectAsState()
    val query by viewModel.query.collectAsState()
    val showArchived by viewModel.showArchived.collectAsState()
    val desktopStatus by viewModel.desktopStatus.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val refreshing by viewModel.refreshing.collectAsState()
    val error by viewModel.error.collectAsState()
    val searchResults by viewModel.searchResults.collectAsState()
    val searchLoading by viewModel.searchLoading.collectAsState()
    val searchAppending by viewModel.searchAppending.collectAsState()
    val searchError by viewModel.searchError.collectAsState()
    val searchNextCursor by viewModel.searchNextCursor.collectAsState()
    val searchScope by viewModel.searchScope.collectAsState()
    val selectedSearchTag by viewModel.selectedSearchTag.collectAsState()
    val selectedTags by viewModel.selectedTags.collectAsState()
    val availableTags by viewModel.availableTags.collectAsState()
    val selectedConversationKeys by viewModel.selectedConversationKeys.collectAsState()
    val selectionMode = selectedConversationKeys.isNotEmpty()
    val commands by viewModel.commands.collectAsState()
    val strings = LocalAppStrings.current

    var topMenuOpen by remember { mutableStateOf(false) }
    var renameTarget by remember { mutableStateOf<ConversationItem?>(null) }
    var renameText by remember { mutableStateOf("") }
    var forkTarget by remember { mutableStateOf<ConversationItem?>(null) }
    var forkText by remember { mutableStateOf("") }
    val showFavorites by viewModel.showFavorites.collectAsState()
    var tagsTarget by remember { mutableStateOf<ConversationItem?>(null) }
    var tagsText by remember { mutableStateOf("") }
    var batchAddTagsOpen by remember { mutableStateOf(false) }
    var batchRemoveTagsOpen by remember { mutableStateOf(false) }
    var batchTagsText by remember { mutableStateOf("") }
    var commandPaletteOpen by remember { mutableStateOf(false) }
    var commandFilter by remember { mutableStateOf("") }
    var focusSearchRequested by remember { mutableStateOf(false) }
    var tagMenuOpen by remember { mutableStateOf(false) }
    val searchFocusRequester = remember { FocusRequester() }
    val unifiedSearchActive = query.trim().length >= 2
    val searchScopes = listOf(
        "all" to "All",
        "sessions" to "Sessions",
        "messages" to "Messages",
        "files" to "Files",
        "tasks" to "Tasks",
    )

    LaunchedEffect(strings.currentLanguage) {
        viewModel.setLanguage(strings.currentLanguage)
        viewModel.load(apiClient)
    }

    LaunchedEffect(focusSearchRequested) {
        if (focusSearchRequested) {
            searchFocusRequester.requestFocus()
            focusSearchRequested = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    if (selectionMode) {
                        Text("${selectedConversationKeys.size} selected", style = MaterialTheme.typography.titleMedium)
                    } else {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Text(
                                strings.brandName,
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Clip,
                            )
                            Text(
                                text = desktopStatus,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                actions = {
                    if (selectionMode) {
                        IconButton(onClick = { viewModel.batchSetFavorite(apiClient, true) }) {
                            Icon(Icons.Default.Favorite, contentDescription = "Favorite selected")
                        }
                        IconButton(onClick = { viewModel.batchSetFavorite(apiClient, false) }) {
                            Icon(Icons.Default.FavoriteBorder, contentDescription = "Remove favorite selected")
                        }
                        IconButton(onClick = { batchTagsText = ""; batchAddTagsOpen = true }) {
                            Icon(Icons.Default.Edit, contentDescription = "Add tags to selected")
                        }
                        IconButton(onClick = { batchTagsText = ""; batchRemoveTagsOpen = true }) {
                            Icon(Icons.Default.Archive, contentDescription = "Remove tags from selected")
                        }
                        IconButton(onClick = viewModel::clearSelection) {
                            Icon(Icons.Default.Close, contentDescription = strings.close)
                        }
                    } else {
                        IconButton(onClick = onNewConversation) {
                            Icon(Icons.Default.Add, contentDescription = strings.newChat)
                        }
                        IconButton(onClick = { viewModel.load(apiClient, isRefresh = true) }) {
                            if (refreshing) {
                                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                            } else {
                                Icon(Icons.Default.Refresh, contentDescription = strings.refresh)
                            }
                        }
                        Box {
                            IconButton(onClick = { topMenuOpen = true }) {
                                Icon(Icons.Default.MoreVert, contentDescription = strings.more)
                            }
                            DropdownMenu(expanded = topMenuOpen, onDismissRequest = { topMenuOpen = false }) {
                                DropdownMenuItem(
                                    text = { Text("Command palette") },
                                    leadingIcon = { Icon(Icons.Default.Settings, contentDescription = null) },
                                    onClick = { topMenuOpen = false; commandPaletteOpen = true },
                                )
                                DropdownMenuItem(
                                    text = { Text(strings.liveCall) },
                                    leadingIcon = { Icon(Icons.Default.Chat, contentDescription = null) },
                                    onClick = {
                                        topMenuOpen = false
                                        onOpenLiveCall()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(strings.workspace) },
                                    leadingIcon = { Icon(Icons.Default.Folder, contentDescription = null) },
                                    onClick = {
                                        topMenuOpen = false
                                        onOpenWorkspace()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(strings.settings) },
                                    leadingIcon = { Icon(Icons.Default.Settings, contentDescription = null) },
                                    onClick = {
                                        topMenuOpen = false
                                        onOpenSettings("")
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(if (showArchived) strings.showActiveChats else strings.showArchivedChats) },
                                    onClick = {
                                        topMenuOpen = false
                                        viewModel.setShowArchived(!showArchived)
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(strings.logout) },
                                    onClick = {
                                        topMenuOpen = false
                                        onLogout()
                                    },
                                )
                            }
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
                    .focusRequester(searchFocusRequester)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                label = { Text(strings.searchChats) },
                singleLine = true,
            )

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AssistChip(
                    onClick = { viewModel.setShowArchived(!showArchived) },
                    label = { Text(if (showArchived) strings.archived else strings.active) },
                    leadingIcon = {
                        Icon(
                            imageVector = if (showArchived) Icons.Default.Unarchive else Icons.Default.Archive,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                    },
                )
                AssistChip(
                    onClick = { viewModel.setShowFavorites(!showFavorites) },
                    label = { Text(if (showFavorites) "Favorites" else "All") },
                    leadingIcon = {
                        Icon(if (showFavorites) Icons.Default.Favorite else Icons.Default.FavoriteBorder, contentDescription = null, modifier = Modifier.size(16.dp))
                    },
                )
                Box {
                    AssistChip(
                        onClick = { tagMenuOpen = true },
                        label = { Text(if (selectedTags.isEmpty()) "All tags" else "Tags: ${selectedTags.size}") },
                    )
                    DropdownMenu(expanded = tagMenuOpen, onDismissRequest = { tagMenuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("All tags") },
                            onClick = {
                                viewModel.clearTagFilters()
                                tagMenuOpen = false
                            },
                        )
                        availableTags.forEach { tag ->
                            DropdownMenuItem(
                                text = { Text(tag) },
                                onClick = {
                                    viewModel.toggleTagFilter(tag)
                                },
                            )
                        }
                    }
                }
                AssistChip(
                    onClick = { viewModel.load(apiClient, isRefresh = true) },
                    label = { Text(strings.syncNow) },
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                searchScopes.forEach { (scope, label) ->
                    FilterChip(
                        selected = searchScope == scope,
                        onClick = { viewModel.setSearchScope(scope) },
                        label = { Text(label) },
                    )
                }
            }

            Box(modifier = Modifier.fillMaxSize()) {
                when {
                    loading && conversations.isEmpty() && !unifiedSearchActive -> {
                        CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                    }
                    error.isNotBlank() && conversations.isEmpty() && !unifiedSearchActive -> {
                        EmptyOrErrorState(
                            title = strings.couldNotLoadChats,
                            body = error,
                            actionText = strings.retry,
                            onAction = { viewModel.load(apiClient) },
                            modifier = Modifier.align(Alignment.Center),
                        )
                    }
                    conversations.isEmpty() && !unifiedSearchActive -> {
                        EmptyOrErrorState(
                            title = if (showArchived) strings.noArchivedChats else strings.noChatsYet,
                            body = if (showArchived) strings.archivedChatsHint else strings.emptyChatsHint,
                            actionText = strings.newChat,
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
                            if (unifiedSearchActive && searchLoading) {
                                item(key = "remote-search-loading") {
                                    ListItem(headlineContent = { Text("Searching…") }, supportingContent = { Text("Loading unified results") })
                                }
                            }
                            if (unifiedSearchActive && searchError.isNotBlank()) {
                                item(key = "remote-search-error") {
                                    ListItem(headlineContent = { Text("Search failed") }, supportingContent = { Text(searchError) })
                                }
                            }
                            if (unifiedSearchActive && !searchLoading && searchError.isBlank() && searchResults.isEmpty()) {
                                item(key = "remote-search-empty") {
                                    ListItem(headlineContent = { Text("No matching results") })
                                }
                            }
                            if (unifiedSearchActive && searchResults.isNotEmpty()) {
                                item(key = "remote-search-header") { Text("Search results", style = MaterialTheme.typography.titleSmall) }
                                items(searchResults, key = { "search:${it.kind}:${it.id}:${it.turnId}:${it.path}" }) { result ->
                                    ListItem(
                                        headlineContent = { Text(result.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                        supportingContent = { Text(result.snippet, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                                        leadingContent = { Text(result.kind, style = MaterialTheme.typography.labelSmall) },
                                        modifier = Modifier.clickable { onOpenSearchResult(result) },
                                    )
                                }
                                if (searchAppending) {
                                    item(key = "remote-search-appending") {
                                        ListItem(headlineContent = { Text("Loading more…") })
                                    }
                                } else if (searchNextCursor.isNotBlank()) {
                                    item(key = "remote-search-load-more") {
                                        Button(onClick = { viewModel.loadMoreSearch(apiClient) }, modifier = Modifier.fillMaxWidth()) {
                                            Text("Load more")
                                        }
                                    }
                                }
                            }
                            if (SessionListErrorPolicy.showCachedContentError(error, conversations.size)) {
                                item(key = "cached-refresh-error") {
                                    CachedRefreshError(
                                        message = error,
                                        retryText = strings.retry,
                                        onRetry = { viewModel.load(apiClient, isRefresh = true) },
                                    )
                                }
                            }
                            items(items = conversations, key = { it.key }) { item ->
                                ConversationCard(
                                    item = item,
                                    selected = item.key in selectedConversationKeys,
                                    selectionMode = selectionMode,
                                    onClick = {
                                        if (selectionMode) viewModel.toggleConversationSelection(item) else onSelectConversation(item)
                                    },
                                    onLongClick = { viewModel.toggleConversationSelection(item) },
                                    onRename = {
                                        renameTarget = item
                                        renameText = item.title
                                    },
                                    onPin = {
                                        viewModel.patchConversation(apiClient, item, ThreadPatch(pinned = !item.pinned))
                                    },
                                    onFavorite = {
                                        viewModel.patchConversation(apiClient, item, ThreadPatch(favorite = !item.favorite))
                                    },
                                    onTags = {
                                        tagsTarget = item
                                        tagsText = item.tags.joinToString(", ")
                                    },
                                    onArchive = {
                                        viewModel.patchConversation(apiClient, item, ThreadPatch(archived = !item.archived))
                                    },
                                    onFork = {
                                        forkTarget = item
                                        forkText = "${item.title} ${strings.fork}"
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
            title = strings.renameChat,
            value = renameText,
            onValueChange = { renameText = it },
            confirmText = strings.save,
            onDismiss = { renameTarget = null },
            onConfirm = {
                viewModel.patchConversation(apiClient, target, ThreadPatch(title = renameText.trim()))
                renameTarget = null
            },
        )
    }

    forkTarget?.let { target ->
        TextInputDialog(
            title = strings.forkChat,
            value = forkText,
            onValueChange = { forkText = it },
            confirmText = strings.fork,
            onDismiss = { forkTarget = null },
            onConfirm = {
                viewModel.forkConversation(apiClient, target, forkText)
                forkTarget = null
            },
        )
    }

    tagsTarget?.let { target ->
        TextInputDialog(
            title = "Edit tags",
            value = tagsText,
            onValueChange = { tagsText = it },
            confirmText = strings.save,
            onDismiss = { tagsTarget = null },
            onConfirm = {
                viewModel.patchConversation(apiClient, target, ThreadPatch(tags = tagsText.split(",").map { it.trim() }.filter { it.isNotBlank() }))
                tagsTarget = null
            },
        )
    }

    if (batchAddTagsOpen) {
        TextInputDialog(
            title = "Add tags to selected",
            value = batchTagsText,
            onValueChange = { batchTagsText = it },
            confirmText = strings.save,
            onDismiss = { batchAddTagsOpen = false },
            onConfirm = {
                viewModel.batchAddTags(apiClient, batchTagsText.split(",").map { it.trim() }.filter { it.isNotBlank() })
                batchAddTagsOpen = false
            },
        )
    }

    if (batchRemoveTagsOpen) {
        TextInputDialog(
            title = "Remove tags from selected",
            value = batchTagsText,
            onValueChange = { batchTagsText = it },
            confirmText = strings.save,
            onDismiss = { batchRemoveTagsOpen = false },
            onConfirm = {
                viewModel.batchRemoveTags(apiClient, batchTagsText.split(",").map { it.trim() }.filter { it.isNotBlank() })
                batchRemoveTagsOpen = false
            },
        )
    }

    if (commandPaletteOpen) {
        AlertDialog(
            onDismissRequest = { commandPaletteOpen = false },
            title = { Text("Command palette") },
            text = {
                Column {
                    OutlinedTextField(value = commandFilter, onValueChange = { commandFilter = it }, label = { Text("Filter commands") }, singleLine = true)
                    LazyColumn {
                        items(filterSessionCommands(commands, commandFilter), key = { it.id }) { command ->
                            val plan = resolveSessionCommand(command)
                            val disabledReason = (plan as? SessionCommand.Disabled)?.reason.orEmpty()
                            ListItem(
                                headlineContent = { Text(command.ui.label.ifBlank { command.name }) },
                                supportingContent = {
                                    Text(if (disabledReason.isBlank()) command.ui.detail.ifBlank { command.description } else disabledReason)
                                },
                                modifier = Modifier.clickable(enabled = plan !is SessionCommand.Disabled) {
                                    commandPaletteOpen = false
                                    when (plan) {
                                        SessionCommand.NewSession -> onNewConversation()
                                        SessionCommand.Refresh -> viewModel.load(apiClient, isRefresh = true)
                                        SessionCommand.FocusSearch -> focusSearchRequested = true
                                        is SessionCommand.Navigate -> when (plan.route) {
                                            "call" -> onOpenLiveCall()
                                            "workspace" -> onOpenWorkspace()
                                            "review" -> onOpenReview()
                                            "settings" -> onOpenSettings("")
                                            "settings?section=approvals" -> onOpenSettings("approvals")
                                        }
                                        is SessionCommand.Disabled -> Unit
                                    }
                                },
                            )
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { commandPaletteOpen = false }) { Text("Close") } },
        )
    }
}

object SessionListErrorPolicy {
    fun showCachedContentError(error: String, conversationCount: Int): Boolean {
        return error.isNotBlank() && conversationCount > 0
    }

}

@Composable
private fun CachedRefreshError(message: String, retryText: String, onRetry: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = message,
                modifier = Modifier.weight(1f),
                color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.bodySmall,
            )
            TextButton(onClick = onRetry) { Text(retryText) }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationCard(
    item: ConversationItem,
    selected: Boolean = false,
    selectionMode: Boolean = false,
    onClick: () -> Unit,
    onLongClick: () -> Unit = {},
    onRename: () -> Unit,
    onPin: () -> Unit,
    onFavorite: () -> Unit,
    onTags: () -> Unit,
    onArchive: () -> Unit,
    onFork: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val strings = LocalAppStrings.current
    val isRunning = item.status == "running"
    val statusColor = when (item.status) {
        "running" -> MaterialTheme.colorScheme.secondary
        "failed", "error" -> MaterialTheme.colorScheme.error
        "desktop" -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val providerLabel = providerLabel(item, strings)

    Card(
        modifier = modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(
            containerColor = when {
                selected -> MaterialTheme.colorScheme.secondaryContainer
                item.kind == "desktop" -> MaterialTheme.colorScheme.primaryContainer
                else -> MaterialTheme.colorScheme.surface
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
                        text = item.title.ifBlank { strings.untitledChat },
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
                    if (item.tags.isNotEmpty()) {
                        Spacer(Modifier.height(6.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            item.tags.take(3).forEach { tag ->
                                AssistChip(onClick = {}, label = { Text(tag, maxLines = 1) })
                            }
                            if (item.tags.size > 3) {
                                Text("+${item.tags.size - 3}", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
                if (item.pinned) {
                    Icon(
                        Icons.Default.PushPin,
                        contentDescription = strings.pinned,
                        tint = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.size(16.dp),
                    )
                }
                Text(
                    text = statusLabel(item, strings),
                    style = MaterialTheme.typography.labelSmall,
                    color = statusColor,
                    fontFamily = FontFamily.Monospace,
                )
                if (item.kind != "desktop" && !selectionMode) {
                    Box {
                        IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(36.dp)) {
                            Icon(Icons.Default.MoreVert, contentDescription = strings.chatActions)
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text(strings.rename) },
                                leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                                onClick = {
                                    menuOpen = false
                                    onRename()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(if (item.pinned) strings.unpin else strings.pin) },
                                leadingIcon = { Icon(Icons.Default.PushPin, contentDescription = null) },
                                onClick = {
                                    menuOpen = false
                                    onPin()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(if (item.favorite) "Remove favorite" else "Favorite") },
                                leadingIcon = { Icon(if (item.favorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder, contentDescription = null) },
                                onClick = { menuOpen = false; onFavorite() },
                            )
                            DropdownMenuItem(
                                text = { Text("Edit tags") },
                                leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                                onClick = { menuOpen = false; onTags() },
                            )
                            DropdownMenuItem(
                                text = { Text(strings.fork) },
                                leadingIcon = { Icon(Icons.Default.ContentCopy, contentDescription = null) },
                                onClick = {
                                    menuOpen = false
                                    onFork()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(if (item.archived) strings.restore else strings.archive) },
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
                    item.desktopLinked -> strings.linkedDesktopConversation
                    item.kind == "fork" -> strings.forkedFrom(item.sourceId.ifBlank { strings.sourceChat })
                    isRunning -> strings.runningNow
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

            val timeAgo = formatTimeAgo(item.updatedAt, strings)
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
    val strings = LocalAppStrings.current
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
            TextButton(onClick = onDismiss) { Text(strings.cancel) }
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

private fun providerLabel(item: ConversationItem, strings: AppStrings): String = when (item.provider) {
    "codex" -> if (item.kind == "desktop") strings.codexRemoteLabel() else "Codex"
    "claude" -> "Claude"
    "doubao" -> "Doubao"
    "zhipu" -> "GLM"
    else -> item.provider.ifBlank { strings.agentLabel() }
}

private fun statusLabel(item: ConversationItem, strings: AppStrings): String = strings.statusLabel(item.status, item.kind)

private fun formatTimeAgo(iso: String?, strings: AppStrings): String {
    if (iso.isNullOrBlank()) return ""
    val instant = try {
        java.time.Instant.parse(iso)
    } catch (_: Exception) {
        return ""
    }
    val diff = java.time.Duration.between(instant, java.time.Instant.now())
    val minutes = diff.toMinutes()
    val hours = diff.toHours()
    val days = diff.toDays()
    return when {
        diff.isNegative -> strings.timeAgo(0, 0, 0)
        else -> strings.timeAgo(minutes, hours, days)
    }
}
