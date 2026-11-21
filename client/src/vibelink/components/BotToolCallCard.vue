<template>
  <div class="rounded-8px border border-[#3a3f42] bg-[#191c1e] text-[#e5e7eb] overflow-hidden min-w-220px max-w-480px">
    <div
      class="flex items-center justify-between gap-2 px-3 py-1.5 cursor-pointer select-none hover:bg-[#22272a]"
      @click="expanded = !expanded">
      <div class="flex items-center gap-2 min-w-0">
        <span class="inline-block w-2 h-2 rounded-full shrink-0" :class="statusDotClass"></span>
        <span class="text-12px font-mono truncate text-[#d1fae5]">{{ message.content }}</span>
      </div>
      <div class="flex items-center gap-2 shrink-0 text-11px text-[#9ca3af]">
        <span>{{ statusText }}</span>
        <span>{{ expanded ? '▾' : '▸' }}</span>
      </div>
    </div>
    <div v-if="expanded" class="border-t border-[#2d3235] bg-[#121415] p-2.5 text-12px font-mono space-y-1">
      <div v-if="exitCode !== undefined" class="text-11px text-[#9ca3af]">
        Exit code: <span :class="exitCode === 0 ? 'text-[#34d399]' : 'text-[#f87171]'">{{ exitCode }}</span>
      </div>
      <pre v-if="outputText" class="m-0 whitespace-pre-wrap break-all text-[#cbd5e1] max-h-180px overflow-y-auto">{{ outputText }}</pre>
      <div v-else class="text-[#767676] italic">暂无标准输出</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { VlMessage } from '../types'

const props = defineProps<{
  message: VlMessage
}>()

const expanded = ref(false)

const statusRaw = computed(() => String(props.message.metadata?.status ?? 'completed'))
const outputText = computed(() =>
  typeof props.message.metadata?.output === 'string' ? props.message.metadata.output : ''
)
const exitCode = computed(() =>
  typeof props.message.metadata?.exitCode === 'number' ? props.message.metadata.exitCode : undefined
)

const statusDotClass = computed(() => {
  switch (statusRaw.value) {
    case 'running':
    case 'in_progress':
      return 'bg-[#f59e0b] animate-pulse'
    case 'failed':
    case 'error':
      return 'bg-[#ef4444]'
    default:
      return 'bg-[#10b981]'
  }
})

const statusText = computed(() => {
  switch (statusRaw.value) {
    case 'running':
    case 'in_progress':
      return '执行中'
    case 'failed':
    case 'error':
      return '失败'
    default:
      return '已完成'
  }
})
</script>
