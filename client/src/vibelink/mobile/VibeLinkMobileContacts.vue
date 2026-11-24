<template>
  <MobileScaffold>
    <template #container>
      <div class="flex flex-col overflow-hidden h-full relative" data-testid="mobile-bots-view">
        <NavBar>
          <template #center>
            <span class="text-16px font-semibold text-[var(--text-color)]">联系人</span>
          </template>
          <template #right>
            <n-dropdown
              trigger="click"
              :show-arrow="true"
              :options="addOptions"
              @select="handleDropdownSelect">
              <n-button round strong secondary size="small">
                <template #icon>
                  <n-icon>
                    <svg><use href="#plus" /></svg>
                  </n-icon>
                </template>
              </n-button>
            </n-dropdown>
          </template>
        </NavBar>

        <div class="px-16px mt-2 mb-10px shrink-0">
          <n-input
            v-model:value="searchText"
            class="rounded-8px w-full text-12px"
            :maxlength="30"
            clearable
            spellcheck="false"
            autocomplete="off"
            placeholder="搜索 Bot 或协作群">
            <template #prefix>
              <svg class="w-14px h-14px text-[#909090]"><use href="#search" /></svg>
            </template>
          </n-input>
        </div>

        <n-card
          :segmented="{ content: true, footer: 'soft' }"
          :bordered="false"
          class="custom-rounded flex-1 min-h-0 flex flex-col"
          header-class="py-12px! px-16px! text-14px!"
          content-class="p-0! flex-1 min-h-0 flex flex-col"
          title="Bot 调度与群组">
          <template #header-extra>
            <button
              type="button"
              class="flex items-center gap-4px bg-transparent border-0 text-12px text-[#13987f] cursor-pointer p-0"
              @click="$emit('goSettings')">
              <span>已接入 {{ store.bots.length }} 个</span>
              <svg class="w-14px h-14px"><use href="#right" /></svg>
            </button>
          </template>

          <n-tabs type="segment" animated class="px-12px pt-4px flex-1 min-h-0 flex flex-col">
            <n-tab-pane name="bots" tab="Bot 好友">
              <div class="overflow-y-auto max-h-[calc(100vh-280px)] pb-16px">
                <n-collapse :default-expanded-names="['default-bots']">
                  <n-collapse-item title="我的 Bot 好友" name="default-bots">
                    <template #header-extra>
                      <span class="text-11px text-[#888]">{{ onlineBotsCount }}/{{ filteredBots.length }}</span>
                    </template>

                    <div
                      v-if="filteredBots.length === 0"
                      class="py-24px text-center text-12.5px text-[#888]">
                      {{ store.connected ? '暂无已配置的 Bot' : '未连接控制面，请先配对' }}
                    </div>

                    <div
                      v-for="bot in filteredBots"
                      :key="bot.id"
                      class="flex items-center gap-10px px-8px py-10px rounded-10px hover:bg-[var(--list-hover-color)] cursor-pointer"
                      @click="$emit('openBotDm', bot.id)">
                      <button
                        type="button"
                        class="p-0 border-0 bg-transparent rounded-full cursor-pointer shrink-0 relative"
                        title="编辑名字与头像"
                        @click.stop="store.openProfileModal(bot.id)">
                        <VlAvatar
                          :avatar="bot.avatar"
                          :name="bot.displayName"
                          :provider="bot.provider"
                          :size="44" />
                        <span
                          class="w-10px h-10px rounded-full border-2 border-[var(--card)] absolute right-0 bottom-0"
                          :style="{ backgroundColor: presenceColor(bot.presence) }"></span>
                      </button>

                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-6px min-w-0">
                          <span class="text-14px font-semibold text-[var(--text-color)] truncate">
                            {{ bot.displayName }}
                          </span>
                          <span class="px-5px py-1px rounded bg-[#13987f]/16 text-[#13987f] dark:text-[#5eead4] text-10.5px shrink-0">
                            @{{ bot.handle }}
                          </span>
                        </div>
                        <div class="text-12px text-[#777] dark:text-[#9ca3af] truncate mt-2px">
                          [{{ formatPresenceText(bot.presence) }} · {{ bot.provider }}{{ bot.model ? ` · ${bot.model}` : '' }}]
                        </div>
                      </div>

                      <n-button
                        size="tiny"
                        secondary
                        round
                        class="shrink-0"
                        @click.stop="store.openBotHomeDrawer(bot.id)">
                        Home
                      </n-button>
                    </div>
                  </n-collapse-item>
                </n-collapse>
              </div>
            </n-tab-pane>

            <n-tab-pane name="groups" tab="协作群">
              <div class="overflow-y-auto max-h-[calc(100vh-280px)] pb-16px">
                <n-collapse :default-expanded-names="['default-groups']">
                  <n-collapse-item title="多 Bot 协作群" name="default-groups">
                    <template #header-extra>
                      <span class="text-11px text-[#888]">{{ filteredGroups.length }}</span>
                    </template>

                    <div
                      v-if="filteredGroups.length === 0"
                      class="py-24px text-center text-12.5px text-[#888]">
                      暂无多 Bot 协作群
                    </div>

                    <div
                      v-for="room in filteredGroups"
                      :key="room.id"
                      class="flex items-center gap-10px px-8px py-10px rounded-10px hover:bg-[var(--list-hover-color)] cursor-pointer"
                      @click="$emit('enterRoom', room.id)">
                      <VlAvatar :avatar="room.avatar" :name="room.name" :size="44" />
                      <div class="flex-1 min-w-0">
                        <div class="text-14px font-semibold text-[var(--text-color)] truncate">
                          {{ room.name }}
                        </div>
                        <div class="text-12px text-[#777] dark:text-[#9ca3af] truncate mt-2px">
                          {{ room.memberCount }} 位成员 · {{ stripMarkdownPreview(room.notice) || '多 Bot 接力群' }}
                        </div>
                      </div>
                      <svg class="w-16px h-16px text-[#888] shrink-0"><use href="#right" /></svg>
                    </div>
                  </n-collapse-item>
                </n-collapse>
              </div>
            </n-tab-pane>
          </n-tabs>
        </n-card>
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
import { formatPresenceText, stripMarkdownPreview } from './mobileFormat'

const emit = defineEmits<{
  openBotDm: [botId: string]
  enterRoom: [roomId: string]
  goSettings: []
  createBot: []
  createGroup: []
}>()

const store = useVibeLinkStore()
const searchText = ref('')

const filteredBots = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  if (!q) return store.bots
  return store.bots.filter(
    (b) =>
      b.displayName.toLowerCase().includes(q) ||
      b.handle.toLowerCase().includes(q) ||
      b.provider.toLowerCase().includes(q)
  )
})

const onlineBotsCount = computed(
  () => filteredBots.value.filter((b) => b.presence !== 'offline' && b.presence !== 'error').length
)

const filteredGroups = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  return store.sortedRooms.filter((r) => {
    if (r.kind !== 'group') return false
    if (!q) return true
    return r.name.toLowerCase().includes(q)
  })
})

const renderImgIcon = (src: string) => () =>
  h('img', {
    src,
    style: 'display:block; width: 20px; height: 20px; object-fit: contain;',
    class: 'dark:invert'
  })

const addOptions = [
  { label: '发起多 Bot 协作群', key: 'create-group', icon: renderImgIcon(groupChatIcon) },
  { label: '新建 Bot 好友', key: 'create-bot', icon: renderImgIcon(addFriendIcon) }
]

function handleDropdownSelect(key: string) {
  if (key === 'create-group') emit('createGroup')
  else if (key === 'create-bot') emit('createBot')
}
</script>

<style scoped>
.custom-rounded {
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  overflow: hidden;
}
</style>
