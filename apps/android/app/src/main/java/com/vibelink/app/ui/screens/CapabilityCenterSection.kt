package com.vibelink.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.google.gson.JsonParser
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ApiException
import com.vibelink.app.network.CapabilityItem
import kotlinx.coroutines.launch

@Composable
fun CapabilityCenterSection(apiClient: ApiClient) {
    val scope = rememberCoroutineScope()
    var category by remember { mutableStateOf("plugins") }
    var items by remember { mutableStateOf(emptyList<CapabilityItem>()) }
    var error by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var first by remember { mutableStateOf("") }
    var second by remember { mutableStateOf("") }
    var third by remember { mutableStateOf("") }
    fun refresh() {
        scope.launch {
            busy = true
            error = runCatching { items = apiClient.listCapabilities(category) }.exceptionOrNull()?.message.orEmpty()
            busy = false
        }
    }
    fun mutate(success: String, operation: suspend () -> Unit) {
        scope.launch {
            busy = true
            error = ""
            notice = ""
            try {
                operation()
                notice = success
                items = apiClient.listCapabilities(category)
            } catch (failure: Throwable) {
                error = CapabilityOperationFeedback.message(failure)
            }
            busy = false
        }
    }
    LaunchedEffect(category) { refresh() }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Capability center", style = MaterialTheme.typography.titleMedium)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("plugins", "hooks", "automations", "subagents", "config").forEach { value ->
                    OutlinedButton(onClick = { category = value; first = ""; second = ""; third = "" }, enabled = !busy) { Text(value) }
                }
            }
            if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
            if (notice.isNotBlank()) Text(notice, color = MaterialTheme.colorScheme.primary)
            when (category) {
                "plugins" -> CapabilityCreateFields(first, { first = it }, second, { second = it }, third, { third = it }, "Plugin id", "Plugin name", "Version") {
                    mutate("Plugin installed.") { apiClient.installPlugin(first.trim(), second.trim(), third.trim()) }
                }
                "automations" -> CapabilityCreateFields(first, { first = it }, second, { second = it }, third, { third = it }, "Title", "Schedule value", "Prompt") {
                    mutate("Automation created.") { apiClient.createAutomation(first.trim(), "interval", second.trim(), third.trim()) }
                }
                "subagents" -> CapabilityCreateFields(first, { first = it }, second, { second = it }, third, { third = it }, "Parent task id", "Prompt", "Agent") {
                    mutate("Subagent started.") { apiClient.createSubagent(first.trim(), second.trim(), third.ifBlank { "codex" }) }
                }
                else -> Unit
            }
            items.forEach { item ->
                    Card(Modifier.fillMaxWidth().padding(vertical = 3.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(item.title.ifBlank { item.label.ifBlank { item.id } }, style = MaterialTheme.typography.titleSmall)
                            Text(item.preview.ifBlank { item.status.ifBlank { item.source } }, style = MaterialTheme.typography.bodySmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (category == "plugins" && item.managed) {
                                    Button(onClick = { mutate("Plugin updated.") { apiClient.setPluginEnabled(item.id, !item.enabled) } }) { Text(if (item.enabled) "Disable" else "Enable") }
                                    OutlinedButton(onClick = { mutate("Plugin removed.") { apiClient.removePlugin(item.id) } }) { Text("Delete") }
                                }
                                if (category == "hooks") Button(onClick = { mutate("Hook updated.") { apiClient.setHookEnabled(item.id, !item.enabled) } }) { Text(if (item.enabled) "Disable" else "Enable") }
                                if (category == "automations") {
                                    Button(onClick = { mutate("Automation started.") { apiClient.runAutomation(item.id) } }) { Text("Run") }
                                    OutlinedButton(onClick = { mutate("Automation updated.") { apiClient.setAutomationEnabled(item.id, !item.enabled) } }) { Text(if (item.enabled) "Pause" else "Enable") }
                                    OutlinedButton(onClick = { mutate("Automation removed.") { apiClient.removeAutomation(item.id) } }) { Text("Delete") }
                                }
                                if (category == "subagents" && item.capabilities["stop"] == true) Button(onClick = { mutate("Subagent stopped.") { apiClient.stopTask(item.id) } }) { Text("Stop") }
                            }
                            if (category == "config" && item.capabilities["edit"] == true) { var draft by remember(item.id, item.digest) { mutableStateOf(item.preview) }; OutlinedTextField(draft, { draft = it }, Modifier.fillMaxWidth(), label = { Text(item.label) }); Button(onClick = { mutate("Configuration saved.") { apiClient.updateCapabilityConfig(item.id, item.digest, draft) } }) { Text("Save") } }
                        }
                    }
            }
        }
    }
}

object CapabilityOperationFeedback {
    fun message(error: Throwable): String {
        if (error !is ApiException || error.statusCode != 428) return error.message ?: "Operation failed"
        val body = runCatching { JsonParser.parseString(error.body).asJsonObject }.getOrNull()
        val reason = body?.get("error")?.asString.orEmpty().ifBlank { "Explicit approval required." }
        val id = body?.get("approvalId")?.asString.orEmpty().ifBlank { body?.getAsJsonObject("approval")?.get("id")?.asString.orEmpty() }
        return "$reason${if (id.isBlank()) " Open Settings > Approvals." else " Approval $id is pending in Settings > Approvals."}"
    }
}

@Composable
private fun CapabilityCreateFields(first: String, onFirst: (String) -> Unit, second: String, onSecond: (String) -> Unit, third: String, onThird: (String) -> Unit, firstLabel: String, secondLabel: String, thirdLabel: String, submit: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(first, onFirst, Modifier.fillMaxWidth(), label = { Text(firstLabel) }, singleLine = true)
        OutlinedTextField(second, onSecond, Modifier.fillMaxWidth(), label = { Text(secondLabel) }, singleLine = true)
        OutlinedTextField(third, onThird, Modifier.fillMaxWidth(), label = { Text(thirdLabel) })
        Button(onClick = submit, enabled = first.isNotBlank() && second.isNotBlank()) { Text("Create") }
    }
}
