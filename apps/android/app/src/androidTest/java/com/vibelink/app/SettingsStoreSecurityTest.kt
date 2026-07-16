package com.vibelink.app

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.vibelink.app.data.SettingsStore
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.charset.StandardCharsets

@RunWith(AndroidJUnit4::class)
class SettingsStoreSecurityTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val settingsStore = SettingsStore(context)

    @Test
    fun deviceTokenIsEncryptedAtRest() {
        try {
            runBlocking { settingsStore.setToken("device-token-at-rest") }

            assertEquals("device-token-at-rest", runBlocking { settingsStore.getTokenSync() })
            val dataStoreFile = context.filesDir.resolve("datastore/vibelink_settings.preferences_pb")
            val raw = dataStoreFile.readBytes().toString(StandardCharsets.ISO_8859_1)
            assertFalse(raw.contains("device-token-at-rest"))
        } finally {
            runBlocking { settingsStore.clearSession() }
        }
    }
}
