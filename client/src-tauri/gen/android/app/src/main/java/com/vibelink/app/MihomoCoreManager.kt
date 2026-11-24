package com.vibelink.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.URLEncoder
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

object MihomoCoreManager {
    private const val TAG = "MihomoCoreManager"

    const val MIXED_PORT = 17890
    const val CONTROLLER_PORT = 19090
    const val DNS_PORT = 11053

    private const val PREFS_NAME = "vibelink_mihomo_prefs"
    private const val KEY_SECRET = "controller_secret"
    private const val KEY_CONFIG_NAME = "config_name"
    private const val KEY_UPDATED_AT = "updated_at"

    private val lock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val logLines = ArrayDeque<String>(140)
    private val tsLoginRegex = Regex("""https://login\.tailscale\.com/a/[A-Za-z0-9_-]+""")
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val controllerClient = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .writeTimeout(5, TimeUnit.SECONDS)
        .build()

    @Volatile
    private var childProcess: Process? = null

    @Volatile
    var isRunning: Boolean = false
        private set

    @Volatile
    var runMode: String = "off" // "off" | "bridge" | "vpn"
        private set

    @Volatile
    var version: String? = null
        private set

    @Volatile
    var activeNode: String? = null
        private set

    @Volatile
    var effectiveNode: String? = null
        private set

    @Volatile
    var entryGroupNow: String? = null
        private set

    @Volatile
    var routeMode: String = "rule"
        private set

    @Volatile
    var tailscaleLoginUrl: String? = null
        private set

    @Volatile
    var lastError: String? = null
        private set

    @Volatile
    var autoHealNotice: String? = null
        private set

    @Volatile
    private var startedAtMs: Long = 0L

    private var registeredConnectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    fun isBinaryAvailable(context: Context): Boolean {
        val bin = binaryFile(context)
        return bin.exists() && bin.length() > 1_000_000L
    }

    fun hasConfig(context: Context): Boolean {
        val cfg = configFile(context)
        return cfg.exists() && cfg.length() > 32L
    }

    fun hasTailscaleState(context: Context): Boolean {
        val dir = tailscaleStateDir(context)
        val files = dir.listFiles() ?: return false
        return files.any { it.isFile && it.length() > 0L }
    }

    private fun binaryFile(context: Context): File {
        return File(context.applicationInfo.nativeLibraryDir, "libmihomo.so")
    }

    private fun homeDir(context: Context): File {
        return File(context.filesDir, "mihomo").apply {
            if (!exists()) mkdirs()
        }
    }

    private fun configFile(context: Context): File = File(homeDir(context), "config.yaml")

    private fun tailscaleStateDir(context: Context): File = File(homeDir(context), "tailscale")

    private fun getOrCreateSecret(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val existing = prefs.getString(KEY_SECRET, "")?.trim().orEmpty()
        if (existing.isNotEmpty()) return existing
        val created = UUID.randomUUID().toString().replace("-", "")
        prefs.edit().putString(KEY_SECRET, created).apply()
        return created
    }

    fun ensureAssets(context: Context) {
        val dir = homeDir(context)
        for (assetName in listOf("geoip.metadb", "geosite.dat")) {
            val target = File(dir, assetName)
            if (target.exists() && target.length() > 10_000L) continue
            runCatching {
                context.assets.open("mihomo/$assetName").use { input ->
                    val tmp = File(dir, "$assetName.tmp")
                    tmp.outputStream().use { out -> input.copyTo(out) }
                    tmp.renameTo(target)
                }
            }.onFailure { err ->
                Log.w(TAG, "Failed to copy asset mihomo/$assetName: ${err.message}")
            }
        }
    }

    /**
     * Rewrites Clash/Mihomo YAML so the embedded Android binary:
     * - binds loopback only on isolated ports (17890 / 19090 / 11053) with per-install secret,
     * - disables internal tun & fake-ip (tun2proxy owns tun0 and ArgDns::Virtual),
     * - stores Tailscale tsnet state under ./tailscale and strips stale auth-key once enrolled.
     */
    fun sanitizeYamlForAndroid(
        rawYaml: String,
        secret: String,
        stripTailscaleAuthKey: Boolean
    ): String {
        val clean = rawYaml.removePrefix("\uFEFF")
        val eol = if (clean.contains("\r\n")) "\r\n" else "\n"
        val lines = clean.split(Regex("\r?\n")).toMutableList()

        fun replaceOrInsertTopLevel(key: String, valueExpr: String) {
            val prefixRegex = Regex("""^${Regex.escape(key)}\s*:.*$""")
            val idx = lines.indexOfFirst { prefixRegex.matches(it) }
            val newLine = "$key: $valueExpr"
            if (idx >= 0) {
                lines[idx] = newLine
            } else {
                lines.add(0, newLine)
            }
        }

        // Remove any existing tun: top-level section so Mihomo never tries to open /dev/tun itself.
        val filtered = mutableListOf<String>()
        var skippingTun = false
        for (line in lines) {
            if (!skippingTun && line.trim() == "tun:") {
                skippingTun = true
                continue
            }
            if (skippingTun) {
                if (line.isNotEmpty() && !line.startsWith(" ") && !line.startsWith("\t") && !line.startsWith("#")) {
                    skippingTun = false
                } else {
                    continue
                }
            }
            filtered.add(line)
        }
        lines.clear()
        lines.addAll(filtered)

        replaceOrInsertTopLevel("mixed-port", "$MIXED_PORT")
        replaceOrInsertTopLevel("allow-lan", "false")
        replaceOrInsertTopLevel("bind-address", "127.0.0.1")
        replaceOrInsertTopLevel("external-controller", "'127.0.0.1:$CONTROLLER_PORT'")
        replaceOrInsertTopLevel("secret", "'$secret'")

        // Adjust dns: listen & enhanced-mode inside top-level dns block if present.
        val dnsIdx = lines.indexOfFirst { Regex("""^dns\s*:.*$""").matches(it) }
        if (dnsIdx >= 0) {
            var endIdx = lines.size
            for (i in (dnsIdx + 1) until lines.size) {
                val l = lines[i]
                if (l.isNotEmpty() && !l.startsWith(" ") && !l.startsWith("\t") && !l.startsWith("#")) {
                    endIdx = i
                    break
                }
            }
            var hasListen = false
            var hasEnhanced = false
            for (i in (dnsIdx + 1) until endIdx) {
                val t = lines[i].trimStart()
                val indent = lines[i].takeWhile { it == ' ' || it == '\t' }.ifEmpty { "  " }
                if (t.startsWith("listen:")) {
                    lines[i] = "${indent}listen: '127.0.0.1:$DNS_PORT'"
                    hasListen = true
                } else if (t.startsWith("enhanced-mode:")) {
                    lines[i] = "${indent}enhanced-mode: normal"
                    hasEnhanced = true
                }
            }
            if (!hasEnhanced) {
                lines.add(dnsIdx + 1, "  enhanced-mode: normal")
            }
            if (!hasListen) {
                lines.add(dnsIdx + 1, "  listen: '127.0.0.1:$DNS_PORT'")
            }
        }

        // Normalize type: tailscale nodes (inline object lines OR block entries) to ./tailscale.
        var inTailscaleBlock = false
        var tailscaleBlockIndent = 0
        for (i in lines.indices) {
            val line = lines[i]
            val trimmed = line.trim()

            // Inline style: - { name: 'tsnode', type: tailscale, ... }
            if (trimmed.startsWith("- {") && Regex("""\btype\s*:\s*['"]?tailscale['"]?\b""").containsMatchIn(line)) {
                var updated = line
                updated = if (Regex("""\bstate-dir\s*:""").containsMatchIn(updated)) {
                    updated.replace(Regex("""\bstate-dir\s*:\s*[^,}]+"""), "state-dir: './tailscale'")
                } else {
                    updated.replace(Regex("""\s*\}\s*$"""), ", state-dir: './tailscale' }")
                }
                if (stripTailscaleAuthKey) {
                    updated = updated
                        .replace(Regex(""",\s*auth-key\s*:\s*[^,}]+"""), "")
                        .replace(Regex("""auth-key\s*:\s*[^,}]+,\s*"""), "")
                }
                lines[i] = updated
                inTailscaleBlock = false
                continue
            }

            // Block style detection
            val leadingSpaces = line.indexOfFirst { it != ' ' && it != '\t' }.let { if (it < 0) 0 else it }
            if (trimmed.startsWith("- ") && Regex("""\btype\s*:\s*['"]?tailscale['"]?$""").containsMatchIn(trimmed)) {
                inTailscaleBlock = true
                tailscaleBlockIndent = leadingSpaces
                continue
            }
            if (inTailscaleBlock) {
                if (trimmed.isNotEmpty() && !trimmed.startsWith("#") && (trimmed.startsWith("- ") || leadingSpaces <= tailscaleBlockIndent)) {
                    inTailscaleBlock = false
                } else {
                    if (trimmed.startsWith("state-dir:")) {
                        val indent = line.takeWhile { it == ' ' || it == '\t' }
                        lines[i] = "${indent}state-dir: './tailscale'"
                    } else if (stripTailscaleAuthKey && trimmed.startsWith("auth-key:")) {
                        lines[i] = ""
                    }
                }
            }
        }

        return lines.filterIndexed { idx, s -> !(s.isEmpty() && idx > 0 && lines[idx - 1].isEmpty()) }.joinToString(eol)
    }

    fun validateYaml(context: Context, yamlText: String): Pair<Boolean, String> {
        ensureAssets(context)
        val bin = binaryFile(context)
        if (!bin.exists()) {
            return false to "内置 Mihomo 核心缺失：${bin.absolutePath}"
        }
        val dir = homeDir(context)
        val candidate = File(dir, "candidate.yaml")
        candidate.writeText(yamlText, Charsets.UTF_8)
        return try {
            val pb = ProcessBuilder(bin.absolutePath, "-t", "-d", dir.absolutePath, "-f", candidate.absolutePath)
            pb.redirectErrorStream(true)
            val proc = pb.start()
            val out = StringBuilder()
            val reader = thread(start = true) {
                runCatching {
                    BufferedReader(InputStreamReader(proc.inputStream, Charsets.UTF_8)).use { br ->
                        var line: String?
                        while (br.readLine().also { line = it } != null) {
                            out.appendLine(line)
                        }
                    }
                }
            }
            val finished = proc.waitFor(15, TimeUnit.SECONDS)
            if (!finished) {
                proc.destroyForcibly()
                return false to "mihomo -t 校验超时"
            }
            reader.join(1000)
            val text = out.toString().trim()
            (proc.exitValue() == 0) to text
        } catch (e: Throwable) {
            false to (e.message ?: e.javaClass.simpleName)
        } finally {
            runCatching { candidate.delete() }
        }
    }

    fun saveConfig(
        context: Context,
        rawYaml: String,
        configName: String? = null,
        resetTailscaleState: Boolean = false
    ): JSONObject {
        ensureAssets(context)
        if (resetTailscaleState) {
            runCatching { tailscaleStateDir(context).deleteRecursively() }
        }
        val secret = getOrCreateSecret(context)
        val stripAuthKey = !resetTailscaleState && hasTailscaleState(context)
        val sanitized = sanitizeYamlForAndroid(rawYaml, secret, stripAuthKey)
        val (ok, output) = validateYaml(context, sanitized)
        if (!ok) {
            throw IllegalArgumentException("Mihomo 配置校验失败：$output")
        }
        val dir = homeDir(context)
        val target = configFile(context)
        val tmp = File(dir, "config.yaml.tmp")
        tmp.writeText(sanitized, Charsets.UTF_8)
        if (!tmp.renameTo(target)) {
            target.writeText(sanitized, Charsets.UTF_8)
            tmp.delete()
        }
        val cleanName = configName?.trim()?.ifEmpty { "custom.yaml" } ?: "custom.yaml"
        val now = System.currentTimeMillis()
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString(KEY_CONFIG_NAME, cleanName)
            .putLong(KEY_UPDATED_AT, now)
            .apply()
        return JSONObject().apply {
            put("saved", true)
            put("configName", cleanName)
            put("updatedAt", now)
            put("bytes", target.length())
        }
    }

    fun start(
        context: Context,
        yamlOverride: String? = null,
        configName: String? = null,
        resetTailscaleState: Boolean = false,
        vpnActive: Boolean = true
    ): Boolean {
        synchronized(lock) {
            val existingProc = childProcess
            val canReuseRunning =
                yamlOverride.isNullOrBlank() &&
                    !resetTailscaleState &&
                    isRunning &&
                    existingProc != null &&
                    isProcessAlive(existingProc)
            if (canReuseRunning) {
                runMode = if (vpnActive) "vpn" else runMode
                applyWebViewProxy(true, waitMs = 1200L)
                runCatching {
                    val secret = getOrCreateSecret(context)
                    refreshSummaryFromController(secret)
                    triggerAutoGroupWarmupAndHealAsync(secret)
                }
                return true
            }

            stopLocked()
            ensureAssets(context)

            val bin = binaryFile(context)
            if (!bin.exists()) {
                lastError = "未找到内置 Mihomo 二进制：${bin.absolutePath}"
                return false
            }

            if (!yamlOverride.isNullOrBlank()) {
                try {
                    saveConfig(context, yamlOverride, configName, resetTailscaleState)
                } catch (e: Throwable) {
                    lastError = e.message ?: e.javaClass.simpleName
                    return false
                }
            } else if (resetTailscaleState) {
                runCatching { tailscaleStateDir(context).deleteRecursively() }
            }

            val cfg = configFile(context)
            if (!cfg.exists() || cfg.length() < 32L) {
                lastError = "尚未同步 Mihomo 配置文件，请先点击「从电脑同步配置」"
                return false
            }

            // Re-sanitize stored config if tsnode already persisted state so old single-use auth-key won't break restart.
            val secret = getOrCreateSecret(context)
            val alreadyEnrolled = hasTailscaleState(context)
            val existingRaw = cfg.readText(Charsets.UTF_8)
            val refreshed = sanitizeYamlForAndroid(existingRaw, secret, alreadyEnrolled)
            if (refreshed != existingRaw) {
                cfg.writeText(refreshed, Charsets.UTF_8)
            }

            lastError = null
            autoHealNotice = null
            tailscaleLoginUrl = null
            synchronized(logLines) { logLines.clear() }

            val home = homeDir(context)
            val proc = try {
                ProcessBuilder(bin.absolutePath, "-d", home.absolutePath, "-f", cfg.absolutePath)
                    .redirectErrorStream(true)
                    .start()
            } catch (e: Throwable) {
                lastError = "拉起 Mihomo 进程失败：${e.message ?: e.javaClass.simpleName}"
                return false
            }
            childProcess = proc

            thread(start = true, isDaemon = true, name = "vibelink-mihomo-stdout") {
                runCatching {
                    BufferedReader(InputStreamReader(proc.inputStream, Charsets.UTF_8)).use { br ->
                        var line: String?
                        while (br.readLine().also { line = it } != null) {
                            val l = line ?: continue
                            synchronized(logLines) {
                                if (logLines.size >= 120) logLines.removeFirst()
                                logLines.addLast(l)
                            }
                            val m = tsLoginRegex.find(l)
                            if (m != null) {
                                tailscaleLoginUrl = m.value
                                Log.i(TAG, "Captured Tailscale auth URL from tsnode")
                            }
                        }
                    }
                }
            }

            val deadline = System.currentTimeMillis() + 10_000L
            var readyVersion: String? = null
            while (System.currentTimeMillis() < deadline) {
                if (!isProcessAlive(proc)) {
                    val tail = synchronized(logLines) { logLines.toList().takeLast(8).joinToString(" | ") }
                    lastError = "Mihomo 内核意外退出 (code=${runCatching { proc.exitValue() }.getOrDefault(-1)}): $tail"
                    childProcess = null
                    return false
                }
                val ver = fetchVersionOnce(secret)
                if (ver != null) {
                    readyVersion = ver
                    break
                }
                Thread.sleep(150)
            }

            if (readyVersion == null) {
                val tail = synchronized(logLines) { logLines.toList().takeLast(8).joinToString(" | ") }
                lastError = "Mihomo 控制接口 (:19090) 响应超时: $tail"
                stopLocked()
                return false
            }

            version = readyVersion
            isRunning = true
            runMode = if (vpnActive) "vpn" else "bridge"
            startedAtMs = System.currentTimeMillis()
            applyWebViewProxy(true, waitMs = 1500L)
            runCatching {
                val pxObj = controllerGetWithSecret(secret, "/proxies")
                val proxiesMap = pxObj.optJSONObject("proxies")
                if (proxiesMap != null) {
                    syncGlobalSelector(secret, proxiesMap)
                }
                refreshSummaryFromController(secret)
            }
            registerNetworkWatcher(context.applicationContext, secret)
            if (refreshed.contains("tailscale")) {
                triggerTailscaleConnectAsync()
            }
            triggerAutoGroupWarmupAndHealAsync(secret)
            return true
        }
    }

    fun stop(context: Context? = null) {
        synchronized(lock) {
            stopLocked()
        }
    }

    private fun stopLocked() {
        unregisterNetworkWatcher()
        applyWebViewProxy(false)
        val proc = childProcess
        childProcess = null
        isRunning = false
        runMode = "off"
        autoHealNotice = null
        version = null
        activeNode = null
        effectiveNode = null
        entryGroupNow = null
        if (proc != null) {
            runCatching {
                proc.destroy()
                if (!proc.waitFor(900, TimeUnit.MILLISECONDS)) {
                    proc.destroyForcibly()
                }
            }
        }
    }

    private fun isProcessAlive(proc: Process): Boolean {
        return try {
            proc.exitValue()
            false
        } catch (_: IllegalThreadStateException) {
            true
        }
    }

    fun applyWebViewProxy(enable: Boolean, waitMs: Long = 0L) {
        val useLatch = waitMs > 0L && Looper.myLooper() != Looper.getMainLooper()
        val latch = if (useLatch) CountDownLatch(1) else null
        mainHandler.post {
            runCatching {
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
                    latch?.countDown()
                    return@runCatching
                }
                val ctrl = ProxyController.getInstance()
                val doneListener = Runnable { latch?.countDown() }
                if (enable && isRunning) {
                    val cfg = ProxyConfig.Builder()
                        .addProxyRule("http://127.0.0.1:$MIXED_PORT")
                        .addBypassRule("localhost")
                        .addBypassRule("127.0.0.1")
                        .addBypassRule("tauri.localhost")
                        .addBypassRule("*.localhost")
                        .addBypassRule("192.168.*")
                        .addBypassRule("10.*")
                        .build()
                    ctrl.setProxyOverride(cfg, { it.run() }, doneListener)
                } else {
                    ctrl.clearProxyOverride({ it.run() }, doneListener)
                }
            }.onFailure { err ->
                Log.w(TAG, "applyWebViewProxy($enable) failed: ${err.message}")
                latch?.countDown()
            }
        }
        if (latch != null) {
            runCatching { latch.await(waitMs, TimeUnit.MILLISECONDS) }
        }
    }

    private fun controllerGet(context: Context, path: String): JSONObject {
        return controllerGetWithSecret(getOrCreateSecret(context), path)
    }

    private fun controllerGetWithSecret(secret: String, path: String): JSONObject {
        val req = Request.Builder()
            .url("http://127.0.0.1:$CONTROLLER_PORT$path")
            .header("Authorization", "Bearer $secret")
            .get()
            .build()
        controllerClient.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IllegalStateException("Mihomo API GET $path HTTP ${resp.code}: $body")
            }
            return if (body.isBlank()) JSONObject() else JSONObject(body)
        }
    }

    private fun controllerPut(secret: String, path: String, payload: JSONObject) {
        val body = payload.toString().toRequestBody(jsonMediaType)
        val req = Request.Builder()
            .url("http://127.0.0.1:$CONTROLLER_PORT$path")
            .header("Authorization", "Bearer $secret")
            .put(body)
            .build()
        controllerClient.newCall(req).execute().use { resp ->
            val respBody = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IllegalStateException("Mihomo API PUT $path HTTP ${resp.code}: $respBody")
            }
        }
    }

    private fun closeAllConnections(secret: String) {
        runCatching {
            val req = Request.Builder()
                .url("http://127.0.0.1:$CONTROLLER_PORT/connections")
                .header("Authorization", "Bearer $secret")
                .delete()
                .build()
            controllerClient.newCall(req).execute().close()
        }
    }

    private fun resolveRootEntryGroup(proxiesMap: JSONObject): String? {
        return when {
            proxiesMap.has("手动选择") -> "手动选择"
            proxiesMap.has("PROXY") -> "PROXY"
            else -> null
        }
    }

    private fun jsonArrayContains(arr: JSONArray?, target: String): Boolean {
        if (arr == null) return false
        for (i in 0 until arr.length()) {
            if (arr.optString(i, "") == target) return true
        }
        return false
    }

    private fun syncGlobalSelector(secret: String, proxiesMap: JSONObject, fallbackTarget: String? = null) {
        val globalObj = proxiesMap.optJSONObject("GLOBAL") ?: return
        val globalAll = globalObj.optJSONArray("all") ?: return
        val rootGroup = resolveRootEntryGroup(proxiesMap)
        var target: String? = null
        if (rootGroup != null && jsonArrayContains(globalAll, rootGroup)) {
            target = rootGroup
        } else if (
            !fallbackTarget.isNullOrBlank() &&
            fallbackTarget != "DIRECT" &&
            fallbackTarget != "REJECT" &&
            jsonArrayContains(globalAll, fallbackTarget)
        ) {
            target = fallbackTarget
        } else {
            for (i in 0 until globalAll.length()) {
                val cand = globalAll.optString(i, "").trim()
                if (cand.isNotEmpty() && cand != "DIRECT" && cand != "REJECT") {
                    target = cand
                    break
                }
            }
        }
        val cleanTarget = target ?: return
        val currentNow = globalObj.optString("now", "").trim()
        if (currentNow != cleanTarget) {
            runCatching {
                controllerPut(secret, "/proxies/GLOBAL", JSONObject().put("name", cleanTarget))
            }
        }
    }

    private fun resolveEffectiveChain(proxiesMap: JSONObject, mode: String): Pair<String, String> {
        if (mode == "direct") {
            return "DIRECT (全局直连)" to "DIRECT"
        }
        val rootGroup = resolveRootEntryGroup(proxiesMap)
        val entry = if (mode == "global") "GLOBAL" else (rootGroup ?: "GLOBAL")
        val chain = mutableListOf<String>()
        val visited = hashSetOf<String>()
        var cursor = entry
        for (hop in 0 until 6) {
            if (!visited.add(cursor)) break
            val obj = proxiesMap.optJSONObject(cursor) ?: break
            val next = obj.optString("now", "").trim()
            if (next.isEmpty()) break
            chain.add(next)
            if (!proxiesMap.has(next) || proxiesMap.optJSONObject(next)?.has("all") != true) {
                break
            }
            cursor = next
        }
        if (chain.isEmpty()) {
            return "默认" to "默认"
        }
        val leaf = chain.last()
        val displayChain = chain.dropWhile { it == "GLOBAL" || it == "手动选择" || it == "PROXY" }
            .ifEmpty { listOf(leaf) }
            .joinToString(" → ")
        return displayChain to leaf
    }

    private fun registerNetworkWatcher(context: Context, secret: String) {
        unregisterNetworkWatcher()
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (!isRunning) return
                if (System.currentTimeMillis() - startedAtMs < 1500L) return
                thread(start = true, isDaemon = true, name = "vibelink-net-heal") {
                    closeAllConnections(secret)
                    triggerTailscaleConnectSync(timeoutMs = 2500)
                    autoHealUnreachableActiveNode(secret)
                }
            }

            override fun onLost(network: Network) {
                if (!isRunning) return
                closeAllConnections(secret)
            }
        }
        runCatching {
            cm.registerNetworkCallback(req, cb)
            registeredConnectivityManager = cm
            networkCallback = cb
        }.onFailure { err ->
            Log.w(TAG, "registerNetworkWatcher failed: ${err.message}")
        }
    }

    private fun unregisterNetworkWatcher() {
        val cb = networkCallback ?: return
        networkCallback = null
        val cm = registeredConnectivityManager
        registeredConnectivityManager = null
        runCatching { cm?.unregisterNetworkCallback(cb) }
    }

    private fun probeProxyDelayOnce(secret: String, proxyName: String, timeoutMs: Int = 2600): Int? {
        return runCatching {
            val encodedTestUrl = URLEncoder.encode("https://www.gstatic.com/generate_204", "UTF-8")
            val encName = URLEncoder.encode(proxyName, "UTF-8").replace("+", "%20")
            val res = controllerGetWithSecret(secret, "/proxies/$encName/delay?timeout=$timeoutMs&url=$encodedTestUrl")
            val d = res.optInt("delay", 0)
            if (d > 0) d else null
        }.getOrNull()
    }

    private fun autoHealUnreachableActiveNode(secret: String) {
        if (!isRunning) return
        runCatching {
            refreshSummaryFromController(secret)
            if (routeMode == "direct") return
            val prevLeaf = effectiveNode?.trim().orEmpty()
            if (prevLeaf.isEmpty() || prevLeaf == "DIRECT") return

            // Probe current leaf directly; if reachable, keep user's selection untouched.
            if (probeProxyDelayOnce(secret, prevLeaf, 2600) != null) {
                return
            }

            Log.i(TAG, "Active leaf '$prevLeaf' unreachable on current network; attempting auto-failover")
            val encodedTestUrl = URLEncoder.encode("https://www.gstatic.com/generate_204", "UTF-8")
            for (grpName in listOf("故障转移", "自动选择")) {
                if (!isRunning) break
                runCatching {
                    val enc = URLEncoder.encode(grpName, "UTF-8").replace("+", "%20")
                    controllerGetWithSecret(secret, "/group/$enc/delay?timeout=3500&url=$encodedTestUrl")
                }
            }

            val pxObj = controllerGetWithSecret(secret, "/proxies")
            val proxiesMap = pxObj.optJSONObject("proxies") ?: return
            val rootGroup = resolveRootEntryGroup(proxiesMap) ?: return
            val rootAll = proxiesMap.optJSONObject(rootGroup)?.optJSONArray("all") ?: return

            var chosenTarget: String? = null
            for (cand in listOf("故障转移", "自动选择")) {
                if (!jsonArrayContains(rootAll, cand)) continue
                val leaf = proxiesMap.optJSONObject(cand)?.optString("now", "")?.trim().orEmpty()
                if (leaf.isNotEmpty() && leaf != "DIRECT" && leaf != prevLeaf && probeProxyDelayOnce(secret, leaf, 2500) != null) {
                    chosenTarget = cand
                    break
                }
            }
            if (chosenTarget == null && jsonArrayContains(rootAll, "故障转移")) {
                chosenTarget = "故障转移"
            } else if (chosenTarget == null && jsonArrayContains(rootAll, "自动选择")) {
                chosenTarget = "自动选择"
            }

            if (chosenTarget != null) {
                val encRoot = URLEncoder.encode(rootGroup, "UTF-8").replace("+", "%20")
                controllerPut(secret, "/proxies/$encRoot", JSONObject().put("name", chosenTarget))
                syncGlobalSelector(secret, proxiesMap, fallbackTarget = rootGroup)
                closeAllConnections(secret)
                refreshSummaryFromController(secret)
                autoHealNotice = "原节点 $prevLeaf 当前网络不可达，已自动切至 ${activeNode ?: chosenTarget}"
                Log.i(TAG, "Auto-failover succeeded -> ${activeNode ?: chosenTarget}")
            }
        }.onFailure { err ->
            Log.w(TAG, "autoHealUnreachableActiveNode error: ${err.message}")
        }
    }

    private fun triggerAutoGroupWarmupAndHealAsync(secret: String) {
        thread(start = true, isDaemon = true, name = "vibelink-mihomo-warmup") {
            autoHealUnreachableActiveNode(secret)
            val encodedUrl = URLEncoder.encode("https://www.gstatic.com/generate_204", "UTF-8")
            for (grpName in listOf("自动选择", "故障转移")) {
                if (!isRunning) break
                runCatching {
                    val enc = URLEncoder.encode(grpName, "UTF-8").replace("+", "%20")
                    controllerGetWithSecret(secret, "/group/$enc/delay?timeout=4500&url=$encodedUrl")
                }
            }
            if (isRunning) {
                runCatching { refreshSummaryFromController(secret) }
            }
        }
    }

    fun triggerTailscaleConnectAsync() {
        thread(start = true, isDaemon = true, name = "vibelink-tsnode-warmup") {
            triggerTailscaleConnectSync(null, 3000)
        }
    }

    private fun triggerTailscaleConnectSync(targetHostPort: String? = null, timeoutMs: Int = 3500) {
        val target = targetHostPort?.trim()?.ifEmpty { null } ?: "100.100.100.100:80"
        runCatching {
            Socket().use { sock ->
                sock.connect(InetSocketAddress("127.0.0.1", MIXED_PORT), 2000)
                sock.soTimeout = timeoutMs
                val out = sock.getOutputStream()
                out.write("CONNECT $target HTTP/1.1\r\nHost: $target\r\n\r\n".toByteArray())
                out.flush()
                val buf = ByteArray(256)
                sock.getInputStream().read(buf)
            }
        }
    }

    fun ensureTailscaleBridge(context: Context, targetHostPort: String? = null): JSONObject {
        val proc = childProcess
        val alive = isRunning && proc != null && isProcessAlive(proc)
        if (!alive) {
            if (!hasConfig(context)) {
                throw IllegalStateException("尚未同步内置 Mihomo/Tailscale 配置，请先在内网配对后点击「从电脑同步配置」")
            }
            val started = start(context.applicationContext, vpnActive = false)
            if (!started) {
                throw IllegalStateException(lastError ?: "启动 Tailscale 轻桥接失败")
            }
        } else {
            applyWebViewProxy(true, waitMs = 1000L)
        }
        triggerTailscaleConnectSync(targetHostPort, if (alive) 2500 else 4500)
        return getStatus(context)
    }

    private fun fetchVersionOnce(secret: String): String? {
        return try {
            val req = Request.Builder()
                .url("http://127.0.0.1:$CONTROLLER_PORT/version")
                .header("Authorization", "Bearer $secret")
                .get()
                .build()
            controllerClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    Log.w(TAG, "fetchVersionOnce HTTP ${resp.code}")
                    return null
                }
                val obj = JSONObject(resp.body?.string().orEmpty())
                obj.optString("version", "").ifEmpty { null }
            }
        } catch (e: Throwable) {
            if (e !is java.net.ConnectException) {
                Log.w(TAG, "fetchVersionOnce failed: ${e.javaClass.simpleName}: ${e.message}")
            }
            null
        }
    }

    private fun refreshSummaryFromController(secret: String) {
        val cfgObj = controllerGetWithSecret(secret, "/configs")
        val mode = cfgObj.optString("mode", "").trim().ifEmpty { routeMode }
        routeMode = mode
        val pxObj = controllerGetWithSecret(secret, "/proxies")
        val proxies = pxObj.optJSONObject("proxies") ?: return
        val rootGroup = resolveRootEntryGroup(proxies)
        entryGroupNow = rootGroup?.let { proxies.optJSONObject(it)?.optString("now", "")?.trim().orEmpty() }?.ifEmpty { null }
        val (chain, leaf) = resolveEffectiveChain(proxies, mode)
        activeNode = chain
        effectiveNode = leaf
    }

    fun getStatus(context: Context): JSONObject {
        val proc = childProcess
        val alive = isRunning && proc != null && isProcessAlive(proc)
        if (!alive && isRunning) {
            isRunning = false
            runMode = "off"
            version = null
        }
        if (alive) {
            runCatching { refreshSummaryFromController(getOrCreateSecret(context)) }
        }
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return JSONObject().apply {
            put("available", isBinaryAvailable(context))
            put("running", alive)
            put("vpnActive", alive && runMode == "vpn")
            put("runMode", if (alive) runMode else "off")
            put("version", version ?: JSONObject.NULL)
            put("hasConfig", hasConfig(context))
            put("configName", prefs.getString(KEY_CONFIG_NAME, null) ?: JSONObject.NULL)
            put("updatedAt", prefs.getLong(KEY_UPDATED_AT, 0L))
            put("routeMode", routeMode)
            put("activeNode", activeNode ?: JSONObject.NULL)
            put("effectiveNode", effectiveNode ?: JSONObject.NULL)
            put("entryGroupNow", entryGroupNow ?: JSONObject.NULL)
            put("mixedPort", MIXED_PORT)
            put("tailscaleStateExists", hasTailscaleState(context))
            put("tailscaleLoginUrl", tailscaleLoginUrl ?: JSONObject.NULL)
            put("autoHealNotice", autoHealNotice ?: JSONObject.NULL)
            put("lastError", lastError ?: JSONObject.NULL)
        }
    }

    fun getProxies(context: Context): JSONObject {
        if (!isRunning) {
            throw IllegalStateException("内置 Mihomo 内核尚未运行")
        }
        val raw = controllerGet(context, "/proxies")
        val proxiesMap = raw.optJSONObject("proxies") ?: JSONObject()
        val groups = JSONArray()
        val nodes = JSONObject()

        val keys = proxiesMap.keys()
        while (keys.hasNext()) {
            val name = keys.next()
            val entry = proxiesMap.optJSONObject(name) ?: continue
            val type = entry.optString("type", "")
            val history = entry.optJSONArray("history")
            var delay: Any = JSONObject.NULL
            if (history != null && history.length() > 0) {
                val last = history.optJSONObject(history.length() - 1)
                if (last != null && last.has("delay")) {
                    delay = last.optInt("delay", 0)
                }
            }
            if (entry.has("all")) {
                groups.put(JSONObject().apply {
                    put("name", name)
                    put("type", type)
                    put("now", entry.optString("now", ""))
                    put("all", entry.optJSONArray("all") ?: JSONArray())
                })
            } else {
                nodes.put(name, JSONObject().apply {
                    put("type", type)
                    put("alive", entry.optBoolean("alive", true))
                    put("delay", delay)
                })
            }
        }

        val rootGroup = resolveRootEntryGroup(proxiesMap)
        entryGroupNow = rootGroup?.let { proxiesMap.optJSONObject(it)?.optString("now", "")?.trim().orEmpty() }?.ifEmpty { null }
        val (chain, leaf) = resolveEffectiveChain(proxiesMap, routeMode)
        activeNode = chain
        effectiveNode = leaf

        return JSONObject().apply {
            put("ok", true)
            put("routeMode", routeMode)
            put("activeNode", activeNode ?: JSONObject.NULL)
            put("effectiveNode", effectiveNode ?: JSONObject.NULL)
            put("entryGroupNow", entryGroupNow ?: JSONObject.NULL)
            put("groups", groups)
            put("nodes", nodes)
        }
    }

    fun selectNode(context: Context, group: String, node: String): JSONObject {
        if (!isRunning) {
            throw IllegalStateException("内置 Mihomo 内核尚未运行")
        }
        val cleanGroup = group.trim().ifEmpty { "手动选择" }
        val cleanNode = node.trim()
        if (cleanNode.isEmpty()) {
            throw IllegalArgumentException("node 不能为空")
        }
        val secret = getOrCreateSecret(context)
        val encodedGroup = URLEncoder.encode(cleanGroup, "UTF-8").replace("+", "%20")
        controllerPut(secret, "/proxies/$encodedGroup", JSONObject().put("name", cleanNode))

        val proxiesMap = controllerGetWithSecret(secret, "/proxies").optJSONObject("proxies") ?: JSONObject()
        val rootGroup = resolveRootEntryGroup(proxiesMap)
        if (rootGroup != null && cleanGroup != rootGroup && cleanGroup != "GLOBAL") {
            val rootObj = proxiesMap.optJSONObject(rootGroup)
            val rootAll = rootObj?.optJSONArray("all")
            if (jsonArrayContains(rootAll, cleanGroup) && rootObj?.optString("now", "") != cleanGroup) {
                val encRoot = URLEncoder.encode(rootGroup, "UTF-8").replace("+", "%20")
                controllerPut(secret, "/proxies/$encRoot", JSONObject().put("name", cleanGroup))
            }
        }
        if (cleanGroup != "GLOBAL") {
            syncGlobalSelector(secret, proxiesMap, fallbackTarget = rootGroup ?: cleanNode)
        }
        closeAllConnections(secret)
        refreshSummaryFromController(secret)
        return JSONObject().apply {
            put("selected", true)
            put("group", cleanGroup)
            put("node", cleanNode)
            put("activeNode", activeNode ?: cleanNode)
            put("effectiveNode", effectiveNode ?: cleanNode)
            put("entryGroupNow", entryGroupNow ?: JSONObject.NULL)
        }
    }

    fun setRouteMode(context: Context, mode: String): JSONObject {
        if (!isRunning) {
            throw IllegalStateException("内置 Mihomo 内核尚未运行")
        }
        val clean = when (mode.trim().lowercase()) {
            "global" -> "global"
            "direct" -> "direct"
            else -> "rule"
        }
        val secret = getOrCreateSecret(context)
        if (clean == "global") {
            runCatching {
                val proxiesMap = controllerGetWithSecret(secret, "/proxies").optJSONObject("proxies")
                if (proxiesMap != null) {
                    syncGlobalSelector(secret, proxiesMap)
                }
            }
        }
        val body = JSONObject().put("mode", clean).toString().toRequestBody(jsonMediaType)
        val req = Request.Builder()
            .url("http://127.0.0.1:$CONTROLLER_PORT/configs")
            .header("Authorization", "Bearer $secret")
            .patch(body)
            .build()
        controllerClient.newCall(req).execute().use { resp ->
            val respBody = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IllegalStateException("切换代理模式失败 HTTP ${resp.code}: $respBody")
            }
        }
        routeMode = clean
        closeAllConnections(secret)
        runCatching { refreshSummaryFromController(secret) }
        return JSONObject().apply {
            put("ok", true)
            put("mode", clean)
            put("activeNode", activeNode ?: JSONObject.NULL)
            put("effectiveNode", effectiveNode ?: JSONObject.NULL)
        }
    }

    fun probeConnectivity(context: Context): JSONObject {
        if (!isRunning) {
            throw IllegalStateException("内置 Mihomo 内核尚未运行")
        }
        val secret = getOrCreateSecret(context)
        runCatching { refreshSummaryFromController(secret) }

        val probeClient = OkHttpClient.Builder()
            .proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", MIXED_PORT)))
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .followRedirects(false)
            .build()

        var googleOk = false
        var googleCode = 0
        var googleMs: Long? = null
        var googleError: String? = null
        val t1 = System.currentTimeMillis()
        try {
            val req = Request.Builder().url("https://www.google.com/generate_204").get().build()
            probeClient.newCall(req).execute().use { resp ->
                googleCode = resp.code
                googleMs = System.currentTimeMillis() - t1
                googleOk = resp.code in 200..399
            }
        } catch (e: Throwable) {
            googleError = e.message ?: e.javaClass.simpleName
        }

        var xOk = false
        var xCode = 0
        var xMs: Long? = null
        var xError: String? = null
        val t2 = System.currentTimeMillis()
        try {
            val req = Request.Builder()
                .url("https://x.com")
                .header("User-Agent", "curl/8.5.0")
                .head()
                .build()
            probeClient.newCall(req).execute().use { resp ->
                xCode = resp.code
                xMs = System.currentTimeMillis() - t2
                xOk = resp.code in 200..399
            }
        } catch (e: Throwable) {
            xError = e.message ?: e.javaClass.simpleName
        }

        return JSONObject().apply {
            put("ok", googleOk || xOk)
            put("googleOk", googleOk)
            put("googleCode", googleCode)
            put("googleMs", googleMs ?: JSONObject.NULL)
            put("googleError", googleError ?: JSONObject.NULL)
            put("xOk", xOk)
            put("xCode", xCode)
            put("xMs", xMs ?: JSONObject.NULL)
            put("xError", xError ?: JSONObject.NULL)
            put("activeNode", activeNode ?: JSONObject.NULL)
            put("effectiveNode", effectiveNode ?: JSONObject.NULL)
            put("routeMode", routeMode)
        }
    }

    fun testDelay(
        context: Context,
        node: String? = null,
        group: String? = null,
        url: String = "https://www.gstatic.com/generate_204",
        timeoutMs: Int = 5000
    ): JSONObject {
        if (!isRunning) {
            throw IllegalStateException("内置 Mihomo 内核尚未运行")
        }
        val cleanUrl = url.trim().ifEmpty { "https://www.gstatic.com/generate_204" }
        val boundedTimeout = timeoutMs.coerceIn(1000, 15000)
        val encodedTestUrl = URLEncoder.encode(cleanUrl, "UTF-8")
        val targetPath = if (!node.isNullOrBlank()) {
            val enc = URLEncoder.encode(node.trim(), "UTF-8").replace("+", "%20")
            "/proxies/$enc/delay?timeout=$boundedTimeout&url=$encodedTestUrl"
        } else {
            val enc = URLEncoder.encode(group?.trim()?.ifEmpty { "手动选择" } ?: "手动选择", "UTF-8").replace("+", "%20")
            "/group/$enc/delay?timeout=$boundedTimeout&url=$encodedTestUrl"
        }
        return controllerGet(context, targetPath)
    }

    fun recentLogs(limit: Int = 30): List<String> {
        synchronized(logLines) {
            return logLines.toList().takeLast(limit.coerceIn(1, 120))
        }
    }
}
