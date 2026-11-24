import { invoke } from '@tauri-apps/api/core'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { type } from '@tauri-apps/plugin-os'

const SERVER_URL_STORAGE_KEY = 'vibelink.serverUrl'
const AUTH_TOKEN_STORAGE_KEY = 'vibelink.authToken'
const SESSION_TOKEN_STORAGE_KEY = 'vibelink.sessionToken'

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

/** Syncs Android system status/navigation bar contrast with current light/dark theme. */
export function syncAndroidSystemBars(isDark: boolean): void {
  if (typeof window === 'undefined') return
  try {
    const bridge = (window as unknown as {
      VibeLinkAndroid?: { setSystemBarTheme?: (dark: boolean) => void }
    }).VibeLinkAndroid
    bridge?.setSystemBarTheme?.(isDark)
  } catch {
    // ignore outside Android WebView bridge
  }
}

/** Toggles Android WebView background transparency so windowed camera QR preview shows behind UI. */
export function setAndroidWebViewTransparent(transparent: boolean): void {
  if (typeof window === 'undefined') return
  try {
    const bridge = (window as unknown as {
      VibeLinkAndroid?: { setWebViewTransparent?: (flag: boolean) => void }
    }).VibeLinkAndroid
    bridge?.setWebViewTransparent?.(transparent)
  } catch {
    // ignore outside Android WebView bridge
  }
}

interface VibeLinkAndroidNativeBridge {
  syncAgentConfig?: (configJson: string) => boolean
  setAgentEnabled?: (enabled: boolean) => boolean
  getDeviceCapabilities?: () => string
  requestVpnPermission?: () => string
  openAccessibilitySettings?: () => boolean
  requestShizukuPermission?: () => string
  enableAccessibilityWithPrivilege?: () => string
  requestBatteryOptimizationExemption?: () => boolean
  applyLocalProxy?: (payloadJson: string) => string
  clearLocalProxy?: () => string
  getMihomoStatus?: () => string
  startMihomo?: (payloadJson: string) => string
  stopMihomo?: () => string
  getMihomoProxies?: () => string
  selectMihomoNode?: (group: string, node: string) => string
  setMihomoMode?: (mode: string) => string
  testMihomoDelay?: (payloadJson: string) => string
  probeMihomoConnectivity?: () => string
  openExternalUrl?: (url: string) => boolean
}

function getAndroidBridge(): VibeLinkAndroidNativeBridge | null {
  if (typeof window === 'undefined') return null
  return (
    (window as unknown as { VibeLinkAndroid?: VibeLinkAndroidNativeBridge }).VibeLinkAndroid ?? null
  )
}

export function isAndroidNativeBridgeAvailable(): boolean {
  const b = getAndroidBridge()
  return Boolean(b && typeof b.getDeviceCapabilities === 'function')
}

export function syncAndroidAgentConfig(config: {
  enabled: boolean
  token: string
  endpoints: string[]
  activeUrl?: string | null
}): boolean {
  try {
    const b = getAndroidBridge()
    return Boolean(b?.syncAgentConfig?.(JSON.stringify(config)))
  } catch {
    return false
  }
}

export function setAndroidAgentEnabled(enabled: boolean): boolean {
  try {
    return Boolean(getAndroidBridge()?.setAgentEnabled?.(enabled))
  } catch {
    return false
  }
}

export function getAndroidDeviceCapabilities(): import('./types').VlLocalAndroidCapabilities | null {
  try {
    const raw = getAndroidBridge()?.getDeviceCapabilities?.()
    if (!raw) return null
    return JSON.parse(raw) as import('./types').VlLocalAndroidCapabilities
  } catch {
    return null
  }
}

export function requestAndroidVpnPermission(): string {
  try {
    return getAndroidBridge()?.requestVpnPermission?.() ?? 'unavailable'
  } catch {
    return 'error'
  }
}

export function openAndroidAccessibilitySettings(): boolean {
  try {
    return Boolean(getAndroidBridge()?.openAccessibilitySettings?.())
  } catch {
    return false
  }
}

export function requestAndroidShizukuPermission(): string {
  try {
    return getAndroidBridge()?.requestShizukuPermission?.() ?? 'unavailable'
  } catch {
    return 'error'
  }
}

export function enableAndroidAccessibilityWithPrivilege(): {
  ok: boolean
  backend?: string
  stderr?: string
} {
  try {
    const raw = getAndroidBridge()?.enableAccessibilityWithPrivilege?.()
    if (!raw) return { ok: false, stderr: '仅限 Android 端可用' }
    return JSON.parse(raw) as { ok: boolean; backend?: string; stderr?: string }
  } catch (err) {
    return { ok: false, stderr: err instanceof Error ? err.message : String(err) }
  }
}

export function requestAndroidBatteryExemption(): boolean {
  try {
    return Boolean(getAndroidBridge()?.requestBatteryOptimizationExemption?.())
  } catch {
    return false
  }
}

export function applyAndroidLocalProxy(payload: {
  proxyUrl: string
  mode?: 'auto' | 'vpn_tun' | 'vpn_http' | 'system_proxy'
  dnsMode?: 'over_tcp' | 'virtual' | 'direct'
}): { ok: boolean; data?: unknown; error?: string } {
  try {
    const raw = getAndroidBridge()?.applyLocalProxy?.(JSON.stringify(payload))
    if (!raw) return { ok: false, error: '仅限 Android 端可用' }
    return JSON.parse(raw) as { ok: boolean; data?: unknown; error?: string }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function clearAndroidLocalProxy(): { ok: boolean; data?: unknown; error?: string } {
  try {
    const raw = getAndroidBridge()?.clearLocalProxy?.()
    if (!raw) return { ok: false, error: '仅限 Android 端可用' }
    return JSON.parse(raw) as { ok: boolean; data?: unknown; error?: string }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function invokeBridgeJson<T = unknown>(fn: (() => string | undefined) | undefined): {
  ok: boolean
  data?: T
  error?: string
} {
  try {
    const raw = fn?.()
    if (!raw) return { ok: false, error: '仅限 Android 端可用' }
    return JSON.parse(raw) as { ok: boolean; data?: T; error?: string }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function getAndroidMihomoStatus() {
  return invokeBridgeJson<import('./types').VlMihomoStatus>(() => getAndroidBridge()?.getMihomoStatus?.())
}

export function startAndroidMihomo(payload: {
  yaml?: string
  configName?: string
  resetTailscaleState?: boolean
} = {}) {
  return invokeBridgeJson<import('./types').VlMihomoStatus>(() =>
    getAndroidBridge()?.startMihomo?.(JSON.stringify(payload))
  )
}

export function stopAndroidMihomo() {
  return invokeBridgeJson<import('./types').VlMihomoStatus>(() => getAndroidBridge()?.stopMihomo?.())
}

export function getAndroidMihomoProxies() {
  return invokeBridgeJson<import('./types').VlMihomoProxiesPayload>(() =>
    getAndroidBridge()?.getMihomoProxies?.()
  )
}

export function selectAndroidMihomoNode(group: string, node: string) {
  return invokeBridgeJson<{
    selected: boolean
    group: string
    node: string
    activeNode: string
    effectiveNode?: string
    entryGroupNow?: string | null
  }>(() => getAndroidBridge()?.selectMihomoNode?.(group, node))
}

export function setAndroidMihomoMode(mode: 'rule' | 'global' | 'direct') {
  return invokeBridgeJson<{
    ok: boolean
    mode: string
    activeNode?: string | null
    effectiveNode?: string | null
  }>(() => getAndroidBridge()?.setMihomoMode?.(mode))
}

export function testAndroidMihomoDelay(payload: {
  node?: string
  group?: string
  url?: string
  timeoutMs?: number
}) {
  return invokeBridgeJson<Record<string, unknown>>(() =>
    getAndroidBridge()?.testMihomoDelay?.(JSON.stringify(payload))
  )
}

export function probeAndroidMihomoConnectivity() {
  return invokeBridgeJson<import('./types').VlMihomoProbeResult>(() =>
    getAndroidBridge()?.probeMihomoConnectivity?.()
  )
}

export function openAndroidExternalUrl(url: string): boolean {
  try {
    return Boolean(getAndroidBridge()?.openExternalUrl?.(url))
  } catch {
    return false
  }
}

const FALLBACK_SERVER_URL = 'http://127.0.0.1:18990'

/**
 * Normalizes and validates a VibeLink server URL (heals fullwidth IME punctuation/spaces).
 * Throws an Error when the input is not a valid http:// or https:// host URL.
 */
export function normalizeServerUrl(raw: string): string {
  let cleaned = (raw || '')
    .replace(/：/g, ':')
    .replace(/／/g, '/')
    .replace(/。/g, '.')
    .replace(/\s+/g, '')
    .trim()

  if (!cleaned) {
    cleaned = FALLBACK_SERVER_URL
  }

  // Handle "http:/host" or missing scheme like "192.168.5.2:18990"
  cleaned = cleaned.replace(/^(https?):\/(?!\/)/i, '$1://')
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cleaned)) {
    cleaned = `http://${cleaned}`
  }

  let parsed: URL
  try {
    parsed = new URL(cleaned)
  } catch {
    throw new Error('请输入有效的 http:// 或 https:// 服务器地址')
  }

  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new Error('请输入有效的 http:// 或 https:// 服务器地址')
  }

  const basePath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${basePath}`.replace(/\/+$/, '')
}

export function getDefaultServerUrl(): string {
  try {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const qServer = params.get('server')?.trim()
      const qToken = params.get('token')?.trim()
      if (qToken) {
        localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, qToken)
      }
      if (qServer) {
        const normalized = normalizeServerUrl(qServer)
        localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized)
        return normalized
      }
    }
    const stored = localStorage.getItem(SERVER_URL_STORAGE_KEY)?.trim()
    if (stored) {
      try {
        const healed = normalizeServerUrl(stored)
        if (healed !== stored) {
          localStorage.setItem(SERVER_URL_STORAGE_KEY, healed)
        }
        return healed
      } catch {
        localStorage.setItem(SERVER_URL_STORAGE_KEY, FALLBACK_SERVER_URL)
        return FALLBACK_SERVER_URL
      }
    }
  } catch {
    // ignore storage errors
  }
  const envUrl = (import.meta.env.VITE_VIBELINK_SERVER_URL as string | undefined)?.trim()
  if (envUrl) {
    try {
      return normalizeServerUrl(envUrl)
    } catch {
      return FALLBACK_SERVER_URL
    }
  }
  return FALLBACK_SERVER_URL
}

export function getStoredAuthToken(): string {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function getStoredSessionToken(): string {
  try {
    return localStorage.getItem(SESSION_TOKEN_STORAGE_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function setSessionToken(token: string | null): void {
  try {
    if (token && token.trim()) {
      localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token.trim())
    } else {
      localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY)
    }
  } catch {
    // ignore storage errors
  }
}

export function setServerConfig(url: string, token: string): void {
  const normalized = normalizeServerUrl(url)
  try {
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
