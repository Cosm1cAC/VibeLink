<template>
  <MobileScaffold>
    <template #container>
      <div class="flex flex-col overflow-hidden h-full relative" data-testid="mobile-settings-view">
        <!-- HuLa My Top Utility Action Icons -->
        <div class="flex items-center justify-end gap-12px px-16px pt-10px shrink-0 z-10">
          <button
            type="button"
            class="px-10px py-4px rounded-full bg-[var(--search-bg-color)] border-0 text-12px text-[var(--text-color)] cursor-pointer"
            @click="toggleAppTheme">
            {{ isDark ? '切换浅色' : '切换深色' }}
          </button>
          <button
            type="button"
            class="w-32px h-32px rounded-full bg-transparent border-0 flex items-center justify-center cursor-pointer text-[var(--icon-color)]"
            aria-label="扫码配对"
            data-testid="mobile-me-scan-btn"
            @click="$emit('scanQr')">
            <svg class="w-22px h-22px"><use href="#saoma" /></svg>
          </button>
          <button
            type="button"
            class="w-32px h-32px rounded-full bg-transparent border-0 flex items-center justify-center cursor-pointer text-[var(--icon-color)]"
            aria-label="刷新同步"
            @click="refreshControlPlane">
            <svg class="w-22px h-22px"><use href="#refresh" /></svg>
          </button>
          <button
            type="button"
            class="w-32px h-32px rounded-full bg-transparent border-0 flex items-center justify-center cursor-pointer text-[var(--icon-color)]"
            aria-label="编辑个人资料"
            @click="store.openProfileModal('me')">
            <svg class="w-24px h-24px"><use href="#wode-shezhi" /></svg>
          </button>
        </div>

        <!-- HuLa PersonalInfo Header -->
        <div class="px-16px py-12px flex items-center gap-14px shrink-0">
          <button
            type="button"
            class="p-0 border-0 bg-transparent rounded-full cursor-pointer shrink-0"
            @click="store.openProfileModal('me')">
            <VlAvatar
              :avatar="store.me?.avatar ?? 'preset:user'"
              :name="store.me?.displayName ?? '我'"
              :size="68" />
          </button>

          <div class="min-w-0 flex-1 space-y-4px">
            <div class="flex items-center gap-8px flex-wrap">
              <span class="text-20px font-bold text-[var(--text-color)] truncate">
                {{ store.me?.displayName || 'VibeLink 用户' }}
              </span>
              <span
                class="px-8px py-2px rounded-full text-11px flex items-center gap-5px"
                :class="store.connected ? 'bg-[#13987f]/18 text-[#13987f] dark:text-[#5eead4]' : 'bg-[var(--danger-bg)] text-[var(--danger-text)]'">
                <span
                  class="w-7px h-7px rounded-full"
                  :class="store.connected ? 'bg-[#22c55e]' : 'bg-[#ef4444]'"></span>
                <span>{{ store.connected ? '控制面在线' : '控制面未连接' }}</span>
              </span>
            </div>

            <div class="text-12px text-[#737373] dark:text-[#9ca3af] truncate font-mono">
              {{ store.serverUrl }}
            </div>
            <div class="text-12px text-[#737373] dark:text-[#9ca3af] truncate">
              {{ store.bots.length }} 个活跃 Bot · {{ store.rooms.length }} 个会话 · {{ store.standbyMode ? 'Mac mini 备服' : store.mockBots ? 'Mock 调试模式' : 'PC 主服在线' }}
            </div>
            <div v-if="store.authUser" class="flex items-center gap-6px flex-wrap pt-2px">
              <span class="px-8px py-1px rounded-full bg-[#13987f]/16 text-[#13987f] dark:text-[#5eead4] text-10.5px font-medium">
                {{ store.authUser.role === 'admin' ? '超级管理员' : '普通用户' }} · @{{ store.authUser.username }}
              </span>
              <span class="px-8px py-1px rounded-full bg-[#242828] text-[#e5e7eb] text-10.5px font-mono">
                DS今日: {{ Number(store.authUser.deepseekDailyRemaining ?? 0).toLocaleString() }} · GPT: {{ Number(store.authUser.gptBalance ?? 0).toLocaleString() }}
              </span>
            </div>
          </div>
        </div>

        <!-- HuLa Bottom Rounded Card Sheet -->
        <n-card
          :bordered="false"
          class="custom-rounded flex-1 min-h-0 flex flex-col"
          content-class="p-12px! flex-1 min-h-0 flex flex-col">
          <n-tabs
            v-model:value="activeSeg"
            type="segment"
            animated
            class="flex-1 min-h-0 flex flex-col">
            <!-- Segment 1: QR Pairing + Multi-Channel Failover + Speed Test -->
            <n-tab-pane name="pair" tab="配对" data-testid="mobile-settings-seg-pair">
              <div class="overflow-y-auto max-h-[calc(100vh-280px)] space-y-12px pt-8px pb-16px">
                <!-- Quick Pairing Card -->
                <n-card size="small" embedded class="rounded-12px">
                  <div class="space-y-10px">
                    <div class="flex items-center justify-between gap-8px">
                      <div>
                        <div class="text-13.5px font-semibold text-[var(--text-color)]">快速配对控制面</div>
                        <div class="text-11.5px text-[#737373] dark:text-[#9ca3af]">
                          扫码或粘贴桌面端二维码内容，一次导入内网与外网多条通道
                        </div>
                      </div>
                    </div>
                    <div class="flex gap-8px">
                      <n-button
                        type="primary"
                        color="#13987f"
                        class="flex-1"
                        data-testid="mobile-scan-pair-btn"
                        @click="$emit('scanQr')">
                        扫一扫配对
                      </n-button>
                      <n-button
                        secondary
                        class="flex-1"
                        data-testid="mobile-paste-pair-btn"
                        @click="openPasteQrModal">
                        粘贴配对码
                      </n-button>
                    </div>
                  </div>
                </n-card>

                <!-- Multi-Channel & Speedtest Card -->
                <n-card size="small" embedded class="rounded-12px" data-testid="mobile-channels-card">
                  <div class="space-y-10px">
                    <div class="flex items-center justify-between gap-8px">
                      <div class="min-w-0">
                        <div class="text-13.5px font-semibold text-[var(--text-color)]">
                          内外网通道管理 ({{ store.channels.length }})
                        </div>
                        <div class="text-11px text-[#737373] dark:text-[#9ca3af]">
                          断线时自动切至外网，回到内网优先切回高速局域网
                        </div>
                      </div>
                      <div class="flex items-center gap-6px shrink-0">
                        <span class="text-11.5px text-[#737373] dark:text-[#9ca3af]">自动切换</span>
                        <n-switch
                          :value="store.channelSwitchMode === 'auto'"
                          size="small"
                          data-testid="mobile-autoswitch-toggle"
                          @update:value="handleToggleAutoSwitch" />
                      </div>
                    </div>

                    <div class="flex gap-6px flex-wrap">
                      <n-button
                        size="small"
                        secondary
                        class="flex-1 min-w-88px"
                        :loading="store.channelTesting"
                        data-testid="mobile-speedtest-all-btn"
                        @click="runAllSpeedTests">
                        一键测速
                      </n-button>
                      <n-button
                        size="small"
                        secondary
                        class="flex-1 min-w-88px"
                        :loading="store.autoSwitching"
                        data-testid="mobile-autoselect-btn"
                        @click="runAutoSelect">
                        智能选路
                      </n-button>
                      <n-button
                        size="small"
                        secondary
                        data-testid="mobile-add-channel-btn"
                        @click="openAddChannelModal">
                        添加通道
                      </n-button>
                    </div>

                    <div
                      v-if="store.lastChannelSwitchNotice"
                      class="px-10px py-6px rounded-8px bg-[#13987f]/16 text-[#13987f] dark:text-[#5eead4] text-11.5px"
                      data-testid="mobile-switch-notice">
                      {{ store.lastChannelSwitchNotice }}
                    </div>

                    <div class="space-y-8px">
                      <div
                        v-for="ch in store.channels"
                        :key="ch.id"
                        class="p-10px rounded-10px border transition-colors space-y-6px"
                        :class="
                          ch.url === store.serverUrl
                            ? 'bg-[#13987f]/10 border-[#13987f]/45'
                            : 'bg-[var(--center-bg-color)] border-[var(--line-color)]'
                        "
                        data-testid="mobile-channel-item">
                        <div class="flex items-center justify-between gap-6px">
                          <div class="flex items-center gap-6px min-w-0">
                            <span
                              class="px-6px py-1px rounded text-10.5px shrink-0 font-medium"
                              :class="channelKindBadgeClass(ch.kind)">
                              {{ channelKindLabel(ch.kind) }}
                            </span>
                            <span class="text-12.5px font-semibold text-[var(--text-color)] truncate">
                              {{ ch.label }}
                            </span>
                          </div>
                          <span
                            v-if="ch.url === store.serverUrl"
                            class="px-6px py-1px rounded-full bg-[#13987f] text-white text-10px shrink-0">
                            当前使用
                          </span>
                        </div>

                        <div class="font-mono text-11px text-[#737373] dark:text-[#9ca3af] break-all">
                          {{ ch.url }}
                        </div>

                        <!-- Speed / Probe Metrics Row -->
                        <div class="flex items-center justify-between gap-8px text-11px">
                          <div v-if="ch.lastStatus === 'testing'" class="text-[#f59e0b]">正在测速...</div>
                          <div v-else-if="ch.lastStatus === 'error'" class="text-[var(--danger-text)] truncate">
                            不可达：{{ ch.lastError || '连接超时' }}
                          </div>
                          <div v-else-if="ch.lastLatencyMs != null" class="flex flex-wrap gap-x-10px gap-y-2px text-[#13987f] dark:text-[#5eead4] font-mono">
                            <span>延迟 {{ ch.lastLatencyMs }}ms</span>
                            <span v-if="ch.lastJitterMs != null">抖动 {{ ch.lastJitterMs }}ms</span>
                            <span v-if="ch.lastDownloadMbps != null">↓ {{ ch.lastDownloadMbps }} Mbps</span>
                            <span v-if="ch.lastUploadMbps != null">↑ {{ ch.lastUploadMbps }} Mbps</span>
                          </div>
                          <div v-else class="text-[#888]">尚未测速</div>

                          <div class="flex items-center gap-6px shrink-0">
                            <n-button
                              size="tiny"
                              secondary
                              :loading="testingChannelId === ch.id"
                              @click="runSingleSpeedTest(ch.id)">
                              测速
                            </n-button>
                            <n-button
                              v-if="ch.url !== store.serverUrl"
                              size="tiny"
                              type="primary"
                              color="#13987f"
                              :loading="switchingChannelId === ch.id"
                              @click="handleSwitchChannel(ch.id)">
                              切换
                            </n-button>
                            <n-button
                              v-if="store.channels.length > 1 && ch.url !== store.serverUrl"
                              size="tiny"
                              tertiary
                              type="error"
                              @click="store.removeChannelEndpoint(ch.id)">
                              删
                            </n-button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </n-card>

                <!-- Manual Fallback URL / Token -->
                <n-card size="small" embedded class="rounded-12px">
                  <div class="space-y-10px">
                    <div class="text-13px font-semibold text-[var(--text-color)]">
                      手动配置地址与 Token
                    </div>
                    <div class="space-y-4px text-12px">
                      <div class="text-[#737373] dark:text-[#9ca3af]">当前主 Server URL</div>
                      <n-input
                        v-model:value="pairUrl"
                        clearable
                        :input-props="{
                          type: 'url',
                          inputmode: 'url',
                          autocapitalize: 'none',
                          autocorrect: 'off',
                          spellcheck: false
                        }"
                        placeholder="http://192.168.x.x:18990"
                        class="font-mono text-12.5px" />
                    </div>
                    <div class="space-y-4px text-12px">
                      <div class="text-[#737373] dark:text-[#9ca3af]">Bearer Token（~/.vibelink/auth-token.txt）</div>
                      <n-input
                        v-model:value="pairToken"
                        type="password"
                        clearable
                        :input-props="{ autocapitalize: 'none', autocorrect: 'off', spellcheck: false }"
                        show-password-on="click"
                        placeholder="输入 auth-token.txt 内容"
                        class="font-mono text-12.5px" />
                    </div>
                    <div
                      v-if="pairMsg"
                      class="px-10px py-6px rounded-8px text-12px"
                      :class="pairOk ? 'bg-[#13987f]/16 text-[#13987f] dark:text-[#5eead4]' : 'bg-[var(--danger-bg)] text-[var(--danger-text)]'">
                      {{ pairMsg }}
                    </div>
                    <div class="flex gap-8px pt-4px">
                      <n-button secondary class="flex-1" :loading="testing" @click="testMobilePair">
                        测试连通
                      </n-button>
                      <n-button
                        type="primary"
                        color="#13987f"
                        class="flex-1"
                        :loading="saving"
                        @click="saveMobilePair">
                        保存配对
                      </n-button>
                    </div>
                  </div>
                </n-card>
              </div>
            </n-tab-pane>

            <!-- Segment 2: Remote Phone Agent & Proxy Control -->
            <n-tab-pane name="agent" tab="控机" data-testid="mobile-settings-seg-agent">
              <div class="overflow-y-auto max-h-[calc(100vh-300px)] space-y-12px pt-8px pb-16px">
                <!-- Background Control Service Card -->
                <n-card size="small" embedded class="rounded-12px" data-testid="mobile-agent-status-card">
                  <div class="space-y-10px">
                    <div class="flex items-center justify-between gap-8px">
                      <div class="min-w-0">
                        <div class="text-13.5px font-semibold text-[var(--text-color)]">
                          后台远程控机通道
                        </div>
                        <div class="text-11.5px text-[#737373] dark:text-[#9ca3af]">
                          {{ localCaps?.socketConnected ? '已常驻连线电脑 Agent（支持息屏/后台操控）' : localCaps?.foregroundService ? '前台保活运行中，正在重连...' : '未启动后台常驻通道' }}
                        </div>
                      </div>
                      <n-switch
                        :value="Boolean(localCaps?.agentEnabled)"
                        size="small"
                        data-testid="mobile-agent-enabled-toggle"
                        @update:value="handleToggleAgentService" />
                    </div>

                    <div v-if="localCaps" class="text-11px font-mono text-[#737373] dark:text-[#9ca3af] space-y-2px">
                      <div>设备 ID：{{ localCaps.deviceId }}</div>
                      <div class="truncate">控制通道：{{ localCaps.activeEndpointUrl || store.serverUrl }}</div>
                    </div>

                    <div class="flex gap-8px">
                      <n-button size="small" secondary class="flex-1" @click="refreshLocalCaps">
                        刷新本机权限状态
                      </n-button>
                      <n-button
                        v-if="localCaps && !localCaps.batteryOptimizationIgnored"
                        size="small"
                        secondary
                        @click="handleBatteryExemption">
                        关闭省电限制
                      </n-button>
                    </div>
                  </div>
                </n-card>

                <!-- Root / Shizuku / Accessibility / VPN Capability Matrix -->
                <n-card size="small" embedded class="rounded-12px" data-testid="mobile-agent-caps-card">
                  <div class="space-y-10px text-12.5px">
                    <div class="font-semibold text-[var(--text-color)]">
                      双模权限矩阵（有 Root 走 su，无 Root 走无障碍 + 本地 VPN / Shizuku）
                    </div>

                    <div class="flex items-center justify-between gap-8px py-4px border-b border-[var(--line-color)]">
                      <div>
                        <div class="font-medium text-[var(--text-color)]">Root (su) 最高权限</div>
                        <div class="text-11px text-[#737373] dark:text-[#9ca3af]">可静默修改系统代理与执行任意系统指令</div>
                      </div>
                      <span
                        class="px-8px py-2px rounded-full text-11px shrink-0"
                        :class="localCaps?.root ? 'bg-[#13987f]/18 text-[#13987f] dark:text-[#5eead4]' : 'bg-[var(--search-bg-color)] text-[#888]'">
                        {{ localCaps?.root ? '已获取' : '未 Root' }}
                      </span>
                    </div>

                    <div class="flex items-center justify-between gap-8px py-4px border-b border-[var(--line-color)]">
                      <div class="min-w-0">
                        <div class="font-medium text-[var(--text-color)]">Shizuku 无线调试提权</div>
                        <div class="text-11px text-[#737373] dark:text-[#9ca3af]">
                          {{ localCaps?.shizukuGranted ? '已授权 shell 权限' : localCaps?.shizukuRunning ? 'Shizuku 运行中，点击授权' : localCaps?.shizukuInstalled ? '已安装 Shizuku，需先在 Shizuku 内激活' : '可选，无 Root 增强全局代理与 Shell' }}
                        </div>
                      </div>
                      <n-button
                        v-if="!localCaps?.shizukuGranted"
                        size="tiny"
                        secondary
                        @click="handleRequestShizuku">
                        请求授权
                      </n-button>
                      <span v-else class="px-8px py-2px rounded-full text-11px bg-[#13987f]/18 text-[#13987f] dark:text-[#5eead4] shrink-0">
                        已授权
                      </span>
                    </div>

                    <div class="flex items-center justify-between gap-8px py-4px border-b border-[var(--line-color)]">
                      <div class="min-w-0">
                        <div class="font-medium text-[var(--text-color)]">无障碍控机服务</div>
                        <div class="text-11px text-[#737373] dark:text-[#9ca3af]">
                          免 Root 读取界面控件树、点击、输入、截图（Android 11+）
                        </div>
                      </div>
                      <div class="flex items-center gap-6px shrink-0">
                        <n-button
                          v-if="!localCaps?.accessibilityEnabled && (localCaps?.root || localCaps?.shizukuGranted)"
                          size="tiny"
                          type="primary"
                          color="#13987f"
                          @click="handlePrivilegedAccessibility">
                          一键开启
                        </n-button>
                        <n-button
                          v-if="!localCaps?.accessibilityEnabled"
                          size="tiny"
                          secondary
                          @click="handleOpenAccessibility">
                          去开启
                        </n-button>
                        <span v-else class="px-8px py-2px rounded-full text-11px bg-[#13987f]/18 text-[#13987f] dark:text-[#5eead4]">
                          已开启
                        </span>
                      </div>
                    </div>

                    <div class="flex items-center justify-between gap-8px py-4px">
                      <div class="min-w-0">
                        <div class="font-medium text-[var(--text-color)]">本地 VPN 全机代理 (tun2proxy)</div>
                        <div class="text-11px text-[#737373] dark:text-[#9ca3af]">
                          首次授权一次后，电脑端可随时无感推送 WProxy 并全机生效
                        </div>
                      </div>
                      <n-button
                        v-if="!localCaps?.vpnPrepared"
                        size="tiny"
                        type="primary"
                        color="#13987f"
                        data-testid="mobile-request-vpn-btn"
                        @click="handleRequestVpn">
                        授权一次 VPN
                      </n-button>
                      <span v-else class="px-8px py-2px rounded-full text-11px bg-[#13987f]/18 text-[#13987f] dark:text-[#5eead4] shrink-0">
                        已预授权
                      </span>
                    </div>
                  </div>
                </n-card>

                <!-- Active Phone Proxy Control Card -->
                <n-card size="small" embedded class="rounded-12px" data-testid="mobile-agent-proxy-card">
                  <div class="space-y-8px text-12.5px">
                    <div class="flex items-center justify-between">
                      <span class="font-semibold text-[var(--text-color)]">手机代理生效状态</span>
                      <span
                        class="px-8px py-2px rounded-full text-11px font-mono"
                        :class="localCaps?.activeProxyMode && localCaps.activeProxyMode !== 'off' ? 'bg-[#13987f]/18 text-[#13987f] dark:text-[#5eead4]' : 'bg-[var(--search-bg-color)] text-[#888]'">
                        {{ localCaps?.activeProxyMode || 'off' }}
                      </span>
                    </div>
                    <div v-if="localCaps?.activeProxyUrl" class="font-mono text-11px text-[#13987f] dark:text-[#5eead4] break-all">
                      {{ localCaps.activeProxyUrl }}
                    </div>
                    <div v-if="agentNotice" class="px-10px py-6px rounded-8px bg-[#13987f]/16 text-[#13987f] dark:text-[#5eead4] text-11.5px">
                      {{ agentNotice }}
                    </div>
                    <div class="flex gap-8px pt-2px">
                      <n-button
                        size="small"
                        type="primary"
                        color="#13987f"
                        class="flex-1"
                        :loading="syncingWProxy"
                        data-testid="mobile-sync-wproxy-btn"
                        @click="handleSyncMyWProxy">
                        同步电脑 WProxy
                      </n-button>
                      <n-button
                        size="small"
                        secondary
                        class="flex-1"
                        data-testid="mobile-clear-proxy-btn"
                        @click="handleClearMyProxy">
                        关闭代理
                      </n-button>
                    </div>
                  </div>
                </n-card>
              </div>
            </n-tab-pane>

            <!-- Segment 3: Plugins (Magpie / WProxy) -->
            <n-tab-pane name="plugins" tab="插件">
              <div class="overflow-y-auto max-h-[calc(100vh-300px)] space-y-10px pt-8px pb-16px">
                <div v-if="store.plugins.length === 0" class="py-24px text-center text-12.5px text-[#888]">
                  {{ store.connected ? '暂无已加载插件' : '连接控制面后可管理 Magpie 与 WProxy 插件' }}
                </div>

                <n-card v-for="p in store.plugins" :key="p.id" size="small" embedded class="rounded-12px">
                  <div class="space-y-8px">
                    <div class="flex items-center justify-between gap-8px">
                      <span class="text-14px font-semibold text-[var(--text-color)]">{{ p.name }}</span>
                      <span
                        class="px-8px py-2px rounded-full text-11px"
                        :class="p.health.ok ? 'bg-[#13987f]/18 text-[#13987f] dark:text-[#5eead4]' : 'bg-[#f59e0b]/20 text-[#fbbf24]'">
                        {{ p.health.ok ? '运行中' : p.health.status }}
                      </span>
                    </div>
                    <div class="text-12px text-[#737373] dark:text-[#9ca3af]">
                      {{ p.health.message }}
                      <span v-if="p.capabilities.includes('agentDiscovery')">
                        · 已展示 {{ p.configuredAgents.length }} 个 Agent
                      </span>
                      <span v-if="p.capabilities.includes('modelCatalog')">
                        · {{ p.modelsCount }} 模型
                      </span>
                    </div>
                    <div class="flex gap-8px">
                      <n-button
                        v-if="p.capabilities.includes('agentDiscovery') || p.capabilities.includes('modelCatalog')"
                        size="small"
                        secondary
                        class="flex-1"
                        :loading="store.pluginsLoading"
                        @click="syncMobilePlugins(p.id)">
                        同步 Agent
                      </n-button>
                      <n-button
                        v-if="p.capabilities.includes('selfUpdate')"
                        size="small"
                        secondary
                        class="flex-1"
                        :loading="store.pluginsLoading"
                        @click="checkMobilePluginUpdate(p.id)">
                        检查更新
                      </n-button>
                      <n-button
                        v-if="p.capabilities.includes('proxyControl')"
                        size="small"
                        type="primary"
                        color="#13987f"
                        class="flex-1"
                        @click="activeSeg = 'wproxy'">
                        代理面板
                      </n-button>
                    </div>
                  </div>
                </n-card>

                <div v-if="mobilePluginNotice" class="px-10px py-8px rounded-8px bg-[#13987f]/14 text-[#13987f] dark:text-[#5eead4] text-12px whitespace-pre-wrap">
                  {{ mobilePluginNotice }}
                </div>
              </div>
            </n-tab-pane>

            <!-- Segment 4: Phone Embedded Mihomo OR Remote PC WProxy -->
            <n-tab-pane name="wproxy" tab="代理" data-testid="mobile-settings-seg-wproxy">
              <div class="overflow-y-auto max-h-[calc(100vh-300px)] space-y-10px pt-8px pb-16px">
                <div
                  class="flex gap-4px p-4px rounded-10px bg-[var(--search-bg-color)] border border-[var(--line-color)]"
                  data-testid="mobile-proxy-scope-switch">
                  <button
                    type="button"
                    class="flex-1 py-6px rounded-8px border-0 text-12px font-medium cursor-pointer transition-colors"
                    :class="proxyScope === 'phone' ? 'bg-[#13987f] text-white' : 'bg-transparent text-[#737373] dark:text-[#9ca3af]'"
                    @click="proxyScope = 'phone'">
                    本机代理（手机）
                  </button>
                  <button
                    type="button"
                    class="flex-1 py-6px rounded-8px border-0 text-12px font-medium cursor-pointer transition-colors"
                    :class="proxyScope === 'pc' ? 'bg-[#13987f] text-white' : 'bg-transparent text-[#737373] dark:text-[#9ca3af]'"
                    @click="proxyScope = 'pc'">
                    电脑代理（WProxy 遥控）
                  </button>
                </div>

                <n-card
                  v-if="proxyScope === 'phone' && localCaps"
                  size="small"
                  embedded
                  class="rounded-12px"
                  data-testid="mobile-embedded-mihomo-card">
                  <div class="space-y-10px">
                    <div class="flex items-center justify-between gap-8px">
                      <div class="min-w-0">
                        <div class="text-13.5px font-semibold text-[var(--text-color)]">
                          本机内置 Mihomo 内核（单 App 闭环）
                        </div>
                        <div class="text-11px text-[#737373] dark:text-[#9ca3af] truncate">
                          {{
                            mihomoStatus?.running
                              ? `运行中 ${mihomoStatus.version || ''} · 实际出口：${mihomoStatus.activeNode || '默认'}`
                              : mihomoStatus?.available
                                ? (mihomoStatus.hasConfig ? '内核就绪 · 已保存配置' : '内核就绪 · 请先从电脑同步配置')
                                : '仅 Android ARM64 安装包可用'
                          }}
                        </div>
                      </div>
                      <n-switch
                        :value="Boolean(mihomoStatus?.running)"
                        :loading="mihomoBusy"
                        :disabled="!mihomoStatus?.available"
                        size="small"
                        data-testid="mobile-mihomo-toggle"
                        @update:value="handleToggleMihomo" />
                    </div>

                    <div class="flex flex-wrap gap-6px">
                      <n-button
                        size="small"
                        type="primary"
                        color="#13987f"
                        class="flex-1 min-w-100px"
                        :loading="mihomoBusy"
                        data-testid="mobile-sync-mihomo-btn"
                        @click="handleSyncMihomoFromPc">
                        从电脑同步配置
                      </n-button>
                      <n-button
                        size="small"
                        secondary
                        @click="showTsKeyBox = !showTsKeyBox">
                        {{ showTsKeyBox ? '收起 TS Key' : (mihomoStatus?.tailscaleStateExists ? '重设 TS Key' : '填 TS Key') }}
                      </n-button>
                      <n-button
                        v-if="mihomoStatus?.running"
                        size="small"
                        secondary
                        :loading="mihomoDelayTesting"
                        @click="handleTestMihomoDelay">
                        测速
                      </n-button>
                      <n-button
                        v-if="mihomoStatus?.running"
                        size="small"
                        secondary
                        :loading="mihomoProbing"
                        data-testid="mobile-probe-mihomo-btn"
                        @click="handleProbeMihomoConnectivity">
                        验外网
                      </n-button>
                    </div>

                    <div v-if="showTsKeyBox" class="space-y-6px">
                      <n-input
                        v-model:value="tsKeyInput"
                        size="small"
                        clearable
                        :input-props="{ autocapitalize: 'none', autocorrect: 'off', spellcheck: false }"
                        placeholder="可选：tskey-auth-...（留空则复用已入网状态或生成登录链接）"
                        class="font-mono text-11.5px" />
                    </div>

                    <div
                      v-if="mihomoStatus?.tailscaleLoginUrl"
                      class="p-8px rounded-8px bg-[#f59e0b]/14 border border-[#f59e0b]/40 flex items-center justify-between gap-8px">
                      <span class="text-11.5px text-[#f59e0b] leading-snug">
                        内置 Tailscale 等待授权（5G 控机需完成一次登录）
                      </span>
                      <n-button
                        size="tiny"
                        type="warning"
                        @click="handleOpenTailscaleLogin(mihomoStatus.tailscaleLoginUrl!)">
                        一键登录
                      </n-button>
                    </div>

                    <div
                      v-if="mihomoNotice"
                      class="px-10px py-6px rounded-8px text-11.5px break-all"
                      :class="mihomoNoticeWarn ? 'bg-[#f59e0b]/16 text-[#f59e0b]' : 'bg-[#13987f]/16 text-[#13987f] dark:text-[#5eead4]'">
                      {{ mihomoNotice }}
                    </div>

                    <div v-if="mihomoStatus?.running && mihomoGroups.length > 0" class="space-y-8px pt-2px">
                      <div class="flex items-center justify-between gap-8px">
                        <span class="text-11.5px text-[#737373] dark:text-[#9ca3af]">本机代理模式</span>
                        <div class="flex gap-4px">
                          <n-button
                            v-for="modeOpt in (['rule', 'global', 'direct'] as const)"
                            :key="modeOpt"
                            size="tiny"
                            :type="mihomoStatus.routeMode === modeOpt ? 'primary' : 'default'"
                            :color="mihomoStatus.routeMode === modeOpt ? '#13987f' : undefined"
                            @click="handleSetMihomoMode(modeOpt)">
                            {{ modeOpt === 'rule' ? '规则' : modeOpt === 'global' ? '全局' : '直连' }}
                          </n-button>
                        </div>
                      </div>

                      <div class="flex gap-6px overflow-x-auto pb-2px">
                        <n-button
                          v-for="grp in mihomoGroups"
                          :key="grp.name"
                          size="tiny"
                          :type="selectedMihomoGroup === grp.name ? 'primary' : 'default'"
                          :color="selectedMihomoGroup === grp.name ? '#13987f' : undefined"
                          @click="selectedMihomoGroup = grp.name">
                          {{ mihomoStatus?.entryGroupNow === grp.name ? `● ${grp.name}` : grp.name }}
                        </n-button>
                      </div>

                      <div
                        v-if="activeMihomoGroupObj && activeMihomoGroupObj.name !== '手动选择' && mihomoStatus?.entryGroupNow && mihomoStatus.entryGroupNow !== activeMihomoGroupObj.name"
                        class="text-10.5px text-[#f59e0b]">
                        当前实际入口组为「{{ mihomoStatus.entryGroupNow }}」，点击下方节点将自动切入「{{ activeMihomoGroupObj.name }}」生效
                      </div>

                      <div v-if="activeMihomoGroupObj" class="grid grid-cols-2 gap-6px max-h-210px overflow-y-auto pr-2px">
                        <button
                          v-for="nodeName in activeMihomoGroupObj.all"
                          :key="nodeName"
                          type="button"
                          class="px-8px py-6px rounded-8px border text-left transition-colors cursor-pointer bg-transparent"
                          :class="
                            activeMihomoGroupObj.now === nodeName
                              ? 'bg-[#13987f]/16 border-[#13987f] text-[var(--text-color)]'
                              : 'bg-[var(--center-bg-color)] border-[var(--line-color)] text-[var(--text-color)]'
                          "
                          @click="handleSelectMihomoNode(activeMihomoGroupObj.name, nodeName)">
                          <div class="text-11.5px font-medium truncate">{{ nodeName }}</div>
                          <div class="text-10px font-mono mt-2px" :class="mihomoNodeDelayClass(nodeName)">
                            {{ mihomoNodeMetaText(nodeName) }}
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                </n-card>

                <WProxyPanel v-if="proxyScope === 'pc'" compact />
              </div>
            </n-tab-pane>

            <n-tab-pane name="account" tab="账号" data-testid="mobile-settings-seg-account">
              <div class="overflow-y-auto max-h-[calc(100vh-280px)] space-y-12px pt-8px pb-16px">
                <AccountWelfarePanel compact @open-auth-modal="accountAuthOpen = true" />
              </div>
            </n-tab-pane>
          </n-tabs>
        </n-card>
      </div>
      <AccountAuthModal :open="accountAuthOpen" @close="accountAuthOpen = false" />

      <!-- Paste Pairing Code / Deep Link Modal -->
      <n-modal
        v-model:show="pasteModalOpen"
        preset="card"
        title="粘贴桌面端配对码"
        class="w-90vw max-w-400px rounded-14px"
        data-testid="mobile-paste-qr-modal">
        <div class="space-y-10px text-12.5px">
          <div class="text-[#737373] dark:text-[#9ca3af] leading-relaxed">
            粘贴电脑端「连接与运行态」里复制的配对码（JSON / <code class="px-3px">vibelink://pair?...</code> / URL），自动导入内网与外网全部通道及 Token。
          </div>
          <n-input
            v-model:value="pasteInput"
            type="textarea"
            :rows="4"
            data-testid="mobile-paste-qr-input"
            :input-props="{
              autocapitalize: 'none',
              autocorrect: 'off',
              spellcheck: false
            }"
            placeholder='{"v":1,"h":"PC","k":"...","e":[...]}'
            class="font-mono text-12px" />
          <div
            v-if="pasteError"
            class="px-10px py-6px rounded-8px bg-[var(--danger-bg)] text-[var(--danger-text)] text-12px">
            {{ pasteError }}
          </div>
          <div class="flex justify-end gap-8px pt-4px">
            <n-button @click="pasteModalOpen = false">取消</n-button>
            <n-button
              type="primary"
              color="#13987f"
              :loading="applyingPaste"
              data-testid="mobile-paste-qr-submit"
              @click="submitPastePairing">
              导入并自动连接
            </n-button>
          </div>
        </div>
      </n-modal>

      <!-- Add Custom Channel Modal -->
      <n-modal
        v-model:show="addChannelOpen"
        preset="card"
        title="添加内网 / 外网通道"
        class="w-90vw max-w-400px rounded-14px"
        data-testid="mobile-add-channel-modal">
        <div class="space-y-10px text-12.5px">
          <div class="space-y-4px">
            <div class="text-[#737373] dark:text-[#9ca3af]">通道名称</div>
            <n-input v-model:value="newChannelLabel" placeholder="例如：家宽内网 / Tailscale / 域名穿透" />
          </div>
          <div class="space-y-4px">
            <div class="text-[#737373] dark:text-[#9ca3af]">Server URL</div>
            <n-input
              v-model:value="newChannelUrl"
              :input-props="{
                type: 'url',
                inputmode: 'url',
                autocapitalize: 'none',
                autocorrect: 'off',
                spellcheck: false
              }"
              placeholder="http://100.x.x.x:18990"
              class="font-mono text-12px" />
          </div>
          <div class="space-y-4px">
            <div class="text-[#737373] dark:text-[#9ca3af]">网络类型</div>
            <n-select v-model:value="newChannelKind" :options="channelKindOptions" />
          </div>
          <div
            v-if="addChannelError"
            class="px-10px py-6px rounded-8px bg-[var(--danger-bg)] text-[var(--danger-text)] text-12px">
            {{ addChannelError }}
          </div>
          <div class="flex justify-end gap-8px pt-4px">
            <n-button @click="addChannelOpen = false">取消</n-button>
            <n-button type="primary" color="#13987f" @click="submitAddChannel">
              保存通道
            </n-button>
          </div>
        </div>
      </n-modal>
    </template>
  </MobileScaffold>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import MobileScaffold from '#/components/MobileScaffold.vue'
import { ThemeEnum } from '@/enums'
import { useSettingStore } from '@/stores/setting'
import AccountAuthModal from '../components/AccountAuthModal.vue'
import AccountWelfarePanel from '../components/AccountWelfarePanel.vue'
import VlAvatar from '../components/VlAvatar.vue'
import WProxyPanel from '../components/WProxyPanel.vue'
import {
  clearAndroidLocalProxy,
  enableAndroidAccessibilityWithPrivilege,
  getAndroidDeviceCapabilities,
  getAndroidMihomoProxies,
  getAndroidMihomoStatus,
  openAndroidAccessibilitySettings,
  openAndroidExternalUrl,
  probeAndroidMihomoConnectivity,
  requestAndroidBatteryExemption,
  requestAndroidShizukuPermission,
  requestAndroidVpnPermission,
  selectAndroidMihomoNode,
  setAndroidAgentEnabled,
  setAndroidMihomoMode,
  startAndroidMihomo,
  stopAndroidMihomo,
  syncAndroidSystemBars,
  testAndroidMihomoDelay
} from '../runtime'
import { useVibeLinkStore } from '../store'
import type { VlChannelKind, VlLocalAndroidCapabilities, VlMihomoProxiesPayload, VlMihomoStatus } from '../types'

const props = defineProps<{
  openPasteTick?: number
}>()

defineEmits<{
  scanQr: []
}>()

const store = useVibeLinkStore()
const settingStore = useSettingStore()

const activeSeg = ref<'pair' | 'agent' | 'plugins' | 'wproxy' | 'account'>('pair')
const accountAuthOpen = ref(false)
const pairUrl = ref(store.serverUrl)
const pairToken = ref(store.authToken)
const pairMsg = ref('')
const pairOk = ref(true)
const testing = ref(false)
const saving = ref(false)
const mobilePluginNotice = ref('')

const localCaps = ref<VlLocalAndroidCapabilities | null>(getAndroidDeviceCapabilities())
const agentNotice = ref('')
const syncingWProxy = ref(false)
const mihomoStatus = ref<VlMihomoStatus | null>(null)
const mihomoProxies = ref<VlMihomoProxiesPayload | null>(null)
const mihomoBusy = ref(false)
const mihomoDelayTesting = ref(false)
const mihomoProbing = ref(false)
const mihomoNotice = ref('')
const mihomoNoticeWarn = ref(false)
const proxyScope = ref<'phone' | 'pc'>('phone')
const showTsKeyBox = ref(false)
const tsKeyInput = ref('')
const selectedMihomoGroup = ref('手动选择')
let capsTimer: ReturnType<typeof setInterval> | null = null

const mihomoGroups = computed(() =>
  (mihomoProxies.value?.groups ?? []).filter((g) => g.name !== 'GLOBAL' && g.all.length > 0)
)
const activeMihomoGroupObj = computed(
  () =>
    mihomoGroups.value.find((g) => g.name === selectedMihomoGroup.value) ??
    mihomoGroups.value[0] ??
    null
)

function mihomoNodeMetaText(nodeName: string): string {
  const meta = mihomoProxies.value?.nodes?.[nodeName]
  if (!meta) return '节点'
  if (typeof meta.delay === 'number' && meta.delay > 0) return `${meta.type} · ${meta.delay}ms`
  return meta.alive ? `${meta.type || 'Direct'}` : `${meta.type} · 超时`
}

function mihomoNodeDelayClass(nodeName: string): string {
  const meta = mihomoProxies.value?.nodes?.[nodeName]
  if (!meta) return 'text-[#888]'
  if (typeof meta.delay === 'number' && meta.delay > 0) {
    return meta.delay < 300 ? 'text-[#13987f] dark:text-[#5eead4]' : 'text-[#f59e0b]'
  }
  return meta.alive ? 'text-[#888]' : 'text-[var(--danger-text)]'
}

function refreshMihomoState() {
  const stRes = getAndroidMihomoStatus()
  if (stRes.ok && stRes.data) {
    mihomoStatus.value = stRes.data
    if (stRes.data.running) {
      const pxRes = getAndroidMihomoProxies()
      if (pxRes.ok && pxRes.data) {
        mihomoProxies.value = pxRes.data
        const availNames = pxRes.data.groups.map((g) => g.name)
        if (!availNames.includes(selectedMihomoGroup.value) && availNames.length > 0) {
          selectedMihomoGroup.value = availNames.includes('手动选择') ? '手动选择' : availNames[0]
        }
      }
    } else {
      mihomoProxies.value = null
    }
  }
}

function refreshLocalCaps() {
  localCaps.value = getAndroidDeviceCapabilities()
  refreshMihomoState()
}

function handleToggleMihomo(enable: boolean) {
  mihomoNotice.value = ''
  mihomoBusy.value = true
  try {
    if (enable) {
      const vpnPerm = requestAndroidVpnPermission()
      if (vpnPerm === 'requested') {
        mihomoNotice.value = '请在系统弹窗允许 VPN 权限后再次打开开关'
        return
      }
      const res = startAndroidMihomo({})
      if (!res.ok) throw new Error(res.error || '启动内置 Mihomo 失败')
      mihomoNotice.value = '内置 Mihomo 内核与单 App 透明隧道已启动'
    } else {
      const res = stopAndroidMihomo()
      if (!res.ok) throw new Error(res.error || '停止内置 Mihomo 失败')
      mihomoNotice.value = '已停止内置 Mihomo 隧道'
    }
    setTimeout(refreshLocalCaps, 400)
  } catch (err) {
    mihomoNotice.value = err instanceof Error ? err.message : String(err)
  } finally {
    mihomoBusy.value = false
  }
}

async function handleSyncMihomoFromPc() {
  mihomoNotice.value = ''
  mihomoBusy.value = true
  try {
    const vpnPerm = requestAndroidVpnPermission()
    if (vpnPerm === 'requested') {
      mihomoNotice.value = '已弹出系统 VPN 授权，请点击「确定」后再点一次同步'
      return
    }
    refreshLocalCaps()
    const deviceId = localCaps.value?.deviceId
    if (!deviceId) throw new Error('尚未识别到本机设备 ID')
    const key = tsKeyInput.value.trim()
    const res = await store.syncMihomoToDevice(deviceId, {
      ...(key ? { tailscaleAuthKey: key, resetTailscaleState: true } : {}),
      start: true
    })
    mihomoNotice.value = `已同步 ${res.configName} (${Math.round(res.bytes / 1024)} KB) 并启动内置 Mihomo`
    setTimeout(refreshLocalCaps, 600)
  } catch (err) {
    mihomoNotice.value = `同步失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    mihomoBusy.value = false
  }
}

function handleSelectMihomoNode(group: string, node: string) {
  mihomoNotice.value = ''
  mihomoNoticeWarn.value = false
  const res = selectAndroidMihomoNode(group, node)
  if (!res.ok) {
    mihomoNoticeWarn.value = true
    mihomoNotice.value = res.error || '切换节点失败'
    return
  }
  mihomoNotice.value = `已生效：${res.data?.activeNode || node}`
  setTimeout(refreshLocalCaps, 250)
}

function handleSetMihomoMode(mode: 'rule' | 'global' | 'direct') {
  mihomoNotice.value = ''
  mihomoNoticeWarn.value = false
  const res = setAndroidMihomoMode(mode)
  if (!res.ok) {
    mihomoNoticeWarn.value = true
    mihomoNotice.value = res.error || '切换本机代理模式失败'
    return
  }
  const label = mode === 'rule' ? '规则' : mode === 'global' ? '全局' : '直连'
  mihomoNotice.value = `已切换本机代理模式为「${label}」· 出口：${res.data?.activeNode || '默认'}`
  setTimeout(refreshLocalCaps, 250)
}

function handleTestMihomoDelay() {
  if (!activeMihomoGroupObj.value) return
  mihomoDelayTesting.value = true
  mihomoNotice.value = ''
  mihomoNoticeWarn.value = false
  setTimeout(() => {
    try {
      const res = testAndroidMihomoDelay({
        group: activeMihomoGroupObj.value?.name || '手动选择',
        timeoutMs: 5000
      })
      if (!res.ok) {
        mihomoNoticeWarn.value = true
        mihomoNotice.value = res.error || '测速失败'
      } else {
        mihomoNotice.value = `已刷新「${activeMihomoGroupObj.value?.name}」实时延迟`
      }
      refreshMihomoState()
    } finally {
      mihomoDelayTesting.value = false
    }
  }, 40)
}

function handleProbeMihomoConnectivity() {
  mihomoProbing.value = true
  mihomoNotice.value = ''
  mihomoNoticeWarn.value = false
  setTimeout(() => {
    try {
      const res = probeAndroidMihomoConnectivity()
      if (!res.ok || !res.data) {
        mihomoNoticeWarn.value = true
        mihomoNotice.value = res.error || '外网连通性检测失败'
        return
      }
      const d = res.data
      const gText = d.googleOk ? `Google ${d.googleMs}ms` : `Google 失败(${d.googleError || d.googleCode})`
      const xText = d.xOk ? `X/Twitter ${d.xMs}ms` : `X 失败(${d.xError || d.xCode})`
      mihomoNoticeWarn.value = !(d.googleOk && d.xOk)
      mihomoNotice.value = `${gText} · ${xText} · 出口：${d.activeNode || '默认'}`
      refreshMihomoState()
    } finally {
      mihomoProbing.value = false
    }
  }, 40)
}

function handleOpenTailscaleLogin(url: string) {
  openAndroidExternalUrl(url)
}

function handleToggleAgentService(enabled: boolean) {
  agentNotice.value = ''
  if (enabled) {
    store.syncNativeAgentBridge(true)
  } else {
    setAndroidAgentEnabled(false)
  }
  setTimeout(refreshLocalCaps, 400)
  agentNotice.value = enabled ? '已开启后台常驻控机通道' : '已暂停后台常驻控机通道'
}

function handleBatteryExemption() {
  requestAndroidBatteryExemption()
  setTimeout(refreshLocalCaps, 1200)
}

function handleRequestShizuku() {
  const status = requestAndroidShizukuPermission()
  agentNotice.value =
    status === 'already_granted'
      ? 'Shizuku 权限已授权'
      : status === 'shizuku_not_running'
        ? '请先在系统里打开并启动 Shizuku 服务'
        : '已弹出 Shizuku 授权提示，请在系统弹窗中允许'
  setTimeout(refreshLocalCaps, 1000)
}

function handleOpenAccessibility() {
  openAndroidAccessibilitySettings()
  agentNotice.value = '请在系统「无障碍 / 已下载的应用」中找到 VibeLink 并开启'
}

function handlePrivilegedAccessibility() {
  const res = enableAndroidAccessibilityWithPrivilege()
  if (res.ok) {
    agentNotice.value = `已通过 ${res.backend} 一键启用无障碍控机服务`
    setTimeout(refreshLocalCaps, 500)
  } else {
    agentNotice.value = `一键开启失败：${res.stderr || '请手动前往无障碍设置开启'}`
  }
}

function handleRequestVpn() {
  const res = requestAndroidVpnPermission()
  agentNotice.value =
    res === 'already_prepared'
      ? 'VPN 权限已预授权，电脑端可随时无感下发代理'
      : '请在系统弹窗中点击「确定」完成一次授权'
  setTimeout(refreshLocalCaps, 1200)
}

async function handleSyncMyWProxy() {
  agentNotice.value = ''
  syncingWProxy.value = true
  try {
    refreshLocalCaps()
    const deviceId = localCaps.value?.deviceId
    if (!deviceId) throw new Error('尚未识别到本机设备 ID')
    const res = await store.syncWProxyToDevice(deviceId, { scheme: 'socks5', mode: 'auto' })
    agentNotice.value = `已同步并启用电脑 WProxy：${res.proxyUrl}`
    setTimeout(refreshLocalCaps, 600)
  } catch (err) {
    agentNotice.value = `同步 WProxy 失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    syncingWProxy.value = false
  }
}

async function handleClearMyProxy() {
  agentNotice.value = ''
  const res = clearAndroidLocalProxy()
  if (res.ok) {
    agentNotice.value = '已关闭手机端代理配置'
    setTimeout(refreshLocalCaps, 500)
  } else {
    agentNotice.value = res.error || '关闭代理失败'
  }
}

onMounted(() => {
  refreshLocalCaps()
  capsTimer = setInterval(refreshLocalCaps, 3000)
})

onUnmounted(() => {
  if (capsTimer) {
    clearInterval(capsTimer)
    capsTimer = null
  }
})

const testingChannelId = ref<string | null>(null)
const switchingChannelId = ref<string | null>(null)

const pasteModalOpen = ref(false)
const pasteInput = ref('')
const pasteError = ref('')
const applyingPaste = ref(false)

const addChannelOpen = ref(false)
const newChannelLabel = ref('')
const newChannelUrl = ref('')
const newChannelKind = ref<'auto' | VlChannelKind>('auto')
const addChannelError = ref('')

const channelKindOptions = [
  { label: '自动识别（推荐）', value: 'auto' },
  { label: '内网 LAN', value: 'lan' },
  { label: 'Tailscale 组网', value: 'tailscale' },
  { label: '外网 / 域名隧道', value: 'wan' },
  { label: '自定义', value: 'custom' }
]

const isDark = computed(() => settingStore.themes.content === ThemeEnum.DARK)

watch(
  () => [store.serverUrl, store.authToken] as const,
  ([u, t]) => {
    pairUrl.value = u
    pairToken.value = t
    setTimeout(refreshLocalCaps, 500)
  }
)

watch(
  () => store.connected,
  () => {
    setTimeout(refreshLocalCaps, 600)
  }
)

watch(
  () => props.openPasteTick,
  (val) => {
    if (val && val > 0) {
      activeSeg.value = 'pair'
      openPasteQrModal()
    }
  }
)

function channelKindLabel(kind: VlChannelKind): string {
  switch (kind) {
    case 'lan':
      return '内网'
    case 'tailscale':
      return 'Tailscale'
    case 'wan':
      return '外网'
    default:
      return '自定义'
  }
}

function channelKindBadgeClass(kind: VlChannelKind): string {
  switch (kind) {
    case 'lan':
      return 'bg-[#13987f]/18 text-[#13987f] dark:text-[#5eead4]'
    case 'tailscale':
      return 'bg-[#2563eb]/18 text-[#2563eb] dark:text-[#93c5fd]'
    case 'wan':
      return 'bg-[#7c3aed]/18 text-[#7c3aed] dark:text-[#c4b5fd]'
    default:
      return 'bg-[#64748b]/18 text-[#64748b] dark:text-[#cbd5e1]'
  }
}

function handleToggleAutoSwitch(enabled: boolean) {
  store.setChannelSwitchMode(enabled ? 'auto' : 'manual')
  window.$message?.info?.(enabled ? '已开启内外网自动切换' : '已切换为手动选路模式')
}

function openPasteQrModal() {
  pasteError.value = ''
  pasteModalOpen.value = true
}

async function submitPastePairing() {
  pasteError.value = ''
  applyingPaste.value = true
  try {
    const res = await store.applyPairingQrPayload(pasteInput.value)
    pasteModalOpen.value = false
    pasteInput.value = ''
    pairOk.value = true
    pairMsg.value = res.endpoint
      ? `已导入 ${res.totalChannels} 条通道，当前连接 ${res.endpoint.label}`
      : `已导入 ${res.totalChannels} 条通道`
    window.$message?.success?.(pairMsg.value)
  } catch (err) {
    pasteError.value = err instanceof Error ? err.message : String(err)
  } finally {
    applyingPaste.value = false
  }
}

function openAddChannelModal() {
  newChannelLabel.value = ''
  newChannelUrl.value = ''
  newChannelKind.value = 'auto'
  addChannelError.value = ''
  addChannelOpen.value = true
}

function submitAddChannel() {
  addChannelError.value = ''
  const rawUrl = newChannelUrl.value.trim()
  if (!rawUrl) {
    addChannelError.value = '请输入服务器 URL'
    return
  }
  try {
    const entry = store.addChannelEndpoint({
      label: newChannelLabel.value.trim() || undefined,
      url: rawUrl,
      kind: newChannelKind.value === 'auto' ? undefined : newChannelKind.value
    })
    addChannelOpen.value = false
    window.$message?.success?.(`已添加通道 ${entry.label}`)
  } catch (err) {
    addChannelError.value = err instanceof Error ? err.message : String(err)
  }
}

async function runSingleSpeedTest(endpointId: string) {
  testingChannelId.value = endpointId
  try {
    const res = await store.testChannelSpeed(endpointId)
    if (res.ok) {
      window.$message?.success?.(
        `测速完成：${res.latencyMs}ms · ↓${res.downloadMbps} / ↑${res.uploadMbps} Mbps`
      )
    } else {
      window.$message?.warning?.(`测速不可达：${res.error || '连接超时'}`)
    }
  } finally {
    testingChannelId.value = null
  }
}

async function runAllSpeedTests() {
  const list = await store.testAllChannelsSpeed()
  const okCount = list.filter((r) => r.ok).length
  window.$message?.info?.(`全部通道测速完成：${okCount}/${list.length} 条可用`)
}

async function runAutoSelect() {
  const best = await store.autoSelectBestChannel({ forceReconnect: true })
  if (best) {
    window.$message?.success?.(`已切换至最优通道：${best.label}`)
  } else {
    window.$message?.error?.('当前没有可用通道，请检查网络或 Tailscale')
  }
}

async function handleSwitchChannel(endpointId: string) {
  switchingChannelId.value = endpointId
  try {
    const ch = await store.switchToChannel(endpointId)
    pairOk.value = true
    pairMsg.value = `已切换至 ${ch.label}`
    window.$message?.success?.(`已切换至 ${ch.label}`)
  } catch (err) {
    pairOk.value = false
    pairMsg.value = `切换失败：${err instanceof Error ? err.message : String(err)}`
    window.$message?.error?.(pairMsg.value)
  } finally {
    switchingChannelId.value = null
  }
}

function toggleAppTheme() {
  const next = isDark.value ? ThemeEnum.LIGHT : ThemeEnum.DARK
  settingStore.toggleTheme(next)
  syncAndroidSystemBars(next === ThemeEnum.DARK)
}

async function refreshControlPlane() {
  try {
    await store.bootstrap()
    window.$message?.success?.('已刷新控制面与插件状态')
  } catch (err) {
    window.$message?.error?.(`刷新失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function testMobilePair() {
  pairMsg.value = ''
  testing.value = true
  try {
    const h = await store.testConnection(pairUrl.value, pairToken.value)
    pairOk.value = true
    pairMsg.value = `连接成功：${h.botsCount} Bots, ${h.roomsCount} 会话`
  } catch (err) {
    pairOk.value = false
    pairMsg.value = `连接失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    testing.value = false
  }
}

async function saveMobilePair() {
  pairMsg.value = ''
  saving.value = true
  try {
    await store.reconnect(pairUrl.value, pairToken.value)
    pairOk.value = true
    pairMsg.value = '配对成功，会话已同步'
    window.$message?.success?.('配对成功')
  } catch (err) {
    pairOk.value = false
    pairMsg.value = `配对失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    saving.value = false
  }
}

async function syncMobilePlugins(pluginId: string) {
  mobilePluginNotice.value = ''
  try {
    await store.syncPlugins(pluginId)
    mobilePluginNotice.value = `已同步插件 ${pluginId}（当前展示 ${store.bots.length} 个 Bot）`
  } catch (err) {
    mobilePluginNotice.value = `同步失败：${err instanceof Error ? err.message : String(err)}`
  }
}

async function checkMobilePluginUpdate(pluginId: string) {
  mobilePluginNotice.value = ''
  try {
    const info = await store.checkPluginUpdate(pluginId)
    mobilePluginNotice.value = `${info.updateAvailable ? '发现新版本' : '已是最新'}（${info.currentVersion || '未知'} -> ${info.latestVersion || '未知'}）\n${info.summary}`
  } catch (err) {
    mobilePluginNotice.value = `检查更新失败：${err instanceof Error ? err.message : String(err)}`
  }
}
</script>

<style scoped>
.custom-rounded {
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  overflow: hidden;
}
</style>
