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
