<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs"
    data-testid="server-settings-modal"
    @click.self="$emit('close')">
    <div class="w-full max-w-520px rounded-12px bg-[#1f2222] border border-[#353a39] text-[#eaeaea] shadow-2xl overflow-hidden">
      <div class="flex items-center justify-between px-4 py-3 bg-[#242828] border-b border-[#343938]">
        <span class="text-15px font-semibold">VibeLink 服务器与运行态面板</span>
        <button
          type="button"
          class="px-2 py-0.5 rounded bg-[#2d3232] border-0 text-[#ccc] cursor-pointer text-12px"
          @click="$emit('close')">
          关闭
        </button>
      </div>

      <div class="p-4 space-y-4">
        <div class="space-y-2.5">
          <label class="block space-y-1 text-12px">
            <span class="text-[#a3a3a3]">Server URL（桌面默认 http://127.0.0.1:18990，移动端可配 LAN 地址）</span>
            <input
              v-model="urlInput"
              type="text"
              placeholder="http://127.0.0.1:18990"
              class="w-full box-border px-3 py-2 rounded-6px bg-[#141616] border border-[#383d3c] text-[#eaeaea] font-mono text-12.5px outline-none focus:border-[#13987f]" />
          </label>

          <label class="block space-y-1 text-12px">
            <span class="text-[#a3a3a3]">Bearer Token（非本机访问时必填，来自 server 启动目录 auth-token.txt）</span>
            <input
              v-model="tokenInput"
              type="password"
              placeholder="可选；本机 loopback 自动放行"
              class="w-full box-border px-3 py-2 rounded-6px bg-[#141616] border border-[#383d3c] text-[#eaeaea] font-mono text-12.5px outline-none focus:border-[#13987f]" />
          </label>
        </div>

        <div v-if="statusBanner" class="px-3 py-2 rounded-6px bg-[#182f2a] border border-[#245147] text-[#a7f3d0] text-12px">
          {{ statusBanner }}
        </div>
        <div v-if="errorBanner" class="px-3 py-2 rounded-6px bg-[#3b1d1d] border border-[#5f2f2f] text-[#fecaca] text-12px">
          {{ errorBanner }}
        </div>

        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded-6px bg-[#2a2f2e] hover:bg-[#363c3b] border-0 text-[#e5e7eb] text-12px cursor-pointer"
            @click="handleTest">
            测试连接
          </button>
          <button
            type="button"
            class="px-3.5 py-1.5 rounded-6px bg-[#13987f] hover:bg-[#17ad91] border-0 text-white text-12px font-medium cursor-pointer"
            @click="handleSaveReconnect">
            保存并重连
          </button>
        </div>

        <div class="border-t border-[#303534] pt-3 space-y-2">
          <div class="flex items-center justify-between text-12px text-[#9ca3af]">
            <span>本地控制面状态（只读，不动 WProxy / opencode-mesh / rshell 系统服务）</span>
            <button
              type="button"
              class="text-11.5px text-[#5eead4] bg-transparent border-0 cursor-pointer"
              @click="refreshInfra">
              刷新
            </button>
          </div>

          <div
            v-if="store.infraStatus"
            class="grid grid-cols-2 gap-x-4 gap-y-1.5 p-3 rounded-8px bg-[#161919] border border-[#2c3130] text-11.5px font-mono text-[#cbd5e1]">
            <div>PID: {{ store.infraStatus.pid }}</div>
            <div>Uptime: {{ store.infraStatus.uptimeSec }}s</div>
            <div>Bots: {{ store.infraStatus.botsTotal }} (工作中 {{ store.infraStatus.botsWorking }})</div>
            <div>Rooms: {{ store.infraStatus.roomsTotal }} / PTY: {{ store.infraStatus.activeTerminals }}</div>
            <div>MockBots: {{ store.infraStatus.mockBots ? 'ON' : 'OFF' }}</div>
            <div>LatestSeq: {{ store.infraStatus.latestSeq }}</div>
            <div class="col-span-2 truncate text-[#94a3b8]">Home: {{ store.infraStatus.homeDir }}</div>
          </div>
          <div v-else class="text-12px text-[#767676]">暂未获取到控制面运行指标</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useVibeLinkStore } from '../store'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const store = useVibeLinkStore()
const urlInput = ref(store.serverUrl)
const tokenInput = ref(store.authToken)
const statusBanner = ref('')
const errorBanner = ref('')

async function refreshInfra() {
  await store.fetchInfraStatus()
}

async function handleTest() {
  errorBanner.value = ''
  statusBanner.value = ''
  try {
    const res = await store.testConnection(urlInput.value, tokenInput.value)
    statusBanner.value = `连接正常 · bots=${res.botsCount}, rooms=${res.roomsCount}, mock=${res.mockBots}`
  } catch (err) {
    errorBanner.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleSaveReconnect() {
  errorBanner.value = ''
  statusBanner.value = ''
  try {
    await store.reconnect(urlInput.value, tokenInput.value)
    await refreshInfra()
    statusBanner.value = '已重新连接并同步会话数据'
    emit('close')
  } catch (err) {
    errorBanner.value = err instanceof Error ? err.message : String(err)
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      urlInput.value = store.serverUrl
      tokenInput.value = store.authToken
      statusBanner.value = ''
      errorBanner.value = ''
      void refreshInfra()
    }
  }
)
</script>
