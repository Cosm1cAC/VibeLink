package com.vibelink.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Square
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vibelink.app.network.ToolCallSummary

/**
 * Renders a list of tool call cards (matching Web ToolCallCards).
 */
@Composable
fun ToolCallCardList(
    toolCalls: List<ToolCallSummary>,
    toolCallCount: Int = 0,
    modifier: Modifier = Modifier,
) {
    if (toolCalls.isEmpty()) return

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        toolCalls.forEach { tool ->
            ToolCallCard(tool = tool)
        }
        if (toolCallCount > toolCalls.size) {
            Text(
                "+${toolCallCount - toolCalls.size} more",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * A single tool call card (collapsible, same as Web).
 */
@Composable
fun ToolCallCard(
    tool: ToolCallSummary,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(tool.status == "started" || tool.status == "running") }
    val isRunning = tool.status == "started" || tool.status == "running"
    val statusColor = when (tool.status) {
        "completed", "done" -> MaterialTheme.colorScheme.primary
        "failed", "error", "expired" -> MaterialTheme.colorScheme.error
        "started", "running", "queued", "cancelling", "approval_required" -> MaterialTheme.colorScheme.secondary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val statusLabel = when (tool.status) {
        "completed", "done" -> "done"
        "failed" -> "failed"
        "error" -> "error"
        "started" -> "started"
        "running" -> "running"
        "cancelled" -> "cancelled"
        "cancelling" -> "cancelling"
        "approval_required" -> "approval required"
        "expired" -> "expired"
        "queued" -> "queued"
        else -> tool.status.ifBlank { "pending" }
    }
    val toolName = tool.label.ifBlank { tool.name.ifBlank { "tool" } }

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isRunning)
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)
            else
                MaterialTheme.colorScheme.surface
        ),
    ) {
        Column {
            // Header / toggle
            TextButton(
                onClick = { expanded = !expanded },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 40.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.Square,
                    contentDescription = null,
                    modifier = Modifier.size(13.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = toolName,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (tool.kind.isNotBlank()) {
                    Text(
                        text = tool.kind,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    text = statusLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = statusColor,
                )
                if (isRunning) {
                    Spacer(Modifier.width(4.dp))
                    CircularProgressIndicator(
                        modifier = Modifier.size(12.dp),
                        strokeWidth = 2.dp,
                    )
                }
                Spacer(Modifier.width(4.dp))
                Icon(
                    imageVector = Icons.Default.ChevronRight,
                    contentDescription = if (expanded) "Collapse" else "Expand",
                    modifier = Modifier
                        .size(15.dp)
                        .let { if (expanded) it else it },
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // Expanded content
            AnimatedVisibility(visible = expanded) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    // Input
                    if (tool.input != null && tool.input.isNotEmpty()) {
                        val inputStr = formatToolPayload(tool.input)
                        if (inputStr.isNotBlank()) {
                            Surface(
                                color = MaterialTheme.colorScheme.surfaceVariant,
                                shape = RoundedCornerShape(6.dp),
                            ) {
                                Text(
                                    text = inputStr,
                                    style = MaterialTheme.typography.bodySmall,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 11.sp,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(8.dp),
                                )
                            }
                        }
                    }

                    // Output
                    if (tool.output.isNotBlank()) {
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceVariant,
                            shape = RoundedCornerShape(6.dp),
                        ) {
                            Text(
                                text = tool.output,
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(8.dp),
                            )
                        }
                    }

                    // Output events
                    if (tool.outputEvents.isNotEmpty()) {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            tool.outputEvents.forEach { ev ->
                                Row {
                                    if (ev.stream == "stderr") {
                                        Text(
                                            text = "stderr ",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.error,
                                        )
                                    }
                                    Text(
                                        text = ev.text,
                                        style = MaterialTheme.typography.bodySmall,
                                        fontFamily = FontFamily.Monospace,
                                        fontSize = 10.sp,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Format tool payload to a human-readable string.
 */
private fun formatToolPayload(payload: Map<String, Any?>?): String {
    if (payload == null || payload.isEmpty()) return ""
    return try {
        val gson = com.google.gson.GsonBuilder().setPrettyPrinting().create()
        gson.toJson(payload)
    } catch (_: Exception) {
        payload.toString()
    }
}
