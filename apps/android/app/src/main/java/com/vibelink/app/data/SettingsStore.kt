package com.vibelink.app.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "vibelink_settings")

/**
 * Persistent key-value storage (localStorage equivalent for Android).
 */
class SettingsStore(private val context: Context) {

    companion object {
        private val KEY_BRIDGE_URL = stringPreferencesKey("bridge_url")
        private val KEY_TOKEN = stringPreferencesKey("token")
        private val KEY_PAIRING_TOKEN = stringPreferencesKey("pairing_token")
        private val KEY_ACTIVE_SESSION_ID = stringPreferencesKey("active_session_id")
        private val KEY_PROMPT_HISTORY = stringPreferencesKey("prompt_history")
    }

    val bridgeUrl: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[KEY_BRIDGE_URL] ?: "http://192.168.1.10:8787"
    }

    val token: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[KEY_TOKEN] ?: ""
    }

    val pairingToken: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[KEY_PAIRING_TOKEN] ?: ""
    }

    val activeSessionId: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[KEY_ACTIVE_SESSION_ID] ?: ""
    }

    val promptHistory: Flow<List<String>> = context.dataStore.data.map { prefs ->
        PromptHistoryCodec.decode(prefs[KEY_PROMPT_HISTORY].orEmpty())
    }

    suspend fun setBridgeUrl(url: String) {
        context.dataStore.edit { it[KEY_BRIDGE_URL] = url }
    }

    suspend fun setToken(token: String) {
        context.dataStore.edit { it[KEY_TOKEN] = token }
    }

    suspend fun setPairingToken(pt: String) {
        context.dataStore.edit { it[KEY_PAIRING_TOKEN] = pt }
    }

    suspend fun setActiveSessionId(id: String) {
        context.dataStore.edit { it[KEY_ACTIVE_SESSION_ID] = id }
    }

    suspend fun addPromptHistory(prompt: String) {
        val trimmed = prompt.trim()
        if (trimmed.isBlank()) return
        context.dataStore.edit { prefs ->
            val next = PromptHistoryCodec.prepend(PromptHistoryCodec.decode(prefs[KEY_PROMPT_HISTORY].orEmpty()), trimmed)
            prefs[KEY_PROMPT_HISTORY] = PromptHistoryCodec.encode(next)
        }
    }

    suspend fun clearPromptHistory() {
        context.dataStore.edit { it.remove(KEY_PROMPT_HISTORY) }
    }

    suspend fun clearSession() {
        context.dataStore.edit {
            it.remove(KEY_TOKEN)
            it.remove(KEY_ACTIVE_SESSION_ID)
        }
    }

    suspend fun getTokenSync(): String {
        return context.dataStore.data.first()[KEY_TOKEN] ?: ""
    }

}

object PromptHistoryCodec {
    fun decode(raw: String): List<String> {
        if (raw.isBlank()) return emptyList()
        return raw.lines().mapNotNull { encoded ->
            runCatching { String(java.util.Base64.getDecoder().decode(encoded)) }
                .getOrNull()
                ?.trim()
                ?.takeIf { it.isNotBlank() }
        }
    }

    fun encode(items: List<String>): String {
        return items.joinToString("\n") { item ->
            java.util.Base64.getEncoder().encodeToString(item.toByteArray())
        }
    }

    fun prepend(existing: List<String>, prompt: String): List<String> {
        val trimmed = prompt.trim()
        if (trimmed.isBlank()) return existing.take(MAX_PROMPT_HISTORY)
        return (listOf(trimmed) + existing).distinct().take(MAX_PROMPT_HISTORY)
    }
}

private const val MAX_PROMPT_HISTORY = 12
