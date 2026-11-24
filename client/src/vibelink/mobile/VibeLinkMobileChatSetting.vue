<template>
  <MobileScaffold>
    <template #header>
      <header
        class="w-full box-border h-[calc(52px+var(--safe-area-inset-top))] pt-[var(--safe-area-inset-top)] px-12px grid grid-cols-[64px_1fr_64px] items-center bg-[var(--center-bg-color)] border-b border-[var(--line-color)]">
        <button
          type="button"
          class="flex items-center bg-transparent border-0 p-4px text-[var(--text-color)] cursor-pointer"
          aria-label="返回聊天"
          @click="$emit('back')">
          <svg class="w-22px h-22px"><use href="#fanhui" /></svg>
        </button>
        <div class="text-center text-16px font-semibold text-[var(--text-color)] truncate">
          {{ room.kind === 'group' ? '群聊设置' : '聊天设置' }}
        </div>
        <div></div>
      </header>
    </template>

    <template #container>
      <div class="h-full overflow-y-auto px-16px py-14px space-y-14px" data-testid="mobile-chat-setting">
        <!-- Room / Bot Identity Card -->
        <n-card size="small" :bordered="false" class="rounded-12px">
          <div class="flex items-center gap-12px">
            <button
              type="button"
              class="p-0 border-0 bg-transparent rounded-full cursor-pointer shrink-0"
              @click="handleHeaderAction">
              <VlAvatar
                :avatar="dmBot ? dmBot.avatar : room.avatar"
                :name="dmBot ? dmBot.displayName : room.name"
                :provider="dmBot?.provider ?? ''"
                :size="48" />
            </button>
            <div class="flex-1 min-w-0">
              <div class="text-15px font-bold text-[var(--text-color)] truncate">{{ room.name }}</div>
              <div class="text-12px text-[#888] truncate mt-2px">
                {{ dmBot ? `${dmBot.provider} · ${dmBot.roleTitle}` : `${room.memberCount} 名成员 · 工作区 ${room.cwd}` }}
              </div>
            </div>
            <n-button size="small" secondary round @click="handleHeaderAction">
              {{ dmBot ? '编辑头像' : '改群名' }}
            </n-button>
          </div>
        </n-card>

        <!-- Group Members Grid (HuLa ChatSetting.vue 5-column style) -->
        <n-card
          v-if="room.kind === 'group'"
          :bordered="false"
          class="rounded-12px"
          title="群聊成员"
          header-class="text-14px! pb-6px!">
          <template #header-extra>
            <span class="text-12px text-[#13987f]">共 {{ room.memberCount }} 人</span>
          </template>
          <div class="grid grid-cols-5 gap-12px pt-6px">
            <button
              v-for="m in store.activeRoomMembers"
              :key="m.account.id"
              type="button"
              class="flex flex-col items-center gap-4px bg-transparent border-0 p-0 cursor-pointer"
              @click="handleMemberTap(m.account)">
              <div class="relative">
                <VlAvatar
                  :avatar="m.account.avatar"
                  :name="m.account.displayName"
                  :provider="m.account.provider"
                  :size="40" />
                <span
                  class="w-9px h-9px rounded-full border-2 border-[var(--card)] absolute right-0 bottom-0"
                  :style="{ backgroundColor: presenceColor(m.account.presence) }"></span>
              </div>
              <span class="text-11px text-[var(--text-color)] truncate max-w-full">
                {{ m.account.displayName }}
              </span>
            </button>

            <button
              v-if="invitableBots.length > 0"
              type="button"
              class="flex flex-col items-center gap-4px bg-transparent border-0 p-0 cursor-pointer"
              @click="inviteModalOpen = true">
              <span class="w-40px h-40px rounded-full bg-[var(--search-bg-color)] flex items-center justify-center text-[var(--icon-color)]">
                <svg class="w-20px h-20px"><use href="#plus" /></svg>
              </span>
              <span class="text-11px text-[#888]">邀请 Bot</span>
            </button>
          </div>
        </n-card>

        <!-- Bot Home Shortcut for DM -->
        <n-card
          v-if="dmBot"
          :bordered="false"
          class="rounded-12px cursor-pointer"
          content-class="py-12px!"
          @click="store.openBotHomeDrawer(dmBot.id)">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-10px">
              <svg class="w-20px h-20px text-[#13987f]"><use href="#settings" /></svg>
              <div>
                <div class="text-14px font-medium text-[var(--text-color)]">Bot Home 与人格配置</div>
                <div class="text-11.5px text-[#888]">查看并编辑 SOUL.md、MEMORY.md、skills/</div>
              </div>
            </div>
            <svg class="w-16px h-16px text-[#888]"><use href="#right" /></svg>
          </div>
        </n-card>

        <!-- Group Notice Card -->
        <n-card
          v-if="room.kind === 'group'"
          :bordered="false"
          class="rounded-12px"
          title="群公告"
          header-class="text-14px! pb-6px!">
          <template #header-extra>
            <button
              type="button"
              class="bg-transparent border-0 text-12px text-[#13987f] cursor-pointer"
              @click="noticeEditOpen = true">
              编辑
            </button>
          </template>
          <div class="text-12.5px text-[#737373] dark:text-[#9ca3af] whitespace-pre-wrap leading-relaxed">
            {{ room.notice || '暂无群公告' }}
          </div>
        </n-card>

        <!-- Pin & Mute Switches (HuLa ChatSetting.vue) -->
        <n-card :bordered="false" class="rounded-12px" title="聊天开关" header-class="text-14px! pb-6px!">
          <div class="space-y-12px">
            <div class="flex items-center justify-between">
              <span class="text-14px text-[var(--text-color)]">置顶聊天</span>
              <n-switch :value="room.pinned" @update:value="togglePin" />
            </div>
            <n-divider class="m-0!" />
            <div class="flex items-center justify-between">
              <span class="text-14px text-[var(--text-color)]">消息免打扰</span>
              <n-switch :value="room.muted" @update:value="toggleMute" />
            </div>
          </div>
        </n-card>
      </div>
    </template>
  </MobileScaffold>

  <!-- Rename Group Modal -->
  <n-modal v-model:show="renameModalOpen" preset="card" title="修改群名称" class="w-86vw max-w-360px rounded-14px">
    <div class="space-y-12px">
      <n-input v-model:value="groupNameDraft" placeholder="输入新的群聊名称" />
      <div class="flex justify-end gap-8px">
        <n-button @click="renameModalOpen = false">取消</n-button>
        <n-button type="primary" color="#13987f" @click="saveGroupName">保存</n-button>
      </div>
    </div>
  </n-modal>

  <!-- Edit Notice Modal -->
  <n-modal v-model:show="noticeEditOpen" preset="card" title="编辑群公告" class="w-88vw max-w-380px rounded-14px">
    <div class="space-y-12px">
      <n-input v-model:value="noticeDraft" type="textarea" :autosize="{ minRows: 3, maxRows: 6 }" />
      <div class="flex justify-end gap-8px">
        <n-button @click="noticeEditOpen = false">取消</n-button>
        <n-button type="primary" color="#13987f" @click="saveNotice">保存</n-button>
      </div>
    </div>
  </n-modal>

  <!-- Invite Bot Modal -->
  <n-modal v-model:show="inviteModalOpen" preset="card" title="邀请 Bot 入群" class="w-88vw max-w-380px rounded-14px">
    <div class="space-y-8px max-h-50vh overflow-y-auto">
      <div
        v-for="b in invitableBots"
        :key="b.id"
        class="flex items-center justify-between gap-10px p-8px rounded-10px bg-[var(--search-bg-color)]">
        <div class="flex items-center gap-8px min-w-0">
          <VlAvatar :avatar="b.avatar" :name="b.displayName" :provider="b.provider" :size="34" />
          <div class="min-w-0">
            <div class="text-13px font-medium truncate">{{ b.displayName }}</div>
            <div class="text-11px text-[#13987f]">@{{ b.handle }}</div>
          </div>
        </div>
        <n-button size="tiny" type="primary" color="#13987f" @click="inviteBot(b.id)">邀请</n-button>
      </div>
    </div>
  </n-modal>

  <!-- Member Quick Action Modal -->
  <n-modal
    v-model:show="memberSheetOpen"
    preset="card"
    :title="selectedMember?.displayName ?? '成员信息'"
    class="w-86vw max-w-340px rounded-14px">
    <div v-if="selectedMember" class="space-y-10px">
      <div class="text-12px text-[#888]">@{{ selectedMember.handle }} · {{ selectedMember.roleTitle }}</div>
      <div class="flex flex-col gap-8px">
        <n-button
          v-if="selectedMember.id !== 'me'"
          type="primary"
          color="#13987f"
          @click="openDmFromMember(selectedMember.id)">
          发私聊消息
        </n-button>
        <n-button secondary @click="editMemberProfile(selectedMember.id)">编辑名字与头像</n-button>
        <n-button
          v-if="selectedMember.kind === 'bot'"
          secondary
          @click="openMemberBotHome(selectedMember.id)">
          查看 Bot Home
        </n-button>
        <n-button
          v-if="room.kind === 'group' && selectedMember.id !== 'me'"
          type="error"
          secondary
          @click="removeMember(selectedMember.id)">
          移出本群
        </n-button>
      </div>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import MobileScaffold from '#/components/MobileScaffold.vue'
import { presenceColor } from '../avatar'
import VlAvatar from '../components/VlAvatar.vue'
import { useVibeLinkStore } from '../store'
import type { VlAccount, VlRoomSummary } from '../types'

const props = defineProps<{
  room: VlRoomSummary
}>()

const emit = defineEmits<{
  back: []
  switchRoom: []
}>()

const store = useVibeLinkStore()

const renameModalOpen = ref(false)
const groupNameDraft = ref(props.room.name)
const noticeEditOpen = ref(false)
const noticeDraft = ref(props.room.notice ?? '')
const inviteModalOpen = ref(false)
const memberSheetOpen = ref(false)
const selectedMember = ref<VlAccount | null>(null)

const dmBot = computed<VlAccount | null>(() => {
  if (props.room.kind !== 'dm') return null
  const m = props.room.members.find((x) => x.accountId !== 'me')
  return m ? store.accountsById[m.accountId] ?? null : null
})

const invitableBots = computed(() => {
  const inRoom = new Set(props.room.members.map((m) => m.accountId))
  return store.bots.filter((b) => !inRoom.has(b.id))
})

function handleHeaderAction() {
  if (dmBot.value) {
    store.openProfileModal(dmBot.value.id)
  } else {
    groupNameDraft.value = props.room.name
    renameModalOpen.value = true
  }
}

async function saveGroupName() {
  const next = groupNameDraft.value.trim()
  if (!next) return
  await store.updateRoomSettings(props.room.id, { name: next })
  renameModalOpen.value = false
  window.$message?.success?.('群名称已更新')
}

async function saveNotice() {
  await store.updateRoomNotice(props.room.id, noticeDraft.value.trim())
  noticeEditOpen.value = false
  window.$message?.success?.('群公告已保存')
}

async function togglePin(val: boolean) {
  await store.updateRoomSettings(props.room.id, { pinned: val })
}

async function toggleMute(val: boolean) {
  await store.updateRoomSettings(props.room.id, { muted: val })
}

function handleMemberTap(acc: VlAccount) {
  selectedMember.value = acc
  memberSheetOpen.value = true
}

async function openDmFromMember(botId: string) {
  memberSheetOpen.value = false
  await store.openDmWithBot(botId)
  emit('switchRoom')
}

function editMemberProfile(accountId: string) {
  memberSheetOpen.value = false
  store.openProfileModal(accountId)
}

function openMemberBotHome(botId: string) {
  memberSheetOpen.value = false
  store.openBotHomeDrawer(botId)
}

async function removeMember(accountId: string) {
  memberSheetOpen.value = false
  await store.removeMemberFromGroup(props.room.id, accountId)
}

async function inviteBot(botId: string) {
  await store.addBotToGroup(props.room.id, botId)
  inviteModalOpen.value = false
  window.$message?.success?.('已邀请加入协作群')
}
</script>
