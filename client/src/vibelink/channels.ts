import { normalizeServerUrl } from './runtime'
import type {
  VlChannelEndpoint,
  VlChannelKind,
  VlChannelSpeedResult,
  VlChannelSwitchMode
} from './types'

const CHANNELS_STORAGE_KEY = 'vibelink.channels.v1'
const SWITCH_MODE_STORAGE_KEY = 'vibelink.channelSwitchMode'

export interface ParsedQrPairing {
  hostName?: string
  token?: string
  endpoints: Array<{
    label: string
    kind: VlChannelKind
    url: string
    serverRole?: 'primary' | 'standby'
    nodeId?: string
    priority: number
  }>
}

export interface ChannelProbeResult {
  endpoint: VlChannelEndpoint
  ok: boolean
  latencyMs: number | null
  error?: string
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function isTailscaleIp(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (!m) return false
  const a = Number.parseInt(m[1], 10)
  const b = Number.parseInt(m[2], 10)
  return a === 100 && b >= 64 && b <= 127
}

function isPrivateLanHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '10.0.2.2' || host === '::1') return true
  if (host.startsWith('192.168.') || host.startsWith('10.')) return true
  const m = /^172\.(\d+)\./.exec(host)
  if (m) {
    const second = Number.parseInt(m[1], 10)
    return second >= 16 && second <= 31
  }
  return host.endsWith('.local')
}

export function classifyEndpointKind(url: string): VlChannelKind {
  try {
    const parsed = new URL(normalizeServerUrl(url))
    const host = parsed.hostname.toLowerCase()
    if (isTailscaleIp(host) || host.includes('.ts.net')) return 'tailscale'
    if (isPrivateLanHost(host)) return 'lan'
    return 'wan'
  } catch {
    return 'custom'
  }
}

export function defaultPriorityForKind(
  kind: VlChannelKind,
  serverRole: 'primary' | 'standby' = 'primary',
): number {
  if (serverRole === 'standby') {
    switch (kind) {
      case 'lan':
        return 55
      case 'tailscale':
        return 60
      case 'wan':
        return 70
      default:
        return 80
    }
  }
  switch (kind) {
    case 'lan':
      return 10
    case 'tailscale':
      return 25
    case 'wan':
      return 35
    default:
      return 50
  }
}

export function makeChannelId(url: string): string {
  const clean = url.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `ch_${clean.slice(0, 64)}`
}

export function loadSwitchMode(): VlChannelSwitchMode {
  try {
    return localStorage.getItem(SWITCH_MODE_STORAGE_KEY) === 'manual' ? 'manual' : 'auto'
  } catch {
    return 'auto'
  }
}

export function saveSwitchMode(mode: VlChannelSwitchMode): void {
  try {
    localStorage.setItem(SWITCH_MODE_STORAGE_KEY, mode)
  } catch {
    // ignore storage errors
  }
}

export function loadStoredChannels(fallbackUrl: string): VlChannelEndpoint[] {
  let list: VlChannelEndpoint[] = []
  try {
    const raw = localStorage.getItem(CHANNELS_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const seen = new Set<string>()
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue
          const rec = item as Partial<VlChannelEndpoint>
          if (typeof rec.url !== 'string' || !rec.url.trim()) continue
          try {
            const normUrl = normalizeServerUrl(rec.url)
            if (seen.has(normUrl)) continue
            seen.add(normUrl)
            const kind = rec.kind ?? classifyEndpointKind(normUrl)
            const serverRole = rec.serverRole === 'standby' ? 'standby' : rec.serverRole === 'primary' ? 'primary' : undefined
            list.push({
              id: typeof rec.id === 'string' && rec.id ? rec.id : makeChannelId(normUrl),
              label:
                typeof rec.label === 'string' && rec.label.trim()
                  ? rec.label.trim()
                  : kind === 'lan'
                    ? '内网通道'
                    : kind === 'tailscale'
                      ? '外网 · Tailscale'
                      : '外网通道',
              kind,
              url: normUrl,
              ...(typeof rec.iface === 'string' ? { iface: rec.iface } : {}),
              ...(serverRole ? { serverRole } : {}),
              ...(typeof rec.nodeId === 'string' && rec.nodeId ? { nodeId: rec.nodeId } : {}),
              priority:
                typeof rec.priority === 'number' && Number.isFinite(rec.priority)
                  ? rec.priority
                  : defaultPriorityForKind(kind, serverRole),
              enabled: rec.enabled !== false,
              lastLatencyMs: typeof rec.lastLatencyMs === 'number' ? rec.lastLatencyMs : null,
              lastJitterMs: typeof rec.lastJitterMs === 'number' ? rec.lastJitterMs : null,
              lastDownloadMbps: typeof rec.lastDownloadMbps === 'number' ? rec.lastDownloadMbps : null,
              lastUploadMbps: typeof rec.lastUploadMbps === 'number' ? rec.lastUploadMbps : null,
              lastStatus: rec.lastStatus ?? 'unknown',
              lastError: typeof rec.lastError === 'string' ? rec.lastError : null,
              lastCheckedAt: typeof rec.lastCheckedAt === 'number' ? rec.lastCheckedAt : null
            })
          } catch {
            // skip invalid stored URL
          }
        }
      }
    }
  } catch {
    list = []
  }

  try {
    const normFallback = normalizeServerUrl(fallbackUrl)
    if (!list.some((c) => c.url === normFallback)) {
      const kind = classifyEndpointKind(normFallback)
      const parsedFallback = new URL(normFallback)
      const isLoopback =
        parsedFallback.hostname === '127.0.0.1' ||
        parsedFallback.hostname === 'localhost' ||
        parsedFallback.hostname === '::1'
      list.unshift({
        id: makeChannelId(normFallback),
        label: isLoopback
          ? '本机回环 / ADB 通道'
          : kind === 'lan'
            ? '默认内网通道'
            : kind === 'tailscale'
              ? 'Tailscale 通道'
              : '当前通道',
        kind,
        url: normFallback,
        priority: isLoopback ? 25 : defaultPriorityForKind(kind),
        enabled: true,
        lastStatus: 'unknown'
      })
    }
  } catch {
    // ignore invalid fallback
  }

  return list.sort((a, b) => a.priority - b.priority || a.url.localeCompare(b.url))
}

export function saveStoredChannels(channels: VlChannelEndpoint[]): void {
  try {
    localStorage.setItem(CHANNELS_STORAGE_KEY, JSON.stringify(channels))
  } catch {
    // ignore storage errors
  }
}

export function mergeEndpoints(
  existing: VlChannelEndpoint[],
  incoming: Array<{
    id?: string
    label: string
    kind: VlChannelKind
    url: string
    iface?: string
    serverRole?: 'primary' | 'standby'
    nodeId?: string
    priority?: number
  }>
): VlChannelEndpoint[] {
  const byUrl = new Map<string, VlChannelEndpoint>()
  for (const ch of existing) {
    try {
      const norm = normalizeServerUrl(ch.url)
      byUrl.set(norm, { ...ch, url: norm })
    } catch {
      // ignore invalid
    }
  }

  for (const ep of incoming) {
    try {
      const norm = normalizeServerUrl(ep.url)
      const prev = byUrl.get(norm)
      const kind = ep.kind ?? classifyEndpointKind(norm)
      const serverRole = ep.serverRole ?? prev?.serverRole
      const priority = ep.priority ?? defaultPriorityForKind(kind, serverRole)
      if (prev) {
        byUrl.set(norm, {
          ...prev,
          label: ep.label || prev.label,
          kind,
          priority,
          ...(ep.iface ? { iface: ep.iface } : {}),
          ...(serverRole ? { serverRole } : {}),
          ...(ep.nodeId ? { nodeId: ep.nodeId } : {})
        })
      } else {
        byUrl.set(norm, {
          id: ep.id || makeChannelId(norm),
          label: ep.label || (kind === 'lan' ? '内网通道' : '外网通道'),
          kind,
          url: norm,
          ...(ep.iface ? { iface: ep.iface } : {}),
          ...(serverRole ? { serverRole } : {}),
          ...(ep.nodeId ? { nodeId: ep.nodeId } : {}),
          priority,
          enabled: true,
          lastStatus: 'unknown'
        })
      }
    } catch {
      // skip invalid endpoint
    }
  }

  return Array.from(byUrl.values()).sort((a, b) => a.priority - b.priority || a.url.localeCompare(b.url))
}

export function parsePairingQrPayload(raw: string): ParsedQrPairing {
  const trimmed = (raw || '').trim()
  if (!trimmed) {
    throw new Error('二维码内容为空')
  }

  if (trimmed.startsWith('{')) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      throw new Error('配对二维码 JSON 格式无效')
    }

    const endpointsRaw = Array.isArray(parsed.e)
      ? parsed.e
      : Array.isArray(parsed.endpoints)
        ? parsed.endpoints
        : []

    const endpoints: ParsedQrPairing['endpoints'] = []
    for (const item of endpointsRaw) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      const rawUrl = typeof obj.u === 'string' ? obj.u : typeof obj.url === 'string' ? obj.url : ''
      if (!rawUrl.trim()) continue
      const url = normalizeServerUrl(rawUrl)
      const rawKind = typeof obj.k === 'string' ? obj.k : typeof obj.kind === 'string' ? obj.kind : ''
      const kind: VlChannelKind =
        rawKind === 'lan' || rawKind === 'tailscale' || rawKind === 'wan' || rawKind === 'custom'
          ? rawKind
          : classifyEndpointKind(url)
      const label =
        typeof obj.n === 'string' && obj.n.trim()
          ? obj.n.trim()
          : typeof obj.label === 'string' && obj.label.trim()
            ? obj.label.trim()
            : kind === 'tailscale'
              ? '外网 · Tailscale'
              : kind === 'lan'
                ? '内网通道'
                : '外网通道'
      const serverRole =
        obj.r === 'standby' || obj.serverRole === 'standby'
          ? 'standby'
          : obj.r === 'primary' || obj.serverRole === 'primary'
            ? 'primary'
            : undefined
      const nodeId =
        typeof obj.d === 'string' && obj.d.trim()
          ? obj.d.trim()
          : typeof obj.nodeId === 'string' && obj.nodeId.trim()
            ? obj.nodeId.trim()
            : undefined
      const priority =
        typeof obj.priority === 'number' && Number.isFinite(obj.priority)
          ? obj.priority
          : defaultPriorityForKind(kind, serverRole)
      endpoints.push({
        label,
        kind,
        url,
        ...(serverRole ? { serverRole } : {}),
        ...(nodeId ? { nodeId } : {}),
        priority
      })
    }

    const singleServer =
      typeof parsed.server === 'string'
        ? parsed.server
        : typeof parsed.url === 'string'
          ? parsed.url
          : ''
    if (singleServer.trim()) {
      const url = normalizeServerUrl(singleServer)
      const kind = classifyEndpointKind(url)
      endpoints.push({
        label: kind === 'lan' ? '内网通道' : '外网通道',
        kind,
        url,
        priority: defaultPriorityForKind(kind)
      })
    }

    if (endpoints.length === 0) {
      throw new Error('配对码中未包含有效的服务器地址')
    }

    const token =
      typeof parsed.k === 'string'
        ? parsed.k.trim()
        : typeof parsed.token === 'string'
          ? parsed.token.trim()
          : undefined
    const hostName =
      typeof parsed.h === 'string'
        ? parsed.h.trim()
        : typeof parsed.hostName === 'string'
          ? parsed.hostName.trim()
          : undefined

    return { hostName, token, endpoints }
  }

  if (/^vibelink:\/\/pair/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    const parsedUrl = new URL(trimmed)
    const token = parsedUrl.searchParams.get('token')?.trim() || undefined
    const endpoints: ParsedQrPairing['endpoints'] = []
    const addParamUrl = (paramVal: string | null, kind: VlChannelKind, label: string) => {
      if (!paramVal?.trim()) return
      const url = normalizeServerUrl(paramVal)
      endpoints.push({ label, kind, url, priority: defaultPriorityForKind(kind) })
    }

    addParamUrl(parsedUrl.searchParams.get('lan'), 'lan', '内网通道')
    addParamUrl(parsedUrl.searchParams.get('ts'), 'tailscale', '外网 · Tailscale')
    addParamUrl(parsedUrl.searchParams.get('tailscale'), 'tailscale', '外网 · Tailscale')
    addParamUrl(parsedUrl.searchParams.get('wan'), 'wan', '外网通道')
    addParamUrl(parsedUrl.searchParams.get('server'), classifyEndpointKind(parsedUrl.searchParams.get('server') || ''), '主通道')

    if (endpoints.length === 0 && /^https?:\/\//i.test(trimmed)) {
      const url = normalizeServerUrl(trimmed)
      const kind = classifyEndpointKind(url)
      endpoints.push({
        label: kind === 'lan' ? '内网通道' : kind === 'tailscale' ? '外网 · Tailscale' : '外网通道',
        kind,
        url,
        priority: defaultPriorityForKind(kind)
      })
    }

    if (endpoints.length === 0) {
      throw new Error('链接中未包含有效通道地址')
    }
    return { token, endpoints }
  }

  const normalized = normalizeServerUrl(trimmed)
  const kind = classifyEndpointKind(normalized)
  return {
    endpoints: [
      {
        label: kind === 'lan' ? '内网通道' : kind === 'tailscale' ? '外网 · Tailscale' : '外网通道',
        kind,
        url: normalized,
        priority: defaultPriorityForKind(kind)
      }
    ]
  }
}

export function pickBestEndpoint(results: ChannelProbeResult[]): ChannelProbeResult | null {
  const okList = results.filter((r) => r.ok && r.endpoint.enabled)
  if (okList.length === 0) return null

  const roleScore = (role?: 'primary' | 'standby'): number => (role === 'standby' ? 1 : 0)

  const tierScore = (kind: VlChannelKind): number => {
    if (kind === 'lan') return 0
    if (kind === 'tailscale') return 1
    if (kind === 'wan') return 2
    return 3
  }

  return okList
    .slice()
    .sort((a, b) => {
      const ra = roleScore(a.endpoint.serverRole)
      const rb = roleScore(b.endpoint.serverRole)
      if (ra !== rb) return ra - rb
      const ta = tierScore(a.endpoint.kind)
      const tb = tierScore(b.endpoint.kind)
      if (ta !== tb) return ta - tb
      const pa = a.endpoint.priority
      const pb = b.endpoint.priority
      if (pa !== pb) return pa - pb
      const la = a.latencyMs ?? 999_999
      const lb = b.latencyMs ?? 999_999
      return la - lb
    })[0]
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timer)
  }
}

function authHeaders(token: string): Record<string, string> {
  const clean = token.trim()
  if (!clean) return {}
  return {
    Authorization: `Bearer ${clean}`,
    'X-VibeLink-Token': clean
  }
}

export async function probeEndpointHealth(
  endpoint: VlChannelEndpoint,
  token: string,
  timeoutMs = 2200
): Promise<ChannelProbeResult> {
  const t0 = nowMs()
  try {
    const res = await fetchWithTimeout(
      `${endpoint.url}/api/vl/health`,
      { method: 'GET', headers: authHeaders(token) },
      timeoutMs
    )
    const latencyMs = Math.max(1, Math.round(nowMs() - t0))
    const text = await res.text()
    let json: Record<string, unknown> | null = null
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      json = null
    }
    if (!res.ok || !json || json.ok !== true || json.service !== 'vibelink') {
      return {
        endpoint,
        ok: false,
        latencyMs: null,
        error: `HTTP ${res.status}`
      }
    }
    return { endpoint, ok: true, latencyMs }
  } catch (err) {
    return {
      endpoint,
      ok: false,
      latencyMs: null,
      error: err instanceof Error ? err.message : '连接超时'
    }
  }
}

export async function measureChannelSpeed(
  endpoint: VlChannelEndpoint,
  token: string,
  options?: { downloadBytes?: number; uploadBytes?: number }
): Promise<VlChannelSpeedResult> {
  const checkedAt = Date.now()
  const headers = authHeaders(token)
  const pings: number[] = []

  try {
    for (let i = 0; i < 3; i++) {
      const t0 = nowMs()
      const res = await fetchWithTimeout(
        `${endpoint.url}/api/vl/speedtest/ping?i=${i}&t=${Date.now()}`,
        { method: 'GET', headers },
        3000
      )
      const rtt = Math.max(1, Math.round(nowMs() - t0))
      const data = (await res.json()) as { ok?: boolean; service?: string }
      if (!res.ok || data.ok !== true || data.service !== 'vibelink') {
        throw new Error(res.status === 401 ? 'Token 鉴权失败 (401)' : `Ping 状态 ${res.status}`)
      }
      pings.push(rtt)
    }

    const sortedPings = pings.slice().sort((a, b) => a - b)
    const latencyMs = sortedPings[1] ?? sortedPings[0] ?? 1
    const jitterMs = Math.max(0, Math.round(Math.max(...sortedPings) - Math.min(...sortedPings)))

    // Download speed benchmark (512 KB default)
    const dlTargetBytes = options?.downloadBytes ?? 512 * 1024
    const dlStart = nowMs()
    const dlRes = await fetchWithTimeout(
      `${endpoint.url}/api/vl/speedtest/download?bytes=${dlTargetBytes}&t=${Date.now()}`,
      { method: 'GET', headers },
      8000
    )
    if (!dlRes.ok) {
      throw new Error(`下载测速失败 (${dlRes.status})`)
    }
    const dlBuf = await dlRes.arrayBuffer()
    const dlElapsedSec = Math.max(0.005, (nowMs() - dlStart) / 1000)
    const downloadMbps = Number(((dlBuf.byteLength * 8) / (dlElapsedSec * 1_000_000)).toFixed(2))

    // Upload speed benchmark (128 KB default)
    const ulTargetBytes = options?.uploadBytes ?? 128 * 1024
    const ulBody = 'V'.repeat(ulTargetBytes)
    const ulStart = nowMs()
    const ulRes = await fetchWithTimeout(
      `${endpoint.url}/api/vl/speedtest/upload?t=${Date.now()}`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'text/plain' },
        body: ulBody
      },
      8000
    )
    if (!ulRes.ok) {
      throw new Error(`上传测速失败 (${ulRes.status})`)
    }
    await ulRes.text()
    const ulElapsedSec = Math.max(0.005, (nowMs() - ulStart) / 1000)
    const uploadMbps = Number(((ulTargetBytes * 8) / (ulElapsedSec * 1_000_000)).toFixed(2))

    return {
      endpointId: endpoint.id,
      url: endpoint.url,
      ok: true,
      latencyMs,
      jitterMs,
      downloadMbps,
      uploadMbps,
      checkedAt
    }
  } catch (err) {
    return {
      endpointId: endpoint.id,
      url: endpoint.url,
      ok: false,
      latencyMs: null,
      jitterMs: null,
      downloadMbps: null,
      uploadMbps: null,
      error: err instanceof Error ? err.message : String(err),
      checkedAt
    }
  }
}
