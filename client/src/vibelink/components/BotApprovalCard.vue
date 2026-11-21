<template>
  <div class="rounded-10px border border-[#4b3e28] bg-[#221d15] p-3 text-[#f3e8d6] min-w-240px max-w-440px space-y-2">
    <div class="flex items-center justify-between gap-2">
      <span class="text-12px font-semibold text-[#fbbf24]">
        审批请求 · {{ requestKind }}
      </span>
      <span
        class="text-11px px-2 py-0.5 rounded-full"
        :class="
          status === 'approved'
            ? 'bg-[#14532d] text-[#86efac]'
            : status === 'rejected'
              ? 'bg-[#7f1d1d] text-[#fca5a5]'
              : 'bg-[#451a03] text-[#fcd34d]'
        ">
        {{ statusLabel }}
      </span>
    </div>
    <div class="text-13px text-[#f5efe6] whitespace-pre-wrap leading-snug">{{ message.content }}</div>
    <div v-if="status === 'pending'" class="flex items-center gap-2 pt-1">
      <button
        type="button"
        :disabled="submitting || !approvalId"
        class="px-3 py-1 rounded-6px border-0 cursor-pointer bg-[#13987f] hover:bg-[#17ad91] disabled:opacity-50 text-white text-12px font-medium"
        @click="submitDecision('approved')">
        批准执行
      </button>
      <button
        type="button"
        :disabled="submitting || !approvalId"
        class="px-3 py-1 rounded-6px border border-[#5c4848] cursor-pointer bg-[#3b1d1d] hover:bg-[#4c2424] disabled:opacity-50 text-[#fecaca] text-12px font-medium"
        @click="submitDecision('rejected')">
        拒绝
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { VlMessage } from '../types'

const props = defineProps<{
  message: VlMessage
}>()

const emit = defineEmits<{
  respond: [payload: { approvalId: string; decision: 'approved' | 'rejected' }]
}>()

const submitting = ref(false)

const approvalId = computed(() =>
  typeof props.message.metadata?.approvalId === 'string' ? props.message.metadata.approvalId : ''
)
const requestKind = computed(() => String(props.message.metadata?.requestKind ?? 'tool'))
const status = computed(() => String(props.message.metadata?.status ?? 'pending'))

const statusLabel = computed(() => {
  if (status.value === 'approved') return '已批准'
  if (status.value === 'rejected') return '已拒绝'
  return '待审批'
})

function submitDecision(decision: 'approved' | 'rejected') {
  if (!approvalId.value || submitting.value) return
  submitting.value = true
  emit('respond', { approvalId: approvalId.value, decision })
  setTimeout(() => {
    submitting.value = false
  }, 500)
}
</script>
