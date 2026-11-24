package com.vibelink.app

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class VibeLinkAgentService : Service() {

    companion object {
        private const val TAG = "VibeLinkAgentService"
        private const val PREFS_NAME = "vibelink_device_agent"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_TOKEN = "token"
        private const val KEY_ENDPOINTS = "endpoints"
        private const val KEY_ACTIVE_URL = "activeUrl"
        private const val KEY_DEVICE_ID = "deviceId"
        private const val KEY_ACTIVE_PROXY_MODE = "activeProxyMode"
        private const val KEY_ACTIVE_PROXY_URL = "activeProxyUrl"

        private const val CHANNEL_ID = "vibelink_agent_channel"
        private const val NOTIF_ID = 41001

        const val ACTION_START_OR_SYNC = "com.vibelink.app.agent.START_OR_SYNC"
        const val ACTION_STOP = "com.vibelink.app.agent.STOP"

        @Volatile
        var isForegroundRunning: Boolean = false
            private set

        @Volatile
        var isSocketConnected: Boolean = false
            private set

        @Volatile
        var activeEndpointUrl: String? = null
            private set

        fun getOrCreateDeviceId(context: Context): String {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val existing = prefs.getString(KEY_DEVICE_ID, null)?.trim()
            if (!existing.isNullOrEmpty()) return existing
            val androidId = runCatching {
                Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
            }.getOrNull()?.trim().orEmpty()
            val generated = if (androidId.isNotEmpty()) {
                "android_${androidId.take(12)}"
            } else {
                "android_${Build.MODEL.replace(Regex("[^a-zA-Z0-9]+"), "_").lowercase().take(12)}_${System.currentTimeMillis() % 10000}"
            }
            prefs.edit().putString(KEY_DEVICE_ID, generated).apply()
            return generated
        }

        fun isAgentEnabled(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            return prefs.getBoolean(KEY_ENABLED, false)
        }

        fun saveConfig(
            context: Context,
            enabled: Boolean,
            token: String,
            endpoints: List<String>,
            activeUrl: String?
        ) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val arr = JSONArray()
            endpoints.distinct().forEach { arr.put(it) }
            prefs.edit()
                .putBoolean(KEY_ENABLED, enabled)
                .putString(KEY_TOKEN, token.trim())
                .putString(KEY_ENDPOINTS, arr.toString())
                .putString(KEY_ACTIVE_URL, activeUrl?.trim().orEmpty())
                .apply()
        }

        fun syncAndEnsureRunning(context: Context, configJson: String) {
            val obj = JSONObject(configJson)
            val enabled = obj.optBoolean("enabled", true)
            val token = obj.optString("token", "").trim()
            val activeUrl = obj.optString("activeUrl", "").trim()
            val endpoints = mutableListOf<String>()
            val arr = obj.optJSONArray("endpoints")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val u = arr.optString(i, "").trim()
                    if (u.startsWith("http://") || u.startsWith("https://")) {
                        endpoints.add(u.trimEnd('/'))
                    }
                }
            }
            if (activeUrl.startsWith("http://") || activeUrl.startsWith("https://")) {
                val cleanActive = activeUrl.trimEnd('/')
                if (!endpoints.contains(cleanActive)) {
                    endpoints.add(0, cleanActive)
                }
            }
            saveConfig(context, enabled, token, endpoints, activeUrl)
            if (enabled && endpoints.isNotEmpty()) {
                startService(context)
            } else if (!enabled) {
                stopService(context)
            }
        }

        fun setEnabledAndUpdate(context: Context, enabled: Boolean) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            prefs.edit().putBoolean(KEY_ENABLED, enabled).apply()
            if (enabled) {
                startService(context)
            } else {
                stopService(context)
            }
        }

        fun startIfConfigured(context: Context) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val enabled = prefs.getBoolean(KEY_ENABLED, false)
            val rawEps = prefs.getString(KEY_ENDPOINTS, "[]") ?: "[]"
            val hasEps = runCatching { JSONArray(rawEps).length() > 0 }.getOrDefault(false)
            if (enabled && hasEps) {
                startService(context)
            }
        }

        private fun startService(context: Context) {
            val intent = Intent(context, VibeLinkAgentService::class.java).apply {
                action = ACTION_START_OR_SYNC
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        private fun stopService(context: Context) {
            val intent = Intent(context, VibeLinkAgentService::class.java).apply {
                action = ACTION_STOP
            }
            runCatching { context.startService(intent) }
        }

        fun collectCapabilities(context: Context): JSONObject {
            val sysProxy = PrivilegedExecutor.getSystemGlobalHttpProxy(context)
            val vpnRunning = VibeLinkVpnService.isRunning
            val activeProxyMode = when {
                vpnRunning -> VibeLinkVpnService.activeMode
                !sysProxy.isNullOrEmpty() -> "system_proxy"
                else -> "off"
            }
            val activeProxyUrl = when {
                vpnRunning -> VibeLinkVpnService.activeProxyUrl
                !sysProxy.isNullOrEmpty() -> "http://$sysProxy"
                else -> null
            }
            val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            val batteryIgnored = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && pm != null) {
                pm.isIgnoringBatteryOptimizations(context.packageName)
            } else {
                true
            }
            return JSONObject().apply {
                put("deviceId", getOrCreateDeviceId(context))
                put("root", PrivilegedExecutor.hasRoot())
                put("shizukuInstalled", PrivilegedExecutor.isShizukuInstalled(context))
                put("shizukuRunning", PrivilegedExecutor.isShizukuRunning())
                put("shizukuGranted", PrivilegedExecutor.isShizukuGranted())
                put("accessibilityEnabled", VibeLinkAccessibilityService.isEnabled(context))
                put("vpnPrepared", VibeLinkVpnService.isPrepared(context))
                put("vpnRunning", vpnRunning)
                put("otherVpnActive", VibeLinkVpnService.isOtherVpnActive(context))
                put("foregroundService", isForegroundRunning)
                put("socketConnected", isSocketConnected)
                put("batteryOptimizationIgnored", batteryIgnored)
                put("activeProxyMode", activeProxyMode)
                if (activeProxyUrl != null) put("activeProxyUrl", activeProxyUrl) else put("activeProxyUrl", JSONObject.NULL)
                if (sysProxy != null) put("systemHttpProxy", sysProxy) else put("systemHttpProxy", JSONObject.NULL)
                val curEp = activeEndpointUrl
                if (curEp != null) put("activeEndpointUrl", curEp) else put("activeEndpointUrl", JSONObject.NULL)
                val mStatus = MihomoCoreManager.getStatus(context)
                put("mihomoAvailable", mStatus.optBoolean("available", false))
                put("mihomoRunning", mStatus.optBoolean("running", false))
                put("mihomoVersion", mStatus.opt("version") ?: JSONObject.NULL)
                put("mihomoActiveNode", mStatus.opt("activeNode") ?: JSONObject.NULL)
                put("mihomoTailscaleLoginUrl", mStatus.opt("tailscaleLoginUrl") ?: JSONObject.NULL)
                put("mihomoHasConfig", mStatus.optBoolean("hasConfig", false))
            }
        }

        fun startMihomoAndWait(
            context: Context,
            yamlOverride: String? = null,
            configName: String? = null,
            resetTailscaleState: Boolean = false
        ): JSONObject {
            if (!VibeLinkVpnService.prepareForTakeover(context)) {
                throw IllegalStateException("Android VPN 权限未预授权，请先在手机「我的 -> 控机」点击「授权一次 VPN」")
            }
            if (PrivilegedExecutor.hasRoot() || PrivilegedExecutor.isShizukuGranted()) {
                if (!PrivilegedExecutor.getSystemGlobalHttpProxy(context).isNullOrEmpty()) {
                    PrivilegedExecutor.clearSystemGlobalHttpProxy()
                }
            }
            val seq = VibeLinkVpnService.startOrUpdate(
                context = context,
                proxyUrl = "socks5://127.0.0.1:${MihomoCoreManager.MIXED_PORT}",
                mode = "mihomo",
                dnsMode = "virtual",
                bypassPackages = arrayListOf(),
                mihomoYaml = yamlOverride,
                mihomoConfigName = configName,
                resetTailscaleState = resetTailscaleState
            )
            val deadline = System.currentTimeMillis() + 12_000L
            while (System.currentTimeMillis() < deadline) {
                if (VibeLinkVpnService.finishedSeq >= seq) {
                    break
                }
                Thread.sleep(80)
            }
            if (!VibeLinkVpnService.isRunning || VibeLinkVpnService.activeMode != "mihomo" || !MihomoCoreManager.isRunning) {
                throw IllegalStateException(
                    VibeLinkVpnService.lastError ?: MihomoCoreManager.lastError ?: "启动内置 Mihomo VPN 失败"
                )
            }
            return MihomoCoreManager.getStatus(context)
        }

        fun stopMihomoTunnel(context: Context): JSONObject {
            val hadVpn = VibeLinkVpnService.isRunning
            if (hadVpn) {
                VibeLinkVpnService.stop(context)
            } else {
                MihomoCoreManager.stop(context)
            }
            val deadline = System.currentTimeMillis() + 2500L
            while (System.currentTimeMillis() < deadline) {
                if (!VibeLinkVpnService.isRunning && !MihomoCoreManager.isRunning) break
                Thread.sleep(80)
            }
            return MihomoCoreManager.getStatus(context)
        }

        private fun isTailnetHost(hostRaw: String?): Boolean {
            val host = hostRaw?.trim()?.lowercase()?.removeSuffix(".") ?: return false
            if (host.endsWith(".ts.net")) return true
            val parts = host.split('.')
            if (parts.size != 4) return false
            val octets = parts.map { it.toIntOrNull() ?: return false }
            if (octets.any { it !in 0..255 }) return false
            // Tailscale CGNAT 100.64.0.0/10 (100.64.0.0 .. 100.127.255.255)
            return octets[0] == 100 && octets[1] in 64..127
        }

        fun applyProxy(
            context: Context,
            proxyUrlRaw: String,
            requestedMode: String = "auto",
            dnsMode: String = "over_tcp",
            bypassPackages: List<String> = emptyList()
        ): JSONObject {
            val proxyUrl = proxyUrlRaw.trim()
            if (proxyUrl.isEmpty()) {
                throw IllegalArgumentException("proxyUrl 不能为空")
            }

            val rootOrShizuku = PrivilegedExecutor.hasRoot() || PrivilegedExecutor.isShizukuGranted()
            val vpnReady = VibeLinkVpnService.isPrepared(context)
            val otherVpn = VibeLinkVpnService.isOtherVpnActive(context)

            val chosenMode = when (requestedMode.trim().lowercase()) {
                "vpn_tun" -> "vpn_tun"
                "vpn_http" -> "vpn_http"
                "system_proxy" -> "system_proxy"
                else -> {
                    when {
                        otherVpn && rootOrShizuku -> "system_proxy"
                        vpnReady -> "vpn_tun"
                        rootOrShizuku -> "system_proxy"
                        else -> throw IllegalStateException(
                            "VPN 尚未预授权且无 Root/Shizuku 权限；请在手机端「我的 -> 控机」点一次「授权本地 VPN」或授权 Shizuku。"
                        )
                    }
                }
            }

            return if (chosenMode == "system_proxy") {
                if (VibeLinkVpnService.isRunning) {
                    VibeLinkVpnService.stop(context)
                }
                val hostPort = extractHostPort(proxyUrl)
                val execRes = PrivilegedExecutor.setSystemGlobalHttpProxy(hostPort)
                if (!execRes.ok) {
                    throw IllegalStateException("设置全局 HTTP 代理失败 (${execRes.backend}): ${execRes.stderr}")
                }
                JSONObject().apply {
                    put("applied", true)
                    put("mode", "system_proxy")
                    put("backend", execRes.backend)
                    put("systemHttpProxy", hostPort)
                    put("proxyUrl", "http://$hostPort")
                }
            } else {
                if (!VibeLinkVpnService.prepareForTakeover(context)) {
                    throw IllegalStateException("Android VPN 权限未预授权，请先在手机「我的 -> 控机」点击「授权本地 VPN」")
                }
                if (rootOrShizuku && !PrivilegedExecutor.getSystemGlobalHttpProxy(context).isNullOrEmpty()) {
                    PrivilegedExecutor.clearSystemGlobalHttpProxy()
                }
                val list = ArrayList(bypassPackages)
                VibeLinkVpnService.startOrUpdate(context, proxyUrl, chosenMode, dnsMode, list)
                val deadline = System.currentTimeMillis() + 2000L
                while (System.currentTimeMillis() < deadline) {
                    if (VibeLinkVpnService.isRunning && VibeLinkVpnService.activeMode == chosenMode) {
                        break
                    }
                    if (!VibeLinkVpnService.lastError.isNullOrEmpty() && !VibeLinkVpnService.isRunning) {
                        break
                    }
                    Thread.sleep(60)
                }
                if (!VibeLinkVpnService.isRunning) {
                    throw IllegalStateException(VibeLinkVpnService.lastError ?: "启动本地 VPN 服务失败")
                }
                JSONObject().apply {
                    put("applied", true)
                    put("mode", VibeLinkVpnService.activeMode)
                    put("proxyUrl", proxyUrl)
                    put("dnsMode", dnsMode)
                }
            }
        }

        fun clearProxy(context: Context): JSONObject {
            val hadVpn = VibeLinkVpnService.isRunning
            if (hadVpn) {
                VibeLinkVpnService.stop(context)
            }
            var clearedSys = false
            if (PrivilegedExecutor.hasRoot() || PrivilegedExecutor.isShizukuGranted()) {
                val res = PrivilegedExecutor.clearSystemGlobalHttpProxy()
                clearedSys = res.ok
            }
            return JSONObject().apply {
                put("cleared", true)
                put("stoppedVpn", hadVpn)
                put("clearedSystemProxy", clearedSys)
            }
        }

        private fun extractHostPort(raw: String): String {
            return if (raw.contains("://")) {
                val uri = URI(raw)
                val h = uri.host ?: throw IllegalArgumentException("无法解析代理主机：$raw")
                val p = if (uri.port > 0) uri.port else 7898
                "$h:$p"
            } else {
                raw
            }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val workerPool = Executors.newCachedThreadPool()
    private val httpClient = OkHttpClient.Builder()
        .proxySelector(object : ProxySelector() {
            override fun select(uri: URI?): List<Proxy> {
                if (MihomoCoreManager.isRunning && isTailnetHost(uri?.host)) {
                    return listOf(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", MihomoCoreManager.MIXED_PORT)))
                }
                return listOf(Proxy.NO_PROXY)
            }

            override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) {
                // ignore
            }
        })
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    @Volatile
    private var destroyed = false

    @Volatile
    private var activeWebSocket: WebSocket? = null

    @Volatile
    private var currentToken: String = ""

    @Volatile
    private var currentEndpoints: List<String> = emptyList()

    @Volatile
    private var endpointIndex = 0

    @Volatile
    private var retryAttempt = 0

    private val reconnectRunnable = Runnable {
        if (!destroyed) {
            connectNextEndpoint()
        }
    }

    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            if (destroyed) return
            val ws = activeWebSocket
            if (ws != null && isSocketConnected) {
                val msg = JSONObject().apply {
                    put("type", "heartbeat")
                    put("capabilities", collectCapabilities(this@VibeLinkAgentService))
                }
                ws.send(msg.toString())
            }
            mainHandler.postDelayed(this, 20_000L)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureNotificationChannel()
        if (intent?.action == ACTION_STOP) {
            shutdownService()
            return START_NOT_STICKY
        }

        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_ENABLED, false)) {
            shutdownService()
            return START_NOT_STICKY
        }

        isForegroundRunning = true
        startForegroundCompat(buildNotification("VibeLink 后台控机就绪", "等待控制面连接..."))

        loadConfigFromPrefs()
        mainHandler.removeCallbacks(heartbeatRunnable)
        mainHandler.postDelayed(heartbeatRunnable, 20_000L)
        reconnectNow()

        return START_STICKY
    }

    override fun onDestroy() {
        destroyed = true
        isForegroundRunning = false
        isSocketConnected = false
        activeEndpointUrl = null
        mainHandler.removeCallbacks(reconnectRunnable)
        mainHandler.removeCallbacks(heartbeatRunnable)
        runCatching { activeWebSocket?.close(1000, "Service destroyed") }
        activeWebSocket = null
        workerPool.shutdownNow()
        super.onDestroy()
    }

    private fun shutdownService() {
        isForegroundRunning = false
        isSocketConnected = false
        activeEndpointUrl = null
        mainHandler.removeCallbacks(reconnectRunnable)
        mainHandler.removeCallbacks(heartbeatRunnable)
        runCatching { activeWebSocket?.close(1000, "Stopped by user") }
        activeWebSocket = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    private fun loadConfigFromPrefs() {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        currentToken = prefs.getString(KEY_TOKEN, "")?.trim().orEmpty()
        val rawArr = prefs.getString(KEY_ENDPOINTS, "[]") ?: "[]"
        val list = mutableListOf<String>()
        runCatching {
            val arr = JSONArray(rawArr)
            for (i in 0 until arr.length()) {
                val u = arr.optString(i, "").trim().trimEnd('/')
                if (u.isNotEmpty() && !list.contains(u)) {
                    list.add(u)
                }
            }
        }
        val activeUrl = prefs.getString(KEY_ACTIVE_URL, "")?.trim()?.trimEnd('/').orEmpty()
        if (activeUrl.isNotEmpty()) {
            list.remove(activeUrl)
            list.add(0, activeUrl)
        }
        currentEndpoints = list
    }

    private fun reconnectNow() {
        mainHandler.removeCallbacks(reconnectRunnable)
        runCatching { activeWebSocket?.cancel() }
        activeWebSocket = null
        isSocketConnected = false
        endpointIndex = 0
        retryAttempt = 0
        connectNextEndpoint()
    }

    private fun connectNextEndpoint() {
        if (destroyed || !isAgentEnabled(this)) return
        val eps = currentEndpoints
        if (eps.isEmpty()) {
            updateNotification("VibeLink 控机待配对", "尚未配置电脑控制面地址")
            return
        }

        val idx = endpointIndex % eps.size
        val baseUrl = eps[idx]
        val parsedUri = runCatching { URI(baseUrl) }.getOrNull()
        if (parsedUri != null && isTailnetHost(parsedUri.host) && !MihomoCoreManager.isRunning && MihomoCoreManager.hasConfig(applicationContext)) {
            val hostPort = "${parsedUri.host}:${if (parsedUri.port > 0) parsedUri.port else 18990}"
            workerPool.execute {
                runCatching { MihomoCoreManager.ensureTailscaleBridge(applicationContext, hostPort) }
                if (!destroyed && isAgentEnabled(this)) {
                    mainHandler.post { openWebSocketToEndpoint(baseUrl) }
                }
            }
            return
        }
        openWebSocketToEndpoint(baseUrl)
    }

    private fun openWebSocketToEndpoint(baseUrl: String) {
        if (destroyed || !isAgentEnabled(this)) return
        val wsUrl = buildWsUrl(baseUrl, currentToken)
        Log.i(TAG, "Connecting device WebSocket -> $baseUrl/ws/vl/device")

        val req = Request.Builder().url(wsUrl).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (activeWebSocket !== webSocket) {
                    webSocket.close(1000, "Superseded")
                    return
                }
                isSocketConnected = true
                activeEndpointUrl = baseUrl
                retryAttempt = 0
                updateNotification("VibeLink 远程控机在线", "已连 $baseUrl")

                val hello = JSONObject().apply {
                    put("type", "hello")
                    put("deviceId", getOrCreateDeviceId(this@VibeLinkAgentService))
                    put("name", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                    put("model", Build.MODEL)
                    put("manufacturer", Build.MANUFACTURER)
                    put("androidVersion", Build.VERSION.RELEASE ?: "")
                    put("sdkInt", Build.VERSION.SDK_INT)
                    put("appVersion", BuildConfig.VERSION_NAME)
                    put("capabilities", collectCapabilities(this@VibeLinkAgentService))
                }
                webSocket.send(hello.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (activeWebSocket !== webSocket) return
                val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
                if (obj.optString("type") == "invoke") {
                    val callId = obj.optString("callId", "")
                    val command = obj.optString("command", "")
                    val params = obj.optJSONObject("params") ?: JSONObject()
                    if (callId.isNotEmpty() && command.isNotEmpty()) {
                        workerPool.execute {
                            executeAndReply(webSocket, callId, command, params)
                        }
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (activeWebSocket !== webSocket) return
                Log.w(TAG, "Device WebSocket failure ($baseUrl): ${t.message}")
                isSocketConnected = false
                scheduleNextAttempt()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (activeWebSocket !== webSocket) return
                isSocketConnected = false
                if (!destroyed && isAgentEnabled(this@VibeLinkAgentService)) {
                    scheduleNextAttempt()
                }
            }
        }
        activeWebSocket = httpClient.newWebSocket(req, listener)
    }

    private fun scheduleNextAttempt() {
        if (destroyed || currentEndpoints.isEmpty()) return
        endpointIndex = (endpointIndex + 1) % currentEndpoints.size
        retryAttempt += 1
        val delayMs = if (endpointIndex != 0 && retryAttempt <= currentEndpoints.size) {
            400L // Immediate failover across LAN / Tailscale / WAN channels
        } else {
            minOf(12_000L, 1_000L * (1 shl minOf(retryAttempt, 3)))
        }
        updateNotification("VibeLink 正在重连控制面...", "尝试切换可用通道 (${delayMs}ms)")
        mainHandler.removeCallbacks(reconnectRunnable)
        mainHandler.postDelayed(reconnectRunnable, delayMs)
    }

    private fun buildWsUrl(httpBase: String, token: String): String {
        val parsed = Uri.parse(httpBase)
        val wsScheme = if (parsed.scheme.equals("https", ignoreCase = true)) "wss" else "ws"
        val builder = parsed.buildUpon()
            .scheme(wsScheme)
            .path("/ws/vl/device")
            .clearQuery()
        if (token.isNotEmpty()) {
            builder.appendQueryParameter("token", token)
        }
        return builder.build().toString()
    }

    private fun executeAndReply(
        ws: WebSocket,
        callId: String,
        command: String,
        params: JSONObject
    ) {
        val started = System.currentTimeMillis()
        val reply = JSONObject().apply {
            put("type", "result")
            put("callId", callId)
        }
        try {
            val data = dispatchCommand(command, params)
            reply.put("ok", true)
            reply.put("data", data)
        } catch (e: Throwable) {
            reply.put("ok", false)
            reply.put("error", e.message ?: e.javaClass.simpleName)
        } finally {
            reply.put("durationMs", System.currentTimeMillis() - started)
            reply.put("capabilities", collectCapabilities(this))
        }
        ws.send(reply.toString())
    }

    private fun dispatchCommand(command: String, params: JSONObject): Any {
        return when (command) {
            "device.info" -> {
                val bm = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
                val batteryPct = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
                val am = getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
                val memInfo = ActivityManager.MemoryInfo()
                am?.getMemoryInfo(memInfo)
                val caps = collectCapabilities(this)
                caps.put("manufacturer", Build.MANUFACTURER)
                caps.put("model", Build.MODEL)
                caps.put("androidVersion", Build.VERSION.RELEASE ?: "")
                caps.put("sdkInt", Build.VERSION.SDK_INT)
                caps.put("appVersion", BuildConfig.VERSION_NAME)
                caps.put("batteryPercent", batteryPct)
                caps.put("availMemMb", memInfo.availMem / (1024 * 1024))
                caps.put("totalMemMb", memInfo.totalMem / (1024 * 1024))
                caps
            }

            "proxy.status" -> collectCapabilities(this)

            "proxy.apply" -> applyProxy(
                context = this,
                proxyUrlRaw = params.optString("proxyUrl", ""),
                requestedMode = params.optString("mode", "auto"),
                dnsMode = params.optString("dnsMode", "over_tcp"),
                bypassPackages = jsonArrayToStrings(params.optJSONArray("bypassPackages"))
            )

            "proxy.clear" -> clearProxy(this)

            "mihomo.status" -> MihomoCoreManager.getStatus(this)

            "mihomo.apply_config" -> {
                val yaml = params.optString("yaml", "")
                if (yaml.isBlank()) throw IllegalArgumentException("yaml 配置内容不能为空")
                val configName = params.optString("configName", "").ifEmpty { null }
                val resetTs = params.optBoolean("resetTailscaleState", false)
                val shouldStart = params.optBoolean("start", true)
                if (shouldStart) {
                    startMihomoAndWait(this, yaml, configName, resetTs)
                } else {
                    MihomoCoreManager.saveConfig(this, yaml, configName, resetTs)
                }
            }

            "mihomo.start" -> {
                val yaml = params.optString("yaml", "").ifEmpty { null }
                val configName = params.optString("configName", "").ifEmpty { null }
                val resetTs = params.optBoolean("resetTailscaleState", false)
                startMihomoAndWait(this, yaml, configName, resetTs)
            }

            "mihomo.stop" -> stopMihomoTunnel(this)

            "mihomo.proxies" -> MihomoCoreManager.getProxies(this)

            "mihomo.select" -> MihomoCoreManager.selectNode(
                context = this,
                group = params.optString("group", "手动选择"),
                node = params.optString("node", "")
            )

            "mihomo.mode" -> MihomoCoreManager.setRouteMode(
                context = this,
                mode = params.optString("mode", "rule")
            )

            "mihomo.delay" -> MihomoCoreManager.testDelay(
                context = this,
                node = params.optString("node", "").ifEmpty { null },
                group = params.optString("group", "").ifEmpty { null },
                url = params.optString("url", "https://www.gstatic.com/generate_204"),
                timeoutMs = params.optInt("timeoutMs", 5000)
            )

            "mihomo.probe" -> MihomoCoreManager.probeConnectivity(this)

            "ui.tree" -> {
                val svc = VibeLinkAccessibilityService.instance
                    ?: throw IllegalStateException("无障碍服务未开启，请先在手机开启「VibeLink 远程控机」无障碍权限（支持 Root/Shizuku 一键开启）")
                svc.dumpUiTree(params.optInt("maxDepth", 12))
            }

            "ui.screenshot" -> captureScreen(
                quality = params.optInt("quality", 85),
                maxWidth = params.optInt("maxWidth", 1080)
            )

            "ui.tap" -> {
                if (params.has("x") && params.has("y")) {
                    val x = params.getDouble("x").toFloat()
                    val y = params.getDouble("y").toFloat()
                    val svc = VibeLinkAccessibilityService.instance
                    if (svc != null) {
                        val ok = svc.tapAt(x, y, params.optLong("durationMs", 60L))
                        JSONObject().put("tapped", ok).put("x", x).put("y", y).put("backend", "accessibility")
                    } else if (PrivilegedExecutor.hasRoot() || PrivilegedExecutor.isShizukuGranted()) {
                        val exec = PrivilegedExecutor.exec("input tap ${x.toInt()} ${y.toInt()}")
                        if (!exec.ok) throw IllegalStateException(exec.stderr)
                        JSONObject().put("tapped", true).put("x", x).put("y", y).put("backend", exec.backend)
                    } else {
                        throw IllegalStateException("请先开启无障碍服务或授权 Root/Shizuku")
                    }
                } else {
                    val svc = VibeLinkAccessibilityService.instance
                        ?: throw IllegalStateException("按控件文本/ID 点击需要开启无障碍服务")
                    svc.tapBySelector(
                        text = params.optString("text", "").ifEmpty { null },
                        resourceId = params.optString("resourceId", "").ifEmpty { null },
                        contentDesc = params.optString("contentDesc", "").ifEmpty { null },
                        index = params.optInt("index", 0)
                    )
                }
            }

            "ui.swipe" -> {
                val x1 = params.optDouble("x", 500.0).toFloat()
                val y1 = params.optDouble("y", 1200.0).toFloat()
                val x2 = params.optDouble("x2", 500.0).toFloat()
                val y2 = params.optDouble("y2", 400.0).toFloat()
                val dur = params.optLong("durationMs", 320L)
                val svc = VibeLinkAccessibilityService.instance
                if (svc != null) {
                    JSONObject().put("swiped", svc.swipe(x1, y1, x2, y2, dur)).put("backend", "accessibility")
                } else if (PrivilegedExecutor.hasRoot() || PrivilegedExecutor.isShizukuGranted()) {
                    val exec = PrivilegedExecutor.exec("input swipe ${x1.toInt()} ${y1.toInt()} ${x2.toInt()} ${y2.toInt()} $dur")
                    if (!exec.ok) throw IllegalStateException(exec.stderr)
                    JSONObject().put("swiped", true).put("backend", exec.backend)
                } else {
                    throw IllegalStateException("请先开启无障碍服务或授权 Root/Shizuku")
                }
            }

            "ui.input" -> {
                val text = params.optString("text", "")
                val clearFirst = params.optBoolean("clearFirst", false)
                val svc = VibeLinkAccessibilityService.instance
                if (svc != null) {
                    val ok = svc.inputText(text, clearFirst)
                    JSONObject().put("input", ok).put("backend", "accessibility")
                } else if (PrivilegedExecutor.hasRoot() || PrivilegedExecutor.isShizukuGranted()) {
                    val escaped = text.replace("'", "'\\''")
                    val exec = PrivilegedExecutor.exec("input text '$escaped'")
                    if (!exec.ok) throw IllegalStateException(exec.stderr)
                    JSONObject().put("input", true).put("backend", exec.backend)
                } else {
                    throw IllegalStateException("请先开启无障碍服务或授权 Root/Shizuku")
                }
            }

            "ui.key" -> {
                val key = params.optString("key", "home")
                val svc = VibeLinkAccessibilityService.instance
                if (svc != null && svc.performKey(key)) {
                    JSONObject().put("performed", true).put("key", key).put("backend", "accessibility")
                } else if (PrivilegedExecutor.hasRoot() || PrivilegedExecutor.isShizukuGranted()) {
                    val keyCode = when (key.lowercase()) {
                        "home" -> "KEYCODE_HOME"
                        "back" -> "KEYCODE_BACK"
                        "recents", "apps" -> "KEYCODE_APP_SWITCH"
                        "power" -> "KEYCODE_POWER"
                        "enter" -> "KEYCODE_ENTER"
                        else -> key
                    }
                    val exec = PrivilegedExecutor.exec("input keyevent $keyCode")
                    if (!exec.ok) throw IllegalStateException(exec.stderr)
                    JSONObject().put("performed", true).put("key", key).put("backend", exec.backend)
                } else {
                    throw IllegalStateException("请先开启无障碍服务或授权 Root/Shizuku")
                }
            }

            "app.launch" -> {
                val pkg = params.optString("packageName", "").trim()
                if (pkg.isEmpty()) throw IllegalArgumentException("packageName 不能为空")
                val launchIntent = packageManager.getLaunchIntentForPackage(pkg)
                if (launchIntent != null) {
                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(launchIntent)
                    JSONObject().put("launched", true).put("packageName", pkg).put("backend", "intent")
                } else if (PrivilegedExecutor.hasRoot() || PrivilegedExecutor.isShizukuGranted()) {
                    val exec = PrivilegedExecutor.exec("monkey -p '${pkg.replace("'", "")}' -c android.intent.category.LAUNCHER 1")
                    if (!exec.ok) throw IllegalStateException(exec.stderr)
                    JSONObject().put("launched", true).put("packageName", pkg).put("backend", exec.backend)
                } else {
                    throw IllegalStateException("未找到应用 $pkg 的启动入口")
                }
            }

            "app.list" -> {
                val pm = packageManager
                @Suppress("DEPRECATION")
                val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
                val out = JSONArray()
                for (ai in apps) {
                    if (pm.getLaunchIntentForPackage(ai.packageName) == null) continue
                    out.put(JSONObject().apply {
                        put("packageName", ai.packageName)
                        put("label", pm.getApplicationLabel(ai).toString())
                    })
                }
                JSONObject().put("apps", out)
            }

            "clipboard.get" -> {
                var clipText = ""
                val latch = java.util.concurrent.CountDownLatch(1)
                mainHandler.post {
                    runCatching {
                        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                        clipText = cm?.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString().orEmpty()
                    }
                    latch.countDown()
                }
                latch.await(2, TimeUnit.SECONDS)
                JSONObject().put("text", clipText)
            }

            "clipboard.set" -> {
                val text = params.optString("text", "")
                val latch = java.util.concurrent.CountDownLatch(1)
                mainHandler.post {
                    runCatching {
                        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                        cm?.setPrimaryClip(ClipData.newPlainText("VibeLink", text))
                    }
                    latch.countDown()
                }
                latch.await(2, TimeUnit.SECONDS)
                JSONObject().put("set", true)
            }

            "device.wake" -> {
                val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
                @Suppress("DEPRECATION")
                val wl = pm?.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                    "VibeLink:RemoteWake"
                )
                wl?.acquire(3000L)
                JSONObject().put("woke", true)
            }

            "shell.exec" -> {
                val cmd = params.optString("command", "").trim()
                if (cmd.isEmpty()) throw IllegalArgumentException("command 不能为空")
                val timeoutMs = params.optInt("timeoutMs", 15_000)
                PrivilegedExecutor.exec(cmd, timeoutMs).toJson()
            }

            else -> throw UnsupportedOperationException("未知手机指令：$command")
        }
    }

    private fun captureScreen(quality: Int, maxWidth: Int): JSONObject {
        val a11y = VibeLinkAccessibilityService.instance
        if (a11y != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val res = a11y.captureScreenshotBase64(quality, maxWidth)
            if (res.optBoolean("ok", false)) {
                return res
            }
        }
        if (PrivilegedExecutor.hasRoot() || PrivilegedExecutor.isShizukuGranted()) {
            val exec = PrivilegedExecutor.exec("screencap -p | base64 | tr -d '\\n'", 15_000)
            if (exec.ok && exec.stdout.trim().isNotEmpty()) {
                val rawBytes = Base64.decode(exec.stdout.trim(), Base64.DEFAULT)
                val bmp = BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size)
                if (bmp != null) {
                    val out = ByteArrayOutputStream()
                    bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
                    val w = bmp.width
                    val h = bmp.height
                    bmp.recycle()
                    return JSONObject().apply {
                        put("ok", true)
                        put("backend", exec.backend)
                        put("mimeType", "image/png")
                        put("width", w)
                        put("height", h)
                        put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                    }
                }
            }
        }
        throw IllegalStateException("截屏失败：需要开启无障碍服务（Android 11+ 免 Root 支持）或授予 Root / Shizuku 权限")
    }

    private fun jsonArrayToStrings(arr: JSONArray?): List<String> {
        if (arr == null) return emptyList()
        val list = mutableListOf<String>()
        for (i in 0 until arr.length()) {
            val v = arr.optString(i, "").trim()
            if (v.isNotEmpty()) list.add(v)
        }
        return list
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            val ch = NotificationChannel(
                CHANNEL_ID,
                "VibeLink 后台控机服务",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "保持电脑端 Agent 与手机之间的双向加密控制通道在线"
            }
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(title: String, text: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pendingIntent = PendingIntent.getActivity(this, 1, openIntent, piFlags)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun updateNotification(title: String, text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        nm.notify(NOTIF_ID, buildNotification(title, text))
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }
}
