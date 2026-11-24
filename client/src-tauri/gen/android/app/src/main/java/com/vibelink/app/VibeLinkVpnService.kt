package com.vibelink.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.ProxyInfo
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

class VibeLinkVpnService : VpnService() {

    companion object {
        private const val TAG = "VibeLinkVpnService"
        private const val CHANNEL_ID = "vibelink_vpn_channel"
        private const val NOTIF_ID = 41002
        private const val PREFS_VPN = "vibelink_vpn_prefs"
        private const val KEY_VPN_CONSENTED = "vpn_consented"

        const val ACTION_APPLY_PROXY = "com.vibelink.app.vpn.APPLY_PROXY"
        const val ACTION_STOP_PROXY = "com.vibelink.app.vpn.STOP_PROXY"

        const val EXTRA_PROXY_URL = "proxyUrl"
        const val EXTRA_MODE = "mode" // "vpn_tun" | "vpn_http" | "mihomo"
        const val EXTRA_DNS_MODE = "dnsMode" // "virtual" | "over_tcp" | "direct"
        const val EXTRA_BYPASS_PACKAGES = "bypassPackages"
        const val EXTRA_MIHOMO_YAML = "mihomoYaml"
        const val EXTRA_MIHOMO_CONFIG_NAME = "mihomoConfigName"
        const val EXTRA_RESET_TS = "resetTailscaleState"
        const val EXTRA_REQ_SEQ = "reqSeq"

        private val requestSeq = AtomicLong(0L)

        @Volatile
        var finishedSeq: Long = 0L
            private set

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        var activeMode: String = "off"
            private set

        @Volatile
        var activeProxyUrl: String? = null
            private set

        @Volatile
        var lastError: String? = null
            private set

        @Volatile
        var lastExitCode: Int = 0
            private set

        init {
            try {
                System.loadLibrary("hula_app_lib")
            } catch (e: Throwable) {
                Log.w(TAG, "loadLibrary(hula_app_lib) deferred or failed: ${e.message}")
            }
        }

        fun markConsented(context: Context, consented: Boolean) {
            runCatching {
                context.getSharedPreferences(PREFS_VPN, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean(KEY_VPN_CONSENTED, consented)
                    .apply()
            }
        }

        fun isPrepared(context: Context): Boolean {
            if (isRunning) {
                markConsented(context, true)
                return true
            }
            // VpnService.prepare() immediately revokes any other active VPN if this app already has consent.
            if (isOtherVpnActive(context)) {
                return context.getSharedPreferences(PREFS_VPN, Context.MODE_PRIVATE)
                    .getBoolean(KEY_VPN_CONSENTED, false)
            }
            val ready = prepare(context) == null
            if (ready) {
                markConsented(context, true)
            }
            return ready
        }

        fun prepareForTakeover(context: Context): Boolean {
            val ready = prepare(context) == null
            markConsented(context, ready)
            return ready
        }

        fun isOtherVpnActive(context: Context): Boolean {
            if (isRunning) return false
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                ?: return false
            return try {
                @Suppress("DEPRECATION")
                cm.allNetworks.any { network ->
                    val caps = cm.getNetworkCapabilities(network)
                    caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                }
            } catch (_: Throwable) {
                false
            }
        }

        fun startOrUpdate(
            context: Context,
            proxyUrl: String,
            mode: String = "vpn_tun",
            dnsMode: String = "over_tcp",
            bypassPackages: ArrayList<String> = arrayListOf(),
            mihomoYaml: String? = null,
            mihomoConfigName: String? = null,
            resetTailscaleState: Boolean = false
        ): Long {
            val seq = requestSeq.incrementAndGet()
            lastError = null
            val intent = Intent(context, VibeLinkVpnService::class.java).apply {
                action = ACTION_APPLY_PROXY
                putExtra(EXTRA_PROXY_URL, proxyUrl)
                putExtra(EXTRA_MODE, mode)
                putExtra(EXTRA_DNS_MODE, dnsMode)
                putStringArrayListExtra(EXTRA_BYPASS_PACKAGES, bypassPackages)
                if (mihomoYaml != null) putExtra(EXTRA_MIHOMO_YAML, mihomoYaml)
                if (mihomoConfigName != null) putExtra(EXTRA_MIHOMO_CONFIG_NAME, mihomoConfigName)
                putExtra(EXTRA_RESET_TS, resetTailscaleState)
                putExtra(EXTRA_REQ_SEQ, seq)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            return seq
        }

        fun stop(context: Context) {
            if (!isRunning) {
                activeMode = "off"
                activeProxyUrl = null
                return
            }
            val intent = Intent(context, VibeLinkVpnService::class.java).apply {
                action = ACTION_STOP_PROXY
            }
            context.startService(intent)
        }
    }

    private external fun nativeStartTun2Proxy(
        proxyUrl: String,
        tunFd: Int,
        tunMtu: Int,
        dnsStrategy: Int
    ): Int

    private external fun nativeStopTun2Proxy(): Int

    private val lock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val serviceExecutor = Executors.newSingleThreadExecutor()
    private var tunInterface: ParcelFileDescriptor? = null
    private var workerThread: Thread? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureNotificationChannel()
        val action = intent?.action ?: ACTION_STOP_PROXY
        if (action == ACTION_STOP_PROXY) {
            serviceExecutor.execute {
                teardownTunnel()
                mainHandler.post {
                    stopForegroundCompat()
                    stopSelf()
                }
            }
            return START_NOT_STICKY
        }

        val proxyUrl = intent?.getStringExtra(EXTRA_PROXY_URL)?.trim().orEmpty()
        val mode = intent?.getStringExtra(EXTRA_MODE)?.trim().orEmpty().ifEmpty { "vpn_tun" }
        val dnsMode = intent?.getStringExtra(EXTRA_DNS_MODE)?.trim().orEmpty().ifEmpty {
            if (mode == "mihomo") "virtual" else "over_tcp"
        }
        val bypass = intent?.getStringArrayListExtra(EXTRA_BYPASS_PACKAGES) ?: arrayListOf()
        val mihomoYaml = intent?.getStringExtra(EXTRA_MIHOMO_YAML)
        val mihomoConfigName = intent?.getStringExtra(EXTRA_MIHOMO_CONFIG_NAME)
        val resetTs = intent?.getBooleanExtra(EXTRA_RESET_TS, false) ?: false
        val reqSeq = intent?.getLongExtra(EXTRA_REQ_SEQ, 0L) ?: 0L

        val effectiveProxyUrl = if (mode == "mihomo") {
            "socks5://127.0.0.1:${MihomoCoreManager.MIXED_PORT}"
        } else {
            proxyUrl
        }

        if (effectiveProxyUrl.isEmpty()) {
            lastError = "代理 URL 不能为空"
            if (reqSeq > finishedSeq) {
                finishedSeq = reqSeq
            }
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }

        val notifTitle = if (mode == "mihomo") "VibeLink 内置 Mihomo 运行中" else "VibeLink 代理运行中 ($mode)"
        startForegroundCompat(buildNotification(notifTitle, effectiveProxyUrl))

        serviceExecutor.execute {
            synchronized(lock) {
                teardownTunnelLocked()
                val ok = establishTunnelLocked(effectiveProxyUrl, mode, dnsMode, bypass, mihomoYaml, mihomoConfigName, resetTs)
                if (!ok) {
                    isRunning = false
                    activeMode = "off"
                    activeProxyUrl = null
                    mainHandler.post {
                        stopForegroundCompat()
                        stopSelf()
                    }
                }
                if (reqSeq > finishedSeq) {
                    finishedSeq = reqSeq
                }
            }
        }

        return START_STICKY
    }

    override fun onRevoke() {
        Log.w(TAG, "VPN permission revoked by system")
        serviceExecutor.execute {
            teardownTunnel()
            mainHandler.post {
                stopForegroundCompat()
                stopSelf()
            }
        }
        super.onRevoke()
    }

    override fun onDestroy() {
        teardownTunnel()
        serviceExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun establishTunnelLocked(
        proxyUrl: String,
        mode: String,
        dnsMode: String,
        bypassPackages: List<String>,
        mihomoYaml: String? = null,
        mihomoConfigName: String? = null,
        resetTailscaleState: Boolean = false
    ): Boolean {
        return try {
            val builder = Builder()
                .setSession("VibeLink Proxy")
                .setMtu(1500)
                .addAddress("10.254.0.2", 32)

            // CRITICAL: Prevent VibeLink's own WebSocket/HTTP control & tun2proxy sockets from looping into TUN
            try {
                builder.addDisallowedApplication(packageName)
            } catch (e: Throwable) {
                Log.w(TAG, "addDisallowedApplication($packageName) failed: ${e.message}")
            }
            for (pkg in bypassPackages) {
                val cleanPkg = pkg.trim()
                if (cleanPkg.isNotEmpty() && cleanPkg != packageName) {
                    runCatching { builder.addDisallowedApplication(cleanPkg) }
                }
            }

            if (mode == "vpn_http") {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    lastError = "vpn_http 模式需要 Android 10 (API 29) 及以上系统"
                    return false
                }
                val uri = URI(proxyUrl)
                val host = uri.host ?: run {
                    lastError = "无法解析代理主机：$proxyUrl"
                    return false
                }
                val port = if (uri.port > 0) uri.port else 7898
                // Dummy point route keeps Android VpnService valid without hijacking raw non-HTTP sockets
                builder.addRoute("10.254.0.1", 32)
                builder.setHttpProxy(ProxyInfo.buildDirectProxy(host, port))
                val pfd = builder.establish() ?: run {
                    lastError = "VpnService.establish() 返回 null（可能尚未授权或被其他 VPN 占用）"
                    return false
                }
                tunInterface = pfd
                isRunning = true
                activeMode = "vpn_http"
                activeProxyUrl = proxyUrl
                lastError = null
                lastExitCode = 0
                true
            } else {
                val isMihomoMode = (mode == "mihomo")
                if (isMihomoMode) {
                    val started = MihomoCoreManager.start(
                        context = this,
                        yamlOverride = mihomoYaml,
                        configName = mihomoConfigName,
                        resetTailscaleState = resetTailscaleState
                    )
                    if (!started) {
                        lastError = MihomoCoreManager.lastError ?: "启动内置 Mihomo 内核失败"
                        return false
                    }
                }

                builder
                    .addRoute("0.0.0.0", 0)
                    .addDnsServer("8.8.8.8")
                    .addDnsServer("1.1.1.1")

                val pfd = builder.establish() ?: run {
                    if (isMihomoMode) {
                        MihomoCoreManager.stop(this)
                    }
                    lastError = "VpnService.establish() 返回 null（可能尚未授权或被其他 VPN 占用）"
                    return false
                }
                tunInterface = pfd
                val fdInt = pfd.fd
                val dnsCode = if (isMihomoMode) {
                    0 // ArgDns::Virtual passes hostnames in SOCKS5 CONNECT so Mihomo DOMAIN/GEOSITE rules match
                } else {
                    when (dnsMode.lowercase()) {
                        "virtual" -> 0
                        "direct" -> 2
                        else -> 1 // over_tcp
                    }
                }

                isRunning = true
                activeMode = if (isMihomoMode) "mihomo" else "vpn_tun"
                activeProxyUrl = if (isMihomoMode) "mihomo://127.0.0.1:${MihomoCoreManager.MIXED_PORT}" else proxyUrl
                lastError = null
                lastExitCode = 0

                workerThread = thread(start = true, name = "vibelink-tun2proxy") {
                    val exitCode = try {
                        nativeStartTun2Proxy(proxyUrl, fdInt, 1500, dnsCode)
                    } catch (e: Throwable) {
                        Log.e(TAG, "nativeStartTun2Proxy threw exception", e)
                        lastError = e.message ?: e.javaClass.simpleName
                        -99
                    }
                    lastExitCode = exitCode
                    if (exitCode != 0 && isRunning) {
                        lastError = "tun2proxy exited with code $exitCode"
                    }
                    if (isMihomoMode && MihomoCoreManager.isRunning) {
                        MihomoCoreManager.stop(this)
                    }
                    isRunning = false
                    if (activeMode == "vpn_tun" || activeMode == "mihomo") {
                        activeMode = "off"
                        activeProxyUrl = null
                    }
                }
                true
            }
        } catch (e: Throwable) {
            Log.e(TAG, "establishTunnelLocked failed", e)
            lastError = e.message ?: e.javaClass.simpleName
            false
        }
    }

    private fun teardownTunnel() {
        synchronized(lock) {
            teardownTunnelLocked()
        }
    }

    private fun teardownTunnelLocked() {
        val wasMihomo = (activeMode == "mihomo") || MihomoCoreManager.isRunning
        isRunning = false
        activeMode = "off"
        activeProxyUrl = null

        runCatching { nativeStopTun2Proxy() }

        val prevThread = workerThread
        workerThread = null
        if (prevThread != null && prevThread.isAlive && prevThread != Thread.currentThread()) {
            runCatching { prevThread.join(1800) }
        }

        val prevPfd = tunInterface
        tunInterface = null
        if (prevPfd != null) {
            runCatching { prevPfd.close() }
        }

        if (wasMihomo) {
            runCatching { MihomoCoreManager.stop(this) }
        }
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            val ch = NotificationChannel(
                CHANNEL_ID,
                "VibeLink VPN 代理",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "用于免 Root 全机透明代理与 WProxy 同步"
            }
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(title: String, text: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pendingIntent = PendingIntent.getActivity(this, 0, openIntent, piFlags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }
}
