package com.vibelink.app.ui.screens

import com.vibelink.app.network.DesktopRemoteState
import com.vibelink.app.network.HistoryItem
import com.vibelink.app.network.TaskSummary
import com.vibelink.app.network.ThreadStateResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals

class SessionListLoaderTest {
    @Test
    fun startsIndependentSessionRequestsConcurrently() = runBlocking {
        val started = Channel<String>(capacity = 4)
        val release = CompletableDeferred<Unit>()

        val loading = async {
            loadSessionListSnapshot(
                loadHistories = {
                    started.send("histories")
                    release.await()
                    listOf(HistoryItem(id = "history-1"))
                },
                loadTasks = {
                    started.send("tasks")
                    release.await()
                    listOf(TaskSummary(id = "task-1"))
                },
                loadThreadState = {
                    started.send("thread-state")
                    release.await()
                    ThreadStateResponse()
                },
                loadDesktop = {
                    started.send("desktop")
                    release.await()
                    DesktopRemoteState()
                },
            )
        }

        val calls = withTimeout(1_000) {
            List(4) { started.receive() }.toSet()
        }
        release.complete(Unit)
        val snapshot = loading.await()

        assertEquals(setOf("histories", "tasks", "thread-state", "desktop"), calls)
        assertEquals("history-1", snapshot.histories.single().id)
        assertEquals("task-1", snapshot.tasks.single().id)
    }
}
