<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-3"
    data-testid="server-settings-modal"
    @click.self="$emit('close')">
    <div class="w-full max-w-760px max-h-88vh flex flex-col rounded-14px bg-[#1f2222] border border-[#353a39] text-[#eaeaea] shadow-2xl overflow-hidden">
      <div class="flex items-center justify-between px-5 py-3.5 bg-[#242828] border-b border-[#343938]">
        <span class="text-15px font-semibold">VibeLink 控制面与插件中心</span>
        <button
          type="button"
          class="px-2.5 py-1 rounded bg-[#2d3232] hover:bg-[#383e3e] border-0 text-[#ccc] cursor-pointer text-12px"
          @click="$emit('close')">
          关闭
        </button>
      </div>

      <div class="px-5 py-2.5 bg-[#212424] border-b border-[#303534] flex items-center gap-2 text-12.5px">
        <button
          type="button"
          data-testid="settings-tab-connection"
          class="px-3.5 py-1.5 rounded-7px border-0 cursor-pointer"
          :class="store.serverSettingsTab === 'connection' ? 'bg-[#13987f] text-white font-medium' : 'bg-[#2a2f2e] text-[#cbd5e1]'"
          @click="switchTab('connection')">
          连接与配对
        </button>
        <button
          type="button"
          data-testid="settings-tab-plugins"
          class="px-3.5 py-1.5 rounded-7px border-0 cursor-pointer flex items-center gap-1.5"
          :class="store.serverSettingsTab === 'plugins' ? 'bg-[#13987f] text-white font-medium' : 'bg-[#2a2f2e] text-[#cbd5e1]'"
          @click="switchTab('plugins')">
          <span>插件中心</span>
          <span class="px-1.5 py-0.1 rounded-full bg-black/25 text-10.5px">{{ store.plugins.length }}</span>
        </button>
        <button
          type="button"
          data-testid="settings-tab-devices"
          class="px-3.5 py-1.5 rounded-7px border-0 cursor-pointer flex items-center gap-1.5"
          :class="store.serverSettingsTab === 'devices' ? 'bg-[#13987f] text-white font-medium' : 'bg-[#2a2f2e] text-[#cbd5e1]'"
          @click="switchTab('devices')">
          <span>已配对手机</span>
          <span class="px-1.5 py-0.1 rounded-full bg-black/25 text-10.5px">
            {{ store.devices.filter((d) => d.online).length }}
          </span>
        </button>
        <button
          type="button"
          data-testid="settings-tab-account"
          class="px-3.5 py-1.5 rounded-7px border-0 cursor-pointer flex items-center gap-1.5"
          :class="store.serverSettingsTab === 'account' ? 'bg-[#13987f] text-white font-medium' : 'bg-[#2a2f2e] text-[#cbd5e1]'"
          @click="switchTab('account')">
          <span>账号与福利</span>
        </button>
      </div>

      <!-- Tab 1: Connection & Infra -->
      <div v-if="store.serverSettingsTab === 'connection'" class="p-4 space-y-4 vl-scroll flex-1 min-h-0">
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

        <!-- Mobile QR Pairing Card (Dynamic LAN + Tailscale + WAN) -->
        <div
          class="border-t border-[#303534] pt-3 space-y-2.5"
          data-testid="desktop-qr-pairing-card">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-12.5px font-medium text-[#e5e7eb]">手机扫码配对（含内外网通道）</div>
              <div class="text-11px text-[#8e9297]">
                包含内网 LAN、Tailscale 与自定义外网通道及 Token，手机扫码即可导入并自动切换。
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                class="px-2.5 py-1 rounded bg-[#2a2f2e] hover:bg-[#363c3b] border-0 text-[#cbd5e1] text-11px cursor-pointer"
                @click="refreshPairingInfo">
                刷新地址
              </button>
              <button
                v-if="store.pairingInfo?.qrPayload"
                type="button"
                data-testid="copy-qr-payload-btn"
                class="px-2.5 py-1 rounded bg-[#13987f] hover:bg-[#17ad91] border-0 text-white text-11px cursor-pointer"
                @click="copyPairingText(store.pairingInfo.qrPayload, '已复制配对码（可在手机「粘贴配对码」导入）')">
                复制配对码
              </button>
            </div>
          </div>

          <div
            v-if="store.pairingInfo"
            class="flex flex-col sm:flex-row gap-3 p-3 rounded-8px bg-[#161919] border border-[#2c3130]">
            <div class="shrink-0 flex flex-col items-center justify-center gap-1.5">
              <div class="p-2 rounded-8px bg-white inline-flex">
                <n-qr-code
                  :value="store.pairingInfo.qrPayload"
                  :size="168"
                  color="#13987f"
                  bg-color="#ffffff"
                  type="canvas"
                  error-correction-level="M" />
              </div>
              <span class="text-10.5px text-[#8e9297] font-mono">{{ store.pairingInfo.hostName }}</span>
            </div>

            <div class="flex-1 min-w-0 space-y-2 text-11.5px">
              <div class="text-[#cbd5e1] font-medium">
                已发现通道 ({{ store.pairingInfo.endpoints.length }})
              </div>
              <div class="space-y-1.5 max-h-140px vl-scroll pr-1">
                <div
                  v-for="ep in store.pairingInfo.endpoints"
                  :key="ep.id"
                  class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-[#1f2424] border border-[#2f3534]">
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <span
                        class="px-1.5 py-0.2 rounded text-10px"
                        :class="
                          ep.kind === 'lan'
                            ? 'bg-[#13987f]/25 text-[#5eead4]'
                            : ep.kind === 'tailscale'
                              ? 'bg-[#2563eb]/25 text-[#93c5fd]'
                              : 'bg-[#7c3aed]/25 text-[#c4b5fd]'
                        ">
                        {{ ep.kind === 'lan' ? '内网' : ep.kind === 'tailscale' ? 'Tailscale' : '外网' }}
                      </span>
                      <span class="text-[#e5e7eb] truncate">{{ ep.label }}</span>
                    </div>
                    <div class="font-mono text-11px text-[#94a3b8] truncate">{{ ep.url }}</div>
                  </div>
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded bg-[#2a2f2e] hover:bg-[#383f3e] border-0 text-[#cbd5e1] text-10.5px cursor-pointer shrink-0"
                    @click="copyPairingText(ep.url, `已复制 ${ep.url}`)">
                    复制
                  </button>
                </div>
              </div>

              <div class="pt-1 space-y-1">
                <div class="text-11px text-[#9ca3af]">自定义外网通道 URL（可选，如 FRP / Cloudflare Tunnel）</div>
                <div class="flex items-center gap-1.5">
                  <input
                    v-model="customExternalInput"
                    type="text"
                    placeholder="https://vibelink.example.com"
                    class="flex-1 min-w-0 px-2.5 py-1.5 rounded bg-[#111414] border border-[#323837] text-[#eaeaea] font-mono text-11.5px outline-none focus:border-[#13987f]" />
                  <button
                    type="button"
                    class="px-2.5 py-1.5 rounded bg-[#2a2f2e] hover:bg-[#363c3b] border-0 text-[#e5e7eb] text-11px cursor-pointer shrink-0"
                    @click="saveCustomExternalUrl">
                    保存外网
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="text-11.5px text-[#767676]">
            连接控制面后即可生成多通道配对二维码（LAN / Tailscale / 自定义外网）。
          </div>
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
            <div v-if="store.infraStatus.userPluginsDir" class="col-span-2 truncate text-[#94a3b8]">
              Plugins: {{ store.infraStatus.userPluginsDir }}
            </div>
          </div>
          <div v-else class="text-12px text-[#767676]">暂未获取到控制面运行指标</div>
        </div>
      </div>

      <!-- Tab 2: Plugins (Decluttered, airy layout) -->
      <div v-else-if="store.serverSettingsTab === 'plugins'" class="p-5 space-y-4 vl-scroll flex-1 min-h-0" data-testid="plugins-tab-pane">
        <div class="flex items-center justify-between gap-3">
          <div class="text-12.5px text-[#9ca3af]">
            已启用的插件会自动出现在左侧导航栏，点击图标即可直接打开功能页。
          </div>
          <button
            type="button"
            :disabled="store.pluginsLoading"
            data-testid="sync-all-plugins-btn"
            class="px-3.5 py-1.5 rounded-7px bg-[#1d4940] hover:bg-[#13987f] disabled:opacity-50 border-0 text-[#ecfdf5] text-12px cursor-pointer shrink-0"
            @click="handleSyncAllPlugins">
            {{ store.pluginsLoading ? '同步中...' : '全部同步' }}
          </button>
        </div>

        <div v-if="pluginBanner" class="px-3.5 py-2.5 rounded-8px bg-[#182f2a] border border-[#245147] text-[#a7f3d0] text-12.5px whitespace-pre-wrap">
          {{ pluginBanner }}
        </div>
        <div v-if="pluginError" class="px-3.5 py-2.5 rounded-8px bg-[#3b1d1d] border border-[#5f2f2f] text-[#fecaca] text-12.5px whitespace-pre-wrap">
          {{ pluginError }}
        </div>

        <div v-if="store.plugins.length === 0" class="py-10 text-center text-13px text-[#888]">
          暂无已加载的 VibeLink 插件
        </div>

        <div
          v-for="plugin in store.plugins"
          :key="plugin.id"
          class="rounded-12px bg-[#171b1b] border border-[#2d3534] p-5 space-y-3"
          :data-testid="`plugin-card-${plugin.id}`">
          <div class="flex items-center justify-between gap-4">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-38px h-38px rounded-10px bg-[#20332f] border border-[#2d584e] text-[#5eead4] flex items-center justify-center shrink-0">
                <svg
                  v-if="plugin.ui?.icon === 'magpie'"
                  viewBox="0 0 24 24"
                  class="w-20px h-20px"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8">
                  <path d="M12 3l7.5 4.3v9.4L12 21l-7.5-4.3V7.3L12 3z" stroke-linejoin="round" />
                  <circle cx="12" cy="12" r="2.6" />
                </svg>
                <svg
                  v-else-if="plugin.ui?.icon === 'globe'"
                  viewBox="0 0 24 24"
                  class="w-20px h-20px"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3.6 9h16.8M3.6 15h16.8M12 3a14.5 14.5 0 0 0 0 18M12 3a14.5 14.5 0 0 1 0 18" />
                </svg>
                <svg v-else viewBox="0 0 24 24" class="w-20px h-20px" fill="none" stroke="currentColor" stroke-width="1.8">
                  <rect x="4" y="4" width="16" height="16" rx="4" />
                  <path d="M9 12h6M12 9v6" stroke-linecap="round" />
                </svg>
              </div>
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-15px font-semibold text-[#f3f3f3]">{{ plugin.name }}</span>
                  <span class="px-2 py-0.5 rounded-full text-11px" :class="healthBadgeClass(plugin.health.status)">
                    {{ healthBadgeLabel(plugin.health.status) }}{{ plugin.health.version ? ` · v${plugin.health.version}` : '' }}
                  </span>
                </div>
                <div class="text-13px text-[#b0b8bf] leading-relaxed">
                  {{ plugin.description }}
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <button
                v-if="plugin.enabled && plugin.ui"
                type="button"
                class="px-3.5 py-1.5 rounded-7px bg-[#13987f] hover:bg-[#17ad91] border-0 text-white text-12.5px font-medium cursor-pointer"
                @click="store.openPluginView(plugin.id)">
                打开页面
              </button>
              <button
                type="button"
                :disabled="store.pluginsLoading"
                class="px-3 py-1.5 rounded-7px border-0 cursor-pointer text-12px"
                :class="plugin.enabled ? 'bg-[#263330] text-[#5eead4]' : 'bg-[#2d3232] text-[#9ca3af]'"
                @click="handleTogglePlugin(plugin)">
                {{ plugin.enabled ? '已启用' : '已停用' }}
              </button>
            </div>
          </div>

          <details class="pt-1 border-t border-[#262b2a] text-12px text-[#8e9297]">
            <summary class="cursor-pointer select-none hover:text-[#cbd5e1] py-1">
              {{
                plugin.capabilities.includes('agentDiscovery')
                  ? `高级管理 · 已同步 ${plugin.configuredAgents.length} 个 Agent / ${plugin.modelsCount} 个模型`
                  : `高级管理 · ${plugin.source === 'user' ? '独立目录' : '内置默认'}`
              }}
            </summary>

            <div class="pt-2.5 space-y-3">
              <div class="flex flex-wrap items-center gap-2">
                <button
                  v-if="plugin.capabilities.includes('agentDiscovery') || plugin.capabilities.includes('modelCatalog')"
                  type="button"
                  :disabled="store.pluginsLoading || !plugin.enabled"
                  class="px-2.5 py-1 rounded-6px bg-[#20332f] hover:bg-[#1d4940] disabled:opacity-50 border border-[#2d584e] text-[#99f6e4] text-11.5px cursor-pointer"
                  @click="handleSyncPlugin(plugin.id)">
                  同步 Agent
                </button>
                <button
                  v-if="plugin.capabilities.includes('selfUpdate')"
                  type="button"
                  :disabled="store.pluginsLoading"
                  class="px-2.5 py-1 rounded-6px bg-[#262b2a] hover:bg-[#323837] disabled:opacity-50 border border-[#383f3e] text-[#e5e7eb] text-11.5px cursor-pointer"
                  @click="handleCheckUpdate(plugin.id)">
                  检查更新
                </button>
                <button
                  v-if="plugin.capabilities.includes('selfUpdate')"
                  type="button"
                  :disabled="store.pluginsLoading"
                  class="px-2.5 py-1 rounded-6px bg-[#262b2a] hover:bg-[#323837] disabled:opacity-50 border border-[#383f3e] text-[#5eead4] text-11.5px cursor-pointer"
                  @click="handleRunHostUpdate(plugin.id)">
                  独立升级 Magpie
                </button>
                <button
                  v-if="plugin.source === 'bundled'"
                  type="button"
                  :disabled="store.pluginsLoading"
                  class="px-2.5 py-1 rounded-6px bg-[#262b2a] hover:bg-[#323837] disabled:opacity-50 border border-[#383f3e] text-[#93c5fd] text-11.5px cursor-pointer"
                  @click="handleEjectPlugin(plugin.id)">
                  迁出到独立目录
                </button>
                <template v-else>
                  <button
                    type="button"
                    :disabled="store.pluginsLoading"
                    class="px-2.5 py-1 rounded-6px bg-[#262b2a] hover:bg-[#323837] disabled:opacity-50 border border-[#383f3e] text-[#e5e7eb] text-11.5px cursor-pointer"
                    @click="handleReloadPlugin(plugin.id)">
                    热重载
                  </button>
                  <button
                    type="button"
                    :disabled="store.pluginsLoading"
                    class="px-2.5 py-1 rounded-6px bg-[#262b2a] hover:bg-[#323837] disabled:opacity-50 border border-[#383f3e] text-[#93c5fd] text-11.5px cursor-pointer"
                    @click="handleRunPluginGitUpdate(plugin.id)">
                    更新插件代码
                  </button>
                </template>
              </div>

              <div
                v-if="updateInfoByPlugin[plugin.id]"
                class="p-2.5 rounded-6px bg-[#141717] border border-[#2a302f] text-11.5px space-y-1">
                <div class="flex items-center justify-between">
                  <span class="font-medium text-[#e5e7eb]">
                    当前：{{ updateInfoByPlugin[plugin.id].currentVersion || '未知' }} ·
                    最新：{{ updateInfoByPlugin[plugin.id].latestVersion || '未知' }}
                  </span>
                  <span :class="updateInfoByPlugin[plugin.id].updateAvailable ? 'text-[#fbbf24]' : 'text-[#34d399]'">
                    {{ updateInfoByPlugin[plugin.id].updateAvailable ? '有可用更新' : '已是最新' }}
                  </span>
                </div>
                <div class="text-[#9ca3af] whitespace-pre-wrap">{{ updateInfoByPlugin[plugin.id].summary }}</div>
              </div>

              <div v-if="plugin.capabilities.includes('agentDiscovery') && plugin.configuredAgents.length > 0" class="flex flex-wrap gap-1.5">
                <span
                  v-for="ag in plugin.configuredAgents"
                  :key="`${ag.botId}-${ag.externalId}`"
                  class="px-2 py-1 rounded-6px bg-[#1b2f2b] border border-[#294942] text-11px text-[#d1fae5]">
                  {{ ag.displayName }} · <span class="text-[#5eead4]">{{ ag.model || ag.rawStatus }}</span>
                </span>
              </div>

              <div class="text-11px font-mono text-[#767d85] truncate" :title="plugin.pluginDir">
                目录：{{ plugin.pluginDir }}
              </div>
            </div>
          </details>
        </div>

        <div class="text-11px font-mono text-[#767d85] truncate pt-1" :title="store.userPluginsDir">
          独立插件目录：{{ store.userPluginsDir || '~/.vibelink/plugins' }}
        </div>
      </div>

      <!-- Tab 3: Paired Android Devices -->
      <div v-else-if="store.serverSettingsTab === 'devices'" class="p-4 space-y-3 vl-scroll flex-1 min-h-0" data-testid="devices-tab-pane">
        <div class="flex items-center justify-between gap-2 text-12px">
          <div class="text-[#9ca3af]">
            已配对手机通过后台 ForegroundService 常驻控制通道接入，支持电脑 Agent 免干预控机与代理同步。
          </div>
          <button
            type="button"
            :disabled="store.devicesLoading"
            class="px-3 py-1 rounded-6px bg-[#2a2f2e] hover:bg-[#363c3b] border-0 text-[#cbd5e1] cursor-pointer shrink-0"
            @click="store.fetchDevices()">
            {{ store.devicesLoading ? '刷新中...' : '刷新列表' }}
          </button>
        </div>

        <div v-if="deviceBanner" class="px-3 py-2 rounded-6px bg-[#182f2a] border border-[#245147] text-[#a7f3d0] text-12px">
          {{ deviceBanner }}
        </div>
        <div v-if="deviceError" class="px-3 py-2 rounded-6px bg-[#3b1d1d] border border-[#5f2f2f] text-[#fecaca] text-12px">
          {{ deviceError }}
        </div>

        <div v-if="store.devices.length === 0" class="py-10 text-center text-12.5px text-[#767676]">
          暂无已接入的手机端控制代理；请在手机端「我的 → 配对」扫码配对电脑后，确认「控机」开关已开启。
        </div>

        <div
          v-for="dev in store.devices"
          :key="dev.deviceId"
          class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2.5 text-12px"
          data-testid="desktop-device-card">
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-semibold text-[#eaeaea] truncate">{{ dev.name }}</span>
                <span
                  class="px-2 py-0.2 rounded-full text-10.5px"
                  :class="dev.online ? 'bg-[#143d2d] text-[#4ade80]' : 'bg-[#2c3030] text-[#9ca3af]'">
                  {{ dev.online ? '在线' : '离线' }}
                </span>
                <span class="text-11px text-[#8e9297] font-mono">Android {{ dev.androidVersion || '?' }}</span>
              </div>
              <div class="text-11px font-mono text-[#8e9297] truncate">
                ID: {{ dev.deviceId }} · 通道: {{ dev.capabilities.activeEndpointUrl || dev.remoteAddress || '-' }}
              </div>
            </div>
            <div class="text-11px font-mono text-[#5eead4] shrink-0">
              代理: {{ dev.capabilities.activeProxyMode }}
            </div>
          </div>

          <div class="flex flex-wrap gap-1.5 text-10.5px">
            <span class="px-2 py-0.5 rounded" :class="dev.capabilities.root ? 'bg-[#143d2d] text-[#4ade80]' : 'bg-[#232727] text-[#8e9297]'">
              Root: {{ dev.capabilities.root ? '已获取' : '无' }}
            </span>
            <span class="px-2 py-0.5 rounded" :class="dev.capabilities.shizukuGranted ? 'bg-[#143d2d] text-[#4ade80]' : 'bg-[#232727] text-[#8e9297]'">
              Shizuku: {{ dev.capabilities.shizukuGranted ? '已授权' : dev.capabilities.shizukuRunning ? '运行中未授权' : '未激活' }}
            </span>
            <span class="px-2 py-0.5 rounded" :class="dev.capabilities.accessibilityEnabled ? 'bg-[#143d2d] text-[#4ade80]' : 'bg-[#232727] text-[#8e9297]'">
              无障碍: {{ dev.capabilities.accessibilityEnabled ? '已开启' : '未开启' }}
            </span>
            <span class="px-2 py-0.5 rounded" :class="dev.capabilities.vpnPrepared ? 'bg-[#143d2d] text-[#4ade80]' : 'bg-[#232727] text-[#8e9297]'">
              VPN: {{ dev.capabilities.vpnRunning ? '运行中' : dev.capabilities.vpnPrepared ? '已预授权' : '未授权' }}
            </span>
            <span
              class="px-2 py-0.5 rounded"
              :class="dev.capabilities.mihomoRunning ? 'bg-[#143d2d] text-[#4ade80]' : dev.capabilities.mihomoAvailable ? 'bg-[#232727] text-[#cbd5e1]' : 'bg-[#232727] text-[#8e9297]'">
              Mihomo: {{ dev.capabilities.mihomoRunning ? `运行中 ${dev.capabilities.mihomoVersion || ''}`.trim() : dev.capabilities.mihomoAvailable ? '就绪' : '未内置' }}
            </span>
          </div>

          <div v-if="dev.capabilities.activeProxyUrl || dev.capabilities.mihomoActiveNode" class="text-11px font-mono text-[#94a3b8] truncate">
            {{ dev.capabilities.mihomoActiveNode ? `Mihomo 节点：${dev.capabilities.mihomoActiveNode} · ` : '' }}{{ dev.capabilities.activeProxyUrl ? `当前代理：${dev.capabilities.activeProxyUrl}` : '' }}
          </div>

          <div class="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              :disabled="!dev.online"
              class="px-2.5 py-1 rounded bg-[#13987f] hover:bg-[#17ad91] disabled:opacity-45 border-0 text-white text-11px cursor-pointer"
              @click="handleSyncDeviceMihomo(dev.deviceId)">
              推送完整 Mihomo
            </button>
            <button
              type="button"
              :disabled="!dev.online"
              class="px-2.5 py-1 rounded bg-[#2a2f2e] hover:bg-[#383f3e] disabled:opacity-45 border-0 text-[#cbd5e1] text-11px cursor-pointer"
              @click="handleSyncDeviceWProxy(dev.deviceId)">
              下发 WProxy 代理
            </button>
            <button
              type="button"
              :disabled="!dev.online"
              class="px-2.5 py-1 rounded bg-[#2a2f2e] hover:bg-[#383f3e] disabled:opacity-45 border-0 text-[#cbd5e1] text-11px cursor-pointer"
              @click="handleClearDeviceProxy(dev.deviceId)">
              关闭手机代理
            </button>
            <button
              type="button"
              :disabled="!dev.online"
              class="px-2.5 py-1 rounded bg-[#2a2f2e] hover:bg-[#383f3e] disabled:opacity-45 border-0 text-[#cbd5e1] text-11px cursor-pointer"
              @click="handleCaptureDeviceScreen(dev.deviceId)">
              远程截屏
            </button>
            <button
              type="button"
              :disabled="!dev.online"
              class="px-2.5 py-1 rounded bg-[#2a2f2e] hover:bg-[#383f3e] disabled:opacity-45 border-0 text-[#cbd5e1] text-11px cursor-pointer"
              @click="handleInspectDeviceTree(dev.deviceId)">
              读取 UI 树
            </button>
          </div>
        </div>

        <div v-if="remoteScreenSrc" class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
          <div class="flex items-center justify-between text-11.5px text-[#cbd5e1]">
            <span>手机远程截屏预览</span>
            <button type="button" class="bg-transparent border-0 text-[#8e9297] cursor-pointer text-11px" @click="remoteScreenSrc = ''">收起</button>
          </div>
          <img :src="remoteScreenSrc" alt="Phone Screen" class="max-h-360px rounded-6px border border-[#2f3534] mx-auto block" />
        </div>

        <pre
          v-if="remoteTreePreview"
          class="p-3 rounded-8px bg-[#111414] border border-[#2c3130] text-11px font-mono text-[#cbd5e1] max-h-220px overflow-auto whitespace-pre-wrap">{{ remoteTreePreview }}</pre>
      </div>

      <!-- Tab 5: Account, Welfare & HA Cluster -->
      <div v-else class="p-4 vl-scroll flex-1 min-h-0">
        <AccountWelfarePanel @open-auth-modal="accountAuthOpen = true" />
      </div>
    </div>
    <AccountAuthModal :open="accountAuthOpen" @close="accountAuthOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useVibeLinkStore } from '../store'
import type { VlPluginHealth, VlPluginSummary, VlPluginUpdateInfo } from '../types'
import AccountAuthModal from './AccountAuthModal.vue'
import AccountWelfarePanel from './AccountWelfarePanel.vue'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const store = useVibeLinkStore()
const urlInput = ref(store.serverUrl)
const tokenInput = ref(store.authToken)
const customExternalInput = ref('')
const statusBanner = ref('')
const errorBanner = ref('')
const pluginBanner = ref('')
const pluginError = ref('')
const deviceBanner = ref('')
const deviceError = ref('')
const remoteScreenSrc = ref('')
const remoteTreePreview = ref('')
const accountAuthOpen = ref(false)
const updateInfoByPlugin = reactive<Record<string, VlPluginUpdateInfo>>({})

async function handleSyncDeviceMihomo(deviceId: string) {
  deviceBanner.value = ''
  deviceError.value = ''
  try {
    const res = await store.syncMihomoToDevice(deviceId, { start: true })
    deviceBanner.value = `已推送完整 Mihomo 配置 (${res.configName}, ${Math.round(res.bytes / 1024)} KB) 并启动单 App 隧道`
  } catch (err) {
    deviceError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleSyncDeviceWProxy(deviceId: string) {
  deviceBanner.value = ''
  deviceError.value = ''
  try {
    const res = await store.syncWProxyToDevice(deviceId, { scheme: 'socks5', mode: 'auto' })
    deviceBanner.value = `已下发 WProxy 代理 (${res.proxyUrl}) 至手机并生效`
  } catch (err) {
    deviceError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleClearDeviceProxy(deviceId: string) {
  deviceBanner.value = ''
  deviceError.value = ''
  try {
    await store.invokeDeviceCommand(deviceId, 'proxy.clear', {})
    deviceBanner.value = '已关闭手机端代理配置'
  } catch (err) {
    deviceError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleCaptureDeviceScreen(deviceId: string) {
  deviceBanner.value = ''
  deviceError.value = ''
  try {
    const res = await store.invokeDeviceCommand(deviceId, 'ui.screenshot', { quality: 82, maxWidth: 1080 }, 25000)
    if (!res.ok) throw new Error(res.error || '截屏失败')
    const data = (res.data ?? {}) as { base64?: string; mimeType?: string; backend?: string }
    if (!data.base64) throw new Error('未返回图片数据')
    remoteScreenSrc.value = `data:${data.mimeType || 'image/jpeg'};base64,${data.base64}`
    deviceBanner.value = `远程截屏成功 (${data.backend || 'android'})`
  } catch (err) {
    deviceError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleInspectDeviceTree(deviceId: string) {
  deviceBanner.value = ''
  deviceError.value = ''
  try {
    const res = await store.invokeDeviceCommand(deviceId, 'ui.tree', { maxDepth: 10 }, 20000)
    if (!res.ok) throw new Error(res.error || '读取 UI 树失败')
    remoteTreePreview.value = JSON.stringify(res.data ?? {}, null, 2)
    deviceBanner.value = '已刷新手机当前屏幕 UI 控件树'
  } catch (err) {
    deviceError.value = err instanceof Error ? err.message : String(err)
  }
}

async function refreshPairingInfo() {
  const info = await store.fetchPairingInfo()
  if (info) {
    customExternalInput.value = info.customExternalUrl || ''
  }
}

async function copyPairingText(text: string, label: string) {
  errorBanner.value = ''
  try {
    await navigator.clipboard.writeText(text)
    statusBanner.value = label
  } catch (err) {
    errorBanner.value = `复制失败：${err instanceof Error ? err.message : String(err)}`
  }
}

async function saveCustomExternalUrl() {
  errorBanner.value = ''
  statusBanner.value = ''
  try {
    const info = await store.updatePairingConfig(customExternalInput.value.trim())
    customExternalInput.value = info.customExternalUrl || ''
    statusBanner.value = info.customExternalUrl
      ? `已更新自定义外网通道并刷新二维码：${info.customExternalUrl}`
      : '已清除自定义外网通道并刷新二维码'
  } catch (err) {
    errorBanner.value = err instanceof Error ? err.message : String(err)
  }
}

function switchTab(tab: 'connection' | 'plugins' | 'devices' | 'account') {
  store.serverSettingsTab = tab
  if (tab === 'plugins') {
    void store.fetchPlugins()
  } else if (tab === 'devices') {
    void store.fetchDevices()
  } else if (tab === 'account') {
    void store.fetchMyWelfare()
    void store.fetchMyApiKeys()
    void store.fetchAdminClusterStatus()
  }
}

function healthBadgeLabel(status: VlPluginHealth['status']): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'installed_idle':
      return '已安装待命'
    case 'disabled':
      return '已停用'
    case 'not_installed':
      return '未安装'
    default:
      return '异常'
  }
}

function healthBadgeClass(status: VlPluginHealth['status']): string {
  switch (status) {
    case 'running':
      return 'bg-[#143d2d] text-[#4ade80]'
    case 'installed_idle':
      return 'bg-[#3d2e14] text-[#fbbf24]'
    case 'disabled':
      return 'bg-[#2c3030] text-[#9ca3af]'
    default:
      return 'bg-[#3b1d1d] text-[#fca5a5]'
  }
}

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

async function handleSyncAllPlugins() {
  pluginBanner.value = ''
  pluginError.value = ''
  try {
    await store.syncPlugins()
    pluginBanner.value = '已同步全部启用插件的 Agent 与模型目录'
  } catch (err) {
    pluginError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleSyncPlugin(pluginId: string) {
  pluginBanner.value = ''
  pluginError.value = ''
  try {
    await store.syncPlugins(pluginId)
    pluginBanner.value = `插件 ${pluginId} 已重新同步`
  } catch (err) {
    pluginError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleTogglePlugin(plugin: VlPluginSummary) {
  pluginBanner.value = ''
  pluginError.value = ''
  try {
    await store.togglePlugin(plugin.id, !plugin.enabled)
    pluginBanner.value = `${plugin.name} 已${!plugin.enabled ? '启用' : '停用'}`
  } catch (err) {
    pluginError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleReloadPlugin(pluginId: string) {
  pluginBanner.value = ''
  pluginError.value = ''
  try {
    await store.reloadPlugin(pluginId)
    pluginBanner.value = `插件 ${pluginId} 已热重载`
  } catch (err) {
    pluginError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleEjectPlugin(pluginId: string) {
  pluginBanner.value = ''
  pluginError.value = ''
  try {
    const res = await store.ejectPlugin(pluginId)
    if (res.ok) {
      pluginBanner.value = res.message
    } else {
      pluginError.value = res.message
    }
  } catch (err) {
    pluginError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleCheckUpdate(pluginId: string) {
  pluginBanner.value = ''
  pluginError.value = ''
  try {
    const info = await store.checkPluginUpdate(pluginId)
    updateInfoByPlugin[pluginId] = info
  } catch (err) {
    pluginError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleRunHostUpdate(pluginId: string) {
  pluginBanner.value = ''
  pluginError.value = ''
  try {
    const res = await store.runPluginUpdate(pluginId, { target: 'host' })
    if (res.ok) {
      pluginBanner.value = `升级完成 (${res.beforeVersion} -> ${res.afterVersion})\n${res.output}`
    } else {
      pluginError.value = res.output
    }
  } catch (err) {
    pluginError.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleRunPluginGitUpdate(pluginId: string) {
  pluginBanner.value = ''
  pluginError.value = ''
  try {
    const res = await store.runPluginUpdate(pluginId, { target: 'plugin' })
    if (res.ok) {
      pluginBanner.value = `插件更新完成 (${res.beforeVersion} -> ${res.afterVersion})\n${res.output}`
    } else {
      pluginError.value = res.output
    }
  } catch (err) {
    pluginError.value = err instanceof Error ? err.message : String(err)
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
      pluginBanner.value = ''
      pluginError.value = ''
      deviceBanner.value = ''
      deviceError.value = ''
      void refreshInfra()
      void refreshPairingInfo()
      void store.fetchPlugins()
      void store.fetchDevices()
    }
  }
)
</script>
