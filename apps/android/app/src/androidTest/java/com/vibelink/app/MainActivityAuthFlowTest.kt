package com.vibelink.app

import android.content.Context
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.vibelink.app.data.SettingsStore
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class MainActivityAuthFlowTest {
    @get:Rule
    val composeRule = createEmptyComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val settingsStore = SettingsStore(context)
    private val pairingClaimCount = AtomicInteger()
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        context.getSharedPreferences("vibelink_permissions", Context.MODE_PRIVATE)
            .edit()
            .putBoolean("notification_permission_asked", true)
            .commit()

        server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val body = when (request.requestUrl?.encodedPath) {
                        "/api/status" -> """{"ok":true}"""
                        "/api/login" -> """{"ok":true,"token":"device-token-under-test"}"""
                        "/api/attachments" ->
                            """{"name":"shared-image.xml","markdown":"![shared-image.xml](/api/attachments/shared-image)","preview":""}"""
                        "/api/pairing-sessions/session-under-test" ->
                            """{"ok":true,"session":{"id":"session-under-test","code":"246810","status":"approved"}}"""
                        "/api/pairing-sessions/session-under-test/claim" -> {
                            pairingClaimCount.incrementAndGet()
                            """{"ok":true,"token":"paired-device-token","session":{"id":"session-under-test","status":"claimed"}}"""
                        }
                        "/api/histories", "/api/tasks" -> """{"items":[]}"""
                        "/api/thread-state" -> """{"threads":[],"forks":[]}"""
                        "/api/desktop-remote/status" -> """{"status":"idle","transcript":[]}"""
                        else -> """{"items":[]}"""
                    }
                    return MockResponse()
                        .setResponseCode(200)
                        .setHeader("Content-Type", "application/json")
                        .setBody(body)
                }
            }
            start()
        }

        runBlocking {
            settingsStore.clearSession()
            settingsStore.setBridgeUrl(server.url("/").toString().trimEnd('/'))
        }
        pairingClaimCount.set(0)
    }

    @After
    fun tearDown() {
        runBlocking { settingsStore.clearSession() }
        server.shutdown()
    }

    @Test
    fun logoutClearsPersistedDeviceToken() {
        ActivityScenario.launch(MainActivity::class.java).use {
            composeRule.waitUntil(5_000) {
                composeRule.onAllNodesWithText("配对 Token")
                    .fetchSemanticsNodes().isNotEmpty()
            }
            val bridgeField = composeRule.onNode(hasText("Bridge 地址") and hasSetTextAction())
            bridgeField.performTextClearance()
            bridgeField.performTextInput(server.url("/").toString().trimEnd('/'))
            composeRule.onNode(hasText("配对 Token") and hasSetTextAction())
                .performTextInput("legacy-pairing-token")
            composeRule.onNodeWithText("使用 Token 连接").performClick()

            val loginRequest = server.takeRequest(5, TimeUnit.SECONDS)
            assertEquals("/api/login", loginRequest?.requestUrl?.encodedPath)

            composeRule.waitUntil(10_000) {
                composeRule.onAllNodesWithContentDescription("更多")
                    .fetchSemanticsNodes().isNotEmpty()
            }
            composeRule.onNodeWithContentDescription("更多").performClick()
            composeRule.onNodeWithText("退出登录").performClick()

            composeRule.waitUntil(3_000) {
                runBlocking { settingsStore.getTokenSync().isBlank() }
            }
        }
    }

    @Test
    fun sharedContentDoesNotBypassLogin() {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, "Shared audit text")

        ActivityScenario.launch<MainActivity>(intent).use {
            composeRule.waitUntil(5_000) {
                composeRule.onAllNodesWithText("Bridge 连接")
                    .fetchSemanticsNodes().isNotEmpty()
            }
            composeRule.waitForIdle()
            composeRule.onNodeWithText("Bridge 连接").assertExists()
        }
    }

    @Test
    fun sharedContentIsRestoredAfterLogin() {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, "Shared audit text")

        val scenario = ActivityScenario.launch<MainActivity>(intent)
        composeRule.waitUntil(5_000) {
            composeRule.onAllNodesWithText("配对 Token")
                .fetchSemanticsNodes().isNotEmpty()
        }
        val bridgeField = composeRule.onNode(hasText("Bridge 地址") and hasSetTextAction())
        bridgeField.performTextClearance()
        bridgeField.performTextInput(server.url("/").toString().trimEnd('/'))
        composeRule.onNode(hasText("配对 Token") and hasSetTextAction())
            .performTextInput("legacy-pairing-token")
        composeRule.onNodeWithText("使用 Token 连接").performClick()

        val loginRequest = server.takeRequest(5, TimeUnit.SECONDS)
        assertEquals("/api/login", loginRequest?.requestUrl?.encodedPath)
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodes(hasText("Shared audit text") and hasSetTextAction())
                .fetchSemanticsNodes().isNotEmpty()
        }
        scenario.onActivity { activity -> activity.finish() }
    }

    @Test
    fun sharedImageIsUploadedAfterLogin() {
        val sharedImage = Uri.parse("android.resource://com.vibelink.app/drawable/ic_launcher_foreground")
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_SEND)
            .setType("image/xml")
            .putExtra(Intent.EXTRA_STREAM, sharedImage)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

        val scenario = ActivityScenario.launch<MainActivity>(intent)
        try {
            composeRule.waitUntil(5_000) {
                composeRule.onAllNodesWithText("配对 Token").fetchSemanticsNodes().isNotEmpty()
            }
            val bridgeField = composeRule.onNode(hasText("Bridge 地址") and hasSetTextAction())
            bridgeField.performTextClearance()
            bridgeField.performTextInput(server.url("/").toString().trimEnd('/'))
            composeRule.onNode(hasText("配对 Token") and hasSetTextAction())
                .performTextInput("legacy-pairing-token")
            composeRule.onNodeWithText("使用 Token 连接").performClick()

            composeRule.waitUntil(30_000) {
                composeRule.onAllNodes(hasText("![shared-image.xml](/api/attachments/shared-image)") and hasSetTextAction())
                    .fetchSemanticsNodes().isNotEmpty()
            }
            val uploadRequest = takeRequestWithPath("/api/attachments")
            assertNotNull(composeRule.onRoot().printToString(), uploadRequest)
        } finally {
            scenario.onActivity { activity -> activity.finish() }
        }
    }

    @Test
    fun pairingTokenFieldIsPasswordProtected() {
        ActivityScenario.launch(MainActivity::class.java).use {
            composeRule.waitUntil(5_000) {
                composeRule.onAllNodesWithText("配对 Token")
                    .fetchSemanticsNodes().isNotEmpty()
            }
            composeRule.onNodeWithText("配对 Token")
                .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Password))
        }
    }

    @Test
    fun logoutAfterPairingDoesNotReuseConsumedIntent() {
        val pairingUri = Uri.Builder()
            .scheme("vibelink")
            .authority("pair")
            .appendQueryParameter("server", server.url("/").toString().trimEnd('/'))
            .appendQueryParameter("session", "session-under-test")
            .appendQueryParameter("code", "246810")
            .build()
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData(pairingUri)

        ActivityScenario.launch<MainActivity>(intent).use {
            composeRule.waitUntil(10_000) {
                composeRule.onAllNodesWithContentDescription("更多")
                    .fetchSemanticsNodes().isNotEmpty()
            }
            composeRule.onNodeWithContentDescription("更多").performClick()
            composeRule.onNodeWithText("退出登录").performClick()
            composeRule.waitUntil(5_000) {
                composeRule.onAllNodesWithText("Bridge 连接")
                    .fetchSemanticsNodes().isNotEmpty()
            }

            Thread.sleep(3_500)
            composeRule.onNodeWithText("Bridge 连接").assertExists()
            assertEquals(1, pairingClaimCount.get())
        }
    }

    @Test
    fun newPairingIntentIsProcessedByRunningActivity() {
        val activityInfo = context.packageManager.getActivityInfo(
            ComponentName(context, MainActivity::class.java),
            0,
        )
        assertEquals(ActivityInfo.LAUNCH_SINGLE_TOP, activityInfo.launchMode)

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            composeRule.waitUntil(5_000) {
                composeRule.onAllNodesWithText("Bridge 连接")
                    .fetchSemanticsNodes().isNotEmpty()
            }

            val pairingUri = Uri.Builder()
                .scheme("vibelink")
                .authority("pair")
                .appendQueryParameter("server", server.url("/").toString().trimEnd('/'))
                .appendQueryParameter("session", "session-under-test")
                .appendQueryParameter("code", "246810")
                .build()
            scenario.onActivity { activity ->
                activity.applyIncomingIntent(Intent(Intent.ACTION_VIEW, pairingUri))
            }

            composeRule.waitUntil(5_000) {
                composeRule.onAllNodesWithText("已扫描配对二维码。请在 VibeLink 中确认此设备，并保持本页打开。")
                    .fetchSemanticsNodes().isNotEmpty()
            }
        }
    }

    private fun takeRequestWithPath(path: String): RecordedRequest? {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val request = server.takeRequest(500, TimeUnit.MILLISECONDS) ?: continue
            if (request.requestUrl?.encodedPath == path) return request
        }
        return null
    }
}
