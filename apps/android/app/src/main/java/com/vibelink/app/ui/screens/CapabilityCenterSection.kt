package com.vibelink.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.CapabilityItem
import kotlinx.coroutines.launch

@Composable
fun CapabilityCenterSection(apiClient: ApiClient) {
    val scope = rememberCoroutineScope()
    var category by remember { mutableStateOf("plugins") }
    var items by remember { mutableStateOf(emptyList<CapabilityItem>()) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    fun refresh() { scope.launch { busy = true; error = runCatching { items = apiClient.listCapabilities(category) }.exceptionOrNull()?.message.orEmpty(); busy = false } }
    LaunchedEffect(category) { refresh() }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Capability center", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("plugins", "hooks", "automations", "subagents", "config").forEach { value ->
                    OutlinedButton(onClick = { category = value }, enabled = !busy) { Text(value) }
                }
            }
            if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
            LazyColumn(Modifier.fillMaxWidth()) {
                items(items, key = { it.id }) { item ->
                    Card(Modifier.fillMaxWidth().padding(vertical = 3.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(item.title.ifBlank { item.label.ifBlank { item.id } }, style = MaterialTheme.typography.titleSmall)
                            Text(item.preview.ifBlank { item.status.ifBlank { item.source } }, style = MaterialTheme.typography.bodySmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (category == "plugins" && item.managed) Button(onClick = { scope.launch { runCatching { apiClient.setPluginEnabled(item.id, !item.enabled) }; refresh() } }) { Text(if (item.enabled) "Disable" else "Enable") }
                                if (category == "hooks") Button(onClick = { scope.launch { runCatching { apiClient.setHookEnabled(item.id, !item.enabled) }; refresh() } }) { Text(if (item.enabled) "Disable" else "Enable") }
                                if (category == "automations") {
                                    Button(onClick = { scope.launch { runCatching { apiClient.runAutomation(item.id) }; refresh() } }) { Text("Run") }
                                    OutlinedButton(onClick = { scope.launch { runCatching { apiClient.setAutomationEnabled(item.id, !item.enabled) }; refresh() } }) { Text(if (item.enabled) "Pause" else "Enable") }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
