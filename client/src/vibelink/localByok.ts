export type VlLocalByokProtocol = 'openai' | 'anthropic' | 'gemini'

export interface VlLocalByokProfile {
  id: string
  name: string
  protocol: VlLocalByokProtocol
  baseUrl: string
  apiKey: string
  defaultModel: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface VlLocalByokTestResult {
  ok: boolean
  latencyMs: number
  modelsCount?: number
  sampleModels?: string[]
  message: string
}

const STORAGE_KEY = 'vibelink.localByokGateways.v1'

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage
    }
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return (globalThis as unknown as { localStorage: Storage }).localStorage
    }
  } catch {
    return null
  }
  return null
}

function normalizeBaseUrl(raw: string): string {
  return String(raw || '').trim().replace(/\/+$/, '')
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `byok_${crypto.randomUUID().slice(0, 12)}`
  }
  return `byok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function maskLocalApiKey(key: string): string {
  const s = String(key || '').trim()
  if (!s) return '(未填写)'
  if (s.length <= 10) return `${s.slice(0, 3)}***`
  return `${s.slice(0, 6)}...${s.slice(-4)}`
}

export function loadLocalByokProfiles(): VlLocalByokProfile[] {
  const storage = getStorage()
  if (!storage) return []
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is VlLocalByokProfile => Boolean(item && typeof item === 'object' && item.id))
      .map((item) => ({
        id: String(item.id),
        name: String(item.name || '自有网关'),
        protocol:
          item.protocol === 'anthropic' || item.protocol === 'gemini' ? item.protocol : 'openai',
        baseUrl: normalizeBaseUrl(String(item.baseUrl || '')),
        apiKey: String(item.apiKey || ''),
        defaultModel: String(item.defaultModel || ''),
        enabled: item.enabled !== false,
        createdAt: Number(item.createdAt || Date.now()),
        updatedAt: Number(item.updatedAt || Date.now())
      }))
  } catch {
    return []
  }
}

function persistProfiles(list: VlLocalByokProfile[]): VlLocalByokProfile[] {
  const storage = getStorage()
  if (storage) {
    storage.setItem(STORAGE_KEY, JSON.stringify(list))
  }
  return list
}

export function saveLocalByokProfile(input: {
  id?: string
  name: string
  protocol: VlLocalByokProtocol
  baseUrl: string
  apiKey: string
  defaultModel?: string
  enabled?: boolean
}): VlLocalByokProfile[] {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('自有网关 Base URL 必须以 http:// 或 https:// 开头')
  }
  const apiKey = String(input.apiKey || '').trim()
  if (!apiKey) {
    throw new Error('请填写您自己的 API Key（仅保存在本机，不会上传服务端）')
  }
  const now = Date.now()
  const existing = loadLocalByokProfiles()
  const targetId = input.id?.trim() || makeId()
  const idx = existing.findIndex((p) => p.id === targetId)
  const record: VlLocalByokProfile = {
    id: targetId,
    name: String(input.name || '').trim() || '自有网关',
    protocol:
      input.protocol === 'anthropic' || input.protocol === 'gemini' ? input.protocol : 'openai',
    baseUrl,
    apiKey,
    defaultModel: String(input.defaultModel || '').trim(),
    enabled: input.enabled !== false,
    createdAt: idx >= 0 ? existing[idx].createdAt : now,
    updatedAt: now
  }
  if (idx >= 0) {
    existing[idx] = record
  } else {
    existing.unshift(record)
  }
  return persistProfiles(existing)
}

export function deleteLocalByokProfile(id: string): VlLocalByokProfile[] {
  const next = loadLocalByokProfiles().filter((p) => p.id !== id)
  return persistProfiles(next)
}

/**
 * Direct client-side connectivity probe against the user's own gateway.
 * Intentionally never routes through or sends secrets to VibeLink Server.
 */
export async function testLocalByokProfile(
  profile: Pick<VlLocalByokProfile, 'protocol' | 'baseUrl' | 'apiKey'>
): Promise<VlLocalByokTestResult> {
  const base = normalizeBaseUrl(profile.baseUrl)
  if (!/^https?:\/\//i.test(base)) {
    return {
      ok: false,
      latencyMs: 0,
      message: 'Base URL 无效（需以 http:// 或 https:// 开头）'
    }
  }

  let probeUrl = ''
  const headers: Record<string, string> = {}
  if (profile.protocol === 'anthropic') {
    probeUrl = /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`
    headers['x-api-key'] = profile.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (profile.protocol === 'gemini') {
    const verBase = /\/v1(beta)?$/i.test(base) ? base : `${base}/v1beta`
    probeUrl = `${verBase}/models?key=${encodeURIComponent(profile.apiKey)}`
  } else {
    probeUrl = /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`
    headers['Authorization'] = `Bearer ${profile.apiKey}`
  }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(probeUrl, {
      method: 'GET',
      headers,
      signal: controller.signal
    })
    const latencyMs = Math.max(1, Date.now() - started)
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return {
        ok: false,
        latencyMs,
        message: `直连返回 HTTP ${res.status}${errText ? `: ${errText.slice(0, 120)}` : ''}`
      }
    }
    const json = (await res.json().catch(() => ({}))) as {
      data?: Array<{ id?: string }>
      models?: Array<{ name?: string }>
    }
    const names = Array.isArray(json.data)
      ? json.data.map((m) => String(m?.id || '').trim()).filter(Boolean)
      : Array.isArray(json.models)
        ? json.models.map((m) => String(m?.name || '').replace(/^models\//, '').trim()).filter(Boolean)
        : []
    return {
      ok: true,
      latencyMs,
      modelsCount: names.length,
      sampleModels: names.slice(0, 6),
      message:
        names.length > 0
          ? `本机直连成功 (${latencyMs}ms，发现 ${names.length} 个模型)`
          : `本机直连成功 (${latencyMs}ms)`
    }
  } catch (err) {
    const latencyMs = Math.max(1, Date.now() - started)
    return {
      ok: false,
      latencyMs,
      message: `本机直连失败：${err instanceof Error ? err.message : String(err)}`
    }
  } finally {
    clearTimeout(timer)
  }
}
