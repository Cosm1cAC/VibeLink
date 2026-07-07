package com.vibelink.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import com.vibelink.app.network.CommandResult
import com.vibelink.app.network.GitDiffResponse
import com.vibelink.app.network.GitStatusItem
import com.vibelink.app.network.WorkspaceFileItem
import com.vibelink.app.network.WorkspaceFileResponse
import com.vibelink.app.network.WorkspaceItem

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(
    apiClient: ApiClient,
    viewModel: WorkspaceViewModel,
    onBack: () -> Unit,
) {
    val workspaces by viewModel.workspaces.collectAsState()
    val selectedWorkspaceId by viewModel.selectedWorkspaceId.collectAsState()
    val currentDir by viewModel.currentDir.collectAsState()
    val files by viewModel.files.collectAsState()
    val selectedFile by viewModel.selectedFile.collectAsState()
    val gitStatus by viewModel.gitStatus.collectAsState()
    val gitDiff by viewModel.gitDiff.collectAsState()
    val commandResult by viewModel.commandResult.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val refreshing by viewModel.refreshing.collectAsState()
    val commandRunning by viewModel.commandRunning.collectAsState()
    val gitActionRunning by viewModel.gitActionRunning.collectAsState()
    val error by viewModel.error.collectAsState()

    var command by remember { mutableStateOf("git status --short --branch") }
    val selectedWorkspace = workspaces.firstOrNull { it.id == selectedWorkspaceId }

    LaunchedEffect(Unit) {
        viewModel.load(apiClient)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Workspace") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.refreshSelected(apiClient) }) {
                        if (refreshing) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                        }
                    }
                },
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when {
                loading && workspaces.isEmpty() -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                workspaces.isEmpty() && error.isBlank() -> EmptyWorkspaceState(modifier = Modifier.align(Alignment.Center))
                else -> WorkspaceContent(
                    apiClient = apiClient,
                    viewModel = viewModel,
                    workspaces = workspaces,
                    selectedWorkspace = selectedWorkspace,
                    selectedWorkspaceId = selectedWorkspaceId,
                    currentDir = currentDir,
                    files = files,
                    selectedFile = selectedFile,
                    changedFiles = gitStatus?.files.orEmpty().ifEmpty { gitDiff?.files.orEmpty() },
                    gitDiff = gitDiff,
                    command = command,
                    commandRunning = commandRunning,
                    gitActionRunning = gitActionRunning,
                    commandResult = commandResult,
                    error = error,
                    onCommandChange = { command = it },
                )
            }

            if (refreshing && workspaces.isNotEmpty()) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth().align(Alignment.TopCenter))
            }
        }
    }
}

@Composable
private fun WorkspaceContent(
    apiClient: ApiClient,
    viewModel: WorkspaceViewModel,
    workspaces: List<WorkspaceItem>,
    selectedWorkspace: WorkspaceItem?,
    selectedWorkspaceId: String,
    currentDir: String,
    files: List<WorkspaceFileItem>,
    selectedFile: WorkspaceFileResponse?,
    changedFiles: List<GitStatusItem>,
    gitDiff: GitDiffResponse?,
    command: String,
    commandRunning: Boolean,
    gitActionRunning: Boolean,
    commandResult: CommandResult?,
    error: String,
    onCommandChange: (String) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (error.isNotBlank()) {
            item { ErrorCard(error) }
        }

        item {
            WorkspacePicker(
                workspaces = workspaces,
                selectedWorkspaceId = selectedWorkspaceId,
                onSelectWorkspace = { viewModel.selectWorkspace(apiClient, it) },
            )
        }

        item {
            WorkspaceSummary(workspace = selectedWorkspace, gitDiff = gitDiff)
        }

        item {
            SectionCard(title = "Files") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = if (currentDir.isBlank()) "/" else currentDir,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        onClick = { viewModel.openParentDirectory(apiClient) },
                        enabled = currentDir.isNotBlank(),
                    ) { Text("Up") }
                }
                if (files.isEmpty()) {
                    MutedText("No files in this directory.")
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        files.take(40).forEach { item ->
                            WorkspaceFileRow(
                                item = item,
                                onClick = {
                                    if (item.type == "directory") viewModel.openDirectory(apiClient, item.path)
                                    else viewModel.openFile(apiClient, item.path)
                                },
                            )
                        }
                    }
                }
            }
        }

        selectedFile?.let { file ->
            item {
                SectionCard(title = "File Preview") {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = file.path,
                            style = MaterialTheme.typography.labelMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        IconButton(onClick = { viewModel.clearFilePreview() }) {
                            Icon(Icons.Default.Close, contentDescription = "Close preview")
                        }
                    }
                    if (file.binary || file.text.isBlank()) {
                        MutedText("Binary or large file; preview is unavailable.")
                    } else {
                        CodeBlock(text = file.text.take(12000), maxLines = 120)
                    }
                }
            }
        }

        item {
            SectionCard(title = "Git Changes") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { viewModel.applyGitAction(apiClient, "stage-all") },
                        enabled = !gitActionRunning && selectedWorkspaceId.isNotBlank(),
                    ) { Text("Stage all") }
                    OutlinedButton(
                        onClick = { viewModel.applyGitAction(apiClient, "unstage-all") },
                        enabled = !gitActionRunning && selectedWorkspaceId.isNotBlank(),
                    ) { Text("Unstage all") }
                }
                Spacer(Modifier.height(8.dp))
                if (changedFiles.isEmpty()) {
                    MutedText("Working tree is clean or Git is unavailable.")
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        changedFiles.take(32).forEach { item ->
                            GitFileRow(
                                item = item,
                                gitActionRunning = gitActionRunning,
                                onStage = { viewModel.applyGitFileAction(apiClient, item.path.ifBlank { item.oldPath }, "stage") },
                                onUnstage = { viewModel.applyGitFileAction(apiClient, item.path.ifBlank { item.oldPath }, "unstage") },
                                onRestore = { viewModel.applyGitFileAction(apiClient, item.path.ifBlank { item.oldPath }, "restore") },
                            )
                        }
                    }
                }
            }
        }

        item {
            SectionCard(title = "Diff Preview") {
                val diff = gitDiff?.diff.orEmpty().trim()
                if (diff.isBlank()) {
                    MutedText("No diff preview.")
                } else {
                    CodeBlock(text = diff.take(8000), maxLines = 80)
                }
            }
        }

        item {
            SectionCard(title = "Command") {
                OutlinedTextField(
                    value = command,
                    onValueChange = onCommandChange,
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 1,
                    maxLines = 3,
                    label = { Text("Command") },
                    singleLine = false,
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = { viewModel.runCommand(apiClient, command) },
                    enabled = command.isNotBlank() && !commandRunning && selectedWorkspaceId.isNotBlank(),
                ) {
                    if (commandRunning) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Default.PlayArrow, contentDescription = null)
                    }
                    Spacer(Modifier.size(8.dp))
                    Text(if (commandRunning) "Running" else "Run")
                }
                commandResult?.let { result ->
                    Spacer(Modifier.height(10.dp))
                    CommandResultView(result)
                }
            }
        }
    }
}

@Composable
private fun WorkspacePicker(
    workspaces: List<WorkspaceItem>,
    selectedWorkspaceId: String,
    onSelectWorkspace: (String) -> Unit,
) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(workspaces, key = { it.id }) { workspace ->
            FilterChip(
                selected = workspace.id == selectedWorkspaceId,
                onClick = { onSelectWorkspace(workspace.id) },
                label = { Text(workspace.title.ifBlank { workspace.id }, maxLines = 1) },
            )
        }
    }
}

@Composable
private fun WorkspaceSummary(workspace: WorkspaceItem?, gitDiff: GitDiffResponse?) {
    ElevatedCard(
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = workspace?.title?.ifBlank { "Workspace" } ?: "Workspace",
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = workspace?.path.orEmpty(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AssistChip(onClick = {}, label = { Text(gitDiff?.branch?.ifBlank { "branch" } ?: "branch") })
                AssistChip(onClick = {}, label = { Text("${gitDiff?.changedCount ?: 0} changed") })
                AssistChip(onClick = {}, label = { Text("${gitDiff?.lineCount ?: 0} lines") })
            }
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Text(text = title, style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(8.dp))
            content()
        }
    }
}

@Composable
private fun WorkspaceFileRow(item: WorkspaceFileItem, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "${if (item.type == "directory") "DIR" else "FILE"}  ${item.path}",
            style = MaterialTheme.typography.bodySmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = if (item.type == "directory") "" else formatSize(item.size),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun GitFileRow(
    item: GitStatusItem,
    gitActionRunning: Boolean,
    onStage: () -> Unit,
    onUnstage: () -> Unit,
    onRestore: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = item.status.ifBlank { "M" },
                style = MaterialTheme.typography.labelMedium,
                fontFamily = FontFamily.Monospace,
                color = statusColor(item.status),
            )
            Text(
                text = item.path.ifBlank { item.oldPath },
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (item.additions != 0 || item.deletions != 0) {
                Text(
                    text = "+${item.additions} -${item.deletions}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                OutlinedButton(onClick = onStage, enabled = !gitActionRunning) { Text("Stage") }
            }
            item {
                OutlinedButton(onClick = onUnstage, enabled = !gitActionRunning) { Text("Unstage") }
            }
            item {
                OutlinedButton(onClick = onRestore, enabled = !gitActionRunning) { Text("Restore") }
            }
        }
    }
}

@Composable
private fun CommandResultView(result: CommandResult) {
    val output = listOf(result.stdout.trim(), result.stderr.trim()).filter { it.isNotBlank() }.joinToString("\n")
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AssistChip(onClick = {}, label = { Text("exit ${result.exitCode}") })
        if (output.isBlank()) {
            MutedText("Command finished without output.")
        } else {
            CodeBlock(text = output.take(8000), maxLines = 80)
        }
    }
}

@Composable
private fun CodeBlock(text: String, maxLines: Int) {
    Text(
        text = text,
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
            .padding(10.dp),
        style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
    )
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

@Composable
private fun EmptyWorkspaceState(modifier: Modifier = Modifier) {
    Column(modifier = modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("No workspaces", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(6.dp))
        MutedText("The bridge has not exposed a workspace yet.")
    }
}

@Composable
private fun MutedText(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun statusColor(status: String) = when {
    status.contains("D") -> MaterialTheme.colorScheme.error
    status.contains("A") || status.contains("??") -> MaterialTheme.colorScheme.secondary
    else -> MaterialTheme.colorScheme.primary
}

private fun formatSize(size: Long): String = when {
    size >= 1024 * 1024 -> "${size / (1024 * 1024)} MB"
    size >= 1024 -> "${size / 1024} KB"
    else -> "$size B"
}