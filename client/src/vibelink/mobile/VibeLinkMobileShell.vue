<template>
  <div class="vl-root vl-theme-dark vl-mobile-shell" data-testid="vibelink-mobile-shell">
    <!-- Top Header -->
    <header class="vl-m-header">
      <template v-if="mobileTab === 'messages' && inRoomChat && store.activeRoom">
        <button
          type="button"
          class="bg-transparent border-0 text-[#5eead4] text-14px cursor-pointer px-1 shrink-0"
          data-testid="mobile-back-btn"
          @click="inRoomChat = false">
          ‹ 消息
        </button>
        <div class="flex items-center gap-1.5 min-w-0 flex-1 justify-center">
          <span class="text-15px font-semibold text-[#f3f3f3] truncate">{{ store.activeRoom.name }}</span>
          <span v-if="store.activeRoom.kind === 'group'" class="text-11.5px text-[#9ca3af] shrink-0">
            [{{ store.activeRoom.memberCount }}]
          </span>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button
            v-if="activeDmBot"
            type="button"
            class="px-2 py-1 rounded bg-[#1d4940] border-0 text-[#99f6e4] text-11.5px cursor-pointer"
            @click="store.openBotHomeDrawer(activeDmBot.id)">
            Home
          </button>
          <button
            type="button"
            class="px-2 py-1 rounded bg-[#2c2c2c] border-0 text-[#e5e7eb] text-11.5px cursor-pointer"
            @click="membersSheetOpen = true">
            成员
          </button>
        </div>
      </template>

      <template v-else>
        <div class="flex items-center gap-2">
          <span
            class="w-2.5 h-2.5 rounded-full"
            :class="store.connected ? 'bg-[#22c55e]' : 'bg-[#ef4444]'"></span>
          <span class="text-15px font-semibold text-[#f3f3f3]">{{ mobileTitle }}</span>
        </div>
        <button
          v-if="mobileTab === 'messages'"
          type="button"
          class="px-2.5 py-1 rounded-6px bg-[#1d4940] border-0 text-[#99f6e4] text-12px cursor-pointer"
          @click="mobileTab = 'settings'">
          {{ store.connected ? '已配对' : '配对设置' }}
        </button>
      </template>
    </header>

    <!-- Body View -->
    <main class="flex-1 min-h-0 flex flex-col overflow-hidden">
      <!-- 1A: Room List -->
      <div
        v-if="mobileTab === 'messages' && !inRoomChat"
        class="flex-1 vl-scroll divide-y divide-[#2a2a2a]"
        data-testid="mobile-session-list">
        <div class="p-2.5 bg-[#1e1e1e]">
          <input
            v-model="searchText"
            type="text"
            placeholder="搜索 Bot 或群聊..."
            class="w-full box-border px-3 py-2 rounded-8px bg-[#2a2a2a] border border-[#353535] text-13px text-[#eaeaea] outline-none" />
        </div>

        <button
          v-for="room in filteredRooms"
          :key="room.id"
          type="button"
          :data-testid="`mobile-session-${room.id}`"
          class="w-full text-left flex items-center gap-3 px-3.5 py-3 bg-[#1e1e1e] active:bg-[#273734] border-0 cursor-pointer"
          @click="enterMobileRoom(room.id)">
          <VlAvatar
            :avatar="roomAvatarProps(room).avatar"
            :name="roomAvatarProps(room).name"
            :provider="roomAvatarProps(room).provider"
            :size="42"
            :shape="room.kind === 'group' ? 'rounded' : 'circle'" />
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="text-14px font-medium text-[#f0f0f0] truncate">{{ room.name }}</span>
              <span class="text-11px text-[#737373] shrink-0">
                {{ formatClockTime(room.lastMessage?.createdAt ?? room.updatedAt) }}
              </span>
            </div>
            <div class="flex items-center justify-between gap-2 mt-1">
              <span class="text-12px text-[#8e9297] truncate">
                {{ room.lastMessage?.content || room.notice || '暂无消息' }}
              </span>
              <span
                v-if="room.unreadCount > 0"
                class="px-1.5 min-w-18px h-18px rounded-full bg-[#c14053] text-white text-10.5px flex items-center justify-center shrink-0">
                {{ room.unreadCount }}
              </span>
            </div>
          </div>
        </button>
      </div>

      <!-- 1B: Active Mobile Room Chat -->
      <div
        v-else-if="mobileTab === 'messages' && inRoomChat && store.activeRoom"
        class="flex-1 min-h-0 flex flex-col bg-[#2a2a2a]"
        data-testid="mobile-chat-room">
        <div
          v-if="store.activeRoom.kind === 'group' && store.activeRoom.notice"
          class="px-3 py-1.5 bg-[#242424] border-b border-[#323232] flex items-center justify-between gap-2 text-12px">
          <span class="truncate text-[#d4d4d4]">📢 {{ store.activeRoom.notice }}</span>
          <button
            type="button"
            class="shrink-0 bg-transparent border-0 text-[#5eead4] text-11.5px cursor-pointer"
            @click="openNoticeEdit">
            查看
          </button>
        </div>

        <div ref="msgScrollRef" class="flex-1 vl-scroll px-3 py-3 space-y-3">
          <template v-for="msg in store.activeMessages" :key="msg.id">
            <div v-if="msg.recalledAt" class="text-center">
              <span class="px-2.5 py-0.5 rounded-full bg-[#242424] text-11px text-[#888]">
                {{ senderName(msg.senderId) }} 撤回了一条消息
              </span>
            </div>
            <div v-else-if="msg.msgType === 'system'" class="flex justify-center">
              <span class="px-3 py-1 rounded-full bg-[#3e362e] text-[#dfd0bf] text-11.5px text-center">
                {{ msg.content }}
              </span>
            </div>
            <div v-else-if="msg.senderId === 'me'" class="flex justify-end">
              <div class="max-w-82% rounded-12px rounded-tr-3px px-3 py-2 bg-[#1d4940] text-[#eef7f5]">
                <BotMarkdownMessage :content="msg.content" :server-url="store.serverUrl" />
              </div>
            </div>
            <div v-else class="flex items-start gap-2">
              <button
                type="button"
                class="p-0 border-0 bg-transparent rounded-full cursor-pointer shrink-0 mt-1"
                title="编辑 Bot 名字与头像"
                @click="store.openProfileModal(msg.senderId)">
                <VlAvatar
                  :avatar="senderAvatarProps(msg.senderId).avatar"
                  :name="senderAvatarProps(msg.senderId).name"
                  :provider="senderAvatarProps(msg.senderId).provider"
                  :size="30" />
              </button>
              <div class="max-w-82% min-w-0 space-y-1">
                <div class="text-11px text-[#a3a3a3]">
                  {{ senderName(msg.senderId) }}
                  <span v-if="senderHandle(msg.senderId)" class="text-[#5eead4] ml-1">@{{ senderHandle(msg.senderId) }}</span>
                </div>
                <BotToolCallCard v-if="msg.msgType === 'bot_tool_call'" :message="msg" />
                <BotApprovalCard
                  v-else-if="msg.msgType === 'bot_approval'"
                  :message="msg"
                  @respond="handleApproval" />
                <BotDiffCheckpointCard
                  v-else-if="msg.msgType === 'bot_diff_checkpoint'"
                  :message="msg"
                  @rollback="handleRollback" />
                <div v-else class="rounded-12px rounded-tl-3px px-3 py-2 bg-[#1e1e1e] border border-[#303030] text-[#eaeaea]">
                  <BotMarkdownMessage :content="msg.content" :server-url="store.serverUrl" />
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- Quick @Bot Chips -->
        <div
          v-if="store.activeRoomBots.length > 0"
          class="px-2.5 py-1.5 bg-[#232323] border-t border-[#323232] flex items-center gap-1.5 overflow-x-auto">
          <button
            v-for="b in store.activeRoomBots"
            :key="b.id"
            type="button"
            class="shrink-0 px-2 py-0.5 rounded-full bg-[#1d3933] border border-[#2c574d] text-[#99f6e4] text-11px cursor-pointer"
            @click="appendMention(b.handle)">
            @{{ b.handle }}
          </button>
          <button
            v-if="store.isActiveRoomBusy"
            type="button"
            class="shrink-0 px-2.5 py-0.5 rounded-full bg-[#5b1d1d] border-0 text-[#fecaca] text-11px cursor-pointer ml-auto"
            @click="store.interruptActiveRoom()">
            ■ 中断
          </button>
        </div>

        <!-- Mobile Composer -->
        <div class="px-2.5 py-2 bg-[#1e1e1e] border-t border-[#323232] flex items-end gap-2">
          <button
            type="button"
            class="w-36px h-36px rounded-8px bg-[#2b2b2b] border-0 text-[#a3a3a3] hover:text-[#13987f] cursor-pointer shrink-0 flex items-center justify-center"
            title="发送文件或图片"
            aria-label="发送附件"
            @click="fileInputRef?.click()">
            <svg viewBox="0 0 24 24" class="w-18px h-18px" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <input ref="fileInputRef" type="file" class="hidden" @change="handleFileUpload" />

          <textarea
            v-model="mobileDraft"
            rows="1"
            placeholder="发消息或点击上方 @Bot..."
            data-testid="mobile-composer-input"
            class="flex-1 box-border px-3 py-2 rounded-8px bg-[#2a2a2a] border border-[#383838] text-13.5px leading-5 text-[#f0f0f0] outline-none resize-none overflow-hidden max-h-96px"
            @keydown.enter.exact.prevent="sendMobileMessage"></textarea>

          <button
            type="button"
            data-testid="mobile-send-btn"
            :disabled="!mobileDraft.trim() || sending"
            class="px-3.5 py-2 rounded-8px bg-[#13987f] disabled:opacity-50 border-0 text-white text-13px font-medium cursor-pointer shrink-0"
            @click="sendMobileMessage">
            发送
          </button>
        </div>
      </div>

      <!-- 2: Bot Fleet Tab -->
      <div v-else-if="mobileTab === 'bots'" class="flex-1 vl-scroll p-3 space-y-2.5" data-testid="mobile-bots-view">
        <div
          v-for="bot in store.bots"
          :key="bot.id"
          class="rounded-10px bg-[#1e1e1e] border border-[#303030] p-3 space-y-2">
          <div class="flex items-center gap-2.5">
            <button
              type="button"
              class="p-0 border-0 bg-transparent rounded-full cursor-pointer shrink-0"
              title="编辑名字与头像"
              @click="store.openProfileModal(bot.id)">
              <VlAvatar
                :avatar="bot.avatar"
                :name="bot.displayName"
                :provider="bot.provider"
                :size="38" />
            </button>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="text-14px font-semibold text-[#f0f0f0]">{{ bot.displayName }}</span>
                <span class="px-1.5 py-0.2 rounded bg-[#1d4940] text-[#5eead4] text-11px">@{{ bot.handle }}</span>
              </div>
              <div class="text-11.5px text-[#8e9297] truncate">{{ bot.provider }} · {{ bot.roleTitle }}</div>
            </div>
            <span
              class="w-2.5 h-2.5 rounded-full shrink-0"
              :style="{ backgroundColor: presenceColor(bot.presence) }"></span>
          </div>
          <div class="flex gap-2">
            <button
              type="button"
              class="flex-1 py-1.5 rounded-7px bg-[#13987f] border-0 text-white text-12px cursor-pointer"
              @click="openMobileBotDm(bot.id)">
              私聊对话
            </button>
            <button
              type="button"
              class="flex-1 py-1.5 rounded-7px bg-[#2a2a2a] border border-[#3a3a3a] text-[#e5e7eb] text-12px cursor-pointer"
              @click="store.openBotHomeDrawer(bot.id)">
              编辑 Bot Home
            </button>
          </div>
        </div>
      </div>

      <!-- 3: Terminal Tab -->
      <div v-else-if="mobileTab === 'terminal'" class="flex-1 min-h-0" data-testid="mobile-terminal-view">
        <BotTerminalPane :room-id="store.activeRoomId" :bot-id="activeDmBot?.id ?? null" />
      </div>

      <!-- 4: LAN Pairing & Settings Tab -->
      <div v-else class="flex-1 vl-scroll p-4 space-y-4" data-testid="mobile-settings-view">
        <div class="rounded-10px bg-[#1e1e1e] border border-[#323232] p-3.5 space-y-3">
          <div class="text-14px font-semibold text-[#eaeaea]">连接桌面控制面 (LAN / Tailscale)</div>
          <label class="block space-y-1 text-12px">
            <span class="text-[#9ca3af]">控制面 Server URL</span>
            <input
              v-model="pairUrl"
              type="text"
              placeholder="http://192.168.x.x:18990"
              class="w-full box-border px-3 py-2 rounded-7px bg-[#141616] border border-[#383d3c] text-[#eaeaea] font-mono text-12.5px outline-none" />
          </label>
          <label class="block space-y-1 text-12px">
            <span class="text-[#9ca3af]">Bearer Token</span>
            <input
              v-model="pairToken"
              type="password"
              placeholder="从 ~/.vibelink/auth-token.txt 复制"
              class="w-full box-border px-3 py-2 rounded-7px bg-[#141616] border border-[#383d3c] text-[#eaeaea] font-mono text-12.5px outline-none" />
          </label>
          <div v-if="pairMsg" class="text-12px text-[#5eead4]">{{ pairMsg }}</div>
          <div class="flex gap-2">
            <button
              type="button"
              class="flex-1 py-2 rounded-7px bg-[#2a2f2e] border-0 text-[#e5e7eb] text-12.5px cursor-pointer"
              @click="testMobilePair">
              测试连通
            </button>
            <button
              type="button"
              class="flex-1 py-2 rounded-7px bg-[#13987f] border-0 text-white text-12.5px font-medium cursor-pointer"
              @click="saveMobilePair">
              保存配对
            </button>
          </div>
        </div>

        <div class="rounded-10px bg-[#1e1e1e] border border-[#323232] p-3.5 text-12px text-[#9ca3af] space-y-1">
          <div>当前状态：{{ store.connected ? 'WebSocket 实时同步中' : '未连接' }}</div>
          <div>Bot 总数：{{ store.bots.length }} · 会话数：{{ store.rooms.length }}</div>
          <div>Mock 模式：{{ store.mockBots ? '已启用' : '真实调度' }}</div>
        </div>
      </div>
    </main>

    <!-- Bottom Tab Bar -->
    <nav v-if="!inRoomChat || mobileTab !== 'messages'" class="vl-m-tabbar" data-testid="mobile-tabbar">
      <button
        type="button"
        class="vl-m-tab"
        :class="{ active: mobileTab === 'messages' }"
        @click="mobileTab = 'messages'">
        <span>💬 消息</span>
        <span v-if="store.totalUnreadCount > 0" class="ml-1 px-1.5 rounded-full bg-[#c14053] text-white text-10px">
          {{ store.totalUnreadCount }}
        </span>
      </button>
      <button
        type="button"
        class="vl-m-tab"
        :class="{ active: mobileTab === 'bots' }"
        @click="mobileTab = 'bots'">
        🤖 Bot
      </button>
      <button
        type="button"
        class="vl-m-tab"
        :class="{ active: mobileTab === 'terminal' }"
        @click="mobileTab = 'terminal'">
        ⌨️ 终端
      </button>
      <button
        type="button"
        class="vl-m-tab"
        :class="{ active: mobileTab === 'settings' }"
        @click="mobileTab = 'settings'">
        🔗 配对
      </button>
    </nav>

    <!-- Group Members Sheet -->
    <div
      v-if="membersSheetOpen && store.activeRoom"
      class="fixed inset-0 z-40 bg-black/60 flex items-end"
      @click.self="membersSheetOpen = false">
      <div class="w-full max-h-70vh bg-[#1e1e1e] rounded-t-14px border-t border-[#343434] p-4 flex flex-col gap-2">
        <div class="flex items-center justify-between text-14px font-semibold text-[#eaeaea]">
          <span>群成员 ({{ store.activeRoom.memberCount }})</span>
          <button type="button" class="bg-transparent border-0 text-[#9ca3af] cursor-pointer" @click="membersSheetOpen = false">关闭</button>
        </div>
        <div class="flex-1 vl-scroll space-y-1.5">
          <div
            v-for="m in store.activeRoomMembers"
            :key="m.account.id"
            class="flex items-center justify-between px-2 py-1.5 rounded bg-[#252525]">
            <div>
              <span class="text-13px text-[#f0f0f0]">{{ m.account.displayName }}</span>
              <span class="ml-1.5 text-11px text-[#5eead4]">@{{ m.account.handle }}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <button
                v-if="m.account.kind === 'bot'"
                type="button"
                class="px-2 py-0.5 rounded bg-[#2b2f2e] border-0 text-[#cbd5e1] text-11px cursor-pointer"
                @click="openMobileEditProfile(m.account.id)">
                改资料
              </button>
              <button
                v-if="m.account.kind === 'bot'"
                type="button"
                class="px-2 py-0.5 rounded bg-[#1d4940] border-0 text-[#99f6e4] text-11px cursor-pointer"
                @click="openMobileBotHome(m.account.id)">
                Bot Home
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <AccountProfileModal
      :account-id="store.profileModalAccountId"
      @close="store.closeProfileModal()"
      @open-bot-home="store.openBotHomeDrawer($event)" />
    <BotHomeDrawer :bot-id="store.botHomeDrawerBotId" @close="store.closeBotHomeDrawer()" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { presenceColor } from '../avatar'
import { hideMobileSplashSafe } from '../runtime'
import { useVibeLinkStore } from '../store'
import type { VlMessage, VlRoomSummary } from '../types'
import '../vibelink.scss'
import AccountProfileModal from '../components/AccountProfileModal.vue'
import BotApprovalCard from '../components/BotApprovalCard.vue'
import BotDiffCheckpointCard from '../components/BotDiffCheckpointCard.vue'
import BotHomeDrawer from '../components/BotHomeDrawer.vue'
import BotMarkdownMessage from '../components/BotMarkdownMessage.vue'
import BotTerminalPane from '../components/BotTerminalPane.vue'
import BotToolCallCard from '../components/BotToolCallCard.vue'
import VlAvatar from '../components/VlAvatar.vue'

type MobileTab = 'messages' | 'bots' | 'terminal' | 'settings'

const store = useVibeLinkStore()
const route = useRoute()

const mobileTab = ref<MobileTab>('messages')
const inRoomChat = ref(false)
const searchText = ref('')
const mobileDraft = ref('')
const sending = ref(false)
const membersSheetOpen = ref(false)
const msgScrollRef = ref<HTMLElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)

const pairUrl = ref(store.serverUrl)
const pairToken = ref(store.authToken)
const pairMsg = ref('')

const mobileTitle = computed(() => {
  switch (mobileTab.value) {
    case 'bots':
      return 'Bot 好友'
    case 'terminal':
      return '工作区终端'
    case 'settings':
      return '控制面配对'
    default:
      return 'VibeLink'
  }
})

const filteredRooms = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  if (!q) return store.sortedRooms
  return store.sortedRooms.filter((r) => r.name.toLowerCase().includes(q))
})

const activeDmBot = computed(() => {
  if (!store.activeRoom || store.activeRoom.kind !== 'dm') return null
  const m = store.activeRoom.members.find((x) => x.accountId !== 'me')
  return m ? store.accountsById[m.accountId] ?? null : null
})

function roomAvatarProps(room: VlRoomSummary) {
  if (room.kind === 'dm') {
    const member = room.members.find((x) => x.accountId !== 'me')
    const bot = member ? store.accountsById[member.accountId] : null
    if (bot) {
      return { avatar: bot.avatar, name: bot.displayName, provider: bot.provider }
    }
  }
  return { avatar: room.avatar, name: room.name, provider: '' }
}

function senderName(senderId: string) {
  return store.accountsById[senderId]?.displayName ?? senderId
}

function senderHandle(senderId: string) {
  return store.accountsById[senderId]?.handle ?? ''
}

function senderAvatarProps(senderId: string) {
  const acc = store.accountsById[senderId]
  return {
    avatar: acc?.avatar ?? '',
    name: acc?.displayName ?? senderId,
    provider: acc?.provider ?? ''
  }
}

function formatClockTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function enterMobileRoom(roomId: string) {
  await store.selectRoom(roomId)
  inRoomChat.value = true
  scrollBottom()
}

function appendMention(handle: string) {
  mobileDraft.value = `${mobileDraft.value}${mobileDraft.value && !mobileDraft.value.endsWith(' ') ? ' ' : ''}@${handle} `
}

function scrollBottom() {
  void nextTick(() => {
    const el = msgScrollRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

async function sendMobileMessage() {
  if (!store.activeRoomId || !mobileDraft.value.trim() || sending.value) return
  sending.value = true
  const content = mobileDraft.value.trim()
  mobileDraft.value = ''
  try {
    await store.sendMessage(store.activeRoomId, content)
    scrollBottom()
  } catch {
    mobileDraft.value = content
  } finally {
    sending.value = false
  }
}

async function handleFileUpload(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !store.activeRoomId) return
  await store.uploadAndSendFile(store.activeRoomId, file)
  scrollBottom()
}

async function openMobileBotDm(botId: string) {
  await store.openDmWithBot(botId)
  mobileTab.value = 'messages'
  inRoomChat.value = true
}

function openMobileBotHome(botId: string) {
  membersSheetOpen.value = false
  store.openBotHomeDrawer(botId)
}

function openMobileEditProfile(accountId: string) {
  membersSheetOpen.value = false
  store.openProfileModal(accountId)
}

function openNoticeEdit() {
  if (!store.activeRoom) return
  const edited = window.prompt('查看或编辑群公告：', store.activeRoom.notice ?? '')
  if (edited !== null) {
    void store.updateRoomNotice(store.activeRoom.id, edited.trim())
  }
}

async function handleApproval(payload: { approvalId: string; decision: 'approved' | 'rejected' }) {
  await store.respondApproval(payload.approvalId, payload.decision)
}

async function handleRollback(msg: VlMessage) {
  if (!store.activeRoomId) return
  await store.rollbackCheckpoint(store.activeRoomId, { messageId: msg.id })
}

async function testMobilePair() {
  pairMsg.value = ''
  try {
    const h = await store.testConnection(pairUrl.value, pairToken.value)
    pairMsg.value = `连接成功：${h.botsCount} Bots, ${h.roomsCount} 会话`
  } catch (err) {
    pairMsg.value = `连接失败：${err instanceof Error ? err.message : String(err)}`
  }
}

async function saveMobilePair() {
  pairMsg.value = ''
  try {
    await store.reconnect(pairUrl.value, pairToken.value)
    pairMsg.value = '配对成功，会话已同步'
    mobileTab.value = 'messages'
  } catch (err) {
    pairMsg.value = `配对失败：${err instanceof Error ? err.message : String(err)}`
  }
}

onMounted(async () => {
  void hideMobileSplashSafe()
  await store.init()
  pairUrl.value = store.serverUrl
  pairToken.value = store.authToken
  if (route.path.startsWith('/mobile/bots')) mobileTab.value = 'bots'
  else if (route.path.startsWith('/mobile/terminal')) mobileTab.value = 'terminal'
  else if (route.path.startsWith('/mobile/settings')) mobileTab.value = 'settings'
  const roomParam = typeof route.params.roomId === 'string' ? route.params.roomId : ''
  if (roomParam) {
    await enterMobileRoom(roomParam)
  }
})

watch(
  () => store.activeMessages.length,
  () => {
    if (inRoomChat.value) scrollBottom()
  }
)
</script>

<style scoped>
.vl-mobile-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 100vw;
  box-sizing: border-box;
  height: 100vh;
  overflow: hidden;
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  background: #1e1e1e;
}

.vl-m-header {
  height: 48px;
  flex-shrink: 0;
  padding: 0 12px;
  background: #233b37;
  border-bottom: 1px solid #1b2f2c;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.vl-m-tabbar {
  height: 52px;
  flex-shrink: 0;
  background: #1a1c1c;
  border-top: 1px solid #2d3030;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
}

.vl-m-tab {
  border: 0;
  background: transparent;
  color: #8f9695;
  font-size: 12.5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.vl-m-tab.active {
  color: #5eead4;
  font-weight: 600;
}
</style>
