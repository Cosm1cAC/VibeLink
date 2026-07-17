package com.vibelink.app.ui.screens

import com.vibelink.app.network.SearchResult
import kotlin.test.Test
import kotlin.test.assertEquals

class SearchResultDedupeTest {
    @Test
    fun keepsFirstResultForSameKindIdTurnAndPath() {
        val results = SessionListViewModel.dedupeSearchResults(
            listOf(
                SearchResult(kind = "message", id = "session-1", turnId = "turn-1", title = "first"),
                SearchResult(kind = "message", id = "session-1", turnId = "turn-1", title = "duplicate"),
                SearchResult(kind = "message", id = "session-1", turnId = "turn-2", title = "other turn"),
                SearchResult(kind = "file", id = "workspace:README.md", path = "README.md", title = "file"),
            ),
        )

        assertEquals(listOf("first", "other turn", "file"), results.map { it.title })
    }
}
