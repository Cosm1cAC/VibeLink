<template>
  <MobileScaffold>
    <template #container>
      <div class="flex flex-col overflow-hidden h-full relative">
        <!-- HuLa Mobile NavBar -->
        <NavBar>
          <template #left>
            <div class="flex items-center gap-8px w-full min-w-0">
              <button
                type="button"
                class="p-0 border-0 bg-transparent cursor-pointer shrink-0 flex items-center"
                title="编辑个人头像与名称"
                @click="store.openProfileModal('me')">
                <VlAvatar
                  :avatar="store.me?.avatar ?? 'preset:user'"
                  :name="store.me?.displayName ?? '我'"
                  :size="38" />
              </button>

              <button
                type="button"
                class="flex flex-col justify-center items-start bg-transparent border-0 p-0 min-w-0 cursor-pointer text-left"
                @click="handleStatusTap">
                <span class="text-16px font-bold text-[var(--text-color)] truncate leading-tight max-w-44vw">
                  {{ store.me?.displayName || 'VibeLink' }}
                </span>
                <span class="flex items-center gap-5px text-11px text-[#737373] dark:text-[#9ca3af] mt-2px">
                  <span
                    class="w-7px h-7px rounded-full shrink-0"
                    :class="statusDotClass"></span>
                  <span class="truncate">{{ connectionSummary }}</span>
                </span>
              </button>
            </div>
          </template>

          <template #right>
            <n-dropdown
              trigger="click"
              :show-arrow="true"
              :options="addDropdownOptions"
              @select="handleDropdownSelect">
              <n-button round strong secondary size="small" data-testid="mobile-add-menu-btn">
                <template #icon>
                  <n-icon>
                    <svg><use href="#plus" /></svg>
                  </n-icon>
                </template>
              </n-button>
            </n-dropdown>
          </template>
        </NavBar>

        <!-- Search Input -->
        <div class="px-16px mt-4px shrink-0">
          <div class="py-4px">
            <n-input
              v-model:value="searchText"
              class="rounded-8px w-full text-12px"
              :maxlength="30"
              clearable
              spellcheck="false"
              autocomplete="off"
              placeholder="搜索 Bot 或群聊">
              <template #prefix>
                <svg class="w-14px h-14px text-[#909090]"><use href="#search" /></svg>
              </template>
            </n-input>
          </div>
          <n-divider class="m-0! p-0! mt-8px!" />
        </div>

        <!-- Inline Reconnect Banner when offline with cached rooms -->
        <button
          v-if="!store.connected && store.rooms.length > 0"
          type="button"
          class="mx-16px mt-8px px-12px py-8px rounded-8px bg-[var(--danger-bg)] text-[var(--danger-text)] border-0 flex items-center justify-between gap-2 text-12px cursor-pointer shrink-0"
          @click="$emit('goSettings')">
          <span class="flex items-center gap-6px truncate">
            <svg class="w-15px h-15px shrink-0"><use href="#cloudError" /></svg>
            <span class="truncate">控制面未连接（{{ store.serverUrl }}），点此配对</span>
          </span>
          <span class="font-semibold shrink-0">配对</span>
        </button>

        <!-- Body: Offline Empty State OR Pull-to-Refresh Session List -->
        <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div
            v-if="!store.connected && store.rooms.length === 0"
            class="flex-1 overflow-y-auto px-20px py-28px flex items-center justify-center"
            data-testid="mobile-offline-card">
            <n-card class="rounded-16px max-w-360px w-full" :bordered="false">
              <div class="flex flex-col items-center text-center gap-12px py-8px">
                <div class="w-52px h-52px rounded-full bg-[#13987f]/15 flex items-center justify-center text-[#13987f]">
                  <svg class="w-26px h-26px"><use href="#cloudError" /></svg>
                </div>
                <div class="text-16px font-bold text-[var(--text-color)]">
                  {{ store.connecting ? '正在连接桌面控制面...' : '尚未连接到桌面控制面' }}
                </div>
                <div class="text-12.5px text-[#777] dark:text-[#a3a3a3] leading-relaxed break-all">
                  当前地址：<span class="font-mono">{{ store.serverUrl }}</span>
                  <div v-if="store.lastError" class="mt-4px text-[var(--danger-text)]">
                    {{ store.lastError }}
                  </div>
                  <div v-else class="mt-4px">
                    请确认电脑端已启动 VibeLink Server（--lan / --host 0.0.0.0），然后输入局域网或 Tailscale 地址与 Token 配对。
                  </div>
                </div>
                <div class="flex gap-8px w-full pt-4px">
                  <n-button
                    secondary
                    round
                    class="flex-1"
                    :loading="store.connecting"
                    @click="store.init(true)">
                    重试连接
                  </n-button>
                  <n-button
                    secondary
                    round
                    class="flex-1"
                    data-testid="mobile-offline-scan-btn"
                    @click="$emit('scanQr')">
                    扫一扫配对
                  </n-button>
                  <n-button
                    type="primary"
                    color="#13987f"
                    round
                    class="flex-1"
                    @click="$emit('goSettings')">
                    配对设置
                  </n-button>
                </div>
              </div>
            </n-card>
          </div>

          <van-pull-refresh
            v-else
            v-model="refreshing"
            class="flex-1 min-h-0 flex flex-col"
            :pull-distance="84"
            @refresh="onRefresh">
            <div class="h-full overflow-y-auto overflow-x-hidden" data-testid="mobile-session-list">
              <div
                v-if="filteredRooms.length === 0"
                class="py-48px text-center text-13px text-[#888]">
                没有匹配的 Bot 或群聊会话
              </div>

              <van-swipe-cell
                v-for="room in filteredRooms"
                :key="room.id"
                :class="room.pinned ? 'bg-[#64A29C18]' : ''"
                @open="onSwipeOpen"
                @close="onSwipeClose">
                <div
                  :data-testid="`mobile-session-${room.id}`"
                  class="grid grid-cols-[52px_1fr_max-content] items-center px-16px py-12px gap-12px cursor-pointer active:bg-[var(--bg-msg-hover)]"
                  @click="handleEnterRoom(room.id)">
                  <!-- Avatar + Badge + DM Online Dot -->
                  <div class="relative shrink-0">
                    <n-badge
                      :offset="[-4, 4]"
                      :color="room.muted ? 'grey' : '#c14053'"
                      :value="room.unreadCount"
                      :max="99">
                      <VlAvatar
                        :avatar="roomAvatarProps(room).avatar"
                        :name="roomAvatarProps(room).name"
                        :provider="roomAvatarProps(room).provider"
                        :size="50" />
                    </n-badge>
                    <span
                      v-if="room.kind === 'dm' && dmBot(room)"
                      class="w-11px h-11px rounded-full border-2 border-[var(--center-bg-color)] absolute right-0 bottom-0"
                      :style="{ backgroundColor: presenceColor(dmBot(room)!.presence) }"></span>
                  </div>

                  <!-- Name + Plain-text Last Message Preview -->
                  <div class="min-w-0 flex flex-col gap-5px">
                    <div class="flex items-center gap-6px min-w-0">
                      <span class="text-15.5px font-bold text-[var(--text-color)] truncate">
                        {{ room.name }}
                      </span>
                      <span
                        v-if="room.kind === 'group'"
                        class="px-5px py-1px rounded bg-[#13987f]/18 text-[#13987f] dark:text-[#5eead4] text-10px font-medium shrink-0">
                        群 {{ room.memberCount }}
                      </span>
                    </div>
                    <div class="text-13px text-[#666] dark:text-[#9ca3af] truncate">
                      {{ formatRoomPreview(room) }}
                    </div>
                  </div>

                  <!-- Timestamp + Mute Icon -->
                  <div class="flex flex-col items-end justify-center gap-6px shrink-0">
                    <span class="text-11.5px text-[#888] whitespace-nowrap">
                      {{ formatSmartTime(room.lastMessage?.createdAt ?? room.updatedAt) }}
                    </span>
                    <svg v-if="room.muted" class="w-14px h-14px text-[#888]">
                      <use href="#close-remind" />
                    </svg>
                  </div>
                </div>

                <template #right>
                  <div class="flex h-full">
                    <button
                      type="button"
                      class="h-full w-76px border-0 bg-[#13987f] text-white text-13px cursor-pointer"
                      @click="togglePin(room)">
                      {{ room.pinned ? '取消置顶' : '置顶' }}
                    </button>
                    <button
                      type="button"
                      class="h-full w-76px border-0 text-white text-13px cursor-pointer"
                      :class="room.muted ? 'bg-[#fbb160]' : 'bg-[#888]'"
                      @click="toggleMute(room)">
                      {{ room.muted ? '取消免打扰' : '免打扰' }}
                    </button>
                  </div>
                </template>
              </van-swipe-cell>
            </div>
          </van-pull-refresh>
        </div>
      </div>
    </template>
  </MobileScaffold>
</template>

<script setup lang="ts">
import { computed, h, ref } from 'vue'
import NavBar from '#/layout/navBar/index.vue'
import MobileScaffold from '#/components/MobileScaffold.vue'
import addFriendIcon from '@/assets/mobile/chat-home/add-friend.webp'
import groupChatIcon from '@/assets/mobile/chat-home/group-chat.webp'
import { presenceColor } from '../avatar'
import VlAvatar from '../components/VlAvatar.vue'
import { useVibeLinkStore } from '../store'
import type { VlAccount, VlRoomSummary } from '../types'
import { formatSmartTime, stripMarkdownPreview } from './mobileFormat'

const emit = defineEmits<{
  enterRoom: [roomId: string]
  goSettings: []
  scanQr: []
  createBot: []
  createGroup: []
}>()

const store = useVibeLinkStore()
const searchText = ref('')
const refreshing = ref(false)
let preventClick: boolean = false

function onSwipeOpen() {
  preventClick = true
}

const statusDotClass = computed(() => {
  if (store.connecting) return 'bg-[#f59e0b]'
  return store.connected ? 'bg-[#22c55e]' : 'bg-[#ef4444]'
})

const connectionSummary = computed(() => {
  if (store.connecting) return '连接控制面中...'
  if (store.connected) {
    const busy = store.bots.filter((b) => b.presence === 'working').length
    return busy > 0 ? `在线 · ${busy} 个 Bot 执行中` : `在线 · ${store.bots.length} 个 Bot 就绪`
  }
  return '未连接 · 点此配对'
})

const filteredRooms = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  if (!q) return store.sortedRooms
  return store.sortedRooms.filter((r) => r.name.toLowerCase().includes(q))
})

function dmBot(room: VlRoomSummary): VlAccount | null {
  if (room.kind !== 'dm') return null
  const member = room.members.find((m) => m.accountId !== 'me')
  return member ? store.accountsById[member.accountId] ?? null : null
}

function roomAvatarProps(room: VlRoomSummary) {
  const bot = dmBot(room)
  if (bot) {
    return { avatar: bot.avatar, name: bot.displayName, provider: bot.provider }
  }
  return { avatar: room.avatar, name: room.name, provider: '' }
}

function formatRoomPreview(room: VlRoomSummary): string {
  const last = room.lastMessage
  if (!last) {
    return stripMarkdownPreview(room.notice) || '暂无消息'
  }
  if (last.recalledAt) {
    const who = store.accountsById[last.senderId]?.displayName ?? last.senderId
    return `${who} 撤回了一条消息`
  }
  const clean = stripMarkdownPreview(last.content)
  if (room.kind === 'group' && last.msgType !== 'system') {
    const who = last.senderId === 'me' ? '我' : store.accountsById[last.senderId]?.displayName ?? last.senderId
    return `${who}: ${clean}`
  }
  return clean || '暂无消息'
}

const renderImgIcon = (src: string) => () =>
  h('img', {
    src,
    style: 'display:block; width: 20px; height: 20px; object-fit: contain;',
    class: 'dark:invert'
  })

const renderSvgIcon = (id: string) => () =>
  h('svg', { class: 'w-18px h-18px' }, [h('use', { href: `#${id}` })])

const addDropdownOptions = [
  { label: '扫一扫配对电脑', key: 'scan-qr', icon: renderSvgIcon('saoma') },
  { label: '发起多 Bot 协作群', key: 'create-group', icon: renderImgIcon(groupChatIcon) },
  { label: '新建 Bot 好友', key: 'create-bot', icon: renderImgIcon(addFriendIcon) },
  { label: '同步 Magpie Agent', key: 'sync-plugins', icon: renderSvgIcon('refresh') },
  { label: '控制面配对设置', key: 'settings', icon: renderSvgIcon('settings') }
]

async function handleDropdownSelect(key: string) {
  if (key === 'scan-qr') emit('scanQr')
  else if (key === 'create-group') emit('createGroup')
  else if (key === 'create-bot') emit('createBot')
  else if (key === 'settings') emit('goSettings')
  else if (key === 'sync-plugins') {
    try {
      await store.syncPlugins()
      window.$message?.success?.(`已同步插件，当前展示 ${store.bots.length} 个 Bot`)
    } catch (err) {
      window.$message?.error?.(`同步失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function handleStatusTap() {
  if (!store.connected) {
    emit('goSettings')
  } else {
    store.openProfileModal('me')
  }
}

function onSwipeClose() {
  setTimeout(() => {
    preventClick = false
  }, 60)
}

function handleEnterRoom(roomId: string) {
  if (preventClick) return
  emit('enterRoom', roomId)
}

async function onRefresh() {
  try {
    await store.bootstrap()
  } catch {
    // store keeps lastError
  } finally {
    refreshing.value = false
  }
}

async function togglePin(room: VlRoomSummary) {
  await store.updateRoomSettings(room.id, { pinned: !room.pinned })
}

async function toggleMute(room: VlRoomSummary) {
  await store.updateRoomSettings(room.id, { muted: !room.muted })
}
</script>
