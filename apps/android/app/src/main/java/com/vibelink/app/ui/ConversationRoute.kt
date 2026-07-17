package com.vibelink.app.ui

import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.SearchResult
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

object ConversationRoute {
    fun encodeKey(key: String): String = key.replace("/", "~")

    fun decodeKey(routeKey: String): String = routeKey.replace("~", "/")

    fun encodeQueryValue(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8.name())

    fun decodeQueryValue(value: String): String = URLDecoder.decode(value, StandardCharsets.UTF_8.name())

    fun conversationFromSearchResult(result: SearchResult): ConversationItem? {
        return when (result.kind) {
            "history" -> ConversationItem(
                key = "history:${result.provider}:${result.id}",
                kind = "history",
                id = result.id,
                provider = result.provider,
                title = result.title,
                status = "history",
                sessionId = result.id,
                preview = result.snippet,
            )
            "message" -> ConversationItem(
                key = "history:${result.provider}:${result.id}",
                kind = "history",
                id = result.id,
                provider = result.provider,
                title = result.title,
                status = "history",
                sessionId = result.id,
                preview = result.snippet,
            )
            "task" -> ConversationItem(
                key = "task:${result.id}",
                kind = "task",
                id = result.id,
                provider = result.provider,
                title = result.title,
                status = "task",
                preview = result.snippet,
            )
            else -> null
        }
    }

    fun isFileSearchResult(result: SearchResult): Boolean = result.kind == "file"

    fun restoreConversation(
        routeKey: String,
        pending: ConversationItem?,
        conversations: List<ConversationItem>,
    ): ConversationItem? {
        val key = decodeKey(routeKey)
        if (pending?.key == key) return pending
        conversations.firstOrNull { it.key == key }?.let { return it }
        return when {
            key.startsWith("new:") -> ConversationItem(
                key = key,
                kind = "new",
                provider = "codex",
                title = "New VibeLink Agent task",
                status = "new",
            )
            key.startsWith("share:") -> ConversationItem(
                key = key,
                kind = "new",
                provider = "codex",
                title = "Shared to VibeLink",
                status = "new",
            )
            else -> null
        }
    }
}
