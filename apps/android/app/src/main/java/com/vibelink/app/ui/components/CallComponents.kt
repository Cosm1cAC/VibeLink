package com.vibelink.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vibelink.app.network.LiveCallEvent

@Composable
fun TranscriptFeed(events: List<LiveCallEvent>) {
    val transcripts = events
        .filter { it.type == "live_call.transcript.final" || it.type == "live_call.transcript.partial" }
        .takeLast(40)
    if (transcripts.isEmpty()) return

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text("实时转录", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            transcripts.forEach { event ->
                val speaker = if (event.speaker == "local") "本地" else "远程"
                val suffix = if (event.type == "live_call.transcript.partial") " ..." else ""
                Text(
                    text = "[$speaker] ${event.text}$suffix",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    lineHeight = 18.sp,
                    modifier = Modifier.padding(vertical = 2.dp)
                )
            }
        }
    }
}

@Composable
fun QaCard(question: String, answer: String, agentState: String?) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            if (question.isNotBlank()) {
                Text("❓ $question", style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(bottom = 4.dp))
            }
            when (agentState) {
                "thinking" -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("思考中…", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                "streaming" -> {
                    Text("💡 $answer", style = MaterialTheme.typography.bodyMedium)
                    Text("▌", style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary)
                }
                else -> {
                    if (answer.isNotBlank()) {
                        Text("💡 $answer", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}

@Composable
fun LevelIndicator(label: String, level: Double) {
    val pct = (level * 200).coerceAtMost(100.0)
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(label, style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.width(40.dp))
        LinearProgressIndicator(
            progress = { (pct / 100).toFloat() },
            modifier = Modifier
                .weight(1f)
                .height(8.dp),
            trackColor = MaterialTheme.colorScheme.surfaceVariant,
        )
        Text("%.0f%%".format(pct), style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace)
    }
}
