package com.vibelink.app.ui

import com.vibelink.app.network.ConversationItem

object ConversationRoute {
    fun encodeKey(key: String): String = key.replace("/", "~")

    fun decodeKey(routeKey: String): String = routeKey.replace("~", "/")

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
