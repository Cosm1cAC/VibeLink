<template>
  <van-config-provider :theme="isDark ? 'dark' : 'light'" class="h-full w-full">
    <div
      class="vl-mobile-root h-full w-full overflow-hidden flex flex-col bg-[var(--center-bg-color)] text-[var(--text-color)]"
      :class="isDark ? 'vl-theme-dark' : ''"
      data-testid="vibelink-mobile-shell">
      <!-- Regular non-admin User Portal on Mobile -->
      <div
        v-if="store.authUser?.role === 'user'"
        class="h-full w-full flex flex-col overflow-hidden bg-[var(--center-bg-color)]"
        data-testid="mobile-user-portal">
        <div class="pt-[var(--safe-area-inset-top)] shrink-0"></div>
        <div class="flex-1 overflow-y-auto p-12px">
          <AccountWelfarePanel compact @open-auth-modal="accountAuthOpen = true" />
        </div>
      </div>

      <!-- Chat Setting Full Screen -->
      <VibeLinkMobileChatSetting
        v-else-if="inRoomChat && store.activeRoom && showChatSetting"
        :room="store.activeRoom"
        @back="showChatSetting = false"
        @switch-room="showChatSetting = false" />

      <!-- Active Chat Room Full Screen -->
      <VibeLinkMobileChatRoom
        v-else-if="inRoomChat && store.activeRoom"
        :room="store.activeRoom"
        @back="exitRoomChat"
        @open-settings="showChatSetting = true" />

      <!-- Main 4-Tab HuLa Scaffold -->
      <MobileScaffold v-else :safe-area="false">
        <template #container>
          <VibeLinkMobileMessages
            v-if="mobileTab === 'messages'"
            @enter-room="enterMobileRoom"
            @go-settings="mobileTab = 'settings'"
            @scan-qr="openQrScanner"
            @create-bot="openCreateBotModal"
            @create-group="openCreateGroupModal" />

          <VibeLinkMobileContacts
            v-else-if="mobileTab === 'bots'"
            @open-bot-dm="openMobileBotDm"
            @enter-room="enterMobileRoom"
            @go-settings="mobileTab = 'settings'"
            @create-bot="openCreateBotModal"
            @create-group="openCreateGroupModal" />

          <div v-else-if="mobileTab === 'terminal'" class="h-full w-full flex flex-col bg-[#141718]" data-testid="mobile-terminal-view">
            <div class="pt-[var(--safe-area-inset-top)] bg-[#1c2021] shrink-0"></div>
            <div class="flex-1 min-h-0">
              <BotTerminalPane :room-id="store.activeRoomId" />
            </div>
          </div>

          <VibeLinkMobileMe
            v-else
            :open-paste-tick="openPasteModalTick"
            @scan-qr="openQrScanner" />
        </template>

        <template #footer>
          <div>
            <VibeLinkMobileTabBar :active-tab="mobileTab" @select="mobileTab = $event" />
          </div>
        </template>
      </MobileScaffold>

      <!-- Native Camera QR Scanner Overlay -->
      <VibeLinkMobileQrScanner
        :open="qrScannerOpen"
        @close="qrScannerOpen = false"
        @scanned="handleQrScanned"
        @fallback-paste="handleQrFallbackPaste" />

      <!-- Shared Modals -->
      <AccountProfileModal
        :account-id="store.profileModalAccountId"
        @close="store.closeProfileModal()"
        @open-bot-home="store.openBotHomeDrawer($event)" />
      <BotHomeDrawer :bot-id="store.botHomeDrawerBotId" @close="store.closeBotHomeDrawer()" />
      <AccountAuthModal
        :open="store.authRequired || accountAuthOpen"
        :dismissible="!store.authRequired"
        @close="accountAuthOpen = false" />

      <!-- Create Bot Modal -->
      <n-modal v-model:show="createBotOpen" preset="card" title="新建 Bot 好友" class="w-90vw max-w-400px rounded-14px">
        <div class="space-y-10px text-13px">
          <div class="space-y-4px">
            <div class="text-[#888]">Bot 显示名</div>
            <n-input v-model:value="newBotName" placeholder="例如：Codex 主程" />
          </div>
          <div class="space-y-4px">
            <div class="text-[#888]">@Handle（群聊点名）</div>
            <n-input v-model:value="newBotHandle" placeholder="例如：codex-helper" />
          </div>
          <div class="space-y-4px">
            <div class="text-[#888]">职责说明</div>
            <n-input v-model:value="newBotRole" placeholder="工程实现 / 代码审查" />
          </div>
          <div class="flex justify-end gap-8px pt-4px">
            <n-button @click="createBotOpen = false">取消</n-button>
            <n-button type="primary" color="#13987f" :loading="creating" @click="submitCreateBot">
              创建
            </n-button>
          </div>
        </div>
      </n-modal>

      <!-- Create Group Modal -->
      <n-modal v-model:show="createGroupOpen" preset="card" title="发起多 Bot 协作群" class="w-90vw max-w-400px rounded-14px">
        <div class="space-y-10px text-13px">
          <div class="space-y-4px">
            <div class="text-[#888]">群聊名称</div>
            <n-input v-model:value="newGroupName" placeholder="例如：VibeLink 移动端攻坚群" />
          </div>
          <div class="space-y-4px">
            <div class="text-[#888]">选择进群的 Bot（点击多选）</div>
            <div class="flex flex-wrap gap-6px max-h-180px overflow-y-auto p-4px">
              <button
                v-for="b in store.bots"
                :key="b.id"
                type="button"
                class="px-10px py-5px rounded-full border text-12px cursor-pointer"
                :class="
                  selectedBotIds.includes(b.id)
                    ? 'bg-[#13987f] border-[#13987f] text-white'
                    : 'bg-transparent border-[var(--line-color)] text-[var(--text-color)]'
                "
                @click="toggleGroupBot(b.id)">
                {{ b.displayName }} (@{{ b.handle }})
              </button>
            </div>
          </div>
          <div class="flex justify-end gap-8px pt-4px">
            <n-button @click="createGroupOpen = false">取消</n-button>
            <n-button type="primary" color="#13987f" :loading="creating" @click="submitCreateGroup">
              建群
            </n-button>
          </div>
        </div>
      </n-modal>
    </div>
  </van-config-provider>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import MobileScaffold from '#/components/MobileScaffold.vue'
import { ThemeEnum } from '@/enums'
import { useSettingStore } from '@/stores/setting'
import AccountAuthModal from '../components/AccountAuthModal.vue'
import AccountProfileModal from '../components/AccountProfileModal.vue'
import AccountWelfarePanel from '../components/AccountWelfarePanel.vue'
import BotHomeDrawer from '../components/BotHomeDrawer.vue'
import BotTerminalPane from '../components/BotTerminalPane.vue'
import { hideMobileSplashSafe, syncAndroidSystemBars } from '../runtime'
import { useVibeLinkStore } from '../store'
import '../vibelink.scss'
import VibeLinkMobileChatRoom from './VibeLinkMobileChatRoom.vue'
import VibeLinkMobileChatSetting from './VibeLinkMobileChatSetting.vue'
import VibeLinkMobileContacts from './VibeLinkMobileContacts.vue'
import VibeLinkMobileMe from './VibeLinkMobileMe.vue'
import VibeLinkMobileMessages from './VibeLinkMobileMessages.vue'
import VibeLinkMobileQrScanner from './VibeLinkMobileQrScanner.vue'
import VibeLinkMobileTabBar, { type VlMobileTab } from './VibeLinkMobileTabBar.vue'

const store = useVibeLinkStore()
const settingStore = useSettingStore()
const route = useRoute()

const mobileTab = ref<VlMobileTab>('messages')
const inRoomChat = ref(false)
const showChatSetting = ref(false)
const qrScannerOpen = ref(false)
const openPasteModalTick = ref(0)
const accountAuthOpen = ref(false)

const createBotOpen = ref(false)
const newBotName = ref('')
const newBotHandle = ref('')
const newBotRole = ref('协同开发')
const createGroupOpen = ref(false)
const newGroupName = ref('')
const selectedBotIds = ref<string[]>([])
const creating = ref(false)

const isDark = computed(() => settingStore.themes.content === ThemeEnum.DARK)

async function enterMobileRoom(roomId: string) {
  await store.selectRoom(roomId)
  showChatSetting.value = false
  inRoomChat.value = true
  try {
    window.history.pushState({ vlRoom: roomId }, '')
  } catch {
    // ignore history push errors
  }
}

function exitRoomChat() {
  showChatSetting.value = false
  inRoomChat.value = false
}

async function openMobileBotDm(botId: string) {
  await store.openDmWithBot(botId)
  mobileTab.value = 'messages'
  showChatSetting.value = false
  inRoomChat.value = true
}

function openCreateBotModal() {
  newBotName.value = ''
  newBotHandle.value = ''
  newBotRole.value = '协同开发'
  createBotOpen.value = true
}

function openCreateGroupModal() {
  newGroupName.value = ''
  selectedBotIds.value = store.bots.slice(0, 3).map((b) => b.id)
  createGroupOpen.value = true
}

function toggleGroupBot(botId: string) {
  if (selectedBotIds.value.includes(botId)) {
    selectedBotIds.value = selectedBotIds.value.filter((id) => id !== botId)
  } else {
    selectedBotIds.value = [...selectedBotIds.value, botId]
  }
}

async function submitCreateBot() {
  const name = newBotName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    await store.createBot({
      displayName: name,
      handle: newBotHandle.value.trim() || undefined,
      roleTitle: newBotRole.value.trim() || '协同开发'
    })
    createBotOpen.value = false
    inRoomChat.value = true
  } catch (err) {
    window.$message?.error?.(`创建失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    creating.value = false
  }
}

async function submitCreateGroup() {
  const name = newGroupName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    await store.createGroup({
      name,
      botIds: selectedBotIds.value
    })
    createGroupOpen.value = false
    inRoomChat.value = true
  } catch (err) {
    window.$message?.error?.(`建群失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    creating.value = false
  }
}

function openQrScanner() {
  qrScannerOpen.value = true
}

function handleQrFallbackPaste() {
  qrScannerOpen.value = false
  mobileTab.value = 'settings'
  openPasteModalTick.value += 1
}

async function handleQrScanned(raw: string) {
  qrScannerOpen.value = false
  try {
    const res = await store.applyPairingQrPayload(raw)
    mobileTab.value = 'settings'
    window.$message?.success?.(
      res.endpoint
        ? `扫码配对成功：已导入 ${res.totalChannels} 条通道，当前连接 ${res.endpoint.label}`
        : `已导入 ${res.totalChannels} 条通道`
    )
  } catch (err) {
    mobileTab.value = 'settings'
    window.$message?.error?.(`扫码配对失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

function handlePopState() {
  if (qrScannerOpen.value) {
    qrScannerOpen.value = false
    return
  }
  if (showChatSetting.value) {
    showChatSetting.value = false
    return
  }
  if (inRoomChat.value) {
    inRoomChat.value = false
  }
}

watch(isDark, (dark) => syncAndroidSystemBars(dark), { immediate: true })

onMounted(async () => {
  void hideMobileSplashSafe()
  syncAndroidSystemBars(isDark.value)
  window.addEventListener('popstate', handlePopState)

  await store.init()
  if (route.path.startsWith('/mobile/bots')) mobileTab.value = 'bots'
  else if (route.path.startsWith('/mobile/terminal')) mobileTab.value = 'terminal'
  else if (route.path.startsWith('/mobile/settings')) mobileTab.value = 'settings'

  const roomParam = typeof route.params.roomId === 'string' ? route.params.roomId : ''
  if (roomParam) {
    await enterMobileRoom(roomParam)
  }
})

onUnmounted(() => {
  window.removeEventListener('popstate', handlePopState)
})
</script>
