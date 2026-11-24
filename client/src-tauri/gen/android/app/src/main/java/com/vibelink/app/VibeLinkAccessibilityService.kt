package com.vibelink.app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class VibeLinkAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile
        var instance: VibeLinkAccessibilityService? = null
            private set

        fun isEnabled(context: Context): Boolean {
            if (instance != null) return true
            val enabled = try {
                Settings.Secure.getInt(context.contentResolver, Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1
            } catch (_: Throwable) {
                false
            }
            if (!enabled) return false
            val expected = ComponentName(context, VibeLinkAccessibilityService::class.java).flattenToString()
            val settingValue = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: return false
            val splitter = TextUtils.SimpleStringSplitter(':')
            splitter.setString(settingValue)
            while (splitter.hasNext()) {
                if (splitter.next().equals(expected, ignoreCase = true)) {
                    return true
                }
            }
            return false
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Passive inspection/execution on demand; no continuous event work required.
    }

    override fun onInterrupt() {
        // Service interrupted by system.
    }

    override fun onDestroy() {
        if (instance === this) {
            instance = null
        }
        super.onDestroy()
    }

    fun dumpUiTree(maxDepth: Int = 12): JSONObject {
        val root = rootInActiveWindow
            ?: return JSONObject().apply {
                put("packageName", "")
                put("nodes", JSONArray())
                put("warning", "rootInActiveWindow 为空")
            }

        val nodes = JSONArray()
        var seq = 0

        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > maxDepth || nodes.length() >= 300) return
            val rect = Rect()
            node.getBoundsInScreen(rect)
            val text = node.text?.toString()?.trim().orEmpty()
            val desc = node.contentDescription?.toString()?.trim().orEmpty()
            val resId = node.viewIdResourceName.orEmpty()
            val meaningful =
                text.isNotEmpty() ||
                    desc.isNotEmpty() ||
                    resId.isNotEmpty() ||
                    node.isClickable ||
                    node.isEditable ||
                    node.isScrollable

            if (meaningful && rect.width() > 0 && rect.height() > 0) {
                val obj = JSONObject().apply {
                    put("id", seq++)
                    put("depth", depth)
                    if (text.isNotEmpty()) put("text", text)
                    if (desc.isNotEmpty()) put("contentDesc", desc)
                    if (resId.isNotEmpty()) put("resourceId", resId)
                    put("className", node.className?.toString().orEmpty())
                    put("packageName", node.packageName?.toString().orEmpty())
                    put("clickable", node.isClickable)
                    put("editable", node.isEditable)
                    put("scrollable", node.isScrollable)
                    put("checked", node.isChecked)
                    put("focused", node.isFocused)
                    put("bounds", JSONArray(listOf(rect.left, rect.top, rect.right, rect.bottom)))
                    put("center", JSONArray(listOf(rect.centerX(), rect.centerY())))
                }
                nodes.put(obj)
            }

            val count = node.childCount
            for (i in 0 until count) {
                val child = node.getChild(i) ?: continue
                try {
                    visit(child, depth + 1)
                } finally {
                    @Suppress("DEPRECATION")
                    runCatching { child.recycle() }
                }
            }
        }

        val pkg = root.packageName?.toString().orEmpty()
        try {
            visit(root, 0)
        } finally {
            @Suppress("DEPRECATION")
            runCatching { root.recycle() }
        }

        return JSONObject().apply {
            put("packageName", pkg)
            put("count", nodes.length())
            put("nodes", nodes)
        }
    }

    fun tapAt(x: Float, y: Float, durationMs: Long = 60L): Boolean {
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(20L, 1500L)))
            .build()
        val latch = CountDownLatch(1)
        var ok = false
        val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                ok = true
                latch.countDown()
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
                ok = false
                latch.countDown()
            }
        }, null)
        if (!dispatched) return false
        latch.await(3, TimeUnit.SECONDS)
        return ok
    }

    fun tapBySelector(text: String?, resourceId: String?, contentDesc: String?, index: Int = 0): JSONObject {
        val root = rootInActiveWindow ?: return JSONObject().apply {
            put("clicked", false)
            put("error", "rootInActiveWindow 为空")
        }
        val matches = mutableListOf<AccessibilityNodeInfo>()

        fun search(node: AccessibilityNodeInfo) {
            val nText = node.text?.toString().orEmpty()
            val nDesc = node.contentDescription?.toString().orEmpty()
            val nRes = node.viewIdResourceName.orEmpty()

            val textOk = text.isNullOrEmpty() || nText.contains(text, ignoreCase = true)
            val descOk = contentDesc.isNullOrEmpty() || nDesc.contains(contentDesc, ignoreCase = true)
            val resOk = resourceId.isNullOrEmpty() || nRes.equals(resourceId, ignoreCase = true) || nRes.endsWith(resourceId)

            if (textOk && descOk && resOk) {
                matches.add(node)
            }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { search(it) }
            }
        }

        search(root)
        val picked = matches.getOrNull(index.coerceAtLeast(0))
            ?: return JSONObject().apply {
                put("clicked", false)
                put("error", "未找到匹配的 UI 控件")
            }

        val rect = Rect()
        picked.getBoundsInScreen(rect)
        var actionNode: AccessibilityNodeInfo? = picked
        var clicked = false
        while (actionNode != null) {
            if (actionNode.isClickable) {
                clicked = actionNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                if (clicked) break
            }
            actionNode = actionNode.parent
        }
        if (!clicked && rect.width() > 0 && rect.height() > 0) {
            clicked = tapAt(rect.centerX().toFloat(), rect.centerY().toFloat())
        }

        return JSONObject().apply {
            put("clicked", clicked)
            put("bounds", JSONArray(listOf(rect.left, rect.top, rect.right, rect.bottom)))
            put("text", picked.text?.toString().orEmpty())
            put("resourceId", picked.viewIdResourceName.orEmpty())
        }
    }

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long = 320L): Boolean {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(60L, 4000L)))
            .build()
        val latch = CountDownLatch(1)
        var ok = false
        val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                ok = true
                latch.countDown()
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
                ok = false
                latch.countDown()
            }
        }, null)
        if (!dispatched) return false
        latch.await(5, TimeUnit.SECONDS)
        return ok
    }

    fun inputText(text: String, clearFirst: Boolean = false): Boolean {
        val root = rootInActiveWindow ?: return false
        var target: AccessibilityNodeInfo? = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (target == null || !target.isEditable) {
            target = findFirstEditable(root)
        }
        target ?: return false
        val finalText = if (clearFirst || target.text.isNullOrEmpty()) text else text
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, finalText)
        }
        return target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun findFirstEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isEditable) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = findFirstEditable(child)
            if (found != null) return found
        }
        return null
    }

    fun performKey(key: String): Boolean {
        val action = when (key.trim().lowercase()) {
            "home" -> GLOBAL_ACTION_HOME
            "back" -> GLOBAL_ACTION_BACK
            "recents", "recent", "apps" -> GLOBAL_ACTION_RECENTS
            "notifications", "notif" -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings", "qs" -> GLOBAL_ACTION_QUICK_SETTINGS
            "power", "power_dialog" -> GLOBAL_ACTION_POWER_DIALOG
            "lock", "lock_screen" -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) GLOBAL_ACTION_LOCK_SCREEN
                else return false
            }
            else -> return false
        }
        return performGlobalAction(action)
    }

    @RequiresApi(Build.VERSION_CODES.R)
    fun captureScreenshotBase64(quality: Int = 85, maxWidth: Int = 1080): JSONObject {
        val latch = CountDownLatch(1)
        var resultObj: JSONObject? = null
        takeScreenshot(
            Display.DEFAULT_DISPLAY,
            mainExecutor,
            object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    val hwBuffer = screenshot.hardwareBuffer
                    try {
                        val hwBmp = Bitmap.wrapHardwareBuffer(hwBuffer, screenshot.colorSpace)
                        if (hwBmp == null) {
                            resultObj = JSONObject().apply {
                                put("ok", false)
                                put("error", "Bitmap.wrapHardwareBuffer returned null")
                            }
                        } else {
                            val swBmp = hwBmp.copy(Bitmap.Config.ARGB_8888, false)
                            hwBmp.recycle()
                            val scaled = scaleIfNeeded(swBmp, maxWidth)
                            if (scaled !== swBmp) swBmp.recycle()
                            val out = ByteArrayOutputStream()
                            val q = quality.coerceIn(30, 100)
                            if (q >= 98) {
                                scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
                            } else {
                                scaled.compress(Bitmap.CompressFormat.JPEG, q, out)
                            }
                            val bytes = out.toByteArray()
                            val w = scaled.width
                            val h = scaled.height
                            scaled.recycle()
                            resultObj = JSONObject().apply {
                                put("ok", true)
                                put("backend", "accessibility")
                                put("mimeType", if (q >= 98) "image/png" else "image/jpeg")
                                put("width", w)
                                put("height", h)
                                put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                            }
                        }
                    } catch (e: Throwable) {
                        resultObj = JSONObject().apply {
                            put("ok", false)
                            put("error", e.message ?: e.javaClass.simpleName)
                        }
                    } finally {
                        runCatching { hwBuffer.close() }
                        latch.countDown()
                    }
                }

                override fun onFailure(errorCode: Int) {
                    resultObj = JSONObject().apply {
                        put("ok", false)
                        put("error", "Accessibility takeScreenshot failed with code $errorCode")
                    }
                    latch.countDown()
                }
            }
        )
        latch.await(8, TimeUnit.SECONDS)
        return resultObj ?: JSONObject().apply {
            put("ok", false)
            put("error", "Accessibility screenshot timed out")
        }
    }

    private fun scaleIfNeeded(src: Bitmap, maxWidth: Int): Bitmap {
        if (maxWidth <= 0 || src.width <= maxWidth) return src
        val ratio = maxWidth.toFloat() / src.width.toFloat()
        val targetH = (src.height * ratio).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(src, maxWidth, targetH, true)
    }
}
