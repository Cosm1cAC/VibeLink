package com.vibelink.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import rikka.shizuku.Shizuku

class MainActivity : TauriActivity() {

    private var splashHidden = false
    private var currentWebView: WebView? = null
    private var lastTopInsetDp = 0
    private var lastBottomInsetDp = 0
    private var lastImeVisible = false
    private var lastIsDark = true

    inner class VibeLinkAndroidBridge {
        @JavascriptInterface
        fun setSystemBarTheme(isDark: Boolean) {
            runOnUiThread {
                lastIsDark = isDark
                val controller = WindowCompat.getInsetsController(window, window.decorView)
                controller.isAppearanceLightStatusBars = !isDark
                controller.isAppearanceLightNavigationBars = !isDark
                currentWebView?.setBackgroundColor(if (isDark) 0xFF1B1B1B.toInt() else 0xFFFFFFFF.toInt())
            }
        }

        @JavascriptInterface
        fun setWebViewTransparent(transparent: Boolean) {
            runOnUiThread {
                currentWebView?.setBackgroundColor(
                    if (transparent) android.graphics.Color.TRANSPARENT
                    else if (lastIsDark) 0xFF1B1B1B.toInt() else 0xFFFFFFFF.toInt()
                )
            }
        }

        @JavascriptInterface
        fun syncAgentConfig(configJson: String): Boolean {
            return runCatching {
                VibeLinkAgentService.syncAndEnsureRunning(applicationContext, configJson)
                true
            }.getOrDefault(false)
        }

        @JavascriptInterface
        fun setAgentEnabled(enabled: Boolean): Boolean {
            return runCatching {
                VibeLinkAgentService.setEnabledAndUpdate(applicationContext, enabled)
                true
            }.getOrDefault(false)
        }

        @JavascriptInterface
        fun getDeviceCapabilities(): String {
            return runCatching {
                val obj = VibeLinkAgentService.collectCapabilities(applicationContext)
                obj.put("agentEnabled", VibeLinkAgentService.isAgentEnabled(applicationContext))
                obj.toString()
            }.getOrDefault("{}")
        }

        @JavascriptInterface
        fun requestVpnPermission(): String {
            val prepIntent = VpnService.prepare(this@MainActivity)
            return if (prepIntent == null) {
                VibeLinkVpnService.markConsented(applicationContext, true)
                "already_prepared"
            } else {
                runOnUiThread {
                    runCatching { vpnConsentLauncher.launch(prepIntent) }
                }
                "requested"
            }
        }

        @JavascriptInterface
        fun openAccessibilitySettings(): Boolean {
            runOnUiThread {
                val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                runCatching { startActivity(intent) }
            }
            return true
        }

        @JavascriptInterface
        fun requestShizukuPermission(): String {
            return PrivilegedExecutor.requestShizukuPermission(9201)
        }

        @JavascriptInterface
        fun enableAccessibilityWithPrivilege(): String {
            return PrivilegedExecutor.enableAccessibilityViaPrivileged(applicationContext).toJson().toString()
        }

        @SuppressLint("BatteryLife")
        @JavascriptInterface
        fun requestBatteryOptimizationExemption(): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
            runOnUiThread {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                runCatching { startActivity(intent) }
            }
            return true
        }

        @JavascriptInterface
        fun applyLocalProxy(payloadJson: String): String {
            return try {
                val obj = org.json.JSONObject(payloadJson)
                val res = VibeLinkAgentService.applyProxy(
                    context = applicationContext,
                    proxyUrlRaw = obj.optString("proxyUrl", ""),
                    requestedMode = obj.optString("mode", "auto"),
                    dnsMode = obj.optString("dnsMode", "over_tcp")
                )
                org.json.JSONObject().put("ok", true).put("data", res).toString()
            } catch (e: Throwable) {
                org.json.JSONObject()
                    .put("ok", false)
                    .put("error", e.message ?: e.javaClass.simpleName)
                    .toString()
            }
        }

        @JavascriptInterface
        fun clearLocalProxy(): String {
            return try {
                val res = VibeLinkAgentService.clearProxy(applicationContext)
                org.json.JSONObject().put("ok", true).put("data", res).toString()
            } catch (e: Throwable) {
                org.json.JSONObject()
                    .put("ok", false)
                    .put("error", e.message ?: e.javaClass.simpleName)
                    .toString()
            }
        }

        private inline fun runBridgeJson(block: () -> org.json.JSONObject): String {
            return try {
                org.json.JSONObject().put("ok", true).put("data", block()).toString()
            } catch (e: Throwable) {
                org.json.JSONObject()
                    .put("ok", false)
                    .put("error", e.message ?: e.javaClass.simpleName)
                    .toString()
            }
        }

        @JavascriptInterface
        fun getMihomoStatus(): String = runBridgeJson {
            MihomoCoreManager.getStatus(applicationContext)
        }

        @JavascriptInterface
        fun startMihomo(payloadJson: String): String = runBridgeJson {
            val obj = if (payloadJson.isBlank()) org.json.JSONObject() else org.json.JSONObject(payloadJson)
            VibeLinkAgentService.startMihomoAndWait(
                context = applicationContext,
                yamlOverride = obj.optString("yaml", "").ifEmpty { null },
                configName = obj.optString("configName", "").ifEmpty { null },
                resetTailscaleState = obj.optBoolean("resetTailscaleState", false)
            )
        }

        @JavascriptInterface
        fun stopMihomo(): String = runBridgeJson {
            VibeLinkAgentService.stopMihomoTunnel(applicationContext)
        }

        @JavascriptInterface
        fun getMihomoProxies(): String = runBridgeJson {
            MihomoCoreManager.getProxies(applicationContext)
        }

        @JavascriptInterface
        fun selectMihomoNode(group: String, node: String): String = runBridgeJson {
            MihomoCoreManager.selectNode(applicationContext, group, node)
        }

        @JavascriptInterface
        fun setMihomoMode(mode: String): String = runBridgeJson {
            MihomoCoreManager.setRouteMode(applicationContext, mode)
        }

        @JavascriptInterface
        fun testMihomoDelay(payloadJson: String): String = runBridgeJson {
            val obj = if (payloadJson.isBlank()) org.json.JSONObject() else org.json.JSONObject(payloadJson)
            MihomoCoreManager.testDelay(
                context = applicationContext,
                node = obj.optString("node", "").ifEmpty { null },
                group = obj.optString("group", "").ifEmpty { null },
                url = obj.optString("url", "https://www.gstatic.com/generate_204"),
                timeoutMs = obj.optInt("timeoutMs", 5000)
            )
        }

        @JavascriptInterface
        fun probeMihomoConnectivity(): String = runBridgeJson {
            MihomoCoreManager.probeConnectivity(applicationContext)
        }

        @JavascriptInterface
        fun openExternalUrl(url: String): Boolean {
            val clean = url.trim()
            if (!clean.startsWith("http://") && !clean.startsWith("https://")) return false
            runOnUiThread {
                runCatching {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(clean)).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(intent)
                }
            }
            return true
        }
    }

    private val vpnConsentLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == Activity.RESULT_OK) {
                VibeLinkVpnService.markConsented(applicationContext, true)
            }
            android.util.Log.i(
                "MainActivity",
                "VPN consent resultCode=${result.resultCode} (OK=${Activity.RESULT_OK})"
            )
        }

    private val shizukuPermissionListener = Shizuku.OnRequestPermissionResultListener { _, grantResult ->
        if (grantResult == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            Thread { PrivilegedExecutor.ensureShizukuBound() }.start()
        }
    }

    private fun applySafeAreaCss() {
        runOnUiThread {
            val bottomDp = if (lastImeVisible) 0 else lastBottomInsetDp
            currentWebView?.evaluateJavascript(
                "document.documentElement?.style?.setProperty('--safe-area-inset-top','${lastTopInsetDp}px');" +
                    "document.documentElement?.style?.setProperty('--safe-area-inset-bottom','${bottomDp}px');",
                null
            )
        }
    }

    @Suppress("unused")
    fun show() {
        android.util.Log.i("MainActivity", "✨ Splash show() called from Rust")
    }

    @Suppress("unused")
    fun hide() {
        android.util.Log.i("MainActivity", "🎯 Splash hide() called from Rust - setting WebView background")
        runOnUiThread {
            hideStartupBackground()
        }
    }

    private fun hideStartupBackground() {
        if (!splashHidden) {
            splashHidden = true
            android.util.Log.d("MainActivity", "hideStartupBackground called, splashHidden set to true")
            currentWebView?.let {
                android.util.Log.d("MainActivity", "WebView reference found, setting background")
                it.setBackgroundColor(0xFF1B1B1B.toInt())
                window.setBackgroundDrawableResource(android.R.color.transparent)
                android.util.Log.i("MainActivity", "✅ WebView background set to dark")
            } ?: android.util.Log.e("MainActivity", "❌ WebView reference not found")
        } else {
            android.util.Log.w("MainActivity", "hideStartupBackground called but splashHidden already true")
        }
    }

    private val requestPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { permissions ->
            permissions.entries.forEach { entry ->
                val permissionName = entry.key
                val isGranted = entry.value
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        val rootView: View = findViewById(android.R.id.content)

        ViewCompat.setOnApplyWindowInsetsListener(rootView) { v, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())

            if (imeVisible) {
                v.setPadding(0, 0, 0, ime.bottom)
            } else {
                v.setPadding(0, 0, 0, 0)
            }

            val density = resources.displayMetrics.density.coerceAtLeast(1f)
            lastTopInsetDp = kotlin.math.ceil(sys.top / density).toInt()
            lastBottomInsetDp = kotlin.math.ceil(sys.bottom / density).toInt()
            lastImeVisible = imeVisible
            applySafeAreaCss()

            insets
        }

        requestPermissions()
        runCatching { Shizuku.addRequestPermissionResultListener(shizukuPermissionListener) }
        runCatching { VibeLinkAgentService.startIfConfigured(applicationContext) }
    }

    override fun onDestroy() {
        runCatching { Shizuku.removeRequestPermissionResultListener(shizukuPermissionListener) }
        super.onDestroy()
    }

    private fun requestPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO
        )

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.READ_MEDIA_IMAGES)
            permissions.add(Manifest.permission.READ_MEDIA_VIDEO)
            permissions.add(Manifest.permission.READ_MEDIA_AUDIO)
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            if (android.os.Build.VERSION.SDK_INT <= android.os.Build.VERSION_CODES.Q) {
                permissions.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }

        requestPermissionLauncher.launch(permissions.toTypedArray())
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        currentWebView = webView

        webView.setBackgroundColor(0xFF1B1B1B.toInt())
        webView.addJavascriptInterface(VibeLinkAndroidBridge(), "VibeLinkAndroid")
        window.setBackgroundDrawableResource(android.R.color.transparent)
        splashHidden = true

        webView.post { applySafeAreaCss() }
        webView.postDelayed({ applySafeAreaCss() }, 400)
        webView.postDelayed({ applySafeAreaCss() }, 1200)
        if (MihomoCoreManager.isRunning) {
            MihomoCoreManager.applyWebViewProxy(true)
        }

        android.util.Log.i("MainActivity", "WebView created with dark VibeLink background")
    }
}
