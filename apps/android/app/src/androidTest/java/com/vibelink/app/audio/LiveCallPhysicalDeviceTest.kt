package com.vibelink.app.audio

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.vibelink.app.MainActivity
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

@RunWith(AndroidJUnit4::class)
class LiveCallPhysicalDeviceTest {
    @Test
    fun microphoneNotificationAndDisconnectRecoveryWorkOnPhysicalDevice() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(
            "physical Live Call acceptance is opt-in",
            InstrumentationRegistry.getArguments().getString("physicalLiveCall") == "true",
        )
        val context = instrumentation.targetContext
        val activity = instrumentation.startActivitySync(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        ) as MainActivity
        requestRuntimePermissions(activity)
        val server = MockWebServer()
        val firstAudio = CountDownLatch(1)
        val recoveredAudio = CountDownLatch(1)
        val firstBytes = AtomicLong(0)
        val recoveredBytes = AtomicLong(0)
        val sessionId = "physical-${System.currentTimeMillis()}"
        val recordingDirectory = context.getExternalFilesDir("live-call-recordings")

        try {
            server.enqueue(webSocketResponse(firstAudio, firstBytes, disconnectAfterAudio = true))
            server.enqueue(webSocketResponse(recoveredAudio, recoveredBytes, disconnectAfterAudio = false))
            server.start()

            context.startForegroundService(
                LiveCallAudioService.startIntent(
                    context = context,
                    baseUrl = server.url("/").toString().trimEnd('/'),
                    token = "physical-device-evidence",
                    sessionId = sessionId,
                ),
            )

            assertTrue("foreground Live Call notification was not posted", waitForNotification(context, true))
            assertTrue("physical microphone produced no PCM", firstAudio.await(20, TimeUnit.SECONDS))
            assertTrue("audio WebSocket did not recover after disconnect", recoveredAudio.await(20, TimeUnit.SECONDS))
            assertTrue("initial microphone stream was empty", firstBytes.get() > 0)
            assertTrue("recovered microphone stream was empty", recoveredBytes.get() > 0)

            context.startService(LiveCallAudioService.stopIntent(context))
            assertTrue("foreground Live Call notification was not removed", waitForNotification(context, false))

            val recordings = recordingDirectory
                ?.listFiles()
                .orEmpty()
                .filter { it.name.startsWith(sessionId) }
            assertTrue("physical microphone recording was not retained", recordings.any { it.length() > 0 })
            assertTrue("recording file handle remained open", recordings.all { it.delete() })

            println(
                "PHYSICAL_ANDROID_LIVE_CALL_EVIDENCE " +
                    "model=${Build.MODEL} sdk=${Build.VERSION.SDK_INT} " +
                    "initialBytes=${firstBytes.get()} recoveredBytes=${recoveredBytes.get()}",
            )
        } finally {
            context.stopService(LiveCallAudioService.stopIntent(context))
            try {
                server.shutdown()
            } finally {
                activity.finish()
            }
        }

        assertFalse(hasLiveCallNotification(context))
    }

    private fun requestRuntimePermissions(activity: MainActivity) {
        val required = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        val missing = required.filter {
            activity.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                activity.requestPermissions(missing.toTypedArray(), 7103)
            }
        }
        assertTrue(
            "physical device permissions were not granted through the system UI",
            waitUntil(30_000) {
                required.all {
                    activity.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
                }
            },
        )
    }

    private fun webSocketResponse(
        audioReceived: CountDownLatch,
        receivedBytes: AtomicLong,
        disconnectAfterAudio: Boolean,
    ): MockResponse = MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (bytes.size == 0) return
            receivedBytes.addAndGet(bytes.size.toLong())
            audioReceived.countDown()
            if (disconnectAfterAudio) webSocket.close(1012, "physical weak-network probe")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            audioReceived.countDown()
        }
    })

    private fun waitForNotification(context: Context, expected: Boolean): Boolean {
        return waitUntil(10_000) { hasLiveCallNotification(context) == expected }
    }

    private fun waitUntil(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return true
            Thread.sleep(100)
        }
        return condition()
    }

    private fun hasLiveCallNotification(context: Context): Boolean {
        val notifications = context.getSystemService(NotificationManager::class.java).activeNotifications
        return notifications.any { it.id == 7101 }
    }
}
