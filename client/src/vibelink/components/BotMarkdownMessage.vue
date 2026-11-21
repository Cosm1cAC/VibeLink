<template>
  <div class="vl-markdown text-13.5px leading-relaxed space-y-2 break-words">
    <template v-for="(block, idx) in blocks" :key="idx">
      <div
        v-if="block.type === 'code'"
        class="rounded-8px overflow-hidden border border-[#3a3a3a] bg-[#141617] my-1.5">
        <div class="flex items-center justify-between px-3 py-1 bg-[#1b1f20] text-11px text-[#9ca3af] border-b border-[#2d3234]">
          <span>{{ block.lang || 'code' }}</span>
          <button
            type="button"
            class="cursor-pointer bg-transparent border-0 text-11px text-[#5eead4] hover:text-[#99f6e4] px-1.5 py-0.5 rounded"
            @click="copyCode(block.code, idx)">
            {{ copiedIdx === idx ? '已复制' : '复制' }}
          </button>
        </div>
        <pre class="m-0 p-3 overflow-x-auto text-12px font-mono text-[#d1fae5] leading-snug"><code>{{ block.code }}</code></pre>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-else class="vl-md-prose whitespace-pre-wrap" v-html="block.html"></div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  content: string
  serverUrl?: string
  botHandles?: string[]
}>()

const copiedIdx = ref<number | null>(null)

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeHref(rawHref: string): string {
  const trimmed = rawHref.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/api/vl/')) {
    return props.serverUrl ? `${props.serverUrl}${trimmed}` : trimmed
  }
  return '#'
}

function formatProseHtml(raw: string): string {
  let html = escapeHtml(raw)

  // Inline code placeholders
  const inlineCodes: string[] = []
  html = html.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code class="vl-md-inline-code">${code}</code>`)
    return `\u0000CODE_${idx}\u0000`
  })

  // Images: ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) => {
    const safeUrl = sanitizeHref(url)
    if (safeUrl === '#') return alt
    return `<img class="vl-md-img" src="${escapeHtml(safeUrl)}" alt="${alt}" loading="lazy" />`
  })

  // Markdown links: [label](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const safeUrl = sanitizeHref(url)
    return `<a class="vl-md-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })

  // Bold & Italic
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')

  // @Bot mentions highlight
  html = html.replace(/(^|\s)(@[\w\u4e00-\u9fa5.-]+)/g, (_m, prefix: string, mention: string) => {
    return `${prefix}<span class="vl-md-mention">${mention}</span>`
  })

  // Restore inline code
  html = html.replace(/\u0000CODE_(\d+)\u0000/g, (_m, idxStr: string) => {
    return inlineCodes[Number(idxStr)] ?? ''
  })

  return html
}

type MdBlock =
  | { type: 'code'; lang: string; code: string }
  | { type: 'prose'; html: string }

const blocks = computed<MdBlock[]>(() => {
  const source = props.content ?? ''
  const result: MdBlock[] = []
  const fenceRegex = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null = fenceRegex.exec(source)
  while (match !== null) {
    if (match.index > lastIndex) {
      const text = source.slice(lastIndex, match.index).trim()
      if (text) {
        result.push({ type: 'prose', html: formatProseHtml(text) })
      }
    }
    result.push({
      type: 'code',
      lang: match[1] || '',
      code: match[2].replace(/\n$/, '')
    })
    lastIndex = fenceRegex.lastIndex
    match = fenceRegex.exec(source)
  }
  if (lastIndex < source.length) {
    const tail = source.slice(lastIndex).trim()
    if (tail) {
      result.push({ type: 'prose', html: formatProseHtml(tail) })
    }
  }
  if (result.length === 0) {
    result.push({ type: 'prose', html: '' })
  }
  return result
})

async function copyCode(code: string, idx: number) {
  try {
    await navigator.clipboard.writeText(code)
    copiedIdx.value = idx
    setTimeout(() => {
      if (copiedIdx.value === idx) copiedIdx.value = null
    }, 1500)
  } catch {
    // ignore clipboard error
  }
}
</script>
