<template>
  <n-divider class="p-0! m-0!" />
  <nav
    class="vl-hula-tabbar flex justify-around items-center pt-8px pb-6px bg-[var(--center-bg-color)]/92"
    data-testid="mobile-tabbar">
    <button
      v-for="item in navItems"
      :key="item.id"
      type="button"
      class="flex flex-col flex-1 items-center justify-center bg-transparent border-0 cursor-pointer p-0 relative"
      :class="activeTab === item.id ? 'text-[#13987f]' : 'text-[#555] dark:text-white/75'"
      :data-testid="`mobile-tab-${item.id}`"
      @click="$emit('select', item.id)">
      <n-badge
        v-if="item.id === 'messages'"
        class="flex flex-col items-center relative"
        :offset="[4, 2]"
        color="#c14053"
        :value="store.totalUnreadCount"
        :max="99">
        <svg class="w-22px h-22px">
          <use :href="`#${activeTab === item.id ? item.actionIcon : item.icon}`" />
        </svg>
        <span class="text-11px mt-3px font-medium">{{ item.label }}</span>
      </n-badge>

      <div v-else class="flex flex-col items-center relative">
        <svg class="w-22px h-22px">
          <use :href="`#${activeTab === item.id ? item.actionIcon : item.icon}`" />
        </svg>
        <span
          v-if="item.id === 'settings' && (!store.connected || store.wproxyStatus?.running)"
          class="w-7px h-7px rounded-full absolute -right-4px top-0 border border-[var(--center-bg-color)]"
          :class="!store.connected ? 'bg-[#ef4444]' : 'bg-[#22c55e]'"></span>
        <span class="text-11px mt-3px font-medium">{{ item.label }}</span>
      </div>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { useVibeLinkStore } from '../store'

export type VlMobileTab = 'messages' | 'bots' | 'terminal' | 'settings'

defineProps<{
  activeTab: VlMobileTab
}>()

defineEmits<{
  select: [tab: VlMobileTab]
}>()

const store = useVibeLinkStore()

const navItems: Array<{ id: VlMobileTab; label: string; icon: string; actionIcon: string }> = [
  { id: 'messages', label: '消息', icon: 'message', actionIcon: 'message-action' },
  { id: 'bots', label: '联系人', icon: 'avatar', actionIcon: 'avatar-action' },
  { id: 'terminal', label: '终端', icon: 'diannao', actionIcon: 'diannao' },
  { id: 'settings', label: '我的', icon: 'wode', actionIcon: 'wode-action' }
]
</script>

<style scoped lang="scss">
.vl-hula-tabbar {
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}
</style>
