<template>
  <div class="flex-1 min-h-0 flex flex-col bg-[#222426]" :data-testid="`plugin-workspace-${plugin.id}`">
    <header class="vl-plugin-header" data-tauri-drag-region>
      <div class="flex items-center gap-2.5 min-w-0">
        <span class="text-15px font-semibold text-[#f3f3f3] truncate">
          {{ plugin.ui?.label || plugin.name }}
        </span>
        <span
          class="px-2 py-0.5 rounded-full text-11px shrink-0"
          :class="plugin.health.ok ? 'bg-[#143d2d] text-[#4ade80]' : 'bg-[#2c3030] text-[#cbd5e1]'">
          {{ statusChipText }}
        </span>
        <span
          v-if="plugin.capabilities.includes('modelCatalog') && plugin.modelsCount > 0"
          class="px-2 py-0.5 rounded bg-[#1d4940] text-[#5eead4] text-11px shrink-0">
          {{ plugin.modelsCount }} 模型
        </span>
      </div>

      <div class="flex items-center gap-2 shrink-0">
        <template v-if="plugin.ui?.viewMode === 'iframe'">
          <button
            type="button"
            class="px-2.5 py-1 rounded-6px bg-[#262b2a] hover:bg-[#323837] border border-[#383f3e] text-[#e5e7eb] text-12px cursor-pointer"
            @click="refreshEmbedPage">
            ↻ 刷新页面
          </button>
          <button
            type="button"
            :disabled="store.pluginsLoading"
            class="px-2.5 py-1 rounded-6px bg-[#20332f] hover:bg-[#1d4940] disabled:opacity-50 border border-[#2d584e] text-[#99f6e4] text-12px cursor-pointer"
            @click="syncAgentState">
            同步 Agent
          </button>
          <button
            type="button"
            :disabled="loading"
            class="px-2.5 py-1 rounded-6px bg-[#262b2a] hover:bg-[#323837] disabled:opacity-50 border border-[#383f3e] text-[#cbd5e1] text-12px cursor-pointer"
            @click="restartWebShell">
            重启内核页
          </button>
          <button
            v-if="plugin.id === 'magpie'"
            type="button"
            class="px-2.5 py-1 rounded-6px bg-[#262b2a] hover:bg-[#323837] border border-[#383f3e] text-[#93c5fd] text-12px cursor-pointer"
            @click="openNativeWindow">
            外部窗口打开
          </button>
        </template>

        <template v-else-if="plugin.ui?.viewMode === 'builtin_wproxy'">
          <button
            type="button"
            :disabled="store.wproxyLoading"
            class="px-2.5 py-1 rounded-6px bg-[#262b2a] hover:bg-[#323837] disabled:opacity-50 border border-[#383f3e] text-[#e5e7eb] text-12px cursor-pointer"
            @click="store.fetchWProxyStatus()">
            ↻ 刷新状态
          </button>
        </template>

        <div v-if="inTauri" class="flex items-center gap-1 ml-1 pl-2 border-l border-[#353535]">
          <button type="button" class="vl-win-btn" title="最小化" @click="minimizeWindowSafe">─</button>
          <button type="button" class="vl-win-btn" title="最大化" @click="toggleMaximizeWindowSafe">□</button>
          <button
            type="button"
            class="vl-win-btn hover:bg-[#c14053] hover:text-white"
            title="隐藏到托盘"
            @click="closeOrHideWindowSafe">
            ×
          </button>
        </div>
      </div>
    </header>

    <div
      v-if="actionNotice"
      class="px-4 py-1.5 bg-[#182f2a] border-b border-[#245147] text-[#a7f3d0] text-12px flex items-center justify-between">
      <span>{{ actionNotice }}</span>
      <button type="button" class="bg-transparent border-0 text-[#9ca3af] cursor-pointer text-12px" @click="actionNotice = ''">
        ×
      </button>
    </div>

    <!-- Embedded Original Plugin UI (e.g. Magpie Web) -->
    <div v-if="plugin.ui?.viewMode === 'iframe'" class="flex-1 min-h-0 flex flex-col relative bg-[#1a1a1e]">
      <div v-if="isRemoteLoopbackOnly" class="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
        <div class="text-15px font-semibold text-[#f3f3f3]">当前正在连接远程控制面 ({{ store.serverUrl }})</div>
        <div class="text-13px text-[#9ca3af] max-w-460px">
          原版 Magpie 控制台页面绑定在电脑宿主机本地回环地址（127.0.0.1），请在 PC 宿主桌面端直接打开，或继续在此同步已配置的 Agent。
        </div>
        <button
          type="button"
          :disabled="store.pluginsLoading"
          class="px-4 py-2 rounded-8px bg-[#13987f] hover:bg-[#17ad91] border-0 text-white text-13px cursor-pointer"
          @click="syncAgentState">
          立即同步 Agent
        </button>
      </div>

      <div v-else-if="loading" class="flex-1 flex flex-col items-center justify-center p-8 space-y-2">
        <div class="text-14px font-medium text-[#eaeaea]">正在启动原版 {{ plugin.ui?.label || plugin.name }} 界面...</div>
        <div class="text-12px text-[#8e9297]">复用本机配置与全部账号，无需重复登录</div>
      </div>

      <div v-else-if="errorMsg" class="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
        <div class="text-14px font-semibold text-[#fca5a5]">无法加载 {{ plugin.ui?.label || plugin.name }}</div>
        <div class="text-12.5px text-[#cbd5e1] max-w-480px whitespace-pre-wrap">{{ errorMsg }}</div>
        <button
          type="button"
          class="px-4 py-1.5 rounded-6px bg-[#13987f] hover:bg-[#17ad91] border-0 text-white text-12.5px cursor-pointer"
          @click="ensureEmbedReady">
          重试启动
        </button>
      </div>

      <iframe
        v-else-if="embedUrl"
        :key="`${embedUrl}#${iframeReloadKey}`"
        :src="embedUrl"
        :title="plugin.name"
        class="w-full flex-1 border-0 bg-[#1a1a1e]"
        allow="clipboard-read; clipboard-write" />
    </div>

    <!-- Built-in WProxy Full Workspace -->
    <div v-else-if="plugin.ui?.viewMode === 'builtin_wproxy'" class="flex-1 min-h-0 vl-scroll p-6 bg-[#242626]">
      <div class="max-w-960px mx-auto">
        <WProxyPanel />
      </div>
    </div>

    <!-- Fallback Generic Plugin View -->
    <div v-else class="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
      <div class="text-16px font-semibold text-[#eaeaea]">{{ plugin.name }}</div>
      <div class="text-13px text-[#9ca3af] max-w-460px">{{ plugin.description }}</div>
      <button
        type="button"
        class="px-4 py-1.5 rounded-6px bg-[#13987f] border-0 text-white text-12.5px cursor-pointer"
        @click="store.openServerSettings('plugins')">
        前往插件中心管理
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  closeOrHideWindowSafe,
  isTauriRuntime,
  minimizeWindowSafe,
  toggleMaximizeWindowSafe
} from '../runtime'
import { useVibeLinkStore } from '../store'
import type { VlPluginSummary } from '../types'
import WProxyPanel from './WProxyPanel.vue'

const props = defineProps<{
  plugin: VlPluginSummary
  visible: boolean
}>()

const store = useVibeLinkStore()
const inTauri = isTauriRuntime()

const loading = ref(false)
const errorMsg = ref('')
const embedUrl = ref('')
const iframeReloadKey = ref(0)
const actionNotice = ref('')

const isRemoteLoopbackOnly = computed(() => {
  if (!embedUrl.value) return false
  try {
    const serverHost = new URL(store.serverUrl).hostname.toLowerCase()
    const targetHost = new URL(embedUrl.value).hostname.toLowerCase()
    const serverLocal = serverHost === '127.0.0.1' || serverHost === 'localhost' || serverHost === '::1'
    const targetLocal = targetHost === '127.0.0.1' || targetHost === 'localhost'
    return targetLocal && !serverLocal
  } catch {
    return false
  }
})

const statusChipText = computed(() => {
  if (props.plugin.id === 'wproxy' && store.wproxyStatus) {
    return store.wproxyStatus.running
      ? `运行中 · ${store.wproxyStatus.activeNode || store.wproxyStatus.routeMode}`
      : '未运行'
  }
  const ver = props.plugin.health.version ? ` v${props.plugin.health.version}` : ''
  if (props.plugin.health.status === 'running') return `运行中${ver}`
  if (props.plugin.health.status === 'installed_idle') return `待命${ver}`
  if (props.plugin.health.status === 'not_installed') return '未安装'
  return props.plugin.health.message || '待检查'
})

async function ensureEmbedReady() {
  if (props.plugin.ui?.viewMode !== 'iframe') return
  if (props.plugin.ui.url) {
    embedUrl.value = props.plugin.ui.url
    return
  }
  loading.value = true
  errorMsg.value = ''
  try {
    const action = props.plugin.ui.embedAction || 'ensureWebUi'
    const res = await store.invokePluginAction<{
      ok?: boolean
      embedUrl?: string
      message?: string
    }>(props.plugin.id, action)
    if (!res.ok || !res.embedUrl) {
      errorMsg.value = res.message || '未能获取到插件页面地址'
      return
    }
    embedUrl.value = res.embedUrl
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function refreshEmbedPage() {
  if (!embedUrl.value) {
    void ensureEmbedReady()
    return
  }
  iframeReloadKey.value += 1
}

async function restartWebShell() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await store.invokePluginAction<{
      ok?: boolean
      embedUrl?: string
      message?: string
    }>(props.plugin.id, 'restartWebUi')
    if (!res.ok || !res.embedUrl) {
      errorMsg.value = res.message || '重启 Magpie 内核页失败'
      return
    }
    embedUrl.value = res.embedUrl
    iframeReloadKey.value += 1
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function syncAgentState() {
  actionNotice.value = ''
  try {
    await store.syncPlugins(props.plugin.id)
    actionNotice.value = '已同步最新 Agent 与模型目录至 VibeLink'
  } catch (err) {
    actionNotice.value = err instanceof Error ? err.message : String(err)
  }
}

async function openNativeWindow() {
  try {
    await store.invokePluginAction(props.plugin.id, 'openNativeWindow')
  } catch (err) {
    actionNotice.value = err instanceof Error ? err.message : String(err)
  }
}

onMounted(() => {
  if (props.visible && props.plugin.ui?.viewMode === 'iframe' && !embedUrl.value) {
    void ensureEmbedReady()
  }
})

watch(
  () => props.visible,
  (isVisible) => {
    if (isVisible && props.plugin.ui?.viewMode === 'iframe' && !embedUrl.value && !loading.value) {
      void ensureEmbedReady()
    }
    if (isVisible && props.plugin.ui?.viewMode === 'builtin_wproxy') {
      void store.fetchWProxyStatus()
    }
  }
)
</script>

<style scoped>
.vl-plugin-header {
  height: 48px;
  flex-shrink: 0;
  padding: 0 14px;
  background: var(--vl-header-bg);
  border-bottom: 1px solid #323232;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
