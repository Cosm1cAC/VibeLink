package com.vibelink.app

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import rikka.shizuku.Shizuku
import rikka.shizuku.Shizuku.UserServiceArgs
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

data class ExecResult(
    val ok: Boolean,
    val backend: String,
    val exitCode: Int,
    val stdout: String,
    val stderr: String,
    val durationMs: Long
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("ok", ok)
        put("backend", backend)
        put("exitCode", exitCode)
        put("stdout", stdout)
        put("stderr", stderr)
        put("durationMs", durationMs)
    }
}

object PrivilegedExecutor {
    private const val TAG = "VibeLinkPrivilege"
    private val bindLock = Any()

    @Volatile
    private var shizukuService: IVibeLinkShellService? = null

    @Volatile
    private var cachedRoot: Boolean? = null

    @Volatile
    private var lastRootCheckAt = 0L

    private fun userServiceArgs(): UserServiceArgs = UserServiceArgs(
        ComponentName(BuildConfig.APPLICATION_ID, VibeLinkShizukuService::class.java.name)
    )
        .daemon(false)
        .processNameSuffix("shizuku")
        .debuggable(BuildConfig.DEBUG)
        .version(BuildConfig.VERSION_CODE)

    fun isShizukuInstalled(context: Context): Boolean {
        return try {
            context.packageManager.getPackageInfo("moe.shizuku.privileged.api", 0)
            true
        } catch (_: Throwable) {
            false
        }
    }

    fun isShizukuRunning(): Boolean {
        return try {
            Shizuku.pingBinder()
        } catch (_: Throwable) {
            false
        }
    }

    fun isShizukuGranted(): Boolean {
        return try {
            Shizuku.pingBinder() &&
                !Shizuku.isPreV11() &&
                Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
        } catch (_: Throwable) {
            false
        }
    }

    fun requestShizukuPermission(requestCode: Int = 9201): String {
        return try {
            if (!Shizuku.pingBinder()) {
                "shizuku_not_running"
            } else if (Shizuku.isPreV11()) {
                "shizuku_too_old"
            } else if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
                ensureShizukuBound()
                "already_granted"
            } else if (Shizuku.shouldShowRequestPermissionRationale()) {
                Shizuku.requestPermission(requestCode)
                "requested"
            } else {
                Shizuku.requestPermission(requestCode)
                "requested"
            }
        } catch (e: Throwable) {
            "error:${e.message ?: e.javaClass.simpleName}"
        }
    }

    fun hasRoot(forceRefresh: Boolean = false): Boolean {
        val now = System.currentTimeMillis()
        val prev = cachedRoot
        if (!forceRefresh && prev != null && now - lastRootCheckAt < 15_000L) {
            return prev
        }
        val detected = probeSu()
        cachedRoot = detected
        lastRootCheckAt = now
        return detected
    }

    private fun probeSu(): Boolean {
        return try {
            val proc = ProcessBuilder("su", "-c", "id -u").start()
            val finished = proc.waitFor(2500, TimeUnit.MILLISECONDS)
            if (!finished) {
                proc.destroyForcibly()
                false
            } else {
                val out = proc.inputStream.bufferedReader().readText().trim()
                proc.exitValue() == 0 && out == "0"
            }
        } catch (_: Throwable) {
            false
        }
    }

    fun ensureShizukuBound(waitMs: Long = 3000L): IVibeLinkShellService? {
        if (!isShizukuGranted()) return null
        val existing = shizukuService
        if (existing != null && existing.asBinder().pingBinder()) {
            return existing
        }

        synchronized(bindLock) {
            val again = shizukuService
            if (again != null && again.asBinder().pingBinder()) {
                return again
            }

            val latch = CountDownLatch(1)
            val conn = object : ServiceConnection {
                override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                    if (service != null && service.pingBinder()) {
                        shizukuService = IVibeLinkShellService.Stub.asInterface(service)
                    }
                    latch.countDown()
                }

                override fun onServiceDisconnected(name: ComponentName?) {
                    shizukuService = null
                }
            }

            try {
                Shizuku.bindUserService(userServiceArgs(), conn)
                latch.await(waitMs, TimeUnit.MILLISECONDS)
            } catch (e: Throwable) {
                Log.w(TAG, "bindUserService failed: ${e.message}")
            }
            return shizukuService
        }
    }

    fun exec(command: String, timeoutMs: Int = 15_000): ExecResult {
        val started = System.currentTimeMillis()
        if (hasRoot()) {
            val rootRes = execWithSu(command, timeoutMs)
            if (rootRes.ok || !isShizukuGranted()) {
                return rootRes
            }
        }

        val svc = ensureShizukuBound()
        if (svc != null) {
            return try {
                val raw = svc.execCommand(command, timeoutMs)
                val obj = JSONObject(raw)
                ExecResult(
                    ok = obj.optBoolean("ok", false),
                    backend = obj.optString("backend", "shizuku"),
                    exitCode = obj.optInt("exitCode", -1),
                    stdout = obj.optString("stdout", ""),
                    stderr = obj.optString("stderr", ""),
                    durationMs = obj.optLong("durationMs", System.currentTimeMillis() - started)
                )
            } catch (e: Throwable) {
                shizukuService = null
                ExecResult(
                    ok = false,
                    backend = "shizuku",
                    exitCode = -1,
                    stdout = "",
                    stderr = e.message ?: "Shizuku IPC failed",
                    durationMs = System.currentTimeMillis() - started
                )
            }
        }

        return ExecResult(
            ok = false,
            backend = "none",
            exitCode = -1,
            stdout = "",
            stderr = "设备未 Root 且未授权 Shizuku，无法执行系统级命令",
            durationMs = System.currentTimeMillis() - started
        )
    }

    private fun execWithSu(command: String, timeoutMs: Int): ExecResult {
        val started = System.currentTimeMillis()
        val bounded = timeoutMs.coerceIn(500, 120_000).toLong()
        return try {
            val proc = ProcessBuilder("su", "-c", command).start()
            val stdoutBytes = ByteArrayOutputStream()
            val stderrBytes = ByteArrayOutputStream()
            val tOut = thread(start = true) { readBounded(proc.inputStream, stdoutBytes, 512 * 1024) }
            val tErr = thread(start = true) { readBounded(proc.errorStream, stderrBytes, 256 * 1024) }

            val done = proc.waitFor(bounded, TimeUnit.MILLISECONDS)
            if (!done) {
                proc.destroyForcibly()
                tOut.join(500)
                tErr.join(500)
                return ExecResult(
                    ok = false,
                    backend = "root",
                    exitCode = -1,
                    stdout = stdoutBytes.toString("UTF-8"),
                    stderr = "Root command timed out after ${bounded}ms",
                    durationMs = System.currentTimeMillis() - started
                )
            }

            tOut.join(1000)
            tErr.join(1000)
            val exitCode = proc.exitValue()
            ExecResult(
                ok = exitCode == 0,
                backend = "root",
                exitCode = exitCode,
                stdout = stdoutBytes.toString("UTF-8"),
                stderr = stderrBytes.toString("UTF-8"),
                durationMs = System.currentTimeMillis() - started
            )
        } catch (e: Throwable) {
            ExecResult(
                ok = false,
                backend = "root",
                exitCode = -1,
                stdout = "",
                stderr = e.message ?: e.javaClass.simpleName,
                durationMs = System.currentTimeMillis() - started
            )
        }
    }

    private fun readBounded(stream: InputStream, out: ByteArrayOutputStream, maxBytes: Int) {
        val buf = ByteArray(8192)
        var total = 0
        try {
            while (true) {
                val n = stream.read(buf)
                if (n <= 0) break
                val allow = minOf(n, maxBytes - total)
                if (allow > 0) {
                    out.write(buf, 0, allow)
                    total += allow
                }
            }
        } catch (_: Throwable) {
        }
    }

    fun getSystemGlobalHttpProxy(context: Context): String? {
        return try {
            val raw = Settings.Global.getString(context.contentResolver, Settings.Global.HTTP_PROXY)
                ?.trim()
            if (raw.isNullOrEmpty() || raw == ":0") null else raw
        } catch (_: Throwable) {
            null
        }
    }

    fun setSystemGlobalHttpProxy(hostPort: String): ExecResult {
        val safe = hostPort.trim().replace("'", "")
        if (safe.isEmpty() || !safe.contains(":")) {
            return ExecResult(false, "none", -1, "", "无效代理地址（应为 host:port）", 0L)
        }
        return exec("settings put global http_proxy '$safe'")
    }

    fun clearSystemGlobalHttpProxy(): ExecResult {
        return exec("settings put global http_proxy :0 && settings delete global http_proxy || true")
    }

    fun enableAccessibilityViaPrivileged(context: Context): ExecResult {
        val component = "${context.packageName}/${VibeLinkAccessibilityService::class.java.name}"
        val current = try {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
                ?.trim()
                .orEmpty()
        } catch (_: Throwable) {
            ""
        }
        val entries = current
            .split(":")
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .toMutableSet()
        entries.add(component)
        val joined = entries.joinToString(":")
        return exec(
            "settings put secure enabled_accessibility_services '$joined' && settings put secure accessibility_enabled 1"
        )
    }
}
