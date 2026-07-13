package com.vibelink.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.vibelink.app.mobile.NotificationPermissionPolicy
import com.vibelink.app.ui.VibeLinkApp
import com.vibelink.app.ui.theme.VibeLinkTheme

class MainActivity : ComponentActivity() {
    private var pairingUri by mutableStateOf<String?>(null)
    private var sharedText by mutableStateOf("")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        requestNotificationPermissionIfNeeded(activityRecreated = savedInstanceState != null)
        applyIncomingIntent(intent)
        setContent {
            VibeLinkTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    VibeLinkApp(
                        initialPairingUri = pairingUri,
                        initialSharedText = sharedText,
                        onSharedContentConsumed = ::consumeSharedContent,
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyIncomingIntent(intent)
    }

    internal fun applyIncomingIntent(intent: Intent?) {
        intent?.data
            ?.takeIf { it.scheme == "vibelink" }
            ?.let { pairingUri = it.toString() }
        sharedContentText(intent)
            .takeIf { it.isNotBlank() }
            ?.let { sharedText = it }
    }

    private fun requestNotificationPermissionIfNeeded(activityRecreated: Boolean) {
        val permissionGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val preferences = getSharedPreferences(PERMISSION_PREFERENCES, MODE_PRIVATE)
        val askedBefore = preferences.getBoolean(KEY_NOTIFICATION_PERMISSION_ASKED, false)
        if (!NotificationPermissionPolicy.shouldRequest(
                apiLevel = Build.VERSION.SDK_INT,
                permissionGranted = permissionGranted,
                askedBefore = askedBefore,
                activityRecreated = activityRecreated,
            )
        ) return

        preferences.edit().putBoolean(KEY_NOTIFICATION_PERMISSION_ASKED, true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_POST_NOTIFICATIONS)
    }

    private fun sharedContentText(intent: Intent?): String {
        if (intent?.action != Intent.ACTION_SEND) return ""
        val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty().trim()
        val stream = intent.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM)
        val type = intent.type.orEmpty()
        return listOfNotNull(
            text.takeIf { it.isNotBlank() },
            stream?.let { uri -> "Shared ${type.ifBlank { "file" }}: $uri" },
        ).joinToString("\n")
    }

    private fun consumeSharedContent() {
        sharedText = ""
        setIntent(Intent(intent).apply {
            action = null
            removeExtra(Intent.EXTRA_TEXT)
            removeExtra(Intent.EXTRA_STREAM)
        })
    }

    companion object {
        private const val REQUEST_POST_NOTIFICATIONS = 7102
        private const val PERMISSION_PREFERENCES = "vibelink_permissions"
        private const val KEY_NOTIFICATION_PERMISSION_ASKED = "notification_permission_asked"
    }
}
