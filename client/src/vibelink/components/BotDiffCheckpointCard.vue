<template>
  <div class="rounded-10px border border-[#334440] bg-[#192220] p-3 text-[#e2ece9] min-w-240px max-w-520px space-y-2">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <span class="px-1.5 py-0.5 rounded bg-[#13987f]/25 text-[#5eead4] text-11px font-mono shrink-0">
          {{ kindLabel }}
        </span>
        <span class="text-12.5px font-medium truncate">{{ message.content }}</span>
      </div>
      <button
        v-if="checkpointId"
        type="button"
        class="shrink-0 px-2.5 py-1 rounded-6px border border-[#2d5b51] bg-[#1d4940] hover:bg-[#13987f] text-[#ecfdf5] text-11.5px cursor-pointer"
        @click="$emit('rollback', message)">
        回滚至此检查点
      </button>
    </div>

    <pre
      v-if="diffStr"
      class="m-0 p-2 rounded-6px bg-[#111514] text-11.5px font-mono text-[#a7f3d0] overflow-x-auto max-h-180px overflow-y-auto whitespace-pre">{{ diffStr }}</pre>

    <div v-else-if="files.length > 0" class="flex flex-wrap gap-1.5">
      <span
        v-for="(file, i) in files"
        :key="i"
        class="px-2 py-0.5 rounded bg-[#111716] border border-[#2d3b38] text-11px font-mono text-[#cbd5e1]">
        {{ typeof file === 'string' ? file : JSON.stringify(file) }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { VlMessage } from '../types'

const props = defineProps<{
  message: VlMessage
}>()

defineEmits<{
  rollback: [message: VlMessage]
}>()

const kind = computed(() => String(props.message.metadata?.kind ?? 'checkpoint'))
const kindLabel = computed(() => (kind.value === 'file_change' ? 'DIFF' : 'CHECKPOINT'))
const checkpointId = computed(() =>
  typeof props.message.metadata?.checkpointId === 'string' ? props.message.metadata.checkpointId : ''
)
const diffStr = computed(() =>
  typeof props.message.metadata?.diffStr === 'string' ? props.message.metadata.diffStr : ''
)
const files = computed(() =>
  Array.isArray(props.message.metadata?.files) ? (props.message.metadata.files as unknown[]) : []
)
</script>
