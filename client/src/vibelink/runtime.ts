import { invoke } from '@tauri-apps/api/core'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { type } from '@tauri-apps/plugin-os'

const SERVER_URL_STORAGE_KEY = 'vibelink.serverUrl'
const AUTH_TOKEN_STORAGE_KEY = 'vibelink.authToken'

/** Detects whether the UI is running inside a Tauri native shell. */
export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

/** Detects whether the UI should mount the mobile shell (Tauri Android/iOS or ?mobile=1 viewport). */
export function isMobileRuntime(): boolean {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    if (params.get('mobile') === '1') return true
    if (params.get('mobile') === '0') return false
    if (window.location.pathname.startsWith('/mobile')) return true
  }

  if (isTauriRuntime()) {
    try {
      const os = type()
      return os === 'android' || os === 'ios'
    } catch {
      return false
    }
  }

  if (typeof navigator !== 'undefined') {
    return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
  }

  return false
}

export function getCurrentWindowLabelSafe(): string {
  if (!isTauriRuntime()) return 'browser'
  try {
    return WebviewWindow.getCurrent().label
  } catch {
    return 'browser'
  }
}

export async function hideMobileSplashSafe(): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    await invoke('hide_splash_screen')
  } catch (err) {
    console.warn('[vibelink/runtime] hide_splash_screen failed:', err)
  }
}

export async function minimizeWindowSafe(): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    await WebviewWindow.getCurrent().minimize()
  } catch (err) {
    console.warn('[vibelink/runtime] minimizeWindow failed:', err)
  }
}

export async function toggleMaximizeWindowSafe(): Promise<boolean> {
  if (!isTauriRuntime()) return false
  try {
    const win = WebviewWindow.getCurrent()
    await win.toggleMaximize()
    return await win.isMaximized()
  } catch (err) {
    console.warn('[vibelink/runtime] toggleMaximize failed:', err)
    return false
  }
}

export async function closeOrHideWindowSafe(): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    const win = WebviewWindow.getCurrent()
    await win.hide()
  } catch (err) {
    console.warn('[vibelink/runtime] closeOrHide failed:', err)
  }
}

export async function triggerDesktopScreenshot(concealCurrentWindow: boolean): Promise<boolean> {
  if (!isTauriRuntime()) return false
  try {
    const { useSettingStore } = await import('@/stores/setting')
    useSettingStore().setScreenshotConceal(concealCurrentWindow)

    const homeWindow = await WebviewWindow.getByLabel('home')
    const captureWindow = await WebviewWindow.getByLabel('capture')
    if (!captureWindow) return false

    if (concealCurrentWindow && homeWindow) {
      await homeWindow.hide()
      await new Promise((resolve) => setTimeout(resolve, 120))
    }

    const screenWidth = window.screen.width * window.devicePixelRatio
    const screenHeight = window.screen.height * window.devicePixelRatio
    await captureWindow.setSize(new LogicalSize(screenWidth, screenHeight))
    await captureWindow.setPosition(new LogicalPosition(0, 0))

    let osName = ''
    try {
      osName = type()
    } catch {
      osName = ''
    }
    if (osName === 'macos') {
      await invoke('set_window_level_above_menubar', { windowLabel: 'capture' })
    }

    await captureWindow.show()
    await captureWindow.setFocus()
    await captureWindow.emit('capture', true)
    return true
  } catch (err) {
    console.warn('[vibelink/runtime] triggerDesktopScreenshot failed:', err)
    return false
  }
}

export async function listenScreenshotResult(cb: (file: File) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  try {
    const appWindow = WebviewWindow.getCurrent()
    const unlisten = await appWindow.listen<{ buffer?: number[] | ArrayBuffer; mimeType?: string }>(
      'screenshot',
      (event) => {
        const payload = event.payload
        if (!payload?.buffer) return
        const mimeType = payload.mimeType || 'image/png'
        const bytes = new Uint8Array(payload.buffer)
        const blob = new Blob([bytes], { type: mimeType })
        const file = new File([blob], `screenshot-${Date.now()}.png`, { type: mimeType })
        cb(file)
      }
    )
    return unlisten
  } catch (err) {
    console.warn('[vibelink/runtime] listenScreenshotResult failed:', err)
    return () => {}
  }
}

export function getDefaultServerUrl(): string {
  try {
    const stored = localStorage.getItem(SERVER_URL_STORAGE_KEY)?.trim()
    if (stored) return stored.replace(/\/+$/, '')
  } catch {
    // ignore storage errors
  }
  const envUrl = (import.meta.env.VITE_VIBELINK_SERVER_URL as string | undefined)?.trim()
  return (envUrl || 'http://127.0.0.1:18990').replace(/\/+$/, '')
}

export function getStoredAuthToken(): string {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function setServerConfig(url: string, token: string): void {
  try {
    const normalized = url.trim().replace(/\/+$/, '') || 'http://127.0.0.1:18990'
    localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized)
    if (token.trim()) {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token.trim())
    } else {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
    }
  } catch {
    // ignore storage errors
  }
}
