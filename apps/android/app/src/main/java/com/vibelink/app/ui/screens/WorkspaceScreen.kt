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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DriveFileRenameOutline
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Save
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
import androidx.compose.material3.HorizontalDivider
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
import com.vibelink.app.network.TestLocation
import com.vibelink.app.network.WorkspaceFileItem
import com.vibelink.app.network.WorkspaceFileResponse
import com.vibelink.app.network.WorkspaceItem
import com.vibelink.app.ui.i18n.LocalAppStrings

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(
    apiClient: ApiClient,
    viewModel: WorkspaceViewModel,
    onOpenApprovals: () -> Unit,
    onBack: () -> Unit,
) {
    val strings = LocalAppStrings.current
    val workspaces by viewModel.workspaces.collectAsState()
    val selectedWorkspaceId by viewModel.selectedWorkspaceId.collectAsState()
    val currentDir by viewModel.currentDir.collectAsState()
    val files by viewModel.files.collectAsState()
    val selectedFile by viewModel.selectedFile.collectAsState()
    val gitStatus by viewModel.gitStatus.collectAsState()
    val gitDiff by viewModel.gitDiff.collectAsState()
    val commandResult by viewModel.commandResult.collectAsState()
    val testResult by viewModel.testResult.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val refreshing by viewModel.refreshing.collectAsState()
    val commandRunning by viewModel.commandRunning.collectAsState()
    val gitActionRunning by viewModel.gitActionRunning.collectAsState()
    val terminal by viewModel.terminal.collectAsState()
    val pendingApproval by viewModel.pendingApproval.collectAsState()
    val error by viewModel.error.collectAsState()

    var command by remember { mutableStateOf("git status --short --branch") }
    var testCommand by remember { mutableStateOf("npm test") }
    var commitMessage by remember { mutableStateOf("") }
    val selectedWorkspace = workspaces.firstOrNull { it.id == selectedWorkspaceId }

    LaunchedEffect(Unit) {
        viewModel.load(apiClient)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(strings.workspace) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = strings.back)
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.refreshSelected(apiClient) }) {
                        if (refreshing) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(Icons.Default.Refresh, contentDescription = strings.refresh)
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
                    terminal = terminal,
                    command = command,
                    refreshing = refreshing,
                    commandRunning = commandRunning,
                    gitActionRunning = gitActionRunning,
                    commandResult = commandResult,
                    testResult = testResult,
                    error = error,
                    pendingApproval = pendingApproval,
                    onOpenApprovals = onOpenApprovals,
                    onCommandChange = { command = it },
                    testCommand = testCommand,
                    onTestCommandChange = { testCommand = it },
                    commitMessage = commitMessage,
                    onCommitMessageChange = { commitMessage = it },
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
    terminal: WorkspaceTerminalUiState,
    command: String,
    refreshing: Boolean,
    commandRunning: Boolean,
    gitActionRunning: Boolean,
    commandResult: CommandResult?,
    testResult: CommandResult?,
    error: String,
    pendingApproval: WorkspaceApprovalNotice?,
    onOpenApprovals: () -> Unit,
    onCommandChange: (String) -> Unit,
    testCommand: String,
    onTestCommandChange: (String) -> Unit,
    commitMessage: String,
    onCommitMessageChange: (String) -> Unit,
) {
    var fileQuery by remember(selectedWorkspaceId, currentDir) { mutableStateOf("") }
    var fileLimit by remember(selectedWorkspaceId, currentDir, fileQuery) { mutableStateOf(40) }
    var changedLimit by remember(selectedWorkspaceId, changedFiles.size) { mutableStateOf(32) }
    var showFullDiff by remember(selectedWorkspaceId, gitDiff?.diff) { mutableStateOf(false) }
    var newFilePath by remember(selectedWorkspaceId, currentDir) { mutableStateOf("") }
    var newFileText by remember(selectedWorkspaceId, currentDir) { mutableStateOf("") }
    var worktreeBranch by remember(selectedWorkspaceId) { mutableStateOf("") }
    var worktreeBaseRef by remember(selectedWorkspaceId) { mutableStateOf("HEAD") }
    var worktreeTitle by remember(selectedWorkspaceId) { mutableStateOf("") }
    var branchName by remember(selectedWorkspaceId) { mutableStateOf("") }
    var branchBaseRef by remember(selectedWorkspaceId) { mutableStateOf("HEAD") }
    var stashMessage by remember(selectedWorkspaceId) { mutableStateOf("") }
    var terminalShell by remember(selectedWorkspaceId) { mutableStateOf("") }
    var terminalInput by remember(selectedWorkspaceId, terminal.sessionId) { mutableStateOf("") }
    val diffHunks = remember(gitDiff?.diff) { parseWorkspaceDiffHunks(gitDiff?.diff.orEmpty()) }
    val filteredFiles = remember(files, fileQuery) {
        val query = fileQuery.trim()
        if (query.isBlank()) files else files.filter { item ->
            item.path.contains(query, ignoreCase = true) || item.name.contains(query, ignoreCase = true)
        }
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (error.isNotBlank()) {
            item {
                ErrorCard(
                    message = error,
                    actionText = if (pendingApproval == null) "" else "Open approvals",
                    onAction = onOpenApprovals,
                )
            }
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
                    ) { Text(ws("上一级", "Up")) }
                }
                if (files.isEmpty()) {
                    MutedText(ws("此目录中没有文件。", "No files in this directory."))
                } else {
                    OutlinedTextField(
                        value = fileQuery,
                        onValueChange = { fileQuery = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(ws("搜索此文件夹中的文件", "Search files in this folder")) },
                        singleLine = true,
                    )
                    Spacer(Modifier.height(8.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        filteredFiles.take(fileLimit).forEach { item ->
                            WorkspaceFileRow(
                                item = item,
                                onClick = {
                                    if (item.type == "directory") viewModel.openDirectory(apiClient, item.path)
                                    else viewModel.openFile(apiClient, item.path)
                                },
                            )
                        }
                    }
                    ListLimitFooter(
                        visible = filteredFiles.size.coerceAtMost(fileLimit),
                        total = filteredFiles.size,
                        onShowMore = { fileLimit += 40 },
                    )
                }
                Spacer(Modifier.height(10.dp))
                WorkspaceFileCreateForm(
                    path = newFilePath,
                    text = newFileText,
                    enabled = !refreshing && selectedWorkspaceId.isNotBlank(),
                    onPathChange = { newFilePath = it },
                    onTextChange = { newFileText = it },
                    onCreate = {
                        viewModel.mutateFile(
                            apiClient = apiClient,
                            action = "write",
                            path = newFilePath,
                            text = newFileText,
                        )
                        newFilePath = ""
                        newFileText = ""
                    },
                )
            }
        }

        selectedFile?.let { file ->
            item {
                WorkspaceFilePreviewCard(
                    file = file,
                    busy = refreshing,
                    onClose = viewModel::clearFilePreview,
                    onSave = { text -> viewModel.mutateFile(apiClient, "write", file.path, text) },
                    onRename = { nextPath -> viewModel.mutateFile(apiClient, "rename", file.path, nextPath = nextPath) },
                    onDelete = { viewModel.mutateFile(apiClient, "delete", file.path) },
                )
            }
        }

        item {
            SectionCard(title = "Git Changes") {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    item {
                        OutlinedButton(
                            onClick = { viewModel.applyGitAction(apiClient, "stage-all") },
                            enabled = !gitActionRunning && selectedWorkspaceId.isNotBlank(),
                        ) { Text(ws("暂存全部", "Stage all")) }
                    }
                    item {
                        OutlinedButton(
                            onClick = { viewModel.applyGitAction(apiClient, "unstage-all") },
                            enabled = !gitActionRunning && selectedWorkspaceId.isNotBlank(),
                        ) { Text(ws("取消暂存全部", "Unstage all")) }
                    }
                    item {
                        OutlinedButton(
                            onClick = { viewModel.applyGitAction(apiClient, "pull") },
                            enabled = !gitActionRunning && selectedWorkspaceId.isNotBlank(),
                        ) { Text(ws("拉取", "Pull")) }
                    }
                    item {
                        OutlinedButton(
                            onClick = { viewModel.applyGitAction(apiClient, "push") },
                            enabled = !gitActionRunning && selectedWorkspaceId.isNotBlank(),
                        ) { Text(ws("推送", "Push")) }
                    }
                    item {
                        OutlinedButton(
                            onClick = { viewModel.applyGitAction(apiClient, "pr") },
                            enabled = !gitActionRunning && selectedWorkspaceId.isNotBlank(),
                        ) { Text(ws("拉取请求", "PR")) }
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = commitMessage,
                    onValueChange = onCommitMessageChange,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(ws("提交说明", "Commit message")) },
                    singleLine = true,
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(
                        onClick = { viewModel.applyGitAction(apiClient, "commit", message = commitMessage.trim()) },
                        enabled = !gitActionRunning && selectedWorkspaceId.isNotBlank() && commitMessage.trim().isNotBlank(),
                    ) { Text(ws("提交", "Commit")) }
                    if (gitActionRunning) CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                }
                Spacer(Modifier.height(10.dp))
                WorkspaceWorktreeForm(
                    branchName = worktreeBranch,
                    baseRef = worktreeBaseRef,
                    title = worktreeTitle,
                    enabled = !gitActionRunning && selectedWorkspaceId.isNotBlank(),
                    onBranchNameChange = { worktreeBranch = it },
                    onBaseRefChange = { worktreeBaseRef = it },
                    onTitleChange = { worktreeTitle = it },
                    onCreate = {
                        viewModel.createWorktree(apiClient, worktreeBranch, worktreeBaseRef, worktreeTitle)
                        worktreeBranch = ""
                        worktreeBaseRef = "HEAD"
                        worktreeTitle = ""
                    },
                )
                Spacer(Modifier.height(10.dp))
                WorkspaceBranchStashForm(
                    branchName = branchName,
                    baseRef = branchBaseRef,
                    stashMessage = stashMessage,
                    enabled = !gitActionRunning && selectedWorkspaceId.isNotBlank(),
                    onBranchNameChange = { branchName = it },
                    onBaseRefChange = { branchBaseRef = it },
                    onStashMessageChange = { stashMessage = it },
                    onCreateBranch = {
                        viewModel.applyGitAction(
                            apiClient,
                            "branch-create",
                            branchName = branchName.trim(),
                            baseRef = branchBaseRef.trim().ifBlank { "HEAD" },
                        )
                    },
                    onSwitchBranch = {
                        viewModel.applyGitAction(apiClient, "branch-switch", branchName = branchName.trim())
                    },
                    onStashPush = {
                        viewModel.applyGitAction(apiClient, "stash-push", message = stashMessage.trim())
                        stashMessage = ""
                    },
                    onStashPop = { viewModel.applyGitAction(apiClient, "stash-pop") },
                )
                Spacer(Modifier.height(8.dp))
                if (changedFiles.isEmpty()) {
                    MutedText(ws("工作树干净，或 Git 不可用。", "Working tree is clean or Git is unavailable."))
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        changedFiles.take(changedLimit).forEach { item ->
                            GitFileRow(
                                item = item,
                                gitActionRunning = gitActionRunning,
                                onStage = { viewModel.applyGitFileAction(apiClient, item.path.ifBlank { item.oldPath }, "stage") },
                                onUnstage = { viewModel.applyGitFileAction(apiClient, item.path.ifBlank { item.oldPath }, "unstage") },
                                onRestore = { viewModel.applyGitFileAction(apiClient, item.path.ifBlank { item.oldPath }, "restore") },
                                onUseOurs = { viewModel.applyGitFileAction(apiClient, item.path.ifBlank { item.oldPath }, "use-ours") },
                                onUseTheirs = { viewModel.applyGitFileAction(apiClient, item.path.ifBlank { item.oldPath }, "use-theirs") },
                                onMarkResolved = { viewModel.applyGitFileAction(apiClient, item.path.ifBlank { item.oldPath }, "mark-resolved") },
                            )
                        }
                    }
                    ListLimitFooter(
                        visible = changedFiles.size.coerceAtMost(changedLimit),
                        total = changedFiles.size,
                        onShowMore = { changedLimit += 32 },
                    )
                }
            }
        }

        item {
            SectionCard(title = "Diff Preview") {
                val diff = gitDiff?.diff.orEmpty().trim()
                if (diff.isBlank()) {
                    MutedText(ws("没有差异预览。", "No diff preview."))
                } else {
                    val truncated = diff.length > 8000 && !showFullDiff
                    CodeBlock(text = if (showFullDiff) diff else diff.take(8000), maxLines = if (showFullDiff) 400 else 80)
                    if (diffHunks.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        DiffHunkPanel(
                            hunks = diffHunks.take(12),
                            enabled = !gitActionRunning && selectedWorkspaceId.isNotBlank(),
                            onStageHunk = { hunk ->
                                viewModel.applyGitFileAction(apiClient, hunk.path, "stage-hunk", patch = hunk.patch)
                            },
                        )
                    }
                    if (truncated) {
                        Spacer(Modifier.height(8.dp))
                        MutedText(ws("差异预览已截断至 8000 个字符。", "Diff preview is truncated at 8000 characters."))
                        TextButton(onClick = { showFullDiff = true }) { Text(ws("显示完整差异", "Show full diff")) }
                    } else if (showFullDiff && diff.length > 8000) {
                        TextButton(onClick = { showFullDiff = false }) { Text(ws("折叠差异", "Collapse diff")) }
                    }
                }
            }
        }

        item {
            SectionCard(title = "Test") {
                OutlinedTextField(
                    value = testCommand,
                    onValueChange = onTestCommandChange,
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 1,
                    maxLines = 3,
                    label = { Text(ws("测试命令", "Test command")) },
                    singleLine = false,
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = { viewModel.runCommand(apiClient, testCommand, kind = "test") },
                    enabled = testCommand.isNotBlank() && !commandRunning && selectedWorkspaceId.isNotBlank(),
                ) {
                    if (commandRunning) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Default.PlayArrow, contentDescription = null)
                    }
                    Spacer(Modifier.size(8.dp))
                    Text(if (commandRunning) "Running" else "Run tests")
                }
                testResult?.let { result ->
                    Spacer(Modifier.height(10.dp))
                    TestResultView(
                        result = result,
                        enabled = !commandRunning,
                        onOpenLocation = { location ->
                            if (location.path.isNotBlank()) viewModel.openFileReference(apiClient, location.path)
                        },
                        onRerun = { rerun -> viewModel.runCommand(apiClient, rerun, kind = "test") },
                    )
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
                    label = { Text(ws("命令", "Command")) },
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

        item {
            WorkspaceTerminalCard(
                terminal = terminal,
                shell = terminalShell,
                input = terminalInput,
                enabled = selectedWorkspaceId.isNotBlank(),
                onShellChange = { terminalShell = it },
                onInputChange = { terminalInput = it },
                onStart = { viewModel.startTerminal(apiClient, terminalShell) },
                onSendInput = {
                    viewModel.sendTerminalInput(apiClient, terminalInput)
                    terminalInput = ""
                },
                onResize = { viewModel.resizeTerminal(apiClient, 120, 36) },
                onStop = { viewModel.stopTerminal(apiClient) },
            )
        }
    }
}

@Composable
private fun WorkspaceFileCreateForm(
    path: String,
    text: String,
    enabled: Boolean,
    onPathChange: (String) -> Unit,
    onTextChange: (String) -> Unit,
    onCreate: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(ws("创建或替换文件", "Create or replace file"), style = MaterialTheme.typography.labelMedium)
        OutlinedTextField(
            value = path,
            onValueChange = onPathChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(ws("路径", "Path")) },
            singleLine = true,
        )
        OutlinedTextField(
            value = text,
            onValueChange = onTextChange,
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
            maxLines = 8,
            label = { Text(ws("文本", "Text")) },
            singleLine = false,
        )
        Button(
            onClick = onCreate,
            enabled = enabled && path.trim().isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.Default.Add, contentDescription = null)
            Spacer(Modifier.size(8.dp))
            Text(ws("写入文件", "Write file"))
        }
    }
}

@Composable
private fun WorkspaceFilePreviewCard(
    file: WorkspaceFileResponse,
    busy: Boolean,
    onClose: () -> Unit,
    onSave: (String) -> Unit,
    onRename: (String) -> Unit,
    onDelete: () -> Unit,
) {
    var editing by remember(file.path, file.updatedAt) { mutableStateOf(false) }
    var draftText by remember(file.path, file.text) { mutableStateOf(file.text) }
    var renamePath by remember(file.path) { mutableStateOf(file.path) }
    var deleteArmed by remember(file.path) { mutableStateOf(false) }

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
            IconButton(onClick = onClose) {
                Icon(Icons.Default.Close, contentDescription = ws("关闭预览", "Close preview"))
            }
        }
        if (file.binary) {
            MutedText(ws("二进制文件或大文件无法预览。", "Binary or large file; preview is unavailable."))
            return@SectionCard
        }

        OutlinedTextField(
            value = renamePath,
            onValueChange = { renamePath = it; deleteArmed = false },
            modifier = Modifier.fillMaxWidth(),
            label = { Text(ws("路径", "Path")) },
            singleLine = true,
        )
        Spacer(Modifier.height(8.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                OutlinedButton(
                    onClick = { editing = !editing; deleteArmed = false },
                    enabled = !busy,
                ) {
                    Icon(Icons.Default.Edit, contentDescription = null)
                    Spacer(Modifier.size(8.dp))
                    Text(if (editing) "Preview" else "Edit")
                }
            }
            item {
                OutlinedButton(
                    onClick = { onRename(renamePath); deleteArmed = false },
                    enabled = !busy && renamePath.trim().isNotBlank() && renamePath.trim() != file.path,
                ) {
                    Icon(Icons.Default.DriveFileRenameOutline, contentDescription = null)
                    Spacer(Modifier.size(8.dp))
                    Text(ws("重命名", "Rename"))
                }
            }
            item {
                Button(
                    onClick = { onSave(draftText); editing = false; deleteArmed = false },
                    enabled = !busy && editing,
                ) {
                    Icon(Icons.Default.Save, contentDescription = null)
                    Spacer(Modifier.size(8.dp))
                    Text(ws("保存", "Save"))
                }
            }
            item {
                OutlinedButton(
                    onClick = {
                        if (deleteArmed) onDelete() else deleteArmed = true
                    },
                    enabled = !busy,
                ) {
                    Icon(Icons.Default.Delete, contentDescription = null)
                    Spacer(Modifier.size(8.dp))
                    Text(if (deleteArmed) "Confirm delete" else "Delete")
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        if (editing) {
            OutlinedTextField(
                value = draftText,
                onValueChange = { draftText = it; deleteArmed = false },
                modifier = Modifier.fillMaxWidth(),
                minLines = 8,
                maxLines = 20,
                label = { Text(ws("文件文本", "File text")) },
                singleLine = false,
            )
        } else if (file.text.isBlank()) {
            MutedText(ws("文本文件为空。", "Text file is empty."))
        } else {
            CodeBlock(text = file.text.take(12000), maxLines = 120)
        }
    }
}

@Composable
private fun WorkspaceWorktreeForm(
    branchName: String,
    baseRef: String,
    title: String,
    enabled: Boolean,
    onBranchNameChange: (String) -> Unit,
    onBaseRefChange: (String) -> Unit,
    onTitleChange: (String) -> Unit,
    onCreate: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(ws("创建工作树", "Create worktree"), style = MaterialTheme.typography.labelMedium)
        OutlinedTextField(
            value = branchName,
            onValueChange = onBranchNameChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(ws("分支", "Branch")) },
            singleLine = true,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = baseRef,
                onValueChange = onBaseRefChange,
                modifier = Modifier.weight(1f),
                label = { Text(ws("基准", "Base")) },
                singleLine = true,
            )
            OutlinedButton(
                onClick = onCreate,
                enabled = enabled && branchName.trim().isNotBlank(),
            ) { Text(ws("创建", "Create")) }
        }
        OutlinedTextField(
            value = title,
            onValueChange = onTitleChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(ws("标题", "Title")) },
            singleLine = true,
        )
    }
}

@Composable
private fun WorkspaceBranchStashForm(
    branchName: String,
    baseRef: String,
    stashMessage: String,
    enabled: Boolean,
    onBranchNameChange: (String) -> Unit,
    onBaseRefChange: (String) -> Unit,
    onStashMessageChange: (String) -> Unit,
    onCreateBranch: () -> Unit,
    onSwitchBranch: () -> Unit,
    onStashPush: () -> Unit,
    onStashPop: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(ws("分支与暂存区", "Branch and stash"), style = MaterialTheme.typography.labelMedium)
        OutlinedTextField(
            value = branchName,
            onValueChange = onBranchNameChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(ws("分支名称", "Branch name")) },
            singleLine = true,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = baseRef,
                onValueChange = onBaseRefChange,
                modifier = Modifier.weight(1f),
                label = { Text(ws("基准", "Base")) },
                singleLine = true,
            )
            OutlinedButton(
                onClick = onCreateBranch,
                enabled = enabled && branchName.trim().isNotBlank(),
            ) { Text(ws("创建", "Create")) }
            OutlinedButton(
                onClick = onSwitchBranch,
                enabled = enabled && branchName.trim().isNotBlank(),
            ) { Text(ws("切换", "Switch")) }
        }
        OutlinedTextField(
            value = stashMessage,
            onValueChange = onStashMessageChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(ws("暂存说明", "Stash message")) },
            singleLine = true,
        )
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                OutlinedButton(onClick = onStashPush, enabled = enabled) { Text(ws("暂存", "Stash")) }
            }
            item {
                OutlinedButton(onClick = onStashPop, enabled = enabled) { Text(ws("恢复暂存", "Pop stash")) }
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
                AssistChip(onClick = {}, label = { Text(ws("${gitDiff?.changedCount ?: 0} 个变更", "${gitDiff?.changedCount ?: 0} changed")) })
                AssistChip(onClick = {}, label = { Text(ws("${gitDiff?.lineCount ?: 0} 行", "${gitDiff?.lineCount ?: 0} lines")) })
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
            .heightIn(min = 48.dp)
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
    onUseOurs: () -> Unit,
    onUseTheirs: () -> Unit,
    onMarkResolved: () -> Unit,
) {
    val conflict = isConflictStatus(item.status)
    Column(modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
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
                OutlinedButton(onClick = onStage, enabled = !gitActionRunning) { Text(ws("暂存", "Stage")) }
            }
            item {
                OutlinedButton(onClick = onUnstage, enabled = !gitActionRunning) { Text(ws("取消暂存", "Unstage")) }
            }
            item {
                OutlinedButton(onClick = onRestore, enabled = !gitActionRunning) { Text(ws("还原", "Restore")) }
            }
            if (conflict) {
                item {
                    OutlinedButton(onClick = onUseOurs, enabled = !gitActionRunning) { Text(ws("使用本地版本", "Ours")) }
                }
                item {
                    OutlinedButton(onClick = onUseTheirs, enabled = !gitActionRunning) { Text(ws("使用远端版本", "Theirs")) }
                }
                item {
                    OutlinedButton(onClick = onMarkResolved, enabled = !gitActionRunning) { Text(ws("标记已解决", "Resolved")) }
                }
            }
        }
    }
}

@Composable
private fun DiffHunkPanel(
    hunks: List<WorkspaceDiffHunk>,
    enabled: Boolean,
    onStageHunk: (WorkspaceDiffHunk) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(ws("差异块", "Hunks"), style = MaterialTheme.typography.labelMedium)
        hunks.forEachIndexed { index, hunk ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "${index + 1}. ${hunk.path} ${hunk.header}",
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                OutlinedButton(onClick = { onStageHunk(hunk) }, enabled = enabled) { Text(ws("暂存", "Stage")) }
            }
        }
    }
}

@Composable
private fun WorkspaceTerminalCard(
    terminal: WorkspaceTerminalUiState,
    shell: String,
    input: String,
    enabled: Boolean,
    onShellChange: (String) -> Unit,
    onInputChange: (String) -> Unit,
    onStart: () -> Unit,
    onSendInput: () -> Unit,
    onResize: () -> Unit,
    onStop: () -> Unit,
) {
    SectionCard(title = "Terminal") {
        OutlinedTextField(
            value = shell,
            onValueChange = onShellChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(ws("Shell", "Shell")) },
            singleLine = true,
        )
        Spacer(Modifier.height(8.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Button(
                    onClick = onStart,
                    enabled = enabled && terminal.status !in setOf("running", "starting", "pending", "approval_required"),
                ) {
                    Icon(Icons.Default.PlayArrow, contentDescription = null)
                    Spacer(Modifier.size(8.dp))
                    Text(ws("启动", "Start"))
                }
            }
            item {
                OutlinedButton(
                    onClick = onResize,
                    enabled = terminal.sessionId.isNotBlank() && terminal.supportsResize,
                ) { Text("120x36") }
            }
            item {
                OutlinedButton(
                    onClick = onStop,
                    enabled = terminal.sessionId.isNotBlank() && terminal.status in setOf("running", "starting", "pending"),
                ) { Text(ws("停止", "Stop")) }
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            AssistChip(onClick = {}, label = { Text(terminal.status.ifBlank { "idle" }) })
            if (terminal.mode.isNotBlank()) AssistChip(onClick = {}, label = { Text(terminal.mode) })
        }
        if (terminal.output.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            CodeBlock(text = terminal.output, maxLines = 120)
        }
        if (terminal.sessionId.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = input,
                onValueChange = onInputChange,
                modifier = Modifier.fillMaxWidth(),
                minLines = 1,
                maxLines = 4,
                label = { Text(ws("输入", "Input")) },
                singleLine = false,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = onSendInput,
                enabled = input.isNotBlank() && terminal.status in setOf("running", "starting", "pending"),
            ) { Text(ws("发送", "Send")) }
        }
    }
}

@Composable
private fun CommandResultView(result: CommandResult) {
    val output = listOf(result.stdout.trim(), result.stderr.trim()).filter { it.isNotBlank() }.joinToString("\n")
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AssistChip(onClick = {}, label = { Text(ws("退出码 ${result.exitCode}", "exit ${result.exitCode}")) })
        result.test?.let { summary ->
            AssistChip(onClick = {}, label = { Text(ws("${summary.passed} 项通过 / ${summary.failed} 项失败", "${summary.passed} passed / ${summary.failed} failed")) })
            if (summary.failures.isNotEmpty()) {
                CodeBlock(text = summary.failures.joinToString("\n"), maxLines = 20)
            }
        }
        if (output.isBlank()) {
            MutedText(ws("命令已完成，没有输出。", "Command finished without output."))
        } else {
            CodeBlock(text = output.take(8000), maxLines = 80)
        }
    }
}

@Composable
private fun ListLimitFooter(visible: Int, total: Int, onShowMore: () -> Unit) {
    if (total <= 0) return
    Spacer(Modifier.height(6.dp))
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MutedText(ws("显示 $visible / $total", "Showing $visible of $total"))
        if (visible < total) TextButton(onClick = onShowMore) { Text(ws("显示更多", "Show more")) }
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
private fun ErrorCard(message: String, actionText: String = "", onAction: () -> Unit = {}) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
            Text(
                text = message,
                color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.bodySmall,
            )
            if (actionText.isNotBlank()) {
                TextButton(onClick = onAction) { Text(actionText) }
            }
        }
    }
}

@Composable
private fun EmptyWorkspaceState(modifier: Modifier = Modifier) {
    Column(modifier = modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(ws("没有工作区", "No workspaces"), style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(6.dp))
        MutedText(ws("Bridge 尚未提供工作区。", "The bridge has not exposed a workspace yet."))
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
private fun TestResultView(
    result: CommandResult,
    enabled: Boolean,
    onOpenLocation: (TestLocation) -> Unit,
    onRerun: (String) -> Unit,
) {
    val summary = result.test
    val output = listOf(result.stdout.trim(), result.stderr.trim()).filter { it.isNotBlank() }.joinToString("\n")
    if (summary == null) {
        CommandResultView(result)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            item { AssistChip(onClick = {}, label = { Text(if (summary.ok) ws("通过", "Passed") else ws("失败", "Failed")) }) }
            if (summary.runner.isNotBlank() && summary.runner != "unknown") item { AssistChip(onClick = {}, label = { Text(summary.runner) }) }
            item { AssistChip(onClick = {}, label = { Text("${summary.passed} passed") }) }
            item { AssistChip(onClick = {}, label = { Text("${summary.failed} failed") }) }
            item { AssistChip(onClick = {}, label = { Text("${summary.skipped} skipped") }) }
            durationLabel(summary.durationMs)?.let { duration -> item { AssistChip(onClick = {}, label = { Text(duration) }) } }
        }
        summary.suites.forEach { suite ->
            var expanded by remember(suite.name, suite.status) { mutableStateOf(suite.status == "fail") }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp)),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    TestStatusDot(suite.status)
                    Text(suite.name.ifBlank { "Test suite" }, modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
                    durationLabel(suite.durationMs)?.let { MutedText(it) }
                    Text(if (expanded) "−" else "+", style = MaterialTheme.typography.titleMedium)
                }
                if (expanded) {
                    if (suite.location.path.isNotBlank()) {
                        TextButton(onClick = { onOpenLocation(suite.location) }) { Text(locationLabel(suite.location)) }
                    }
                    suite.cases.forEachIndexed { index, testCase ->
                        if (index > 0) HorizontalDivider()
                        Row(
                            modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(10.dp),
                            verticalAlignment = Alignment.Top,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            TestStatusDot(testCase.status)
                            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(testCase.name.ifBlank { testCase.fullName }, style = MaterialTheme.typography.bodyMedium)
                                if (testCase.suite.isNotBlank()) MutedText(testCase.suite)
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                    if (testCase.location.path.isNotBlank()) {
                                        TextButton(onClick = { onOpenLocation(testCase.location) }, contentPadding = PaddingValues(0.dp)) {
                                            Text(locationLabel(testCase.location), style = MaterialTheme.typography.labelSmall)
                                        }
                                    }
                                    durationLabel(testCase.durationMs)?.let { MutedText(it) }
                                }
                                if (testCase.failure.isNotBlank()) CodeBlock(testCase.failure, maxLines = 30)
                            }
                            testCase.rerunCommand?.takeIf { it.isNotBlank() }?.let { rerun ->
                                IconButton(onClick = { onRerun(rerun) }, enabled = enabled) {
                                    Icon(Icons.Default.Refresh, contentDescription = ws("重跑失败用例", "Rerun failed test"))
                                }
                            }
                        }
                    }
                }
            }
        }
        if (summary.suites.isEmpty() && summary.failures.isNotEmpty()) CodeBlock(summary.failures.joinToString("\n"), maxLines = 30)
        if (output.isNotBlank()) CodeBlock(output.take(8000), maxLines = 80)
    }
}

@Composable
private fun TestStatusDot(status: String) {
    val color = when (status) {
        "pass" -> MaterialTheme.colorScheme.primary
        "fail" -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.outline
    }
    Box(modifier = Modifier.size(8.dp).background(color, RoundedCornerShape(4.dp)))
}

private fun durationLabel(value: Double?): String? {
    val duration = value?.takeIf { it.isFinite() && it >= 0 } ?: return null
    return if (duration < 1000) "${(duration * 10).toInt() / 10.0} ms" else "${(duration / 100).toInt() / 10.0} s"
}

private fun locationLabel(location: TestLocation): String = buildString {
    append(location.path)
    location.line?.let { append(":$it") }
    location.column?.let { append(":$it") }
}

@Composable
private fun ws(chinese: String, english: String): String =
    LocalAppStrings.current.text(chinese, english)

@Composable
private fun statusColor(status: String) = when {
    status.contains("D") -> MaterialTheme.colorScheme.error
    status.contains("A") || status.contains("??") -> MaterialTheme.colorScheme.secondary
    else -> MaterialTheme.colorScheme.primary
}

private fun isConflictStatus(status: String): Boolean {
    val trimmed = status.trim()
    return trimmed.contains("U") || trimmed in setOf("AA", "DD")
}

private fun formatSize(size: Long): String = when {
    size >= 1024 * 1024 -> "${size / (1024 * 1024)} MB"
    size >= 1024 -> "${size / 1024} KB"
    else -> "$size B"
}
