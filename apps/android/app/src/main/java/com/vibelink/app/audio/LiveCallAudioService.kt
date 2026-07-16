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
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File

class LiveCallAudioService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var streamer: LiveCallAudioStreamer? = null
    private var controlCoordinator: LiveCallControlCoordinator? = null
    private var sessionId: String = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startStreaming(intent)
            ACTION_PAUSE -> handleControl(ACTION_PAUSE, intent.getBooleanExtra(EXTRA_SYNC_SERVER, false))
            ACTION_RESUME -> handleControl(ACTION_RESUME, intent.getBooleanExtra(EXTRA_SYNC_SERVER, false))
            ACTION_STOP -> handleControl(ACTION_STOP, intent.getBooleanExtra(EXTRA_SYNC_SERVER, false))
        }
        return START_STICKY
    }

    override fun onDestroy() {
        streamer?.stop()
        streamer = null
        controlCoordinator = null
        scope.cancel()
        removeNotification()
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

        startForeground(NOTIFICATION_ID, buildNotification("正在连接"))
        val apiClient = ApiClient(baseUrl = baseUrl, token = token)
        val file = recordingFile(sessionId)
        val nextStreamer = LiveCallAudioStreamer(apiClient, scope)
        streamer?.stop()
        streamer = nextStreamer
        controlCoordinator = LiveCallControlCoordinator(
            remote = ApiLiveCallRemoteControl(apiClient),
            local = object : LiveCallLocalControl {
                override fun pause() = nextStreamer.pause()
                override fun resume() = nextStreamer.resume()
                override fun stop() = nextStreamer.stop()
            },
        )
        nextStreamer.start(
            context = applicationContext,
            sessionId = sessionId,
            onStatus = { updateNotification(it) },
            onError = { updateNotification("错误：$it") },
            recordingFile = file,
        )
    }

    private fun handleControl(action: String, syncServer: Boolean) {
        if (!syncServer) {
            when (action) {
                ACTION_PAUSE -> {
                    streamer?.pause()
                    updateNotification("已暂停")
                }
                ACTION_RESUME -> {
                    streamer?.resume()
                    updateNotification("录音中")
                }
                ACTION_STOP -> stopSelf()
            }
            return
        }

        val coordinator = controlCoordinator
        if (sessionId.isBlank() || coordinator == null) {
            updateNotification("控制失败：实时通话尚未连接")
            return
        }
        scope.launch {
            val pendingText = when (action) {
                ACTION_PAUSE -> "正在暂停"
                ACTION_RESUME -> "正在继续"
                else -> "正在停止"
            }
            updateNotification(pendingText)
            runCatching {
                when (action) {
                    ACTION_PAUSE -> coordinator.pause(sessionId)
                    ACTION_RESUME -> coordinator.resume(sessionId)
                    ACTION_STOP -> coordinator.stop(sessionId)
                }
            }.onSuccess {
                when (action) {
                    ACTION_PAUSE -> updateNotification("已暂停")
                    ACTION_RESUME -> updateNotification("录音中")
                    ACTION_STOP -> stopSelf()
                }
            }.onFailure { error ->
                val label = when (action) {
                    ACTION_PAUSE -> "暂停"
                    ACTION_RESUME -> "继续"
                    else -> "停止"
                }
                updateNotification("${label}失败：${error.message ?: "网络请求失败"}")
            }
        }
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
            .setContentTitle("实时通话助手")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .addAction(android.R.drawable.ic_media_pause, "暂停", serviceIntent(ACTION_PAUSE, 1))
            .addAction(android.R.drawable.ic_media_play, "继续", serviceIntent(ACTION_RESUME, 2))
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止", serviceIntent(ACTION_STOP, 3))
            .build()
    }

    private fun removeNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }

    private fun serviceIntent(action: String, requestCode: Int): PendingIntent {
        return PendingIntent.getService(
            this,
            requestCode,
            Intent(this, LiveCallAudioService::class.java)
                .setAction(action)
                .putExtra(EXTRA_SYNC_SERVER, true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "实时通话助手", NotificationManager.IMPORTANCE_LOW),
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
        const val EXTRA_SYNC_SERVER = "syncServer"

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

        fun pauseIntent(context: Context): Intent {
            return Intent(context, LiveCallAudioService::class.java).setAction(ACTION_PAUSE)
        }

        fun resumeIntent(context: Context): Intent {
            return Intent(context, LiveCallAudioService::class.java).setAction(ACTION_RESUME)
        }
    }
}
