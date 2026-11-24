<template>
  <div class="space-y-3 text-12px text-[#eaeaea]" data-testid="wproxy-panel">
    <!-- Top Status Card -->
    <div class="rounded-10px bg-[#171a1a] border border-[#2f3534] p-3.5 space-y-2.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span
            class="w-2.5 h-2.5 rounded-full shrink-0"
            :class="status?.running ? 'bg-[#22c55e]' : 'bg-[#ef4444]'"></span>
          <span class="text-13.5px font-semibold truncate">
            {{ status?.running ? `WProxy · ${status.activeNode || '未选择'}` : 'WProxy 未连接或已停用' }}
          </span>
          <span
            v-if="status?.version"
            class="px-1.5 py-0.2 rounded bg-[#262d2c] text-[#cbd5e1] text-10.5px font-mono">
            {{ status.version }}
          </span>
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            :disabled="store.wproxyLoading"
            data-testid="wproxy-refresh-btn"
            class="px-2.5 py-1 rounded-6px bg-[#262b2a] hover:bg-[#323837] disabled:opacity-50 border-0 text-[#e5e7eb] text-11.5px cursor-pointer"
            @click="handleRefresh">
            刷新
          </button>
          <button
            type="button"
            :disabled="store.wproxyLoading || !status?.running"
            data-testid="wproxy-probe-egress-btn"
            class="px-2.5 py-1 rounded-6px bg-[#1d4940] hover:bg-[#13987f] disabled:opacity-50 border-0 text-[#ecfdf5] text-11.5px cursor-pointer"
            @click="handleProbeEgress">
            测出口 IP
          </button>
        </div>
      </div>

      <div
        v-if="status"
        class="grid gap-x-3 gap-y-1 text-11px font-mono text-[#a3b1b0]"
        :class="compact ? 'grid-cols-1' : 'grid-cols-2'">
        <div>本地端口：{{ status.localProxy.host }}:{{ status.localProxy.port }} ({{ status.routeMode }})</div>
        <div>HY2 进程：{{ status.hysteriaRunning ? '运行中' : '未运行' }}</div>
        <div>活跃连接：{{ status.connections.count }}</div>
        <div>累计流量：↑{{ formatBytes(status.connections.uploadTotal) }} ↓{{ formatBytes(status.connections.downloadTotal) }}</div>
      </div>
      <div v-else class="text-11.5px text-[#8e9297]">
        暂未获取到 WProxy 状态；请确认宿主机 WProxy 内核与 `wproxy` 插件已启用。
      </div>

      <div v-if="bannerText" class="px-2.5 py-1.5 rounded bg-[#182f2a] border border-[#245147] text-[#a7f3d0] text-11.5px whitespace-pre-wrap">
        {{ bannerText }}
      </div>
      <div v-if="errorText" class="px-2.5 py-1.5 rounded bg-[#3b1d1d] border border-[#5f2f2f] text-[#fecaca] text-11.5px whitespace-pre-wrap">
        {{ errorText }}
      </div>
    </div>

    <!-- Route Mode & Host Controls -->
    <div v-if="status?.running" class="rounded-10px bg-[#171a1a] border border-[#2f3534] p-3.5 space-y-2.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="space-y-0.5">
          <div class="text-12px font-medium text-[#cbd5e1]">电脑代理模式（宿主机 WProxy）</div>
          <div v-if="compact" class="text-10.5px text-[#8e9297]">
            远程控制电脑端 WProxy，不改变手机内置 Mihomo
          </div>
        </div>
        <div class="flex items-center p-0.5 rounded-7px bg-[#111313] border border-[#2c3130]">
          <button
            v-for="m in routeModes"
            :key="m.value"
            type="button"
            :disabled="store.wproxyLoading"
            class="px-2.5 py-1 rounded-5px border-0 text-11.5px cursor-pointer"
            :class="status.routeMode === m.value ? 'bg-[#13987f] text-white font-medium' : 'bg-transparent text-[#9ca3af] hover:text-[#eaeaea]'"
            @click="handleRouteMode(m.value)">
            {{ m.label }}
          </button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          :disabled="store.wproxyLoading"
          data-testid="wproxy-sysproxy-toggle-btn"
          class="px-3 py-1.5 rounded-6px border text-11.5px cursor-pointer disabled:opacity-50"
          :class="
            status.sysProxy.enable
              ? 'bg-[#1d4940] border-[#2d5b51] text-[#99f6e4]'
              : 'bg-[#262b2a] border-[#383f3e] text-[#cbd5e1]'
          "
          @click="handleToggleSysProxy">
          {{ status.sysProxy.enable ? `PC 系统代理：开 (${status.sysProxy.server})` : 'PC 系统代理：关 (直连)' }}
        </button>

        <button
          type="button"
          :disabled="store.wproxyLoading"
          data-testid="wproxy-heal-hy2-btn"
          class="px-3 py-1.5 rounded-6px bg-[#262b2a] hover:bg-[#323837] disabled:opacity-50 border border-[#383f3e] text-[#fbbf24] text-11.5px cursor-pointer"
          @click="handleHealHy2">
          HY2 自愈重启
        </button>

        <button
          type="button"
          :disabled="store.wproxyLoading"
          class="px-3 py-1.5 rounded-6px bg-[#262b2a] hover:bg-[#323837] disabled:opacity-50 border border-[#383f3e] text-[#cbd5e1] text-11.5px cursor-pointer"
          @click="handleReloadConfig">
          热重载配置
        </button>
      </div>
    </div>

    <!-- Node Selection & Google 204 Delay -->
    <div v-if="status?.running" class="rounded-10px bg-[#171a1a] border border-[#2f3534] p-3.5 space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <span class="text-12px font-medium text-[#cbd5e1]">
          PROXY 节点列表（{{ status.nodes.length }}）
        </span>
        <button
          type="button"
          :disabled="store.wproxyLoading"
          data-testid="wproxy-test-all-delay-btn"
          class="px-2.5 py-1 rounded-6px bg-[#20332f] hover:bg-[#1d4940] disabled:opacity-50 border border-[#2d584e] text-[#99f6e4] text-11.5px cursor-pointer"
          @click="handleTestDelay()">
          全部测速 (google 204)
        </button>
      </div>

      <div class="grid gap-1.5 max-h-220px vl-scroll" :class="compact ? 'grid-cols-1' : 'grid-cols-2'">
        <div
          v-for="node in status.nodes"
          :key="node.name"
          class="flex items-center justify-between gap-2 px-2.5 py-2 rounded-7px border cursor-pointer transition-colors"
          :class="
            status.activeNode === node.name
              ? 'bg-[#17362f] border-[#13987f] text-[#ecfdf5]'
              : 'bg-[#1f2323] border-[#2c3130] hover:border-[#4b5563] text-[#d4d4d4]'
          "
          :data-testid="`wproxy-node-${node.name}`"
          @click="handleSelectNode(node.name)">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span v-if="status.activeNode === node.name" class="text-[#34d399] text-11px">●</span>
              <span class="font-medium truncate">{{ node.name }}</span>
            </div>
            <div class="text-10.5px text-[#8e9297]">{{ node.type }}</div>
          </div>

          <div class="flex items-center gap-1.5 shrink-0" @click.stop>
            <span class="text-11px font-mono" :class="delayColorClass(node.delay)">
              {{ node.delay ? `${node.delay}ms` : '-' }}
            </span>
            <button
              type="button"
              :disabled="store.wproxyLoading"
              class="px-1.5 py-0.5 rounded bg-[#2a2f2e] hover:bg-[#383e3d] border-0 text-[#cbd5e1] text-10.5px cursor-pointer"
              title="探测此节点延迟"
              @click="handleTestDelay(node.name)">
              测速
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Android / LAN Shared Proxy Card -->
    <div v-if="status?.lanShare" class="rounded-10px bg-[#171a1a] border border-[#2f3534] p-3.5 space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <span class="text-12px font-semibold text-[#eaeaea]">
          安卓 / 局域网共享代理 (端口 :{{ status.lanShare.port }})
        </span>
        <span class="text-10.5px px-1.5 py-0.2 rounded bg-[#242a29] text-[#93c5fd]">
          {{ status.lanShare.authRequired ? `需认证 · ${status.lanShare.username}` : '免密' }}
        </span>
      </div>

      <div v-if="status.lanShare.endpoints.length === 0" class="text-11.5px text-[#8e9297]">
        未发现可用的局域网或 Tailscale IPv4 接口
      </div>

      <div v-else class="space-y-1.5">
        <div
          v-for="ep in status.lanShare.endpoints"
          :key="ep.ip"
          class="flex flex-wrap items-center justify-between gap-2 p-2 rounded-7px bg-[#121515] border border-[#282d2c]">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span
                class="px-1.5 py-0.1 rounded text-10px font-medium"
                :class="ep.kind === 'lan' ? 'bg-[#1d4940] text-[#5eead4]' : 'bg-[#2a2f45] text-[#93c5fd]'">
                {{ ep.kind === 'lan' ? 'LAN' : 'Tailscale' }}
              </span>
              <span class="font-mono text-12px text-[#f0f0f0]">{{ ep.address }}</span>
            </div>
            <div class="text-10.5px text-[#8e9297] truncate">{{ ep.iface }}</div>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              class="px-2 py-1 rounded bg-[#262b2a] hover:bg-[#323837] border-0 text-[#e5e7eb] text-11px cursor-pointer"
              @click="copyText(ep.address, `已复制地址 ${ep.address}`)">
              复制 host:port
            </button>
            <button
              type="button"
              class="px-2 py-1 rounded bg-[#20332f] hover:bg-[#1d4940] border-0 text-[#99f6e4] text-11px cursor-pointer"
              @click="copyLanUri(ep.ip, 'http')">
              复制 HTTP
            </button>
            <button
              type="button"
              class="px-2 py-1 rounded bg-[#20332f] hover:bg-[#1d4940] border-0 text-[#99f6e4] text-11px cursor-pointer"
              @click="copyLanUri(ep.ip, 'socks5')">
              复制 SOCKS5
            </button>
          </div>
        </div>
      </div>

      <div class="text-11px text-[#9ca3af] leading-relaxed bg-[#141717] p-2 rounded border border-[#262b2a]">
        手机端说明：若手机使用 CMFA 等 VPN 代理 App，请保持系统 Wi-Fi 代理为「无」，避免双层代理叠加导致 SSL 证书异常；仅在不使用 VPN App 时在 Wi-Fi 设置填写上方 LAN 地址与端口。
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useVibeLinkStore } from '../store'

defineProps<{
  compact?: boolean
}>()

const store = useVibeLinkStore()
const bannerText = ref('')
const errorText = ref('')

const status = computed(() => store.wproxyStatus)

const routeModes: Array<{ value: 'rule' | 'global' | 'direct'; label: string }> = [
  { value: 'rule', label: '规则' },
  { value: 'global', label: '全局' },
  { value: 'direct', label: '直连' }
]

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let idx = 0
  let val = bytes
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`
}

function delayColorClass(delay: number | null): string {
  if (!delay || delay <= 0) return 'text-[#6b7280]'
  if (delay < 400) return 'text-[#4ade80]'
  if (delay < 1000) return 'text-[#fbbf24]'
  return 'text-[#f87171]'
}

function clearFeedback() {
  bannerText.value = ''
  errorText.value = ''
}

async function handleRefresh() {
  clearFeedback()
  const res = await store.fetchWProxyStatus()
  if (!res) {
    errorText.value = '无法连接 WProxy 控制接口 (127.0.0.1:9097)'
  }
}

async function handleProbeEgress() {
  clearFeedback()
  try {
    const res = await store.probeWProxyEgress()
    bannerText.value = `当前代理出口 IP：${res.ip || '未知'} (${res.latencyMs}ms)`
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleRouteMode(mode: 'rule' | 'global' | 'direct') {
  clearFeedback()
  try {
    await store.setWProxyRouteMode(mode)
    bannerText.value = `已切换路由模式为 ${mode}`
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleToggleSysProxy() {
  if (!status.value) return
  clearFeedback()
  const next = !status.value.sysProxy.enable
  try {
    const res = await store.setWProxySystemProxy(next)
    bannerText.value = res.output || (next ? '已开启 PC 系统代理' : '已切换为直连')
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleHealHy2() {
  clearFeedback()
  try {
    const res = await store.healWProxyHysteria()
    bannerText.value = res.output || '已触发 HY2 自愈重启'
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleReloadConfig() {
  clearFeedback()
  try {
    const res = await store.reloadWProxyConfig()
    bannerText.value = res.message
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleSelectNode(node: string) {
  clearFeedback()
  try {
    await store.selectWProxyNode(node)
    bannerText.value = `已手动切换 PROXY 节点为 ${node}`
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleTestDelay(node?: string) {
  clearFeedback()
  try {
    const res = await store.testWProxyDelay(node)
    const count = Object.keys(res.delays).length
    bannerText.value = node
      ? `节点 ${node} 测速完成：${res.delays[node] ? `${res.delays[node]}ms` : '超时/不可达'}`
      : `已完成 ${count} 个节点 Google 204 测速`
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}

async function copyText(text: string, msg: string) {
  clearFeedback()
  try {
    await navigator.clipboard.writeText(text)
    bannerText.value = msg
  } catch {
    bannerText.value = text
  }
}

async function copyLanUri(host: string, scheme: 'http' | 'socks5') {
  clearFeedback()
  try {
    const res = await store.getWProxyLanShareUri(host, scheme)
    await copyText(res.uri, `已复制 ${scheme.toUpperCase()} 代理地址（含局域网共享认证）`)
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}

onMounted(() => {
  void store.fetchWProxyStatus()
})
</script>
