<template>
  <div
    v-if="bot"
    class="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-xs"
    data-testid="bot-home-drawer"
    @click.self="$emit('close')">
    <div class="w-full max-w-680px h-full bg-[#1e1e1e] border-l border-[#343434] flex flex-col text-[#eaeaea] shadow-2xl">
      <div class="flex items-center justify-between px-4 py-3 bg-[#242424] border-b border-[#343434]">
        <div class="flex items-center gap-3 min-w-0">
          <button
            type="button"
            class="border-0 p-0 bg-transparent rounded-full cursor-pointer shrink-0"
            title="编辑 Bot 名字与头像"
            @click="store.openProfileModal(bot.id)">
            <VlAvatar
              :avatar="bot.avatar"
              :name="bot.displayName"
              :provider="bot.provider"
              :size="36" />
          </button>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-15px font-semibold truncate">{{ bot.displayName }}</span>
              <span class="px-1.5 py-0.5 rounded bg-[#1d4940] text-[#5eead4] text-11px">@{{ bot.handle }}</span>
              <span class="text-11px text-[#9ca3af]">{{ bot.provider }} / {{ bot.model || 'default' }}</span>
            </div>
            <div class="text-11.5px text-[#8e9297] truncate">{{ bot.roleTitle }} · {{ bot.cwd }}</div>
          </div>
        </div>
        <button
          type="button"
          class="px-2.5 py-1 rounded bg-[#2e2e2e] hover:bg-[#3b3b3b] border-0 text-[#ccc] cursor-pointer text-12px"
          @click="$emit('close')">
          关闭
        </button>
      </div>

      <div class="px-4 py-2.5 bg-[#212423] border-b border-[#303634] flex flex-wrap items-center gap-2 text-12px">
        <button
          type="button"
          :class="viewTab === 'files' ? 'bg-[#13987f] text-white' : 'bg-[#2b2f2e] text-[#cbd5e1]'"
          class="px-3 py-1 rounded-6px border-0 cursor-pointer"
          @click="viewTab = 'files'">
          Bot Home 文件
        </button>
        <button
          type="button"
          :class="viewTab === 'profile' ? 'bg-[#13987f] text-white' : 'bg-[#2b2f2e] text-[#cbd5e1]'"
          class="px-3 py-1 rounded-6px border-0 cursor-pointer"
          @click="viewTab = 'profile'">
          模型与工作区配置
        </button>
        <div class="flex-1"></div>
        <button
          type="button"
          class="px-3 py-1 rounded-6px border border-[#2d5b51] bg-[#1d4940] hover:bg-[#13987f] text-[#ecfdf5] cursor-pointer"
          @click="handleTidyMemory">
          整理记忆 (40条预算)
        </button>
      </div>

      <div v-if="noticeText" class="px-4 py-1.5 bg-[#17362f] text-[#a7f3d0] text-12px border-b border-[#255248]">
        {{ noticeText }}
      </div>

      <div v-if="viewTab === 'files'" class="flex-1 min-h-0 flex">
        <div class="w-185px border-r border-[#303030] bg-[#191919] p-2 flex flex-col gap-1 vl-scroll">
          <button
            v-for="f in fileEntries"
            :key="f.path"
            type="button"
            class="text-left px-2.5 py-1.5 rounded-6px border-0 cursor-pointer text-12px font-mono truncate"
            :class="selectedFile === f.path ? 'bg-[#1d4940] text-[#ecfdf5]' : 'bg-transparent text-[#b9c0c4] hover:bg-[#252525]'"
            @click="loadFile(f.path)">
            {{ f.path }}
          </button>

          <div class="mt-2 pt-2 border-t border-[#2d2d2d] space-y-1.5">
            <input
              v-model="newSkillName"
              type="text"
              placeholder="新建 skill 名 (如 review)"
              class="w-full box-border px-2 py-1 rounded bg-[#252525] border border-[#383838] text-11.5px text-[#eaeaea] outline-none" />
            <button
              type="button"
              class="w-full py-1 rounded bg-[#2b2f2e] hover:bg-[#383d3c] border-0 text-[#cbd5e1] text-11.5px cursor-pointer"
              @click="createNewSkill">
              + 新建 Skill
            </button>
          </div>
        </div>

        <div class="flex-1 min-w-0 flex flex-col p-3 gap-2">
          <div class="flex items-center justify-between text-12px text-[#9ca3af]">
            <span class="font-mono text-[#5eead4]">{{ selectedFile }}</span>
            <button
              type="button"
              :disabled="savingFile"
              class="px-3.5 py-1 rounded-6px border-0 cursor-pointer bg-[#13987f] hover:bg-[#17ad91] disabled:opacity-50 text-white text-12px font-medium"
              data-testid="bot-home-save-file"
              @click="saveCurrentFile">
              {{ savingFile ? '保存中...' : '保存文件' }}
            </button>
          </div>
          <textarea
            v-model="fileContent"
            data-testid="bot-home-file-editor"
            class="flex-1 w-full box-border resize-none rounded-8px bg-[#141414] border border-[#343434] p-3 text-12.5px font-mono text-[#eaeaea] leading-relaxed outline-none focus:border-[#13987f]"
            spellcheck="false"></textarea>
        </div>
      </div>

      <div v-else class="flex-1 p-4 space-y-3 vl-scroll">
        <div class="grid grid-cols-2 gap-3">
          <label class="space-y-1 text-12px">
            <span class="text-[#9ca3af]">显示名称</span>
            <input
              v-model="profileForm.displayName"
              class="w-full box-border px-3 py-1.5 rounded bg-[#141414] border border-[#383838] text-[#eaeaea] outline-none" />
          </label>
          <label class="space-y-1 text-12px">
            <span class="text-[#9ca3af]">@Handle（群聊点名）</span>
            <input
              v-model="profileForm.handle"
              class="w-full box-border px-3 py-1.5 rounded bg-[#141414] border border-[#383838] text-[#eaeaea] outline-none" />
          </label>
          <label class="space-y-1 text-12px">
            <span class="text-[#9ca3af]">Provider / 驱动引擎</span>
            <select
              v-model="profileForm.provider"
              class="w-full box-border px-3 py-1.5 rounded bg-[#141414] border border-[#383838] text-[#eaeaea] outline-none">
              <option value="antigravity">antigravity (Gemini / AG)</option>
              <option value="claude">claude (Claude Agent)</option>
              <option value="opencode">opencode (OpenCode)</option>
              <option value="codex">codex (Codex CLI)</option>
            </select>
          </label>
          <label class="space-y-1 text-12px">
            <span class="text-[#9ca3af]">Model</span>
            <input
              v-model="profileForm.model"
              class="w-full box-border px-3 py-1.5 rounded bg-[#141414] border border-[#383838] text-[#eaeaea] outline-none" />
          </label>
        </div>
        <label class="block space-y-1 text-12px">
          <span class="text-[#9ca3af]">岗位职责 (roleTitle)</span>
          <input
            v-model="profileForm.roleTitle"
            class="w-full box-border px-3 py-1.5 rounded bg-[#141414] border border-[#383838] text-[#eaeaea] outline-none" />
        </label>
        <label class="block space-y-1 text-12px">
          <span class="text-[#9ca3af]">默认工作目录 (cwd)</span>
          <input
            v-model="profileForm.cwd"
            class="w-full box-border px-3 py-1.5 rounded bg-[#141414] border border-[#383838] font-mono text-[#eaeaea] outline-none" />
        </label>
        <label class="block space-y-1 text-12px">
          <span class="text-[#9ca3af]">简介 / 人设说明</span>
          <textarea
            v-model="profileForm.description"
            rows="3"
            class="w-full box-border px-3 py-1.5 rounded bg-[#141414] border border-[#383838] text-[#eaeaea] outline-none"></textarea>
        </label>
        <div class="pt-2 flex justify-end">
          <button
            type="button"
            class="px-4 py-1.5 rounded-6px border-0 cursor-pointer bg-[#13987f] hover:bg-[#17ad91] text-white text-12.5px font-medium"
            @click="saveProfile">
            保存配置
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useVibeLinkStore } from '../store'
import type { VlBotFileEntry } from '../types'
import VlAvatar from './VlAvatar.vue'

const props = defineProps<{
  botId: string | null
}>()

defineEmits<{
  close: []
}>()

const store = useVibeLinkStore()
const viewTab = ref<'files' | 'profile'>('files')
const files = ref<VlBotFileEntry[]>([])
const selectedFile = ref('SOUL.md')
const fileContent = ref('')
const savingFile = ref(false)
const newSkillName = ref('')
const noticeText = ref('')

const profileForm = reactive({
  displayName: '',
  handle: '',
  provider: 'codex',
  model: '',
  roleTitle: '',
  cwd: '',
  description: ''
})

const bot = computed(() => {
  if (!props.botId) return null
  return store.accountsById[props.botId] ?? null
})

const fileEntries = computed<VlBotFileEntry[]>(() => {
  const defaults = ['SOUL.md', 'MEMORY.md', 'tools.json', 'bot.json']
  const seen = new Set<string>()
  const list: VlBotFileEntry[] = []
  for (const name of defaults) {
    const found = files.value.find((f) => f.path === name)
    if (found) {
      list.push(found)
      seen.add(name)
    } else {
      list.push({ path: name, name, kind: 'file', sizeBytes: 0, updatedAt: Date.now() })
      seen.add(name)
    }
  }
  for (const f of files.value) {
    if (f.kind === 'file' && !seen.has(f.path)) {
      list.push(f)
      seen.add(f.path)
    }
  }
  return list
})

async function refreshBotHome() {
  if (!bot.value) return
  profileForm.displayName = bot.value.displayName
  profileForm.handle = bot.value.handle
  profileForm.provider = bot.value.provider || 'codex'
  profileForm.model = bot.value.model
  profileForm.roleTitle = bot.value.roleTitle
  profileForm.cwd = bot.value.cwd
  profileForm.description = bot.value.description
  try {
    files.value = await store.listBotFiles(bot.value.id)
  } catch {
    files.value = []
  }
  await loadFile(selectedFile.value || 'SOUL.md')
}

async function loadFile(relPath: string) {
  if (!bot.value) return
  selectedFile.value = relPath
  try {
    fileContent.value = await store.readBotFile(bot.value.id, relPath)
  } catch {
    fileContent.value = ''
  }
}

async function saveCurrentFile() {
  if (!bot.value || !selectedFile.value) return
  savingFile.value = true
  try {
    await store.writeBotFile(bot.value.id, selectedFile.value, fileContent.value)
    files.value = await store.listBotFiles(bot.value.id)
    noticeText.value = `已保存 ${selectedFile.value}`
  } catch (err) {
    noticeText.value = `保存失败: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    savingFile.value = false
  }
}

async function createNewSkill() {
  if (!bot.value) return
  const clean = newSkillName.value.trim().replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  if (!clean) return
  const path = `skills/${clean}.md`
  const starter = `# Skill: ${clean}\n\n适用场景：请在此描述该技能的触发条件与步骤。\n`
  await store.writeBotFile(bot.value.id, path, starter)
  newSkillName.value = ''
  files.value = await store.listBotFiles(bot.value.id)
  await loadFile(path)
  noticeText.value = `已创建技能 ${path}`
}

async function handleTidyMemory() {
  if (!bot.value) return
  try {
    const res = await store.tidyBotMemory(bot.value.id)
    noticeText.value = `记忆整理完成 (${JSON.stringify(res)})`
    if (selectedFile.value === 'MEMORY.md') {
      await loadFile('MEMORY.md')
    }
  } catch (err) {
    noticeText.value = `记忆整理失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function saveProfile() {
  if (!bot.value) return
  try {
    await store.updateBotProfile(bot.value.id, { ...profileForm })
    noticeText.value = 'Bot 配置已更新'
  } catch (err) {
    noticeText.value = `更新失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

watch(
  () => props.botId,
  (id) => {
    noticeText.value = ''
    selectedFile.value = 'SOUL.md'
    viewTab.value = 'files'
    if (id) {
      void refreshBotHome()
    }
  },
  { immediate: true }
)
</script>
