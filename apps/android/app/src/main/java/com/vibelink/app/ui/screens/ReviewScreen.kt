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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.WorkspaceItem

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun ReviewScreen(apiClient: ApiClient, viewModel: ReviewViewModel, onBack: () -> Unit) {
    val workspaces by viewModel.workspaces.collectAsState()
    val selectedWorkspace by viewModel.selectedWorkspace.collectAsState()
    val reviews by viewModel.reviews.collectAsState()
    val selectedReview by viewModel.selectedReview.collectAsState()
    val diff by viewModel.diff.collectAsState()
    val severity by viewModel.severity.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val error by viewModel.error.collectAsState()
    var workspaceMenu by remember { mutableStateOf(false) }
    var title by remember { mutableStateOf("") }
    var branch by remember { mutableStateOf("") }
    var commentFile by remember { mutableStateOf("") }
    var commentLine by remember { mutableStateOf(0) }
    var commentText by remember { mutableStateOf("") }
    var commentSeverity by remember { mutableStateOf("medium") }
    var commentDialog by remember { mutableStateOf(false) }
    var selectedFilePath by remember { mutableStateOf("") }

    LaunchedEffect(Unit) { viewModel.load(apiClient) }
    Scaffold(topBar = { TopAppBar(title = { Text("PR Review") }, navigationIcon = { TextButton(onClick = onBack) { Text("Back") } }) }) { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Review setup", style = MaterialTheme.typography.titleMedium)
                        Box {
                            Button(onClick = { workspaceMenu = true }, modifier = Modifier.fillMaxWidth()) { Text(selectedWorkspace?.title?.ifBlank { selectedWorkspace?.id ?: "Choose Workspace" } ?: "Choose Workspace") }
                            DropdownMenu(expanded = workspaceMenu, onDismissRequest = { workspaceMenu = false }) {
                                workspaces.forEach { workspace ->
                                    DropdownMenuItem(text = { Text(workspace.title.ifBlank { workspace.id }) }, onClick = { workspaceMenu = false; viewModel.selectWorkspace(apiClient, workspace) })
                                }
                            }
                        }
                        OutlinedTextField(value = branch.ifBlank { diff?.branch.orEmpty() }, onValueChange = { branch = it }, label = { Text("Branch") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                        OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Review title") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                        Button(onClick = { viewModel.createReview(apiClient, title, branch) }, enabled = selectedWorkspace != null && !loading) { Text("Create or save review") }
                    }
                }
            }
            if (error.isNotBlank()) item { Text(error, color = MaterialTheme.colorScheme.error) }
            if (reviews.isNotEmpty()) {
                item { Text("Saved reviews", style = MaterialTheme.typography.titleMedium) }
                items(reviews, key = { it.id }) { review ->
                    ListItem(headlineContent = { Text(review.title) }, supportingContent = { Text("${review.branch} · ${review.status} · ${review.comments.size} comments") }, modifier = Modifier.clickable { viewModel.selectReview(apiClient, review) })
                }
            }
            selectedReview?.let { review ->
                item { Text("${review.title} · ${review.status}", style = MaterialTheme.typography.titleMedium) }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("all", "critical", "high", "medium", "low", "info").forEach { value -> AssistChip(onClick = { viewModel.setSeverity(value) }, label = { Text(value) }) }
                    }
                }
                val files = diff?.files.orEmpty()
                if (files.isEmpty()) item { Text("No changed files on this branch") }
                items(files, key = { it.path }) { file ->
                    Card(modifier = Modifier.fillMaxWidth().clickable { selectedFilePath = file.path }) {
                        Column(Modifier.padding(12.dp)) {
                            Text(file.path, style = MaterialTheme.typography.titleSmall)
                            Text("${file.status}  +${file.additions} / -${file.deletions}")
                            if (selectedFilePath == file.path) {
                                val lines = diff?.diff.orEmpty().lineSequence().toList()
                                val start = lines.indexOfFirst { it == "+++ b/${file.path}" }
                                val end = if (start >= 0) lines.drop(start + 1).indexOfFirst { it.startsWith("diff --git ") }.let { if (it < 0) lines.size else start + 1 + it } else lines.size
                                val fileLines = if (start >= 0) lines.subList(start + 1, end) else emptyList()
                                fileLines.take(240).forEachIndexed { index, line ->
                                    Text(
                                        text = "${index + 1}: $line",
                                        modifier = Modifier.fillMaxWidth().clickable { commentFile = file.path; commentLine = index + 1; commentDialog = true }.padding(vertical = 2.dp),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = if (line.startsWith("+")) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                    )
                                }
                            }
                        }
                    }
                }
                val visibleComments = viewModel.visibleComments()
                if (visibleComments.isNotEmpty()) {
                    item { Text("Comments", style = MaterialTheme.typography.titleMedium) }
                    items(visibleComments, key = { it.id }) { comment ->
                        ListItem(headlineContent = { Text("${comment.file}:${comment.line} · ${comment.severity}") }, supportingContent = { Text(comment.body) })
                    }
                }
            }
        }
    }

    if (commentDialog) {
        AlertDialog(
            onDismissRequest = { commentDialog = false },
            title = { Text("Add line comment") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("$commentFile:$commentLine")
                    OutlinedTextField(value = commentText, onValueChange = { commentText = it }, label = { Text("Comment") }, minLines = 3)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { listOf("critical", "high", "medium", "low", "info").forEach { value -> AssistChip(onClick = { commentSeverity = value }, label = { Text(value) }) } }
                }
            },
            confirmButton = { TextButton(onClick = { viewModel.addComment(apiClient, commentFile, commentLine, commentText, commentSeverity); commentText = ""; commentDialog = false }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { commentDialog = false }) { Text("Cancel") } },
        )
    }
}
