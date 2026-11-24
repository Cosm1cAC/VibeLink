export interface AvatarStyleSpec {
  label: string
  bg: string
  fg: string
  badge?: string
}

export interface AvatarPresetOption {
  value: string
  label: string
}

export const HULA_PRESET_AVATARS: ReadonlyArray<AvatarPresetOption> = [
  ...Array.from({ length: 22 }, (_, i) => {
    const code = String(i + 1).padStart(3, '0')
    return {
      value: `/avatar/${code}.webp`,
      label: `头像 ${code}`
    }
  }),
  { value: '/AI/deepseek.png', label: 'DeepSeek' },
  { value: '/AI/openai.svg', label: 'OpenAI' },
  { value: '/AI/QW.png', label: 'Qwen' }
]

export const MONOGRAM_PRESET_AVATARS: ReadonlyArray<AvatarPresetOption> = [
  { value: 'preset:codex', label: 'Codex' },
  { value: 'preset:claude', label: 'Claude' },
  { value: 'preset:antigravity', label: 'Antigravity' },
  { value: 'preset:opencode', label: 'OpenCode' },
  { value: 'preset:gemini', label: 'Gemini' },
  { value: 'preset:deepseek', label: 'DeepSeek' },
  { value: 'preset:magpie-gateway', label: 'Magpie' },
  { value: 'preset:user', label: '我' }
]

const PRESET_MAP: Record<string, AvatarStyleSpec> = {
  'preset:user': { label: '我', bg: '#13987F', fg: '#ecfdf5' },
  'preset:me': { label: '我', bg: '#13987F', fg: '#ecfdf5' },
  'preset:group': { label: '群', bg: '#1d4940', fg: '#5eead4' },
  'preset:gemini': { label: 'Gem', bg: '#2563eb', fg: '#eff6ff' },
  'preset:antigravity': { label: 'AG', bg: '#0284c7', fg: '#f0f9ff' },
  'preset:claude': { label: 'Cld', bg: '#b45309', fg: '#fffbeb' },
  'preset:claudeagent': { label: 'Cld', bg: '#b45309', fg: '#fffbeb' },
  'preset:opencode': { label: 'OC', bg: '#7c3aed', fg: '#f5f3ff' },
  'preset:codex': { label: 'Cdx', bg: '#0d9488', fg: '#f0fdfa' },
  'preset:deepseek': { label: 'DS', bg: '#1d4ed8', fg: '#eff6ff' },
  'preset:grok': { label: 'Grk', bg: '#374151', fg: '#f9fafb' },
  'preset:cursor': { label: 'Cur', bg: '#0f766e', fg: '#f0fdfa' },
  'preset:kiro': { label: 'Kir', bg: '#6d28d9', fg: '#f5f3ff' },
  'preset:pi': { label: 'Pi', bg: '#4f46e5', fg: '#eef2ff' },
  'preset:magpie-gateway': { label: 'Mag', bg: '#059669', fg: '#ecfdf5' }
}

export function isImageAvatarUrl(avatar?: string | null): boolean {
  if (!avatar) return false
  return /^https?:\/\/|^data:image\/|^blob:|^\//.test(avatar.trim())
}

export function resolveAvatarImageSrc(
  avatar?: string | null,
  serverUrl = '',
  authToken = ''
): string | null {
  const trimmed = (avatar || '').trim()
  if (!trimmed || trimmed.startsWith('preset:')) return null
  if (trimmed.startsWith('/api/vl/')) {
    const base = serverUrl.trim().replace(/\/+$/, '')
    const raw = base ? `${base}${trimmed}` : trimmed
    if (authToken.trim()) {
      const sep = raw.includes('?') ? '&' : '?'
      return `${raw}${sep}token=${encodeURIComponent(authToken.trim())}`
    }
    return raw
  }
  if (/^(https?:\/\/|data:image\/|blob:|\/)/i.test(trimmed)) {
    return trimmed
  }
  return null
}

export function resolveAvatarSpec(
  avatar?: string | null,
  fallbackName?: string | null,
  provider?: string | null
): AvatarStyleSpec {
  const key = (avatar || '').trim().toLowerCase()
  if (key && PRESET_MAP[key]) {
    return PRESET_MAP[key]
  }
  const provKey = provider ? `preset:${provider.trim().toLowerCase()}` : ''
  if (provKey && PRESET_MAP[provKey]) {
    const base = PRESET_MAP[provKey]
    const initials = (fallbackName || base.label).trim().slice(0, 2).toUpperCase()
    return { ...base, label: initials || base.label }
  }
  const clean = (fallbackName || 'VL').trim()
  const label = /[\u4e00-\u9fa5]/.test(clean) ? clean.slice(0, 1) : clean.slice(0, 2).toUpperCase()
  return {
    label: label || 'VL',
    bg: '#1d4940',
    fg: '#d1fae5'
  }
}

export function presenceColor(presence?: string | null): string {
  switch (presence) {
    case 'online':
      return '#22c55e'
    case 'working':
      return '#f59e0b'
    case 'idle':
      return '#10b981'
    case 'error':
      return '#ef4444'
    default:
      return '#64748b'
  }
}

export function presenceLabel(presence?: string | null): string {
  switch (presence) {
    case 'online':
      return '在线'
    case 'working':
      return '执行中'
    case 'idle':
      return '待命'
    case 'error':
      return '异常'
    default:
      return '离线'
  }
}
