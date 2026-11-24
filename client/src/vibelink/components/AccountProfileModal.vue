<template>
  <div
    v-if="account"
    class="fixed inset-0 z-55 flex items-center justify-center bg-black/60 backdrop-blur-xs p-3"
    data-testid="account-profile-modal"
    @click.self="$emit('close')">
    <div class="w-full max-w-500px rounded-12px bg-[#1f2222] border border-[#353a39] text-[#eaeaea] shadow-2xl overflow-hidden flex flex-col max-h-[84vh]">
      <div class="flex items-center justify-between px-4 py-3 bg-[#242828] border-b border-[#343938]">
        <span class="text-15px font-semibold">
          {{ account.id === 'me' ? '编辑个人资料与头像' : `编辑 Bot 资料 · ${account.displayName}` }}
        </span>
        <button
          type="button"
          class="px-2 py-0.5 rounded bg-[#2d3232] border-0 text-[#ccc] cursor-pointer text-12px"
          @click="$emit('close')">
          关闭
        </button>
      </div>

      <div class="p-4 space-y-4 vl-scroll flex-1 min-h-0">
        <!-- Top Preview + Basic Identity -->
        <div class="flex items-start gap-4">
          <div class="flex flex-col items-center gap-1.5 shrink-0">
            <button
              type="button"
              class="relative p-0 border-0 bg-transparent rounded-full cursor-pointer group"
              title="点击上传自定义头像图片"
              @click="avatarFileInputRef?.click()">
              <VlAvatar
                :avatar="form.avatar"
                :name="form.displayName || account.displayName"
                :provider="account.provider"
                :size="72" />
              <span class="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-11px text-white">
                {{ uploading ? '上传中' : '换头像' }}
              </span>
            </button>
            <button
              type="button"
              class="px-2 py-0.5 rounded bg-[#2a2f2e] hover:bg-[#363d3b] border-0 text-[#99f6e4] text-11px cursor-pointer"
              @click="avatarFileInputRef?.click()">
              上传本地图片
            </button>
            <input
              ref="avatarFileInputRef"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              class="hidden"
              @change="handleUploadAvatar" />
          </div>

          <div class="flex-1 min-w-0 space-y-2.5 text-12px">
            <label class="block space-y-1">
              <span class="text-[#9ca3af]">名称</span>
              <input
                v-model="form.displayName"
                type="text"
                data-testid="profile-display-name-input"
                placeholder="输入显示名字"
                class="vl-profile-input" />
            </label>

            <div v-if="account.kind === 'bot'" class="grid grid-cols-2 gap-2">
              <label class="space-y-1">
                <span class="text-[#9ca3af]">@Handle（群点名）</span>
                <input v-model="form.handle" type="text" class="vl-profile-input" />
              </label>
              <label class="space-y-1">
                <span class="text-[#9ca3af]">角色标签</span>
                <input v-model="form.roleTitle" type="text" class="vl-profile-input" />
              </label>
            </div>

            <label v-else class="block space-y-1">
              <span class="text-[#9ca3af]">在线状态</span>
              <select v-model="form.presence" class="vl-profile-input">
                <option value="online">在线</option>
                <option value="idle">忙碌</option>
                <option value="offline">隐身</option>
              </select>
            </label>

            <label class="block space-y-1">
              <span class="text-[#9ca3af]">状态签名</span>
              <input v-model="form.statusText" type="text" placeholder="一句话状态..." class="vl-profile-input" />
            </label>
          </div>
        </div>

        <!-- HuLa Built-in Image Avatar Presets -->
        <div class="space-y-2">
          <div class="text-12px text-[#9ca3af]">HuLa 内置头像库</div>
          <div class="grid grid-cols-5 sm:grid-cols-7 gap-2 max-h-180px vl-scroll p-2 rounded-8px bg-[#161919] border border-[#2d3231]">
            <button
              v-for="item in HULA_PRESET_AVATARS"
              :key="item.value"
              type="button"
              :title="item.label"
              :data-testid="presetTestId(item.value)"
              class="p-1 rounded-8px border-2 cursor-pointer bg-[#222525] flex items-center justify-center transition-colors"
              :class="form.avatar === item.value ? 'border-[#13987f] bg-[#163630]' : 'border-transparent hover:border-[#4b5563]'"
              @click="form.avatar = item.value">
              <img :src="item.value" :alt="item.label" class="w-38px h-38px rounded-full object-cover block" />
            </button>
          </div>
        </div>

        <!-- Color Monogram Presets & Custom URL -->
        <div class="space-y-2">
          <div class="text-12px text-[#9ca3af]">字母徽章预设 / 自定义头像 URL</div>
          <div class="flex flex-wrap items-center gap-1.5">
            <button
              v-for="item in MONOGRAM_PRESET_AVATARS"
              :key="item.value"
              type="button"
              :data-testid="presetTestId(item.value)"
              class="p-0.5 rounded-full border-2 cursor-pointer bg-transparent"
              :class="form.avatar === item.value ? 'border-[#13987f]' : 'border-transparent'"
              @click="form.avatar = item.value">
              <VlAvatar :avatar="item.value" :name="item.label" :size="30" />
            </button>
          </div>
          <input
            v-model="form.avatar"
            type="text"
            placeholder="或直接填写图片 URL，如 https://... 或 /avatar/001.webp"
            class="vl-profile-input font-mono text-11.5px" />
        </div>

        <div v-if="errorText" class="px-3 py-1.5 rounded bg-[#3b1d1d] border border-[#5f2f2f] text-[#fecaca] text-12px">
          {{ errorText }}
        </div>
      </div>

      <div class="px-4 py-3 bg-[#242828] border-t border-[#343938] flex items-center justify-between gap-2">
        <button
          v-if="account.kind === 'bot'"
          type="button"
          class="bg-transparent border-0 text-[#5eead4] hover:text-[#99f6e4] text-12px cursor-pointer"
          @click="openBotHome">
          打开 Bot Home (SOUL/MEMORY) &gt;
        </button>
        <span v-else></span>

        <div class="flex items-center gap-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded-6px bg-[#2c3030] border-0 text-[#ddd] text-12px cursor-pointer"
            @click="$emit('close')">
            取消
          </button>
          <button
            type="button"
            data-testid="profile-save-btn"
            :disabled="saving || !form.displayName.trim()"
            class="px-4 py-1.5 rounded-6px bg-[#13987f] hover:bg-[#17ad91] disabled:opacity-50 border-0 text-white text-12px font-medium cursor-pointer"
            @click="handleSave">
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { HULA_PRESET_AVATARS, MONOGRAM_PRESET_AVATARS } from '../avatar'
import { useVibeLinkStore } from '../store'
import type { VlPresence } from '../types'
import VlAvatar from './VlAvatar.vue'

const props = defineProps<{
  accountId: string | null
}>()

const emit = defineEmits<{
  close: []
  openBotHome: [botId: string]
}>()

const store = useVibeLinkStore()
const avatarFileInputRef = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const saving = ref(false)
const errorText = ref('')

const form = reactive({
  displayName: '',
  handle: '',
  roleTitle: '',
  statusText: '',
  avatar: '',
  presence: 'online' as VlPresence
})

const account = computed(() =>
  props.accountId ? store.accountsById[props.accountId] ?? null : null
)

function presetTestId(val: string): string {
  return `avatar-preset-${val.replace(/[^a-zA-Z0-9]+/g, '_')}`
}

watch(
  () => account.value,
  (acc) => {
    errorText.value = ''
    if (!acc) return
    form.displayName = acc.displayName
    form.handle = acc.handle
    form.roleTitle = acc.roleTitle
    form.statusText = acc.statusText
    form.avatar = acc.avatar
    form.presence = acc.presence
  },
  { immediate: true }
)

async function handleUploadAvatar(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  uploading.value = true
  errorText.value = ''
  try {
    const res = await store.uploadAvatar(file)
    form.avatar = res.url
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  } finally {
    uploading.value = false
  }
}

async function handleSave() {
  if (!account.value || !form.displayName.trim()) return
  saving.value = true
  errorText.value = ''
  try {
    if (account.value.id === 'me') {
      await store.updateMeStatus({
        displayName: form.displayName.trim(),
        statusText: form.statusText.trim(),
        presence: form.presence,
        avatar: form.avatar.trim()
      })
    } else {
      await store.updateBotProfile(account.value.id, {
        displayName: form.displayName.trim(),
        handle: form.handle.trim() || account.value.handle,
        roleTitle: form.roleTitle.trim(),
        statusText: form.statusText.trim(),
        avatar: form.avatar.trim()
      })
    }
    emit('close')
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

function openBotHome() {
  if (!account.value || account.value.kind !== 'bot') return
  const id = account.value.id
  emit('close')
  emit('openBotHome', id)
}
</script>

<style scoped>
.vl-profile-input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  border-radius: 6px;
  background: #141616;
  border: 1px solid #383d3c;
  color: #eaeaea;
  font-size: 12.5px;
  outline: none;
}

.vl-profile-input:focus {
  border-color: #13987f;
}
</style>
