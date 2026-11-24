/** Strip markdown syntax for clean single-line session previews on mobile. */
export function stripMarkdownPreview(raw?: string | null): string {
  if (!raw) return ''
  let text = raw
  // Replace markdown links [label](url) -> label
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[图片]')
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // Strip fenced code blocks & inline backticks
  text = text.replace(/```[\s\S]*?```/g, '[代码]')
  text = text.replace(/`([^`]+)`/g, '$1')
  // Strip headings, blockquotes, list markers, emphasis
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  text = text.replace(/^\s*>\s?/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/\*([^*\n]+)\*/g, '$1')
  text = text.replace(/~~([^~]+)~~/g, '$1')
  return text.replace(/\s+/g, ' ').trim()
}

/** Format timestamp like QQ / HuLa mobile list. */
export function formatSmartTime(ts?: number | null): string {
  if (!ts) return ''
  const date = new Date(ts)
  const now = new Date()
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startMsg = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const diffDays = Math.round((startToday - startMsg) / 86_400_000)

  if (diffDays === 0) return hm
  if (diffDays === 1) return `昨天 ${hm}`
  if (date.getFullYear() === now.getFullYear()) {
    return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
  }
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
}

/** Show centered timestamp divider when gap exceeds 5 minutes. */
export function shouldShowTimeDivider(prevTs: number | undefined, currTs: number): boolean {
  if (!prevTs) return true
  return currTs - prevTs > 5 * 60 * 1000
}

export function formatPresenceText(presence?: string): string {
  switch (presence) {
    case 'working':
      return '处理中'
    case 'online':
      return '在线'
    case 'idle':
      return '忙碌'
    case 'error':
      return '异常'
    default:
      return '离线'
  }
}
