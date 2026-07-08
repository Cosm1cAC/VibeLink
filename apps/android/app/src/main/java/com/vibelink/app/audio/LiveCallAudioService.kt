package com.vibelink.app.audio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import com.vibelink.app.MainActivity
import com.vibelink.app.network.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.io.File

class LiveCallAudioService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var streamer: LiveCallAudioStreamer? = null
    private var sessionId: String = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startStreaming(intent)
            ACTION_PAUSE -> {
                streamer?.pause()
                updateNotification("Paused")
            }
            ACTION_RESUME -> {
                streamer?.resume()
                updateNotification("Recording")
            }
            ACTION_STOP -> stopSelf()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        streamer?.stop()
        streamer = null
        super.onDestroy()
    }

    private fun startStreaming(intent: Intent) {
        val baseUrl = intent.getStringExtra(EXTRA_BASE_URL).orEmpty()
        val token = intent.getStringExtra(EXTRA_TOKEN).orEmpty()
        sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        if (baseUrl.isBlank() || sessionId.isBlank()) {
            stopSelf()
            return
        }

        startForeground(NOTIFICATION_ID, buildNotification("Connecting"))
        val apiClient = ApiClient(baseUrl = baseUrl, token = token)
        val file = recordingFile(sessionId)
        val nextStreamer = LiveCallAudioStreamer(apiClient, scope)
        streamer?.stop()
        streamer = nextStreamer
        nextStreamer.start(
            context = applicationContext,
            sessionId = sessionId,
            onStatus = { updateNotification(it) },
            onError = { updateNotification("Error: $it") },
            recordingFile = file,
        )
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Live Call Assistant")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .addAction(android.R.drawable.ic_media_pause, "Pause", serviceIntent(ACTION_PAUSE, 1))
            .addAction(android.R.drawable.ic_media_play, "Resume", serviceIntent(ACTION_RESUME, 2))
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", serviceIntent(ACTION_STOP, 3))
            .build()
    }

    private fun serviceIntent(action: String, requestCode: Int): PendingIntent {
        return PendingIntent.getService(
            this,
            requestCode,
            Intent(this, LiveCallAudioService::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Live Call Assistant", NotificationManager.IMPORTANCE_LOW),
        )
    }

    private fun recordingFile(sessionId: String): File {
        return File(getExternalFilesDir("live-call-recordings"), "$sessionId-${System.currentTimeMillis()}.pcm")
    }

    companion object {
        private const val CHANNEL_ID = "vibelink_live_call"
        private const val NOTIFICATION_ID = 7101
        const val ACTION_START = "com.vibelink.app.livecall.START"
        const val ACTION_PAUSE = "com.vibelink.app.livecall.PAUSE"
        const val ACTION_RESUME = "com.vibelink.app.livecall.RESUME"
        const val ACTION_STOP = "com.vibelink.app.livecall.STOP"
        const val EXTRA_BASE_URL = "baseUrl"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_SESSION_ID = "sessionId"

        fun startIntent(context: Context, baseUrl: String, token: String, sessionId: String): Intent {
            return Intent(context, LiveCallAudioService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_BASE_URL, baseUrl)
                .putExtra(EXTRA_TOKEN, token)
                .putExtra(EXTRA_SESSION_ID, sessionId)
        }

        fun stopIntent(context: Context): Intent {
            return Intent(context, LiveCallAudioService::class.java).setAction(ACTION_STOP)
        }
    }
}
