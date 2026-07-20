package com.vibelink.app.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ArtifactDocument
import com.vibelink.app.network.ArtifactStructuredPreview
import com.vibelink.app.ui.i18n.LocalAppStrings
import kotlinx.coroutines.launch

@Composable
fun ArtifactWorkbenchDialog(
    link: MessageContentUtils.ContentLink,
    apiClient: ApiClient,
    onDismiss: () -> Unit,
) {
    val strings = LocalAppStrings.current
    val scope = rememberCoroutineScope()
    val artifactId = remember(link.url) { artifactId(link.url) }
    var preview by remember(link.url) { mutableStateOf<ArtifactStructuredPreview?>(null) }
    var document by remember(link.url) { mutableStateOf<ArtifactDocument?>(null) }
    var loading by remember(link.url) { mutableStateOf(true) }
    var saving by remember(link.url) { mutableStateOf(false) }
    var error by remember(link.url) { mutableStateOf("") }
    var loadAttempt by remember(link.url) { mutableStateOf(0) }

    LaunchedEffect(artifactId, loadAttempt) {
        loading = true
        error = ""
        runCatching { apiClient.previewArtifact(artifactId) }
            .onSuccess { preview = it; document = it.document }
            .onFailure { error = it.message.orEmpty() }
        loading = false
    }

    fun save() {
        val current = preview ?: return
        val edited = document ?: return
        saving = true
        error = ""
        scope.launch {
            runCatching {
                if (edited.type == "table") apiClient.saveTableArtifact(artifactId, current.digest, edited)
                else apiClient.saveNotebookArtifact(artifactId, current.digest, edited.cells)
            }.onSuccess { preview = it; document = it.document }
                .onFailure { error = if ((it as? com.vibelink.app.network.ApiException)?.statusCode == 409) strings.text("文件已在其他设备修改，请关闭后重新打开。", "The artifact changed on another device. Close and reopen it.") else it.message.orEmpty() }
            saving = false
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            modifier = Modifier.fillMaxWidth(0.96f).fillMaxHeight(0.9f).widthIn(max = 900.dp),
            shape = MaterialTheme.shapes.medium,
        ) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        Text(link.label, style = MaterialTheme.typography.titleMedium)
                        Text("${preview?.kind ?: link.kind} · ${if (preview?.capabilities?.mutation == true) strings.text("可编辑", "editable") else strings.text("只读", "read-only")}", style = MaterialTheme.typography.bodySmall)
                    }
                    if (preview?.capabilities?.mutation == true) IconButton(onClick = ::save, enabled = !saving) { Icon(Icons.Default.Save, strings.save) }
                    IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, strings.close) }
                }
                if (error.isNotBlank()) { Text(ArtifactDisplayPolicy.fallbackMessage(error), color = MaterialTheme.colorScheme.error); OutlinedButton(onClick = { loadAttempt += 1 }) { Text(strings.text("重试", "Retry")) } }
                if (loading) CircularProgressIndicator()
                else document?.let { ArtifactDocumentView(it, preview?.capabilities?.mutation == true, onChange = { value -> document = value }) }
            }
        }
    }
}

@Composable
private fun ArtifactDocumentView(document: ArtifactDocument, editable: Boolean, onChange: (ArtifactDocument) -> Unit) {
    when (document.type) {
        "table" -> BoxWithConstraints(Modifier.fillMaxWidth()) {
          val visibleRows = ArtifactDisplayPolicy.visibleRows(maxWidth.value.toInt(), document.rows.size)
          Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            Column {
                Row { document.columns.forEach { Text(it, Modifier.widthIn(min = 120.dp).padding(8.dp), style = MaterialTheme.typography.labelMedium) } }
                document.rows.take(visibleRows).forEachIndexed { rowIndex, row ->
                    Row { row.forEachIndexed { columnIndex, cell ->
                        if (editable) OutlinedTextField(
                            value = cell,
                            onValueChange = { value -> onChange(document.copy(rows = document.rows.mapIndexed { index, item -> if (index == rowIndex) item.mapIndexed { cellIndex, old -> if (cellIndex == columnIndex) value else old } else item })) },
                            modifier = Modifier.widthIn(min = 120.dp, max = 220.dp),
                            singleLine = true,
                        ) else Text(cell, Modifier.widthIn(min = 120.dp).padding(8.dp))
                    } }
                }
                if (visibleRows < document.rows.size) Text("Showing $visibleRows of ${document.rows.size} rows", Modifier.padding(8.dp), style = MaterialTheme.typography.bodySmall)
            }
          }
        }
        "notebook" -> Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            document.cells.forEach { cell ->
                Text("${cell.type} · #${cell.index + 1}", style = MaterialTheme.typography.labelMedium)
                if (editable) OutlinedTextField(
                    value = cell.source,
                    onValueChange = { source -> onChange(document.copy(cells = document.cells.map { if (it.index == cell.index) it.copy(source = source) else it })) },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3,
                    textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                ) else Text(cell.source, fontFamily = FontFamily.Monospace)
                cell.outputs.forEach { Text(it.text, color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = FontFamily.Monospace) }
            }
        }
        "workbook" -> Column(Modifier.verticalScroll(rememberScrollState())) { document.sheets.forEach { sheet -> Text(sheet.name, style = MaterialTheme.typography.titleSmall); sheet.rows.forEach { Text(it.joinToString("  |  "), fontFamily = FontFamily.Monospace) } } }
        "document" -> Column(Modifier.verticalScroll(rememberScrollState())) { document.paragraphs.forEach { Text(it, Modifier.padding(vertical = 4.dp)) } }
        "presentation" -> Column(Modifier.verticalScroll(rememberScrollState())) { document.slides.forEachIndexed { index, slide -> Text("Slide ${index + 1}", style = MaterialTheme.typography.titleSmall); slide.paragraphs.forEach { Text(it, Modifier.padding(vertical = 3.dp)) } } }
        "pdf", "text" -> Text(document.text, Modifier.verticalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace)
        else -> Text(document.reason.ifBlank { "No structured preview is available." })
    }
}

object ArtifactDisplayPolicy {
    fun visibleRows(widthDp: Int, total: Int): Int = minOf(total, if (widthDp >= 600) 120 else 40)
    fun fallbackMessage(error: String): String = error.ifBlank { "Preview unavailable. Retry after checking the file." }
}

private fun artifactId(value: String): String {
    val clean = value.substringBefore('?').substringBefore('#').trimEnd('/', '\\')
    return clean.substringAfterLast('/').substringAfterLast('\\')
}
