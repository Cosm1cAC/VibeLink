<template>
  <MobileScaffold :safe-area="false">
    <!-- Top HuLa HeaderBar -->
    <template #header>
      <header
        class="w-full box-border h-[calc(52px+var(--safe-area-inset-top))] pt-[var(--safe-area-inset-top)] px-12px grid grid-cols-[84px_1fr_84px] items-center bg-[var(--center-bg-color)]/95 border-b border-[var(--line-color)] backdrop-blur-md z-20">
        <!-- Back + Unread Badge -->
        <div class="flex items-center">
          <button
            type="button"
            class="flex items-center gap-4px bg-transparent border-0 p-4px text-[var(--text-color)] cursor-pointer"
            data-testid="mobile-back-btn"
            aria-label="返回消息列表"
            @click="$emit('back')">
            <svg class="w-22px h-22px"><use href="#fanhui" /></svg>
            <span
              v-if="otherUnreadCount > 0"
              class="rounded-15px bg-[#C7DBD9] dark:bg-[#234740] text-[var(--text-color)] px-7px py-1px text-12px font-medium leading-tight">
              {{ otherUnreadCount > 99 ? '99+' : otherUnreadCount }}
            </span>
          </button>
        </div>

        <!-- Center Room Title + Live Presence -->
        <button
          type="button"
          class="flex flex-col items-center justify-center min-w-0 bg-transparent border-0 p-0 cursor-pointer"
          @click="handleCenterTitleClick">
          <div class="flex items-center gap-4px max-w-full">
            <span class="text-15.5px font-semibold text-[var(--text-color)] truncate">
              {{ room.name }}
            </span>
            <span
              v-if="room.kind === 'group'"
              class="text-12px text-[#888] shrink-0">
              ({{ room.memberCount }})
            </span>
          </div>
          <span class="flex items-center gap-4px text-10.5px text-[#737373] dark:text-[#9ca3af] truncate max-w-full">
            <span
              class="w-6px h-6px rounded-full shrink-0"
              :style="{ backgroundColor: headerPresenceColor }"></span>
            <span class="truncate">{{ headerSubtitle }}</span>
          </span>
        </button>

        <!-- Right Icon-only Controls -->
        <div class="flex items-center justify-end gap-6px">
          <button
            type="button"
            class="p-6px rounded-8px bg-transparent border-0 cursor-pointer flex items-center justify-center"
            :class="roomMode !== 'chat' ? 'text-[#13987f]' : 'text-[var(--icon-color)]'"
            aria-label="终端与Diff"
            @click="toggleWorkspaceMode">
            <svg class="w-21px h-21px"><use href="#diannao" /></svg>
          </button>
          <button
            type="button"
            class="p-6px rounded-8px bg-transparent border-0 text-[var(--icon-color)] cursor-pointer flex items-center justify-center"
            aria-label="聊天设置"
            @click="$emit('openSettings')">
            <svg class="w-21px h-21px"><use href="#more" /></svg>
          </button>
        </div>
      </header>
    </template>

    <!-- Main Container -->
    <template #container>
      <div class="h-full w-full flex flex-col overflow-hidden bg-[var(--right-theme-bg-color)]" data-testid="mobile-chat-room">
        <!-- Group Announcement Banner (HuLa style) -->
        <div v-if="room.kind === 'group' && room.notice" class="px-12px pt-8px shrink-0">
          <div
            class="flex items-center justify-between gap-8px px-12px py-8px rounded-10px bg-[var(--group-notice-bg)] border border-[var(--line-color)]/60">
            <div class="flex items-center gap-6px min-w-0 flex-1">
              <svg class="w-16px h-16px text-[#13987f] shrink-0"><use href="#Loudspeaker" /></svg>
              <span class="text-12px text-[var(--chat-text-color)] truncate">{{ room.notice }}</span>
            </div>
            <button
              type="button"
              class="bg-transparent border-0 p-0 text-12px text-[#13987f] cursor-pointer shrink-0 font-medium"
              @click="openNoticeModal">
              查看全部
            </button>
          </div>
        </div>

        <!-- Inline Workspace Switcher when viewing Terminal or Diff -->
        <div
          v-if="roomMode !== 'chat'"
          class="px-12px py-8px flex items-center gap-8px bg-[var(--center-bg-color)] border-b border-[var(--line-color)] shrink-0">
          <button
            type="button"
            class="px-10px py-4px rounded-6px border-0 text-12px cursor-pointer"
            :class="roomMode === 'terminal' ? 'bg-[#13987f] text-white font-medium' : 'bg-[var(--search-bg-color)] text-[var(--text-color)]'"
            @click="roomMode = 'terminal'">
            终端 PTY
          </button>
          <button
            type="button"
            class="px-10px py-4px rounded-6px border-0 text-12px cursor-pointer"
            :class="roomMode === 'diff' ? 'bg-[#13987f] text-white font-medium' : 'bg-[var(--search-bg-color)] text-[var(--text-color)]'"
            @click="roomMode = 'diff'">
            Diff 检查点 ({{ roomCheckpoints.length }})
          </button>
          <div class="flex-1"></div>
          <button
            type="button"
            class="px-10px py-4px rounded-6px border-0 bg-[var(--search-bg-color)] text-[var(--text-color)] text-12px cursor-pointer"
            @click="roomMode = 'chat'">
            返回聊天
          </button>
        </div>

        <!-- Terminal Mode -->
        <div v-if="roomMode === 'terminal'" class="flex-1 min-h-0 overflow-hidden">
          <BotTerminalPane :room-id="room.id" :bot-id="activeDmBot?.id ?? null" />
        </div>

        <!-- Diff Checkpoints Mode -->
        <div v-else-if="roomMode === 'diff'" class="flex-1 min-h-0 overflow-y-auto p-12px space-y-10px">
          <div v-if="roomCheckpoints.length === 0" class="py-40px text-center text-13px text-[#888]">
            当前会话暂无代码 Diff 或检查点记录
          </div>
          <BotDiffCheckpointCard
            v-for="cp in roomCheckpoints"
            :key="cp.id"
            :message="cp"
            @rollback="handleRollback" />
        </div>

        <!-- Default Chat Stream Mode -->
        <div
          v-else
          ref="msgScrollRef"
          class="flex-1 min-h-0 overflow-y-auto px-14px py-12px space-y-12px"
          @click="closeComposerPanels">
          <template v-for="(msg, idx) in store.activeMessages" :key="msg.id">
            <!-- Centered Time Divider -->
            <div
              v-if="shouldShowTimeDivider(store.activeMessages[idx - 1]?.createdAt, msg.createdAt)"
              class="flex justify-center pt-2px">
              <span class="text-11.5px text-[#888] px-8px py-2px">
                {{ formatSmartTime(msg.createdAt) }}
              </span>
            </div>

            <!-- Recalled Message -->
            <div v-if="msg.recalledAt" class="flex justify-center">
              <span class="px-10px py-3px rounded-full bg-[var(--bg-bubble)] text-11.5px text-[#888]">
                {{ senderName(msg.senderId) }} 撤回了一条消息
              </span>
            </div>

            <!-- System Notice Message -->
            <div v-else-if="msg.msgType === 'system'" class="flex justify-center px-16px">
              <span class="px-12px py-4px rounded-full bg-[#3e362e]/85 text-[#dfd0bf] text-11.5px text-center leading-snug">
                {{ msg.content }}
              </span>
            </div>

            <!-- Outgoing User Message (Right-aligned, HuLa avatar right + green bubble) -->
            <div v-else-if="msg.senderId === 'me'" class="flex items-start justify-end gap-8px">
              <div class="flex flex-col items-end max-w-[76vw] min-w-0 space-y-4px">
                <div
                  v-if="msg.replyToId && findReplyTarget(msg.replyToId)"
                  class="px-8px py-4px rounded-8px bg-[var(--reply-bg)] text-11px text-[var(--reply-color)] max-w-full truncate">
                  回复 {{ senderName(findReplyTarget(msg.replyToId)!.senderId) }}: {{ findReplyTarget(msg.replyToId)!.content }}
                </div>
                <div
                  class="vl-m-bubble-self rounded-[18px_4px_18px_18px] px-12px py-8px bg-[#13987f] dark:bg-[#1d5c50] text-white shadow-sm cursor-pointer"
                  @click.stop="openMessageActions(msg)">
                  <BotMarkdownMessage :content="msg.content" :server-url="store.serverUrl" />
                </div>
              </div>
              <button
                type="button"
                class="p-0 border-0 bg-transparent rounded-full cursor-pointer shrink-0"
                @click.stop="openAvatarMenu($event, 'me')">
                <VlAvatar
                  :avatar="store.me?.avatar ?? 'preset:user'"
                  :name="store.me?.displayName ?? '我'"
                  :size="38" />
              </button>
            </div>

            <!-- Incoming Bot Message (Left-aligned, HuLa avatar left + bubble) -->
            <div v-else class="flex items-start gap-8px">
              <button
                type="button"
                class="p-0 border-0 bg-transparent rounded-full cursor-pointer shrink-0"
                title="点击查看资料或编辑名字与头像"
                @click.stop="openAvatarMenu($event, msg.senderId)">
                <VlAvatar
                  :avatar="senderAvatarProps(msg.senderId).avatar"
                  :name="senderAvatarProps(msg.senderId).name"
                  :provider="senderAvatarProps(msg.senderId).provider"
                  :size="38" />
              </button>

              <div class="flex flex-col items-start max-w-[78vw] min-w-0 space-y-4px">
                <div class="flex items-center gap-6px text-11.5px text-[#737373] dark:text-[#9ca3af] px-2px">
                  <span class="font-medium">{{ senderName(msg.senderId) }}</span>
                  <span v-if="senderHandle(msg.senderId)" class="text-[#13987f] dark:text-[#5eead4]">
                    @{{ senderHandle(msg.senderId) }}
                  </span>
                </div>

                <div
                  v-if="msg.replyToId && findReplyTarget(msg.replyToId)"
                  class="px-8px py-4px rounded-8px bg-[var(--reply-bg)] text-11px text-[var(--reply-color)] max-w-full truncate">
                  引用 {{ senderName(findReplyTarget(msg.replyToId)!.senderId) }}: {{ findReplyTarget(msg.replyToId)!.content }}
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
                <div
                  v-else
                  class="vl-m-bubble-in rounded-[4px_18px_18px_18px] px-12px py-8px bg-[var(--bg-bubble)] text-[var(--text-color)] border border-[var(--line-color)]/60 shadow-sm cursor-pointer"
                  @click.stop="openMessageActions(msg)">
                  <BotMarkdownMessage
                    :content="msg.content"
                    :server-url="store.serverUrl"
                    :bot-handles="roomBotHandles" />
                </div>
              </div>
            </div>
          </template>

          <!-- Busy Bot Status Pill -->
          <div v-if="store.isActiveRoomBusy" class="flex items-center justify-between px-12px py-8px rounded-10px bg-[var(--bg-bubble)] border border-[#13987f]/35">
            <span class="text-12px text-[#13987f] dark:text-[#5eead4] flex items-center gap-6px">
              <span class="w-8px h-8px rounded-full bg-[#13987f] animate-pulse"></span>
              <span>{{ workingBotNames }} 正在思考执行中...</span>
            </span>
            <button
              type="button"
              class="px-10px py-3px rounded-full bg-[#c14053] border-0 text-white text-11.5px cursor-pointer"
              @click="store.interruptActiveRoom()">
              停止
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- HuLa Mobile Footer Composer -->
    <template #footer>
      <div
        v-if="roomMode === 'chat'"
        class="w-full bg-[var(--center-bg-color)] border-t border-[var(--line-color)] flex flex-col relative">
        <!-- @Bot Mention Picker Overlay -->
        <div
          v-if="mentionOpen && store.activeRoomBots.length > 0"
          class="max-h-190px overflow-y-auto bg-[var(--bg-popover)] border-b border-[var(--line-color)] px-8px py-6px space-y-2px"
          data-testid="mobile-mention-picker">
          <div class="flex items-center justify-between px-6px py-4px text-11px text-[#888]">
            <span>选择要 @ 协接力的 Bot</span>
            <button
              type="button"
              class="bg-transparent border-0 text-[#888] cursor-pointer text-11px"
              @click="mentionOpen = false">
              关闭
            </button>
          </div>
          <button
            v-for="b in store.activeRoomBots"
            :key="b.id"
            type="button"
            class="w-full flex items-center gap-10px px-8px py-7px rounded-8px bg-transparent hover:bg-[var(--list-hover-color)] border-0 cursor-pointer text-left"
            @click="insertBotMention(b.handle)">
            <VlAvatar :avatar="b.avatar" :name="b.displayName" :provider="b.provider" :size="28" />
            <div class="min-w-0 flex-1">
              <div class="text-13px font-medium text-[var(--text-color)] truncate">{{ b.displayName }}</div>
              <div class="text-11px text-[#13987f] dark:text-[#5eead4]">@{{ b.handle }} · {{ b.roleTitle }}</div>
            </div>
          </button>
        </div>

        <!-- Quote Reply Bar -->
        <div
          v-if="replyTarget"
          class="flex items-center justify-between gap-8px px-12px py-6px bg-[var(--search-bg-color)] border-b border-[var(--line-color)] text-12px">
          <span class="truncate text-[var(--reply-color)]">
            回复 {{ senderName(replyTarget.senderId) }}：{{ stripMarkdownPreview(replyTarget.content) }}
          </span>
          <button
            type="button"
            class="p-2px bg-transparent border-0 text-[#888] cursor-pointer shrink-0 flex items-center"
            @click="replyTarget = null">
            <svg class="w-14px h-14px"><use href="#close" /></svg>
          </button>
        </div>

        <!-- Icon-only Composer Row (matches HuLa MsgInput.vue) -->
        <div class="px-10px py-8px flex items-end gap-8px">
          <button
            type="button"
            class="w-34px h-34px rounded-full bg-transparent border-0 text-[var(--icon-color)] cursor-pointer shrink-0 flex items-center justify-center"
            aria-label="Bot菜单或@提及"
            @click="handleLeftComposerIcon">
            <svg class="w-24px h-24px"><use href="#robot" /></svg>
          </button>

          <textarea
            ref="composerInputRef"
            v-model="mobileDraft"
            rows="1"
            placeholder="发消息..."
            data-testid="mobile-composer-input"
            class="flex-1 box-border px-12px py-7px rounded-10px bg-[var(--search-bg-color)] border-0 text-14px leading-5 text-[var(--text-color)] outline-none resize-none max-h-104px overflow-y-auto"
            @focus="activePanel = 'none'"
            @input="handleComposerInput"
            @keydown.enter.exact.prevent="sendMobileMessage"></textarea>

          <button
            type="button"
            class="w-34px h-34px rounded-full bg-transparent border-0 text-[var(--icon-color)] cursor-pointer shrink-0 flex items-center justify-center"
            :class="activePanel === 'emoji' ? 'text-[#13987f]' : ''"
            aria-label="表情"
            @click="togglePanel('emoji')">
            <svg class="w-24px h-24px">
              <use :href="activePanel === 'emoji' ? '#face' : '#smiling-face'" />
            </svg>
          </button>

          <n-button
            v-if="mobileDraft.trim().length > 0"
            type="primary"
            color="#13987f"
            size="small"
            data-testid="mobile-send-btn"
            :loading="sending"
            class="h-34px px-12px rounded-8px shrink-0"
            @click="sendMobileMessage">
            发送
          </n-button>

          <button
            v-else
            type="button"
            data-testid="mobile-more-btn"
            class="w-34px h-34px rounded-full bg-transparent border-0 text-[var(--icon-color)] cursor-pointer shrink-0 flex items-center justify-center transition-transform duration-200"
            :class="activePanel === 'more' ? 'rotate-45 text-[#13987f]' : ''"
            aria-label="更多功能"
            @click="togglePanel('more')">
            <svg class="w-24px h-24px"><use href="#add-one" /></svg>
          </button>
        </div>

        <!-- Hidden File Picker -->
        <input ref="fileInputRef" type="file" class="hidden" @change="handleFileUpload" />
        <input ref="imageInputRef" type="file" accept="image/*" class="hidden" @change="handleFileUpload" />

        <!-- Slide-up Emoji Panel -->
        <div
          v-if="activePanel === 'emoji'"
          class="h-210px border-t border-[var(--line-color)] bg-[var(--center-bg-color)] p-12px overflow-y-auto"
          data-testid="mobile-emoji-panel">
          <div class="grid grid-cols-7 gap-8px">
            <button
              v-for="em in QUICK_EMOJIS"
              :key="em"
              type="button"
              class="h-38px rounded-8px bg-[var(--search-bg-color)] border-0 text-20px cursor-pointer flex items-center justify-center"
              @click="appendEmoji(em)">
              {{ em }}
            </button>
          </div>
        </div>

        <!-- Slide-up HuLa 2x4 More Panel -->
        <div
          v-else-if="activePanel === 'more'"
          class="border-t border-[var(--line-color)] bg-[var(--center-bg-color)] px-16px py-14px"
          data-testid="mobile-more-panel">
          <div class="grid grid-cols-4 gap-14px">
            <button
              v-for="tile in moreTiles"
              :key="tile.id"
              type="button"
              class="flex flex-col items-center gap-6px bg-transparent border-0 cursor-pointer p-0 text-[var(--text-color)]"
              @click="handleMoreTile(tile.id)">
              <span class="w-48px h-48px rounded-12px bg-[var(--search-bg-color)] flex items-center justify-center text-[var(--icon-color)]">
                <svg class="w-22px h-22px"><use :href="`#${tile.icon}`" /></svg>
              </span>
              <span class="text-11px text-[#737373] dark:text-[#9ca3af]">{{ tile.label }}</span>
            </button>
          </div>
        </div>
      </div>
    </template>
  </MobileScaffold>

  <!-- Avatar Action Menu (HuLa style click-on-avatar) -->
  <AvatarActionMenu
    :account="avatarMenuAccount"
    :anchor="avatarMenuAnchor"
    :in-group="room.kind === 'group'"
    @close="avatarMenuAccount = null"
    @dm="handleMenuDm"
    @poke="handleMenuPoke"
    @view-profile="handleMenuViewProfile"
    @edit-profile="handleMenuEditProfile" />

  <!-- Group Notice View / Edit Modal -->
  <n-modal v-model:show="noticeModalOpen" preset="card" title="群公告" class="w-90vw max-w-420px rounded-14px">
    <div class="space-y-12px">
      <n-input
        v-model:value="noticeDraft"
        type="textarea"
        :autosize="{ minRows: 3, maxRows: 6 }"
        placeholder="输入群公告内容..." />
      <div class="flex justify-end gap-8px">
        <n-button @click="noticeModalOpen = false">取消</n-button>
        <n-button type="primary" color="#13987f" @click="saveNotice">保存公告</n-button>
      </div>
    </div>
  </n-modal>

  <!-- Message Action Sheet Modal -->
  <n-modal v-model:show="msgActionModalOpen" preset="card" title="消息操作" class="w-84vw max-w-340px rounded-14px">
    <div v-if="selectedMsg" class="space-y-8px">
      <div class="text-12px text-[#888] truncate pb-4px border-b border-[var(--line-color)]">
        {{ stripMarkdownPreview(selectedMsg.content) }}
      </div>
      <div class="grid grid-cols-3 gap-8px">
        <n-button secondary @click="copySelectedMessage">复制</n-button>
        <n-button secondary @click="quoteSelectedMessage">引用回复</n-button>
        <n-button
          v-if="selectedMsg.senderId === 'me'"
          type="error"
          secondary
          @click="recallSelectedMessage">
          撤回
        </n-button>
      </div>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import MobileScaffold from '#/components/MobileScaffold.vue'
import { presenceColor } from '../avatar'
import AvatarActionMenu from '../components/AvatarActionMenu.vue'
import BotApprovalCard from '../components/BotApprovalCard.vue'
import BotDiffCheckpointCard from '../components/BotDiffCheckpointCard.vue'
import BotMarkdownMessage from '../components/BotMarkdownMessage.vue'
import BotTerminalPane from '../components/BotTerminalPane.vue'
import BotToolCallCard from '../components/BotToolCallCard.vue'
import VlAvatar from '../components/VlAvatar.vue'
import { useVibeLinkStore } from '../store'
import type { VlAccount, VlMessage, VlRoomSummary } from '../types'
import { formatPresenceText, formatSmartTime, shouldShowTimeDivider, stripMarkdownPreview } from './mobileFormat'

const props = defineProps<{
  room: VlRoomSummary
}>()

const emit = defineEmits<{
  back: []
  openSettings: []
}>()

const store = useVibeLinkStore()

const roomMode = ref<'chat' | 'terminal' | 'diff'>('chat')
const mobileDraft = ref('')
const sending = ref(false)
const activePanel = ref<'none' | 'emoji' | 'more'>('none')
const mentionOpen = ref(false)
const replyTarget = ref<VlMessage | null>(null)
const msgScrollRef = ref<HTMLElement | null>(null)
const composerInputRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const imageInputRef = ref<HTMLInputElement | null>(null)

const avatarMenuAccount = ref<VlAccount | null>(null)
const avatarMenuAnchor = ref<{ x: number; y: number } | null>(null)

const noticeModalOpen = ref(false)
const noticeDraft = ref('')

const msgActionModalOpen = ref(false)
const selectedMsg = ref<VlMessage | null>(null)

const QUICK_EMOJIS = [
  '👍', '👌', '🎉', '🔥', '🚀', '💡', '👀',
  '😄', '😅', '🤝', '❤️', '✅', '⚠️', '🐛',
  '🛠️', '🧪', '📦', '📝', '🤖', '⚡', '🙏'
]

const moreTiles = computed(() => [
  { id: 'image', label: '图片', icon: 'photo' },
  { id: 'file', label: '文件', icon: 'file' },
  { id: 'mention', label: '@Bot', icon: 'robot' },
  { id: 'terminal', label: '终端', icon: 'diannao' },
  { id: 'diff', label: 'Diff', icon: 'history' },
  { id: 'home', label: 'Bot Home', icon: 'settings' },
  { id: 'notice', label: props.room.kind === 'group' ? '群公告' : '房间设置', icon: 'Loudspeaker' },
  { id: 'profile', label: '改资料', icon: 'edit' }
])

const otherUnreadCount = computed(() =>
  store.rooms.reduce((sum, r) => (r.id === props.room.id || r.muted ? sum : sum + (r.unreadCount || 0)), 0)
)

const activeDmBot = computed<VlAccount | null>(() => {
  if (props.room.kind !== 'dm') return null
  const member = props.room.members.find((m) => m.accountId !== 'me')
  return member ? store.accountsById[member.accountId] ?? null : null
})

const headerPresenceColor = computed(() => {
  if (activeDmBot.value) return presenceColor(activeDmBot.value.presence)
  return store.isActiveRoomBusy ? '#f59e0b' : '#22c55e'
})

const workingBotNames = computed(() =>
  store.activeRoomBots
    .filter((b) => b.presence === 'working')
    .map((b) => b.displayName)
    .join('、')
)

const headerSubtitle = computed(() => {
  if (activeDmBot.value) {
    const bot = activeDmBot.value
    return `${formatPresenceText(bot.presence)} · ${bot.provider}${bot.model ? ` · ${bot.model}` : ''}`
  }
  if (store.isActiveRoomBusy) return `${workingBotNames.value} 处理中...`
  return `${props.room.onlineCount}/${props.room.memberCount} 在线协作`
})

const roomBotHandles = computed(() => store.activeRoomBots.map((b) => b.handle))
const roomCheckpoints = computed(() => store.checkpointsByRoom[props.room.id] ?? [])

function senderName(senderId: string): string {
  return store.accountsById[senderId]?.displayName ?? senderId
}

function senderHandle(senderId: string): string {
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

function findReplyTarget(replyToId: string): VlMessage | null {
  return store.activeMessages.find((m) => m.id === replyToId) ?? null
}

function scrollBottom() {
  void nextTick(() => {
    const el = msgScrollRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function closeComposerPanels() {
  activePanel.value = 'none'
  mentionOpen.value = false
}

function toggleWorkspaceMode() {
  roomMode.value = roomMode.value === 'chat' ? 'terminal' : 'chat'
}

function handleCenterTitleClick() {
  if (activeDmBot.value) {
    store.openProfileModal(activeDmBot.value.id)
  } else {
    emit('openSettings')
  }
}

function togglePanel(panel: 'emoji' | 'more') {
  mentionOpen.value = false
  activePanel.value = activePanel.value === panel ? 'none' : panel
}

function handleLeftComposerIcon() {
  if (props.room.kind === 'group' && store.activeRoomBots.length > 0) {
    activePanel.value = 'none'
    mentionOpen.value = !mentionOpen.value
  } else if (activeDmBot.value) {
    store.openBotHomeDrawer(activeDmBot.value.id)
  } else {
    emit('openSettings')
  }
}

function handleComposerInput() {
  const el = composerInputRef.value
  if (el) {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 104)}px`
  }
  if (props.room.kind === 'group' && mobileDraft.value.endsWith('@')) {
    mentionOpen.value = true
  }
}

function insertBotMention(handle: string) {
  const val = mobileDraft.value
  if (val.endsWith('@')) {
    mobileDraft.value = `${val}${handle} `
  } else {
    mobileDraft.value = `${val}${val && !val.endsWith(' ') ? ' ' : ''}@${handle} `
  }
  mentionOpen.value = false
  composerInputRef.value?.focus()
}

function appendEmoji(emoji: string) {
  mobileDraft.value += emoji
}

async function sendMobileMessage() {
  if (!mobileDraft.value.trim() || sending.value) return
  sending.value = true
  const content = mobileDraft.value.trim()
  mobileDraft.value = ''
  if (composerInputRef.value) composerInputRef.value.style.height = 'auto'
  mentionOpen.value = false
  activePanel.value = 'none'
  const quoteId = replyTarget.value?.id ?? null
  replyTarget.value = null
  try {
    await store.sendMessage(props.room.id, content, { replyToId: quoteId })
    scrollBottom()
  } catch (err) {
    mobileDraft.value = content
    window.$message?.error?.(`发送失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    sending.value = false
  }
}

async function handleFileUpload(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  activePanel.value = 'none'
  try {
    await store.uploadAndSendFile(props.room.id, file)
    scrollBottom()
  } catch (err) {
    window.$message?.error?.(`上传失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

function handleMoreTile(tileId: string) {
  switch (tileId) {
    case 'image':
      imageInputRef.value?.click()
      break
    case 'file':
      fileInputRef.value?.click()
      break
    case 'mention':
      activePanel.value = 'none'
      if (store.activeRoomBots.length > 0) mentionOpen.value = true
      break
    case 'terminal':
      activePanel.value = 'none'
      roomMode.value = 'terminal'
      break
    case 'diff':
      activePanel.value = 'none'
      roomMode.value = 'diff'
      break
    case 'home': {
      activePanel.value = 'none'
      const target = activeDmBot.value ?? store.activeRoomBots[0]
      if (target) store.openBotHomeDrawer(target.id)
      break
    }
    case 'notice':
      activePanel.value = 'none'
      if (props.room.kind === 'group') openNoticeModal()
      else emit('openSettings')
      break
    case 'profile': {
      activePanel.value = 'none'
      const target = activeDmBot.value ?? store.activeRoomBots[0]
      if (target) store.openProfileModal(target.id)
      else emit('openSettings')
      break
    }
  }
}

function openAvatarMenu(ev: MouseEvent, accountId: string) {
  const acc = store.accountsById[accountId]
  if (!acc) return
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  avatarMenuAccount.value = acc
  avatarMenuAnchor.value = { x: rect.left, y: rect.bottom + 6 }
}

async function handleMenuDm(acc: VlAccount) {
  await store.openDmWithBot(acc.id)
  scrollBottom()
}

async function handleMenuPoke(acc: VlAccount) {
  if (props.room.kind === 'group') {
    insertBotMention(acc.handle)
  } else {
    await store.sendMessage(props.room.id, `👉 戳了戳 @${acc.handle}`)
    scrollBottom()
  }
}

function handleMenuViewProfile(acc: VlAccount) {
  store.openBotHomeDrawer(acc.id)
}

function handleMenuEditProfile(acc: VlAccount) {
  store.openProfileModal(acc.id)
}

function openNoticeModal() {
  noticeDraft.value = props.room.notice ?? ''
  noticeModalOpen.value = true
}

async function saveNotice() {
  await store.updateRoomNotice(props.room.id, noticeDraft.value.trim())
  noticeModalOpen.value = false
  window.$message?.success?.('群公告已更新')
}

function openMessageActions(msg: VlMessage) {
  selectedMsg.value = msg
  msgActionModalOpen.value = true
}

async function copySelectedMessage() {
  if (!selectedMsg.value) return
  try {
    await navigator.clipboard.writeText(selectedMsg.value.content)
    window.$message?.success?.('已复制')
  } catch {
    window.$message?.info?.('复制失败，请长按文本选择')
  }
  msgActionModalOpen.value = false
}

function quoteSelectedMessage() {
  if (!selectedMsg.value) return
  replyTarget.value = selectedMsg.value
  msgActionModalOpen.value = false
  composerInputRef.value?.focus()
}

async function recallSelectedMessage() {
  if (!selectedMsg.value) return
  const id = selectedMsg.value.id
  msgActionModalOpen.value = false
  await store.recallMessage(props.room.id, id)
}

async function handleApproval(payload: { approvalId: string; decision: 'approved' | 'rejected' }) {
  await store.respondApproval(payload.approvalId, payload.decision)
}

async function handleRollback(msg: VlMessage) {
  await store.rollbackCheckpoint(props.room.id, { messageId: msg.id })
}

onMounted(scrollBottom)

watch(
  () => [props.room.id, store.activeMessages.length],
  () => {
    if (roomMode.value === 'chat') scrollBottom()
  }
)
</script>

<style scoped>
.vl-m-bubble-self :deep(.vl-md-inline-code) {
  background: rgba(0, 0, 0, 0.25);
  border-color: rgba(255, 255, 255, 0.2);
  color: #ffffff;
}

.vl-m-bubble-self :deep(.vl-md-mention) {
  background: rgba(255, 255, 255, 0.22);
  color: #ffffff;
}

.vl-m-bubble-self :deep(.vl-md-link) {
  color: #ecfdf5;
}
</style>
