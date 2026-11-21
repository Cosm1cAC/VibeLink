export interface AvatarStyleSpec {
  label: string
  bg: string
  fg: string
  badge?: string
}

const PRESET_MAP: Record<string, AvatarStyleSpec> = {
  'preset:user': { label: '我', bg: '#13987F', fg: '#ecfdf5' },
  'preset:me': { label: '我', bg: '#13987F', fg: '#ecfdf5' },
  'preset:group': { label: '群', bg: '#1d4940', fg: '#5eead4' },
  'preset:cto': { label: 'Gem', bg: '#2563eb', fg: '#eff6ff', badge: 'CTO' },
  'preset:gemini': { label: 'Gem', bg: '#2563eb', fg: '#eff6ff' },
  'preset:antigravity': { label: 'AG', bg: '#0284c7', fg: '#f0f9ff' },
  'preset:claude': { label: 'Cld', bg: '#b45309', fg: '#fffbeb' },
  'preset:claudeagent': { label: 'Cld', bg: '#b45309', fg: '#fffbeb' },
  'preset:opencode': { label: 'OC', bg: '#7c3aed', fg: '#f5f3ff' },
  'preset:codex': { label: 'Cdx', bg: '#0d9488', fg: '#f0fdfa' },
  'preset:ui': { label: 'UI', bg: '#db2777', fg: '#fdf2f8' },
  'preset:qa': { label: 'QA', bg: '#059669', fg: '#ecfdf5' }
}

export function isImageAvatarUrl(avatar?: string | null): boolean {
  if (!avatar) return false
  return /^https?:\/\/|^data:image\/|^blob:|^\//.test(avatar.trim())
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
