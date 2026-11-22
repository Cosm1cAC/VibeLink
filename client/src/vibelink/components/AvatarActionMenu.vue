<template>
  <div
    v-if="account && anchor"
    class="fixed inset-0 z-50"
    data-testid="avatar-action-backdrop"
    @click="$emit('close')"
    @contextmenu.prevent="$emit('close')">
    <div
      class="fixed w-196px rounded-10px bg-[#242626] border border-[#3a3d3d] shadow-2xl py-1.5 text-13px text-[#eaeaea]"
      :style="menuStyle"
      data-testid="avatar-action-menu"
      @click.stop>
      <div class="flex items-center gap-2 px-3 py-2 border-b border-[#323535] mb-1">
        <VlAvatar
          :avatar="account.avatar"
          :name="account.displayName"
          :provider="account.provider"
          :size="30" />
        <div class="min-w-0 flex-1">
          <div class="text-12.5px font-semibold truncate text-[#f3f3f3]">{{ account.displayName }}</div>
          <div class="text-11px text-[#5eead4] truncate">@{{ account.handle }}</div>
        </div>
      </div>

      <template v-if="account.id !== 'me'">
        <button
          type="button"
          class="vl-ctx-item"
          data-testid="avatar-menu-dm"
          @click="handleAction('dm')">
          <svg viewBox="0 0 24 24" class="w-15px h-15px shrink-0" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          <span>发送消息</span>
        </button>

        <button
          type="button"
          class="vl-ctx-item"
          data-testid="avatar-menu-poke"
          @click="handleAction('poke')">
          <svg viewBox="0 0 24 24" class="w-15px h-15px shrink-0" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v6M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8" stroke-linecap="round" />
            <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.7-2.7L3.4 14a2 2 0 0 1 3-2.5L8 13" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ inGroup ? '戳一戳 / @提及' : '戳一戳' }}</span>
        </button>

        <button
          type="button"
          class="vl-ctx-item"
          data-testid="avatar-menu-profile"
          @click="handleAction('viewProfile')">
          <svg viewBox="0 0 24 24" class="w-15px h-15px shrink-0" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="4" y="3" width="16" height="18" rx="2" />
            <path d="M8 8h8M8 12h8M8 16h5" stroke-linecap="round" />
          </svg>
          <span>查看资料 / Bot Home</span>
        </button>
      </template>

      <button
        type="button"
        class="vl-ctx-item"
        data-testid="avatar-menu-edit-profile"
        @click="handleAction('editProfile')">
        <svg viewBox="0 0 24 24" class="w-15px h-15px shrink-0" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M12 20h9" stroke-linecap="round" />
          <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" stroke-linejoin="round" />
        </svg>
        <span>{{ account.id === 'me' ? '编辑个人资料与头像' : '编辑名字与头像' }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import type { VlAccount } from '../types'
import VlAvatar from './VlAvatar.vue'

const props = defineProps<{
  account: VlAccount | null
  anchor: { x: number; y: number } | null
  inGroup?: boolean
}>()

const emit = defineEmits<{
  close: []
  dm: [account: VlAccount]
  poke: [account: VlAccount]
  viewProfile: [account: VlAccount]
  editProfile: [account: VlAccount]
}>()

const menuStyle = computed(() => {
  const x = props.anchor?.x ?? 120
  const y = props.anchor?.y ?? 120
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 820
  const left = Math.max(8, Math.min(x, vw - 208))
  const top = Math.max(8, Math.min(y, vh - 220))
  return {
    left: `${left}px`,
    top: `${top}px`
  }
})

function handleAction(action: 'dm' | 'poke' | 'viewProfile' | 'editProfile') {
  if (!props.account) return
  const acc = props.account
  emit('close')
  if (action === 'dm') emit('dm', acc)
  else if (action === 'poke') emit('poke', acc)
  else if (action === 'viewProfile') emit('viewProfile', acc)
  else emit('editProfile', acc)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.account) {
    emit('close')
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.vl-ctx-item {
  width: 100%;
  border: 0;
  background: transparent;
  color: #e5e5e5;
  padding: 8px 12px;
  font-size: 12.5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 9px;
  text-align: left;
}

.vl-ctx-item:hover {
  background: #1d4940;
  color: #ffffff;
}
</style>
