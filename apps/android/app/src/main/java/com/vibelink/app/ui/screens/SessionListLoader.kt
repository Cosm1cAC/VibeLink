package com.vibelink.app.ui.screens

import com.vibelink.app.network.DesktopRemoteState
import com.vibelink.app.network.HistoryItem
import com.vibelink.app.network.TaskSummary
import com.vibelink.app.network.ThreadStateResponse
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

data class SessionListSnapshot(
    val histories: List<HistoryItem>,
    val tasks: List<TaskSummary>,
    val threadState: ThreadStateResponse,
    val desktop: DesktopRemoteState?,
)

suspend fun loadSessionListSnapshot(
    loadHistories: suspend () -> List<HistoryItem>,
    loadTasks: suspend () -> List<TaskSummary>,
    loadThreadState: suspend () -> ThreadStateResponse,
    loadDesktop: suspend () -> DesktopRemoteState,
): SessionListSnapshot = coroutineScope {
    val histories = async { loadHistories() }
    val tasks = async { loadTasks() }
    val threadState = async { runCatching { loadThreadState() }.getOrElse { ThreadStateResponse() } }
    val desktop = async { runCatching { loadDesktop() }.getOrNull() }

    SessionListSnapshot(
        histories = histories.await(),
        tasks = tasks.await(),
        threadState = threadState.await(),
        desktop = desktop.await(),
    )
}
