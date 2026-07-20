package com.vibelink.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.DrawerValue
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.ui.i18n.LocalAppStrings
import kotlinx.coroutines.launch

object AgentDrawerPolicy {
    fun filterAndSort(conversations: List<ConversationItem>, query: String): List<ConversationItem> {
        val needle = query.trim()
        return conversations
            .asSequence()
            .filterNot { it.archived }
            .filter { item ->
                needle.isBlank() || listOf(item.title, item.provider, item.cwd, item.preview, item.group)
                    .any { value -> value.contains(needle, ignoreCase = true) }
            }
            .sortedWith(compareByDescending<ConversationItem> { it.pinned }.thenByDescending { it.updatedAt })
            .toList()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentShell(
    apiClient: ApiClient,
    viewModel: SessionListViewModel,
    activeConversation: ConversationItem?,
    onSelectConversation: (ConversationItem) -> Unit,
    onNewConversation: () -> Unit,
    onOpenWorkspace: () -> Unit,
    onOpenLiveCall: () -> Unit,
    onOpenReview: () -> Unit,
    onOpenSettings: (String) -> Unit,
    onLogout: () -> Unit,
    content: @Composable (openDrawer: () -> Unit) -> Unit,
) {
    val conversations by viewModel.conversations.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.load(apiClient)
    }

    fun closeDrawer() {
        scope.launch { drawerState.close() }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        gesturesEnabled = true,
        drawerContent = {
            AgentDrawer(
                conversations = conversations,
                activeConversation = activeConversation,
                loading = loading,
                onSelectConversation = {
                    onSelectConversation(it)
                    closeDrawer()
                },
                onNewConversation = {
                    onNewConversation()
                    closeDrawer()
                },
                onOpenWorkspace = { onOpenWorkspace(); closeDrawer() },
                onOpenLiveCall = { onOpenLiveCall(); closeDrawer() },
                onOpenReview = { onOpenReview(); closeDrawer() },
                onOpenSettings = { section -> onOpenSettings(section); closeDrawer() },
                onLogout = { onLogout(); closeDrawer() },
            )
        },
    ) {
        content { scope.launch { drawerState.open() } }
    }
}

@Composable
private fun AgentDrawer(
    conversations: List<ConversationItem>,
    activeConversation: ConversationItem?,
    loading: Boolean,
    onSelectConversation: (ConversationItem) -> Unit,
    onNewConversation: () -> Unit,
    onOpenWorkspace: () -> Unit,
    onOpenLiveCall: () -> Unit,
    onOpenReview: () -> Unit,
    onOpenSettings: (String) -> Unit,
    onLogout: () -> Unit,
) {
    val strings = LocalAppStrings.current
    var query by remember { mutableStateOf("") }
    var accountMenuOpen by remember { mutableStateOf(false) }
    val visibleConversations = remember(conversations, query) {
        AgentDrawerPolicy.filterAndSort(conversations, query)
    }

    ModalDrawerSheet(
        modifier = Modifier.fillMaxHeight().widthIn(max = 360.dp),
        drawerContainerColor = MaterialTheme.colorScheme.surfaceVariant,
        drawerShape = RoundedCornerShape(topEnd = 20.dp, bottomEnd = 20.dp),
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primary, modifier = Modifier.size(40.dp)) {
                    Box(contentAlignment = Alignment.Center) {
                        Text("V", color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.titleMedium)
                    }
                }
                Column(modifier = Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(strings.brandName, style = MaterialTheme.typography.titleMedium)
                    Text(
                        strings.text("本地 Agent 控制台", "Local agent console"),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Box {
                    IconButton(onClick = { accountMenuOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = strings.more)
                    }
                    DropdownMenu(expanded = accountMenuOpen, onDismissRequest = { accountMenuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text(strings.text("退出登录", "Log out")) },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null) },
                            onClick = { accountMenuOpen = false; onLogout() },
                        )
                    }
                }
            }

            DrawerUtilityActions(
                onOpenWorkspace = onOpenWorkspace,
                onOpenLiveCall = onOpenLiveCall,
                onOpenReview = onOpenReview,
                onOpenApprovals = { onOpenSettings("approvals") },
            )

            Text(
                strings.text("对话", "Conversations"),
                modifier = Modifier.padding(top = 20.dp, bottom = 8.dp),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                when {
                    loading && visibleConversations.isEmpty() -> CircularProgressIndicator(
                        modifier = Modifier.size(24.dp).align(Alignment.Center),
                        strokeWidth = 2.dp,
                    )
                    visibleConversations.isEmpty() -> Text(
                        text = if (query.isBlank()) strings.text("还没有对话", "No conversations yet") else strings.text("没有匹配的对话", "No matching conversations"),
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    else -> ConversationHistory(
                        conversations = visibleConversations,
                        activeKey = activeConversation?.key.orEmpty(),
                        onSelectConversation = onSelectConversation,
                    )
                }
            }

            DrawerSearchBar(query = query, onQueryChange = { query = it })
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                DrawerBottomAction(
                    icon = { Icon(Icons.Default.Settings, contentDescription = null) },
                    label = strings.settings,
                    onClick = { onOpenSettings("") },
                    modifier = Modifier.weight(1f),
                )
                DrawerBottomAction(
                    icon = { Icon(Icons.Default.Add, contentDescription = null) },
                    label = strings.newChat,
                    onClick = onNewConversation,
                    modifier = Modifier.weight(1f),
                    emphasized = true,
                )
            }
        }
    }
}

@Composable
private fun DrawerUtilityActions(
    onOpenWorkspace: () -> Unit,
    onOpenLiveCall: () -> Unit,
    onOpenReview: () -> Unit,
    onOpenApprovals: () -> Unit,
) {
    val strings = LocalAppStrings.current
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        DrawerUtilityRow(Icons.Default.Folder, strings.workspace, onOpenWorkspace)
        DrawerUtilityRow(Icons.Default.Call, strings.liveCall, onOpenLiveCall)
        DrawerUtilityRow(Icons.Default.Checklist, strings.text("Review 与审批", "Review and approvals"), onOpenReview)
        DrawerUtilityRow(Icons.Default.Settings, strings.text("待处理权限", "Pending permissions"), onOpenApprovals)
    }
}

@Composable
private fun DrawerUtilityRow(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ConversationHistory(
    conversations: List<ConversationItem>,
    activeKey: String,
    onSelectConversation: (ConversationItem) -> Unit,
) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(conversations, key = { it.key }) { conversation ->
            ConversationHistoryRow(
                conversation = conversation,
                selected = conversation.key == activeKey,
                onClick = { onSelectConversation(conversation) },
            )
        }
    }
}

@Composable
private fun ConversationHistoryRow(conversation: ConversationItem, selected: Boolean, onClick: () -> Unit) {
    var menuOpen by remember { mutableStateOf(false) }
    Surface(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        color = if (selected) MaterialTheme.colorScheme.surface else androidx.compose.ui.graphics.Color.Transparent,
        shape = RoundedCornerShape(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 10.dp, top = 10.dp, bottom = 10.dp, end = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    conversation.title.ifBlank { LocalAppStrings.current.untitledChat },
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    drawerTimestamp(conversation.updatedAt).ifBlank { conversation.provider },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
            Box {
                IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Default.MoreVert, contentDescription = LocalAppStrings.current.chatActions, modifier = Modifier.size(18.dp))
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text(conversation.provider.ifBlank { "Agent" }) },
                        onClick = { menuOpen = false },
                        enabled = false,
                    )
                }
            }
        }
    }
}

@Composable
private fun DrawerSearchBar(query: String, onQueryChange: (String) -> Unit) {
    val strings = LocalAppStrings.current
    OutlinedTextField(
        value = query,
        onValueChange = onQueryChange,
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        shape = RoundedCornerShape(24.dp),
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
        placeholder = { Text(strings.text("搜索对话", "Search conversations")) },
    )
}

@Composable
private fun DrawerBottomAction(
    icon: @Composable () -> Unit,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    emphasized: Boolean = false,
) {
    Surface(
        onClick = onClick,
        modifier = modifier.height(48.dp),
        shape = RoundedCornerShape(24.dp),
        color = if (emphasized) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface,
        contentColor = if (emphasized) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
    ) {
        Row(
            modifier = Modifier.fillMaxSize(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            icon()
            Text(label, modifier = Modifier.padding(start = 6.dp), style = MaterialTheme.typography.labelLarge, maxLines = 1)
        }
    }
}

private fun drawerTimestamp(value: String): String {
    if (value.length < 10) return value
    return value.substring(5, 10).replace('-', '/')
}
