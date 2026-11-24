package com.vibelink.app

import android.os.Process
import androidx.annotation.Keep
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.system.exitProcess

@Keep
class VibeLinkShizukuService : IVibeLinkShellService.Stub() {

    override fun getUid(): Int = Process.myUid()

    override fun execCommand(command: String, timeoutMs: Int): String {
        val started = System.currentTimeMillis()
        val boundedTimeout = timeoutMs.coerceIn(500, 120_000).toLong()
        return try {
            val proc = ProcessBuilder("/system/bin/sh", "-c", command).start()
            val stdoutBytes = ByteArrayOutputStream()
            val stderrBytes = ByteArrayOutputStream()

            val tOut = thread(start = true) { readBounded(proc.inputStream, stdoutBytes, 512 * 1024) }
            val tErr = thread(start = true) { readBounded(proc.errorStream, stderrBytes, 256 * 1024) }

            val finished = proc.waitFor(boundedTimeout, TimeUnit.MILLISECONDS)
            if (!finished) {
                proc.destroyForcibly()
                tOut.join(500)
                tErr.join(500)
                return JSONObject().apply {
                    put("ok", false)
                    put("backend", "shizuku")
                    put("uid", Process.myUid())
                    put("exitCode", -1)
                    put("stdout", stdoutBytes.toString("UTF-8"))
                    put("stderr", "Command timed out after ${boundedTimeout}ms")
                    put("durationMs", System.currentTimeMillis() - started)
                }.toString()
            }

            tOut.join(1000)
            tErr.join(1000)
            val exitCode = proc.exitValue()
            JSONObject().apply {
                put("ok", exitCode == 0)
                put("backend", "shizuku")
                put("uid", Process.myUid())
                put("exitCode", exitCode)
                put("stdout", stdoutBytes.toString("UTF-8"))
                put("stderr", stderrBytes.toString("UTF-8"))
                put("durationMs", System.currentTimeMillis() - started)
            }.toString()
        } catch (e: Throwable) {
            JSONObject().apply {
                put("ok", false)
                put("backend", "shizuku")
                put("uid", Process.myUid())
                put("exitCode", -1)
                put("stdout", "")
                put("stderr", e.message ?: e.javaClass.simpleName)
                put("durationMs", System.currentTimeMillis() - started)
            }.toString()
        }
    }

    override fun destroy() {
        thread(start = true) {
            try {
                Thread.sleep(150)
            } catch (_: InterruptedException) {
            }
            exitProcess(0)
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
}
