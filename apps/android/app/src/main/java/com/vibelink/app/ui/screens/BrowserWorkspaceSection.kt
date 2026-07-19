package com.vibelink.app.ui.screens

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.BrowserPageInfo
import com.vibelink.app.network.BrowserSessionInfo
import com.vibelink.app.ui.i18n.LocalAppStrings

@Composable
fun BrowserWorkspaceSection(
    state: BrowserWorkspaceUiState,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onCloseSession: () -> Unit,
    onSelectSession: (String) -> Unit,
    onSelectPage: (String) -> Unit,
    onCreatePage: () -> Unit,
    onNavigate: (String) -> Unit,
    onScreenshot: () -> Unit,
) {
    val strings = LocalAppStrings.current
    val selected = state.sessions.firstOrNull { it.id == state.sessionId }
    val pages = selected?.pages.orEmpty().filter { it.status != "closed" }
    var address by remember(state.sessionId, state.pageId) {
        mutableStateOf(pages.firstOrNull { it.id == state.pageId }?.url?.takeUnless { it == "about:blank" }.orEmpty())
    }

    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(strings.text("托管浏览器", "Managed browser"), style = MaterialTheme.typography.titleMedium)
                    Text(strings.text("遥控 Bridge 托管的 Chromium，并查看脱敏 trace。", "Control bridge-owned Chromium and inspect redacted traces."), style = MaterialTheme.typography.bodySmall)
                }
                IconButton(onClick = onRefresh, enabled = state.busy.isBlank()) { Icon(Icons.Default.Refresh, strings.refresh) }
                IconButton(onClick = onCreateSession, enabled = state.busy.isBlank()) { Icon(Icons.Default.Add, strings.text("新建会话", "New session")) }
                IconButton(onClick = onCloseSession, enabled = state.busy.isBlank() && selected != null) { Icon(Icons.Default.Delete, strings.text("关闭会话", "Close session")) }
            }
            if (state.error.isNotBlank()) Text(state.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            if (selected == null) {
                Text(strings.text("尚无浏览器会话。", "No browser session."), style = MaterialTheme.typography.bodyMedium)
                Button(onClick = onCreateSession, enabled = state.busy.isBlank()) { Text(strings.text("创建会话", "Create session")) }
            } else {
                BrowserSelector(strings.text("会话", "Session"), selected.id, state.sessions, { it.id }, onSelectSession)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) { BrowserPageSelector(state.pageId, pages, onSelectPage) }
                    IconButton(onClick = onCreatePage, enabled = state.busy.isBlank()) { Icon(Icons.Default.Add, strings.text("新建页面", "New page")) }
                }
                OutlinedTextField(value = address, onValueChange = { address = it }, modifier = Modifier.fillMaxWidth(), singleLine = true, label = { Text(strings.text("地址", "Address")) })
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onNavigate(address) }, enabled = state.busy.isBlank() && state.pageId.isNotBlank() && address.isNotBlank()) { Icon(Icons.Default.OpenInBrowser, null); Text(strings.text("打开", "Open")) }
                    IconButton(onClick = onScreenshot, enabled = state.busy.isBlank() && state.pageId.isNotBlank()) { Icon(Icons.Default.CameraAlt, strings.text("截图", "Screenshot")) }
                }
                BrowserScreenshotPreview(state)
                Text(strings.text("Trace", "Trace"), style = MaterialTheme.typography.titleSmall)
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 180.dp)) {
                    items(state.trace.asReversed(), key = { it.seq }) { event ->
                        Column(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                            Text(event.type, style = MaterialTheme.typography.labelMedium)
                            Text(event.data["url"]?.toString() ?: event.data["text"]?.toString() ?: event.at, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun <T> BrowserSelector(label: String, selected: String, items: List<T>, id: (T) -> String, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        Button(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) { Text("$label · ${selected.take(8)}", maxLines = 1) }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            items.forEach { item -> DropdownMenuItem(text = { Text(id(item).take(12)) }, onClick = { expanded = false; onSelect(id(item)) }) }
        }
    }
}

@Composable
private fun BrowserPageSelector(selected: String, pages: List<BrowserPageInfo>, onSelect: (String) -> Unit) =
    BrowserSelector("Page", selected, pages, { it.id }, onSelect)

@Composable
private fun BrowserScreenshotPreview(state: BrowserWorkspaceUiState) {
    val screenshot = state.screenshot
    val bitmap = remember(screenshot?.dataBase64, screenshot?.mimeType) {
        screenshot?.takeIf { it.mimeType in listOf("image/png", "image/jpeg") && it.dataBase64.isNotBlank() }?.let { value ->
            runCatching {
                val bytes = Base64.decode(value.dataBase64, Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
            }.getOrNull()
        }
    }
    Box(
        Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap != null) Image(bitmap, "Managed browser screenshot", Modifier.fillMaxWidth(), contentScale = ContentScale.Fit)
        else Text(if (state.busy.isNotBlank()) "Working..." else "No screenshot", style = MaterialTheme.typography.bodySmall)
    }
}
