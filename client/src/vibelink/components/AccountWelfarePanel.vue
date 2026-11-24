<template>
  <div
    class="space-y-3 text-[#eaeaea]"
    :class="compact ? 'text-12px' : 'text-12.5px'"
    data-testid="account-welfare-panel">
    <!-- Top Identity & Cluster Node Header -->
    <div class="p-3 rounded-10px bg-[#161919] border border-[#2d3231] flex flex-wrap items-center justify-between gap-2.5">
      <div class="min-w-0 space-y-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-14px font-semibold text-white">
            {{ store.authUser?.displayName || '管理员 (我)' }}
          </span>
          <span class="text-11px font-mono text-[#9ca3af]">@{{ store.authUser?.username || 'admin' }}</span>
          <span
            class="px-2 py-0.5 rounded-full text-10.5px font-medium"
            :class="
              isAdmin
                ? 'bg-[#13987f]/22 text-[#5eead4] border border-[#13987f]/45'
                : 'bg-[#2a2f2e] text-[#cbd5e1]'
            ">
            {{ isAdmin ? '超级管理员' : '普通用户' }}
          </span>
          <span
            v-if="store.clusterSummary"
            class="px-2 py-0.5 rounded-full text-10.5px font-medium"
            :class="
              store.clusterSummary.role === 'standby'
                ? 'bg-[#3d2e14] text-[#fbbf24]'
                : 'bg-[#143d2d] text-[#4ade80]'
            ">
            {{ store.clusterSummary.nodeLabel }} · rev {{ store.clusterSummary.syncRevision }}
          </span>
        </div>
        <div class="text-11px text-[#8e9297]">
          认证方式：{{ authModeLabel }} · 当前连接：
          <span class="font-mono text-[#cbd5e1]">{{ store.serverUrl }}</span>
        </div>
      </div>

      <div class="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          class="px-2.5 py-1 rounded-6px bg-[#2a2f2e] hover:bg-[#363d3b] border-0 text-[#e5e7eb] text-11.5px cursor-pointer"
          :disabled="loading"
          @click="refreshAll">
          {{ loading ? '刷新中...' : '刷新' }}
        </button>
        <button
          type="button"
          class="px-2.5 py-1 rounded-6px bg-[#1d4940] hover:bg-[#13987f] border-0 text-[#99f6e4] hover:text-white text-11.5px cursor-pointer"
          @click="$emit('openAuthModal')">
          切换账号
        </button>
        <button
          v-if="store.sessionToken"
          type="button"
          class="px-2.5 py-1 rounded-6px bg-[#3b1d1d] hover:bg-[#522828] border-0 text-[#fecaca] text-11.5px cursor-pointer"
          @click="handleLogout">
          退出登录
        </button>
      </div>
    </div>

    <div
      v-if="bannerMsg"
      class="px-3 py-2 rounded-8px bg-[#143d2d] border border-[#22c55e]/35 text-[#a7f3d0] text-12px">
      {{ bannerMsg }}
    </div>
    <div
      v-if="errorMsg"
      class="px-3 py-2 rounded-8px bg-[#3b1d1d] border border-[#5f2f2f] text-[#fecaca] text-12px">
      {{ errorMsg }}
    </div>

    <!-- Primary Tabs (User Welfare vs Admin Console) -->
    <div v-if="isAdmin" class="flex gap-1.5 p-1 rounded-8px bg-[#151818] border border-[#2d3231]">
      <button
        type="button"
        data-testid="aw-tab-mine"
        class="flex-1 py-1.5 rounded-6px border-0 cursor-pointer text-12px font-medium"
        :class="mainTab === 'mine' ? 'bg-[#13987f] text-white' : 'bg-transparent text-[#9ca3af]'"
        @click="mainTab = 'mine'">
        我的福利与 API Key
      </button>
      <button
        type="button"
        data-testid="aw-tab-admin"
        class="flex-1 py-1.5 rounded-6px border-0 cursor-pointer text-12px font-medium"
        :class="mainTab === 'admin' ? 'bg-[#13987f] text-white' : 'bg-transparent text-[#9ca3af]'"
        @click="openAdminTab">
        管理员控制台（发福利 / 邀请码 / 主备集群）
      </button>
    </div>

    <!-- TAB 1: MY WELFARE & API KEYS -->
    <div v-if="mainTab === 'mine' || !isAdmin" class="space-y-3">
      <!-- KPI Cards -->
      <div class="grid gap-2" :class="compact ? 'grid-cols-1' : 'grid-cols-3'">
        <div class="p-2.5 rounded-8px bg-[#161919] border border-[#2c3130]">
          <div class="text-11px text-[#9ca3af]">今日 DeepSeek V4.1 免费额度</div>
          <div class="text-17px font-bold font-mono text-[#5eead4] mt-0.5">
            {{ formatNum(currentUser?.deepseekDailyRemaining ?? 0) }}
          </div>
          <div class="text-10px text-[#8e9297] font-mono mt-0.5">
            每日 {{ formatNum(currentUser?.deepseekDailyQuota ?? 10000000) }} · 次日刷新不累计
          </div>
        </div>
        <div class="p-2.5 rounded-8px bg-[#161919] border border-[#2c3130]">
          <div class="text-11px text-[#9ca3af]">DeepSeek 额外赠送余额</div>
          <div class="text-17px font-bold font-mono text-[#eaeaea] mt-0.5">
            {{ formatNum(currentUser?.tokenBalance ?? 0) }}
          </div>
          <div class="text-10px text-[#8e9297] font-mono mt-0.5">
            今日已用 {{ formatNum(currentUser?.deepseekDailyUsed ?? 0) }} · 累计 {{ formatNum(currentUser?.tokenUsed ?? 0) }}
          </div>
        </div>
        <div class="p-2.5 rounded-8px bg-[#161919] border border-[#2c3130]">
          <div class="text-11px text-[#9ca3af]">GPT-6.1 Sol 专属额度</div>
          <div class="text-17px font-bold font-mono text-[#fbbf24] mt-0.5">
            {{ formatNum(currentUser?.gptBalance ?? 0) }}
          </div>
          <div class="text-10px text-[#8e9297] font-mono mt-0.5">
            默认 0 · 仅管理员下发 · 已用 {{ formatNum(currentUser?.gptUsed ?? 0) }}
          </div>
        </div>
      </div>

      <!-- OpenAI Compatible Gateway Info + CDK Redeem -->
      <div class="grid gap-2.5" :class="compact ? 'grid-cols-1' : 'grid-cols-2'">
        <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
          <div class="flex items-center justify-between gap-2">
            <span class="font-semibold text-[#e5e7eb]">🎁 服务端赠送额度网关（仅走赠送 Token · 严禁反代 Claude/Gemini）</span>
            <button
              type="button"
              class="px-2 py-0.5 rounded bg-[#2a2f2e] border-0 text-[#5eead4] text-11px cursor-pointer"
              @click="copyText(`${store.serverUrl}/v1`, '已复制当前 /v1 Base URL')">
              复制当前
            </button>
          </div>
          <div class="text-11px text-[#8e9297]">
            仅用于使用服务端赠送的 `auto/deepseek-v4.1-flash`（每日 10M）及管理员下发的 `auto/gpt-6.1-sol`；自用 Key 请配置在下方「仅存本机网关」，切勿上传服务端。
          </div>
          <div class="text-11px font-mono text-[#9ca3af] break-all">
            主地址：{{ store.serverUrl }}/v1
          </div>
          <div v-if="standbyEndpoints.length > 0" class="text-11px font-mono text-[#fbbf24] break-all">
            备服地址：{{ standbyEndpoints[0].url }}/v1
          </div>
          <div v-if="availableModels.length > 0" class="flex flex-wrap items-center gap-1 pt-0.5">
            <span
              v-for="m in visibleAvailableModels"
              :key="m"
              class="px-1.5 py-0.2 rounded bg-[#202625] text-[#cbd5e1] text-10.5px font-mono">
              {{ m }}
            </span>
            <button
              v-if="availableModels.length > 12"
              type="button"
              class="px-1.5 py-0.2 rounded bg-[#1d4940] border-0 text-[#5eead4] text-10.5px cursor-pointer"
              @click="showAllModels = !showAllModels">
              {{ showAllModels ? '收起' : `展开全部 (${availableModels.length})` }}
            </button>
          </div>
          <div v-else class="text-11px text-[#737373]">
            暂未检测到可用授权模型（请确认节点 Magpie 运行中）
          </div>
        </div>

        <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
          <div class="font-semibold text-[#e5e7eb]">福利码 / CDK 兑换</div>
          <div class="flex gap-1.5">
            <input
              v-model="redeemCodeInput"
              type="text"
              placeholder="输入福利兑换码（如 GIFT-XXXXXX）"
              class="vl-aw-input flex-1 font-mono uppercase" />
            <button
              type="button"
              :disabled="!redeemCodeInput.trim() || actionBusy"
              class="px-3 py-1.5 rounded-6px bg-[#13987f] hover:bg-[#17ad91] disabled:opacity-50 border-0 text-white text-12px cursor-pointer shrink-0"
              @click="handleRedeem">
              兑换
            </button>
          </div>
          <div class="text-11px text-[#8e9297]">
            兑换成功后免费 Token 立即到账，并自动同步到 PC 主服与 Mac mini 备服。
          </div>
        </div>
      </div>

      <!-- My Personal API Keys (sk-vl-...) -->
      <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <span class="font-semibold text-[#e5e7eb]">我的 API Keys (`sk-vl-...`)</span>
          <div class="flex items-center gap-1.5">
            <input
              v-model="newKeyName"
              type="text"
              placeholder="Key 名称（可选）"
              class="vl-aw-input w-140px py-1!" />
            <button
              type="button"
              :disabled="actionBusy"
              class="px-2.5 py-1 rounded-6px bg-[#13987f] hover:bg-[#17ad91] border-0 text-white text-11.5px cursor-pointer"
              @click="handleCreateKey">
              + 生成 Key
            </button>
          </div>
        </div>

        <div v-if="store.myApiKeys.length === 0" class="text-11.5px text-[#8e9297]">
          还没有 API Key，点击右上角「+ 生成 Key」即可在支持 OpenAI 接口的客户端中使用你的免费 Token 额度。
        </div>
        <div v-else class="space-y-1.5 max-h-190px overflow-y-auto pr-1">
          <div
            v-for="k in store.myApiKeys"
            :key="k.id"
            class="p-2 rounded-6px bg-[#1f2424] border border-[#2f3534] flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-medium text-[#eaeaea]">{{ k.name }}</span>
                <span
                  class="px-1.5 py-0.2 rounded text-10px"
                  :class="k.revoked ? 'bg-[#3b1d1d] text-[#fca5a5]' : 'bg-[#143d2d] text-[#4ade80]'">
                  {{ k.revoked ? '已吊销' : '可用' }}
                </span>
                <span class="text-10.5px text-[#9ca3af] font-mono">已用 {{ formatNum(k.tokensUsed) }}</span>
              </div>
              <div class="text-11px font-mono text-[#8e9297] truncate">
                {{ k.key || k.keyPrefix }}
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button
                v-if="k.key && !k.revoked"
                type="button"
                class="px-2 py-0.5 rounded bg-[#2a2f2e] border-0 text-[#5eead4] text-11px cursor-pointer"
                @click="copyText(k.key!, `已复制 Key: ${k.name}`)">
                复制
              </button>
              <button
                v-if="!k.revoked"
                type="button"
                class="px-2 py-0.5 rounded bg-[#3b1d1d] border-0 text-[#fecaca] text-11px cursor-pointer"
                @click="handleRevokeKey(k.id)">
                吊销
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Local-Only BYOK / Own Gateway (Never Uploaded to Server) -->
      <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="font-semibold text-[#e5e7eb]">🔒 我的自有网关 / API Key（仅存本机，绝不上传服务端）</div>
            <div class="text-11px text-[#8e9297]">
              您自备的 Claude / Gemini / OpenAI 等 Key 与中转地址仅保存在当前设备 localStorage，并由本机直接发起请求，不会经过 VibeLink 服务端。
            </div>
          </div>
          <span class="px-2 py-0.5 rounded bg-[#143d2d] text-[#4ade80] text-10.5px font-mono shrink-0">
            LocalStorage 直连
          </span>
        </div>

        <div class="grid gap-2" :class="compact ? 'grid-cols-1' : 'grid-cols-5'">
          <input v-model="byokForm.name" type="text" placeholder="配置名（如：我的中转）" class="vl-aw-input" />
          <select v-model="byokForm.protocol" class="vl-aw-input">
            <option value="openai">OpenAI / 兼容</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="gemini">Google Gemini</option>
          </select>
          <input v-model="byokForm.baseUrl" type="text" placeholder="自有网关 Base URL" class="vl-aw-input font-mono" />
          <input v-model="byokForm.apiKey" type="password" placeholder="您的 API Key（仅存本机）" class="vl-aw-input font-mono" />
          <input v-model="byokForm.defaultModel" type="text" placeholder="默认模型名（可选）" class="vl-aw-input font-mono" />
        </div>
        <div class="flex justify-end">
          <button
            type="button"
            class="px-3 py-1 rounded-6px bg-[#2a2f2e] hover:bg-[#363d3b] border-0 text-[#5eead4] text-11.5px cursor-pointer"
            @click="handleSaveLocalByok">
            + 保存到本机（绝不上传）
          </button>
        </div>

        <div v-if="byokProfiles.length === 0" class="text-11px text-[#8e9297]">
          暂无本机自有网关配置。若需使用自有 Claude / Gemini / OpenAI 账号额度，请在此配置后直连您自己的网关。
        </div>
        <div v-else class="space-y-1.5 max-h-180px overflow-y-auto pr-1">
          <div
            v-for="p in byokProfiles"
            :key="p.id"
            class="p-2 rounded-6px bg-[#1f2424] border border-[#2f3534] flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-medium text-[#eaeaea]">{{ p.name }}</span>
                <span class="px-1.5 py-0.2 rounded bg-[#202625] text-[#5eead4] text-10px font-mono">{{ p.protocol }}</span>
                <span class="text-10.5px font-mono text-[#9ca3af]">{{ maskLocalApiKey(p.apiKey) }}</span>
                <span v-if="p.defaultModel" class="text-10.5px font-mono text-[#cbd5e1]">{{ p.defaultModel }}</span>
              </div>
              <div class="text-10.5px font-mono text-[#8e9297] truncate">{{ p.baseUrl }}</div>
              <div
                v-if="byokTestResults[p.id]"
                class="text-10.5px mt-0.5"
                :class="byokTestResults[p.id].ok ? 'text-[#4ade80]' : 'text-[#fca5a5]'">
                {{ byokTestResults[p.id].message }}
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                :disabled="byokBusyId === p.id"
                class="px-2 py-0.5 rounded bg-[#1d4940] border-0 text-[#99f6e4] text-11px cursor-pointer"
                @click="handleTestLocalByok(p)">
                {{ byokBusyId === p.id ? '测速中...' : '本机直连测试' }}
              </button>
              <button
                type="button"
                class="px-2 py-0.5 rounded bg-[#2a2f2e] border-0 text-[#e5e7eb] text-11px cursor-pointer"
                @click="copyText(p.baseUrl, `已复制自有网关地址: ${p.name}`)">
                复制地址
              </button>
              <button
                type="button"
                class="px-2 py-0.5 rounded bg-[#3b1d1d] border-0 text-[#fecaca] text-11px cursor-pointer"
                @click="handleDeleteLocalByok(p.id)">
                删除
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Received Welfare / Secret Drops Inbox -->
      <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
        <div class="font-semibold text-[#e5e7eb]">我收到的福利与专属下发</div>
        <div v-if="(store.myWelfare?.grants.length ?? 0) === 0" class="text-11.5px text-[#8e9297]">
          暂无下发记录。
        </div>
        <div v-else class="space-y-1.5 max-h-200px overflow-y-auto pr-1">
          <div
            v-for="g in store.myWelfare?.grants ?? []"
            :key="g.id"
            class="p-2.5 rounded-6px bg-[#1f2424] border border-[#2f3534] space-y-1">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-medium text-[#f3f4f6]">{{ g.title }}</span>
                <span
                  v-if="g.tokenAmount > 0"
                  class="px-1.5 py-0.2 rounded text-10.5px font-mono"
                  :class="g.quotaPool === 'gpt' ? 'bg-[#3d2e14] text-[#fbbf24]' : 'bg-[#143d2d] text-[#4ade80]'">
                  +{{ formatNum(g.tokenAmount) }} {{ g.quotaPool === 'gpt' ? 'GPT-6.1' : 'DeepSeek' }}
                </span>
              </div>
              <button
                v-if="!g.alreadyClaimed && g.status === 'active'"
                type="button"
                class="px-2 py-0.5 rounded bg-[#13987f] border-0 text-white text-11px cursor-pointer"
                @click="handleClaimGrant(g.id)">
                立即领取
              </button>
              <span v-else class="text-10.5px text-[#9ca3af]">{{ g.alreadyClaimed ? '已到账' : g.status }}</span>
            </div>
            <div v-if="g.description" class="text-11px text-[#9ca3af]">{{ g.description }}</div>
            <div
              v-if="hasPayloadDetails(g.payload)"
              class="p-2 rounded bg-[#141717] border border-[#2a302f] flex items-center justify-between gap-2">
              <div class="text-11px font-mono text-[#5eead4] break-all">
                {{ formatPayloadText(g.payload) }}
              </div>
              <button
                type="button"
                class="px-2 py-0.5 rounded bg-[#2a2f2e] border-0 text-[#e5e7eb] text-10.5px cursor-pointer shrink-0"
                @click="copyText(extractCopyPayload(g.payload), '已复制福利内容')">
                复制
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Ledger & Password Change -->
      <div class="grid gap-2.5" :class="compact ? 'grid-cols-1' : 'grid-cols-2'">
        <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
          <div class="font-semibold text-[#e5e7eb]">近期额度明细</div>
          <div v-if="(store.myWelfare?.ledger.length ?? 0) === 0" class="text-11.5px text-[#8e9297]">
            暂无账本流水。
          </div>
          <div v-else class="space-y-1 max-h-140px overflow-y-auto pr-1 text-11px font-mono">
            <div
              v-for="l in store.myWelfare?.ledger ?? []"
              :key="l.id"
              class="flex items-center justify-between gap-2 px-2 py-1 rounded bg-[#1d2121]">
              <span class="truncate text-[#cbd5e1]">
                <span :class="l.quotaPool === 'gpt' ? 'text-[#fbbf24]' : 'text-[#5eead4]'">
                  [{{ l.quotaPool === 'gpt' ? 'GPT' : 'DS' }}]
                </span>
                {{ l.reason }}{{ l.model ? ` · ${l.model}` : '' }}
              </span>
              <span :class="l.delta >= 0 ? 'text-[#4ade80]' : 'text-[#fca5a5]'">
                {{ l.delta >= 0 ? `+${l.delta}` : l.delta }}
              </span>
            </div>
          </div>
        </div>

        <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
          <div class="font-semibold text-[#e5e7eb]">修改登录密码</div>
          <input
            v-if="store.authMode === 'user_session'"
            v-model="oldPwd"
            type="password"
            placeholder="当前密码"
            class="vl-aw-input" />
          <div class="flex gap-1.5">
            <input
              v-model="newPwd"
              type="password"
              placeholder="设置新密码（至少 6 位）"
              class="vl-aw-input flex-1" />
            <button
              type="button"
              :disabled="newPwd.length < 6 || actionBusy"
              class="px-3 py-1 rounded-6px bg-[#2a2f2e] hover:bg-[#363d3b] disabled:opacity-50 border-0 text-[#eaeaea] text-11.5px cursor-pointer"
              @click="handleChangePassword">
              更新
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 2: ADMIN CONSOLE -->
    <div v-else class="space-y-3">
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="sub in adminSubTabs"
          :key="sub.id"
          type="button"
          class="px-2.5 py-1 rounded-6px border-0 cursor-pointer text-11.5px"
          :class="adminSubTab === sub.id ? 'bg-[#13987f] text-white font-medium' : 'bg-[#252928] text-[#cbd5e1]'"
          @click="switchAdminSubTab(sub.id)">
          {{ sub.label }}
        </button>
      </div>

      <!-- Admin Subtab 1: Users & Direct Grants -->
      <div v-if="adminSubTab === 'users'" class="space-y-2.5">
        <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
          <div class="font-semibold text-[#e5e7eb]">管理员新建账号</div>
          <div class="grid gap-2" :class="compact ? 'grid-cols-1' : 'grid-cols-5'">
            <input v-model="newUser.username" type="text" placeholder="用户名" class="vl-aw-input" />
            <input v-model="newUser.password" type="password" placeholder="初始密码 (>=6位)" class="vl-aw-input" />
            <input v-model="newUser.displayName" type="text" placeholder="显示名 (可选)" class="vl-aw-input" />
            <input v-model.number="newUser.tokenBalance" type="number" min="0" placeholder="初始 DS 额外额度" class="vl-aw-input" />
            <input v-model.number="newUser.gptBalance" type="number" min="0" placeholder="初始 GPT-6.1 (默认 0)" class="vl-aw-input" />
          </div>
          <div class="flex justify-end">
            <button
              type="button"
              :disabled="!newUser.username.trim() || newUser.password.length < 6 || actionBusy"
              class="px-3 py-1 rounded-6px bg-[#13987f] hover:bg-[#17ad91] disabled:opacity-50 border-0 text-white text-12px cursor-pointer"
              @click="handleAdminCreateUser">
              + 创建账号
            </button>
          </div>
        </div>

        <div class="space-y-2 max-h-320px overflow-y-auto pr-1">
          <div
            v-for="u in store.adminUsers"
            :key="u.id"
            class="p-2.5 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-semibold text-white">{{ u.displayName }}</span>
                <span class="font-mono text-11px text-[#9ca3af]">@{{ u.username }}</span>
                <span
                  class="px-1.5 py-0.2 rounded text-10px"
                  :class="u.role === 'admin' ? 'bg-[#13987f]/25 text-[#5eead4]' : 'bg-[#2a2f2e] text-[#cbd5e1]'">
                  {{ u.role }}
                </span>
                <span
                  class="px-1.5 py-0.2 rounded text-10px"
                  :class="u.status === 'active' ? 'bg-[#143d2d] text-[#4ade80]' : 'bg-[#3b1d1d] text-[#fca5a5]'">
                  {{ u.status }}
                </span>
              </div>
              <div class="text-11.5px font-mono text-[#5eead4]">
                DS今日 {{ formatNum(u.deepseekDailyRemaining ?? 0) }}/{{ formatNum(u.deepseekDailyQuota ?? 10000000) }} · DS赠送 {{ formatNum(u.tokenBalance) }} · <span class="text-[#fbbf24]">GPT {{ formatNum(u.gptBalance ?? 0) }}</span>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                class="px-2 py-0.5 rounded bg-[#1d4940] border-0 text-[#99f6e4] text-11px cursor-pointer"
                @click="openGrantForUser(u.id)">
                定向赠送 DeepSeek / GPT Token
              </button>
              <button
                v-if="u.id !== 'usr_admin'"
                type="button"
                class="px-2 py-0.5 rounded bg-[#2a2f2e] border-0 text-[#e5e7eb] text-11px cursor-pointer"
                @click="handleToggleUserStatus(u)">
                {{ u.status === 'active' ? '禁用' : '启用' }}
              </button>
              <button
                v-if="u.id !== 'usr_admin'"
                type="button"
                class="px-2 py-0.5 rounded bg-[#3b1d1d] border-0 text-[#fecaca] text-11px cursor-pointer"
                @click="handleDeleteUser(u.id)">
                删除
              </button>
            </div>

            <!-- Inline Grant Box -->
            <div
              v-if="grantTargetUserId === u.id"
              class="p-2.5 rounded-6px bg-[#1f2424] border border-[#13987f]/45 space-y-2">
              <div class="grid gap-2" :class="compact ? 'grid-cols-1' : 'grid-cols-4'">
                <select v-model="grantForm.quotaPool" class="vl-aw-input">
                  <option value="deepseek">DeepSeek V4.1 额度池</option>
                  <option value="gpt">GPT-6.1 Sol 专属池</option>
                </select>
                <input v-model="grantForm.title" type="text" placeholder="福利标题（如：指定用户加赠）" class="vl-aw-input" />
                <input v-model.number="grantForm.tokenAmount" type="number" min="0" placeholder="赠送 Token 数量" class="vl-aw-input" />
                <input v-model="grantForm.secret" type="text" placeholder="附加说明/自定义文本（可选）" class="vl-aw-input font-mono" />
              </div>
              <div class="flex justify-end gap-1.5">
                <button
                  type="button"
                  class="px-2.5 py-1 rounded bg-[#2c3030] border-0 text-[#ccc] text-11px cursor-pointer"
                  @click="grantTargetUserId = null">
                  取消
                </button>
                <button
                  type="button"
                  :disabled="actionBusy"
                  class="px-3 py-1 rounded bg-[#13987f] border-0 text-white text-11px cursor-pointer"
                  @click="submitGrantToUser(u.id)">
                  确认下发
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Admin Subtab 2: Invites & CDK -->
      <div v-else-if="adminSubTab === 'invites'" class="space-y-2.5">
        <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
          <div class="font-semibold text-[#e5e7eb]">生成注册邀请码</div>
          <div class="grid gap-2" :class="compact ? 'grid-cols-1' : 'grid-cols-4'">
            <input v-model="inviteForm.code" type="text" placeholder="自定义码 (留空自动)" class="vl-aw-input font-mono uppercase" />
            <input v-model.number="inviteForm.grantTokens" type="number" min="0" placeholder="注册赠送 Token" class="vl-aw-input" />
            <input v-model.number="inviteForm.maxUses" type="number" min="1" placeholder="可用次数" class="vl-aw-input" />
            <input v-model="inviteForm.note" type="text" placeholder="备注" class="vl-aw-input" />
          </div>
          <div class="flex justify-end">
            <button
              type="button"
              :disabled="actionBusy"
              class="px-3 py-1 rounded-6px bg-[#13987f] border-0 text-white text-11.5px cursor-pointer"
              @click="handleCreateInvite">
              + 生成邀请码
            </button>
          </div>
          <div class="space-y-1 max-h-140px overflow-y-auto pr-1">
            <div
              v-for="inv in store.adminInvites"
              :key="inv.code"
              class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-[#1f2424] text-11.5px">
              <div class="min-w-0">
                <span class="font-mono font-semibold text-[#5eead4]">{{ inv.code }}</span>
                <span class="text-[#9ca3af] ml-2">
                  +{{ formatNum(inv.grantTokens) }} Tokens · {{ inv.usedCount }}/{{ inv.maxUses }}
                </span>
                <span v-if="inv.disabled" class="ml-1.5 text-[#fca5a5]">[已作废]</span>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  class="px-2 py-0.5 rounded bg-[#2a2f2e] border-0 text-[#e5e7eb] text-10.5px cursor-pointer"
                  @click="copyText(inv.code, `已复制邀请码 ${inv.code}`)">
                  复制
                </button>
                <button
                  v-if="!inv.disabled"
                  type="button"
                  class="px-2 py-0.5 rounded bg-[#3b1d1d] border-0 text-[#fecaca] text-10.5px cursor-pointer"
                  @click="store.adminRevokeInvite(inv.code)">
                  作废
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
          <div class="font-semibold text-[#e5e7eb]">生成通用/专属福利兑换码 (CDK)</div>
          <div class="grid gap-2" :class="compact ? 'grid-cols-1' : 'grid-cols-5'">
            <select v-model="cdkForm.quotaPool" class="vl-aw-input">
              <option value="deepseek">DeepSeek V4.1 池</option>
              <option value="gpt">GPT-6.1 Sol 池</option>
            </select>
            <input v-model="cdkForm.title" type="text" placeholder="福利名称（如：GPT 定向补贴）" class="vl-aw-input" />
            <input v-model="cdkForm.code" type="text" placeholder="兑换码 (留空自动)" class="vl-aw-input font-mono uppercase" />
            <input v-model.number="cdkForm.tokenAmount" type="number" min="0" placeholder="免费 Token" class="vl-aw-input" />
            <input v-model.number="cdkForm.maxClaims" type="number" min="1" placeholder="可领取人数" class="vl-aw-input" />
          </div>
          <div class="flex justify-end">
            <button
              type="button"
              :disabled="!cdkForm.title.trim() || actionBusy"
              class="px-3 py-1 rounded-6px bg-[#13987f] border-0 text-white text-11.5px cursor-pointer"
              @click="handleCreateCdk">
              + 生成福利兑换码
            </button>
          </div>
          <div class="space-y-1 max-h-140px overflow-y-auto pr-1">
            <div
              v-for="w in store.adminWelfare"
              :key="w.id"
              class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-[#1f2424] text-11.5px">
              <div class="min-w-0 truncate">
                <span class="font-medium text-white">{{ w.title }}</span>
                <span
                  class="px-1.5 py-0.2 rounded text-10px ml-1.5 font-mono"
                  :class="w.quotaPool === 'gpt' ? 'bg-[#3d2e14] text-[#fbbf24]' : 'bg-[#143d2d] text-[#4ade80]'">
                  {{ w.quotaPool === 'gpt' ? 'GPT' : 'DS' }}
                </span>
                <span v-if="w.code" class="font-mono text-[#5eead4] ml-2">{{ w.code }}</span>
                <span class="text-[#9ca3af] ml-2">
                  +{{ formatNum(w.tokenAmount) }} · {{ w.claimedCount }}/{{ w.maxClaims }} · {{ w.status }}
                </span>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <button
                  v-if="w.code"
                  type="button"
                  class="px-2 py-0.5 rounded bg-[#2a2f2e] border-0 text-[#e5e7eb] text-10.5px cursor-pointer"
                  @click="copyText(w.code!, `已复制兑换码 ${w.code}`)">
                  复制
                </button>
                <button
                  v-if="w.status === 'active'"
                  type="button"
                  class="px-2 py-0.5 rounded bg-[#3b1d1d] border-0 text-[#fecaca] text-10.5px cursor-pointer"
                  @click="store.adminRevokeWelfare(w.id)">
                  作废
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Admin Subtab 3: Gateway Upstreams & Built-in Magpie Bridge -->
      <div v-else-if="adminSubTab === 'upstreams'" class="space-y-2.5">
        <!-- Built-in Magpie Bridge Card -->
        <div class="p-3 rounded-8px bg-[#161919] border border-[#13987f]/45 space-y-2.5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0 space-y-0.5">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-semibold text-white">内置 Magpie 网关桥接（默认启用，主备各自复用本机 Magpie）</span>
                <span
                  class="px-2 py-0.2 rounded-full text-10.5px font-medium"
                  :class="
                    !magpieForm.enabled
                      ? 'bg-[#2a2f2e] text-[#9ca3af]'
                      : store.adminMagpieBridge?.status.running
                        ? 'bg-[#143d2d] text-[#4ade80]'
                        : 'bg-[#3d2e14] text-[#fbbf24]'
                  ">
                  {{
                    !magpieForm.enabled
                      ? '已关闭'
                      : store.adminMagpieBridge?.status.running
                        ? '运行中'
                        : '离线'
                  }}
                </span>
              </div>
              <div v-if="store.adminMagpieBridge" class="text-11px text-[#9ca3af] font-mono break-all">
                {{ store.adminMagpieBridge.status.message }}
                <span v-if="store.adminMagpieBridge.status.gatewayUrl">
                  · {{ store.adminMagpieBridge.status.gatewayUrl }}
                </span>
              </div>
              <div v-if="store.adminMagpieBridge?.status.protocols?.length" class="flex flex-wrap gap-1 pt-0.5">
                <span
                  v-for="proto in store.adminMagpieBridge.status.protocols"
                  :key="proto"
                  class="px-1.5 py-0.2 rounded bg-[#202625] text-[#5eead4] text-10px font-mono">
                  {{ proto }}
                </span>
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                class="px-2.5 py-1 rounded-6px border-0 text-11.5px cursor-pointer"
                :class="magpieForm.enabled ? 'bg-[#143d2d] text-[#4ade80]' : 'bg-[#2a2f2e] text-[#cbd5e1]'"
                @click="magpieForm.enabled = !magpieForm.enabled">
                {{ magpieForm.enabled ? '已启用' : '已关闭' }}
              </button>
              <button
                type="button"
                :disabled="actionBusy"
                class="px-2.5 py-1 rounded-6px bg-[#2a2f2e] border-0 text-[#e5e7eb] text-11.5px cursor-pointer"
                @click="store.adminFetchUpstreams(true)">
                探测模型
              </button>
            </div>
          </div>

          <div class="grid gap-2" :class="compact ? 'grid-cols-1' : 'grid-cols-3'">
            <label class="space-y-1 text-11px text-[#9ca3af]">
              <span>合规锁定渠道（仅允许 DeepSeek V4.1 / GPT-6.1 Sol，严禁 * / Claude / Gemini）</span>
              <input
                v-model="magpieForm.allowedModelsText"
                type="text"
                placeholder="auto/deepseek-v4.1-flash, auto/gpt-6.1-sol"
                class="vl-aw-input font-mono" />
            </label>
            <label class="space-y-1 text-11px text-[#9ca3af]">
              <span>扣费倍率</span>
              <input v-model.number="magpieForm.rateMultiplier" type="number" step="0.1" min="0.01" class="vl-aw-input" />
            </label>
            <label class="space-y-1 text-11px text-[#9ca3af]">
              <span>网关地址覆盖（留空自动发现内置插件）</span>
              <input v-model="magpieForm.urlOverride" type="text" placeholder="留空自动走 http://127.0.0.1:3425" class="vl-aw-input font-mono" />
            </label>
          </div>
          <div class="flex justify-end">
            <button
              type="button"
              :disabled="actionBusy"
              data-testid="save-magpie-bridge-btn"
              class="px-3 py-1 rounded-6px bg-[#13987f] hover:bg-[#17ad91] disabled:opacity-50 border-0 text-white text-11.5px cursor-pointer"
              @click="handleSaveMagpieBridge">
              保存 Magpie 桥接
            </button>
          </div>
        </div>

        <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
          <div class="font-semibold text-[#e5e7eb]">可选补充 / 定向覆盖上游（匹配时优先于内置 Magpie）</div>
          <div class="grid gap-2" :class="compact ? 'grid-cols-1' : 'grid-cols-2'">
            <input v-model="upsForm.name" type="text" placeholder="名称（如：DeepSeek / OpenAI 中转）" class="vl-aw-input" />
            <input v-model="upsForm.baseUrl" type="text" placeholder="Base URL（如 https://api.openai.com）" class="vl-aw-input font-mono" />
            <input v-model="upsForm.apiKey" type="password" placeholder="上游 API Key（加密存储）" class="vl-aw-input font-mono" />
            <input v-model="upsForm.modelsText" type="text" placeholder="模型列表（逗号分隔，或 * 通配）" class="vl-aw-input font-mono" />
          </div>
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 text-11px text-[#9ca3af]">
              <span>扣费倍率</span>
              <input v-model.number="upsForm.rateMultiplier" type="number" step="0.1" min="0.1" class="vl-aw-input w-70px py-1!" />
              <span>优先级</span>
              <input v-model.number="upsForm.priority" type="number" class="vl-aw-input w-70px py-1!" />
            </div>
            <button
              type="button"
              :disabled="!upsForm.baseUrl.trim() || !upsForm.apiKey.trim() || actionBusy"
              class="px-3 py-1 rounded-6px bg-[#13987f] disabled:opacity-50 border-0 text-white text-11.5px cursor-pointer"
              @click="handleSaveUpstream">
              保存上游
            </button>
          </div>
        </div>

        <div class="space-y-1.5">
          <div
            v-for="u in store.adminUpstreams"
            :key="u.id"
            class="p-2.5 rounded-8px bg-[#161919] border border-[#2c3130] flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-medium text-white">{{ u.name }}</span>
                <span class="font-mono text-11px text-[#5eead4]">{{ u.apiKeyMasked }}</span>
                <span class="text-10.5px text-[#9ca3af]">倍率 {{ u.rateMultiplier }}x · 优先级 {{ u.priority }}</span>
              </div>
              <div class="text-11px font-mono text-[#8e9297] truncate">{{ u.baseUrl }}</div>
              <div class="text-10.5px font-mono text-[#cbd5e1] truncate">
                模型：{{ u.models.join(', ') || '*' }}
              </div>
            </div>
            <button
              type="button"
              class="px-2 py-0.5 rounded bg-[#3b1d1d] border-0 text-[#fecaca] text-11px cursor-pointer shrink-0"
              @click="store.adminDeleteUpstream(u.id)">
              删除
            </button>
          </div>
        </div>
      </div>

      <!-- Admin Subtab 4: Primary / Standby Cluster -->
      <div v-else class="space-y-2.5">
        <div
          v-if="store.adminClusterStatus"
          class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <div class="font-semibold text-white">
                当前节点：{{ store.adminClusterStatus.nodeLabel }} ({{ store.adminClusterStatus.role.toUpperCase() }})
              </div>
              <div class="text-11px text-[#9ca3af] font-mono">
                revision={{ store.adminClusterStatus.syncRevision }} ·
                standbyDirty={{ store.adminClusterStatus.standbyDirty }} ·
                对端：{{
                  store.adminClusterStatus.peerStatus?.reachable
                    ? `在线 (${store.adminClusterStatus.peerStatus.nodeLabel || store.adminClusterStatus.peerUrl}, rev=${store.adminClusterStatus.peerStatus.syncRevision ?? '?'}, ${store.adminClusterStatus.peerStatus.latencyMs ?? '-'}ms)`
                    : `未连通 (${store.adminClusterStatus.lastSyncError || '离线'})`
                }}
              </div>
            </div>
            <button
              type="button"
              :disabled="actionBusy"
              data-testid="cluster-sync-now-btn"
              class="px-3 py-1.5 rounded-6px bg-[#13987f] hover:bg-[#17ad91] disabled:opacity-50 border-0 text-white text-12px cursor-pointer"
              @click="handleSyncCluster">
              立即主备同步
            </button>
          </div>
        </div>

        <div class="p-3 rounded-8px bg-[#161919] border border-[#2c3130] space-y-2">
          <div class="font-semibold text-[#e5e7eb]">主备与公网域名入口配置（自动下发给客户端故障转移）</div>
          <div class="grid gap-2" :class="compact ? 'grid-cols-1' : 'grid-cols-2'">
            <label class="space-y-1 text-11px text-[#9ca3af]">
              <span>对端节点同步地址 (peerUrl)</span>
              <input v-model="clusterForm.peerUrl" type="text" class="vl-aw-input font-mono" />
            </label>
            <label class="space-y-1 text-11px text-[#9ca3af]">
              <span>PC 主服 Tailscale 地址</span>
              <input v-model="clusterForm.primaryTailscaleUrl" type="text" class="vl-aw-input font-mono" />
            </label>
            <label class="space-y-1 text-11px text-[#9ca3af]">
              <span>PC 主服公网域名（可选）</span>
              <input v-model="clusterForm.primaryPublicUrl" type="text" placeholder="https://primary.example.com" class="vl-aw-input font-mono" />
            </label>
            <label class="space-y-1 text-11px text-[#9ca3af]">
              <span>Mac mini 备服 Tailscale 地址</span>
              <input v-model="clusterForm.standbyTailscaleUrl" type="text" class="vl-aw-input font-mono" />
            </label>
            <label class="space-y-1 text-11px text-[#9ca3af] col-span-full">
              <span>Mac mini 备服公网域名（可选）</span>
              <input v-model="clusterForm.standbyPublicUrl" type="text" placeholder="https://standby.example.com" class="vl-aw-input font-mono" />
            </label>
          </div>
          <div class="flex justify-end">
            <button
              type="button"
              :disabled="actionBusy"
              class="px-3.5 py-1.5 rounded-6px bg-[#13987f] hover:bg-[#17ad91] border-0 text-white text-12px cursor-pointer"
              @click="handleSaveClusterConfig">
              保存集群配置
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useVibeLinkStore } from '../store'
import {
  deleteLocalByokProfile,
  loadLocalByokProfiles,
  maskLocalApiKey,
  saveLocalByokProfile,
  testLocalByokProfile,
  type VlLocalByokProfile,
  type VlLocalByokProtocol,
  type VlLocalByokTestResult
} from '../localByok'
import type { VlAuthUser, VlQuotaPool } from '../types'

withDefaults(
  defineProps<{
    compact?: boolean
  }>(),
  {
    compact: false
  }
)

defineEmits<{
  openAuthModal: []
}>()

const store = useVibeLinkStore()
const loading = ref(false)
const actionBusy = ref(false)
const bannerMsg = ref('')
const errorMsg = ref('')
const mainTab = ref<'mine' | 'admin'>('mine')
const adminSubTab = ref<'users' | 'invites' | 'upstreams' | 'cluster'>('users')

const redeemCodeInput = ref('')
const newKeyName = ref('')
const oldPwd = ref('')
const newPwd = ref('')
const grantTargetUserId = ref<string | null>(null)

const newUser = reactive({
  username: '',
  password: '',
  displayName: '',
  tokenBalance: 0,
  gptBalance: 0
})

const grantForm = reactive({
  quotaPool: 'deepseek' as VlQuotaPool,
  title: '免费额度福利',
  tokenAmount: 1000000,
  secret: ''
})

const inviteForm = reactive({
  code: '',
  grantTokens: 0,
  maxUses: 5,
  note: ''
})

const cdkForm = reactive({
  quotaPool: 'deepseek' as VlQuotaPool,
  title: '限时免费 Token 包',
  code: '',
  tokenAmount: 1000000,
  maxClaims: 10
})

const byokProfiles = ref<VlLocalByokProfile[]>(loadLocalByokProfiles())
const byokTestResults = reactive<Record<string, VlLocalByokTestResult>>({})
const byokBusyId = ref<string | null>(null)
const byokForm = reactive({
  name: '',
  protocol: 'openai' as VlLocalByokProtocol,
  baseUrl: '',
  apiKey: '',
  defaultModel: ''
})

const upsForm = reactive({
  name: '',
  baseUrl: '',
  apiKey: '',
  modelsText: '*',
  rateMultiplier: 1,
  priority: 10
})

const magpieForm = reactive({
  enabled: true,
  allowedModelsText: 'auto/deepseek-v4.1-flash, auto/gpt-6.1-sol',
  rateMultiplier: 1,
  urlOverride: ''
})

const showAllModels = ref(false)

const clusterForm = reactive({
  peerUrl: '',
  primaryTailscaleUrl: '',
  primaryPublicUrl: '',
  standbyTailscaleUrl: '',
  standbyPublicUrl: ''
})

const adminSubTabs: Array<{ id: 'users' | 'invites' | 'upstreams' | 'cluster'; label: string }> = [
  { id: 'users', label: '用户与发福利' },
  { id: 'invites', label: '邀请码 / CDK' },
  { id: 'upstreams', label: '模型上游池' },
  { id: 'cluster', label: '一主一备集群' }
]

const isAdmin = computed(() => store.authUser?.role === 'admin' || store.authMode === 'loopback_admin' || store.authMode === 'owner_token')
const currentUser = computed(() => store.myWelfare?.user ?? store.authUser)
const availableModels = computed(() => store.myWelfare?.availableModels ?? [])
const visibleAvailableModels = computed(() =>
  showAllModels.value ? availableModels.value : availableModels.value.slice(0, 12)
)
const standbyEndpoints = computed(() => store.channels.filter((c) => c.serverRole === 'standby'))

const authModeLabel = computed(() => {
  if (store.authMode === 'user_session') return '账号会话'
  if (store.authMode === 'owner_token') return 'Owner Token'
  if (store.authMode === 'loopback_admin') return '本机管理员直连'
  return '未认证'
})

function formatNum(n: number): string {
  return Number(n || 0).toLocaleString()
}

function hasPayloadDetails(payload: Record<string, unknown>): boolean {
  return Object.keys(payload || {}).length > 0
}

function formatPayloadText(payload: Record<string, unknown>): string {
  if (typeof payload.secret === 'string' && payload.secret) {
    return payload.note ? `${payload.secret} (${payload.note})` : payload.secret
  }
  return JSON.stringify(payload)
}

function extractCopyPayload(payload: Record<string, unknown>): string {
  if (typeof payload.secret === 'string' && payload.secret) return payload.secret
  return JSON.stringify(payload)
}

async function copyText(text: string, label: string) {
  errorMsg.value = ''
  try {
    await navigator.clipboard.writeText(text)
    bannerMsg.value = label
  } catch (err) {
    errorMsg.value = `复制失败：${err instanceof Error ? err.message : String(err)}`
  }
}

async function refreshAll() {
  loading.value = true
  errorMsg.value = ''
  try {
    await Promise.all([store.fetchMyWelfare(), store.fetchMyApiKeys()])
    if (isAdmin.value && mainTab.value === 'admin') {
      await loadAdminData()
    }
  } finally {
    loading.value = false
  }
}

async function loadAdminData() {
  await Promise.all([
    store.adminFetchUsers().catch(() => {}),
    store.adminFetchInvites().catch(() => {}),
    store.adminFetchWelfare().catch(() => {}),
    store.adminFetchUpstreams().catch(() => {}),
    store.fetchAdminClusterStatus().catch(() => {})
  ])
}

function openAdminTab() {
  mainTab.value = 'admin'
  void loadAdminData()
}

function switchAdminSubTab(tab: 'users' | 'invites' | 'upstreams' | 'cluster') {
  adminSubTab.value = tab
  void loadAdminData()
}

watch(
  () => store.adminMagpieBridge,
  (mb) => {
    if (!mb) return
    magpieForm.enabled = mb.config.enabled
    magpieForm.allowedModelsText =
      mb.config.allowedModels.join(', ') || 'auto/deepseek-v4.1-flash, auto/gpt-6.1-sol'
    magpieForm.rateMultiplier = mb.config.rateMultiplier
    magpieForm.urlOverride = mb.config.urlOverride
  },
  { immediate: true }
)

watch(
  () => store.adminClusterStatus,
  (st) => {
    if (!st) return
    clusterForm.peerUrl = st.peerUrl
    clusterForm.primaryTailscaleUrl = st.primaryTailscaleUrl
    clusterForm.primaryPublicUrl = st.primaryPublicUrl
    clusterForm.standbyTailscaleUrl = st.standbyTailscaleUrl
    clusterForm.standbyPublicUrl = st.standbyPublicUrl
  },
  { immediate: true }
)

onMounted(() => {
  void refreshAll()
})

async function handleLogout() {
  await store.authLogout()
}

async function handleRedeem() {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    const res = await store.redeemWelfare({ code: redeemCodeInput.value.trim() })
    redeemCodeInput.value = ''
    bannerMsg.value = `兑换成功！到账 ${formatNum(res.creditedTokens)} Tokens`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

async function handleClaimGrant(grantId: string) {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    const res = await store.redeemWelfare({ grantId })
    bannerMsg.value = `领取成功！到账 ${formatNum(res.creditedTokens)} Tokens`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

async function handleCreateKey() {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    const k = await store.createMyApiKey({
      ...(newKeyName.value.trim() ? { name: newKeyName.value.trim() } : {})
    })
    newKeyName.value = ''
    bannerMsg.value = `已生成 API Key：${k.name}`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

async function handleRevokeKey(keyId: string) {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    await store.revokeMyApiKey(keyId)
    bannerMsg.value = '已吊销指定 API Key'
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

async function handleChangePassword() {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    await store.authChangePassword(oldPwd.value, newPwd.value)
    oldPwd.value = ''
    newPwd.value = ''
    bannerMsg.value = '登录密码已更新'
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

function handleSaveLocalByok() {
  bannerMsg.value = ''
  errorMsg.value = ''
  try {
    byokProfiles.value = saveLocalByokProfile({
      name: byokForm.name.trim() || '自有网关',
      protocol: byokForm.protocol,
      baseUrl: byokForm.baseUrl,
      apiKey: byokForm.apiKey,
      defaultModel: byokForm.defaultModel
    })
    byokForm.name = ''
    byokForm.baseUrl = ''
    byokForm.apiKey = ''
    byokForm.defaultModel = ''
    bannerMsg.value = '已保存自有网关配置到本机 localStorage（绝未上传服务端）'
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  }
}

function handleDeleteLocalByok(id: string) {
  byokProfiles.value = deleteLocalByokProfile(id)
  delete byokTestResults[id]
  bannerMsg.value = '已从本机移除自有网关配置'
}

async function handleTestLocalByok(profile: VlLocalByokProfile) {
  byokBusyId.value = profile.id
  errorMsg.value = ''
  try {
    byokTestResults[profile.id] = await testLocalByokProfile(profile)
  } finally {
    byokBusyId.value = null
  }
}

async function handleAdminCreateUser() {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    const created = await store.adminCreateUser({
      username: newUser.username.trim(),
      password: newUser.password,
      ...(newUser.displayName.trim() ? { displayName: newUser.displayName.trim() } : {}),
      tokenBalance: Number(newUser.tokenBalance || 0),
      gptBalance: Number(newUser.gptBalance || 0)
    })
    newUser.username = ''
    newUser.password = ''
    newUser.displayName = ''
    newUser.gptBalance = 0
    bannerMsg.value = `已创建用户 @${created.username}（每日默认 10M DeepSeek V4.1）`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

function openGrantForUser(userId: string) {
  grantTargetUserId.value = grantTargetUserId.value === userId ? null : userId
}

async function submitGrantToUser(userId: string) {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    const hasSecret = grantForm.secret.trim().length > 0
    await store.adminGrantUser(userId, {
      kind: hasSecret ? 'custom_secret' : 'token_credit',
      quotaPool: grantForm.quotaPool,
      title:
        grantForm.title.trim() ||
        (grantForm.quotaPool === 'gpt' ? 'GPT-6.1 Sol 专属额度下发' : 'DeepSeek V4.1 福利下发'),
      tokenAmount: Number(grantForm.tokenAmount || 0),
      ...(hasSecret ? { payload: { secret: grantForm.secret.trim() } } : {})
    })
    grantForm.secret = ''
    grantTargetUserId.value = null
    bannerMsg.value = `${grantForm.quotaPool === 'gpt' ? 'GPT-6.1 Sol' : 'DeepSeek V4.1'} 额度已下发到账`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

async function handleToggleUserStatus(u: VlAuthUser) {
  bannerMsg.value = ''
  errorMsg.value = ''
  try {
    await store.adminUpdateUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })
    bannerMsg.value = `用户 @${u.username} 状态已更新`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleDeleteUser(userId: string) {
  bannerMsg.value = ''
  errorMsg.value = ''
  try {
    await store.adminDeleteUser(userId)
    bannerMsg.value = '已删除用户'
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleCreateInvite() {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    const inv = await store.adminCreateInvite({
      ...(inviteForm.code.trim() ? { code: inviteForm.code.trim() } : {}),
      grantTokens: Number(inviteForm.grantTokens || 0),
      maxUses: Number(inviteForm.maxUses || 1),
      ...(inviteForm.note.trim() ? { note: inviteForm.note.trim() } : {})
    })
    inviteForm.code = ''
    bannerMsg.value = `已生成邀请码：${inv.code}`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

async function handleCreateCdk() {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    const w = await store.adminCreateWelfare({
      kind: 'redeem_code',
      quotaPool: cdkForm.quotaPool,
      title: cdkForm.title.trim(),
      ...(cdkForm.code.trim() ? { code: cdkForm.code.trim() } : {}),
      tokenAmount: Number(cdkForm.tokenAmount || 0),
      maxClaims: Number(cdkForm.maxClaims || 1)
    })
    cdkForm.code = ''
    bannerMsg.value = `已生成福利兑换码：${w.code}`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

async function handleSaveMagpieBridge() {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    const allowedModels = magpieForm.allowedModelsText
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const updated = await store.adminUpdateMagpieBridge({
      enabled: magpieForm.enabled,
      allowedModels:
        allowedModels.length > 0
          ? allowedModels
          : ['auto/deepseek-v4.1-flash', 'auto/gpt-6.1-sol'],
      rateMultiplier: Number(magpieForm.rateMultiplier || 1),
      urlOverride: magpieForm.urlOverride.trim()
    })
    bannerMsg.value = `Magpie 网关桥接已更新：${updated.status.message}`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

async function handleSaveUpstream() {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    const models = upsForm.modelsText
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    await store.adminUpsertUpstream({
      name: upsForm.name.trim() || '模型上游',
      baseUrl: upsForm.baseUrl.trim(),
      apiKey: upsForm.apiKey.trim(),
      models,
      rateMultiplier: Number(upsForm.rateMultiplier || 1),
      priority: Number(upsForm.priority || 10),
      enabled: true
    })
    upsForm.apiKey = ''
    bannerMsg.value = '上游模型池已保存并加密同步'
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

async function handleSaveClusterConfig() {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    await store.adminUpdateClusterConfig({
      peerUrl: clusterForm.peerUrl.trim(),
      primaryTailscaleUrl: clusterForm.primaryTailscaleUrl.trim(),
      primaryPublicUrl: clusterForm.primaryPublicUrl.trim(),
      standbyTailscaleUrl: clusterForm.standbyTailscaleUrl.trim(),
      standbyPublicUrl: clusterForm.standbyPublicUrl.trim()
    })
    bannerMsg.value = '集群主备与公网域名配置已更新'
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}

async function handleSyncCluster() {
  bannerMsg.value = ''
  errorMsg.value = ''
  actionBusy.value = true
  try {
    const res = await store.adminTriggerClusterSync(true)
    if (!res.ok) {
      throw new Error(res.error || '同步失败')
    }
    bannerMsg.value = `主备同步成功 (${res.action}, rev=${res.syncRevision})`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = false
  }
}
</script>

<style scoped>
.vl-aw-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 9px;
  border-radius: 6px;
  background: #141616;
  border: 1px solid #353b3a;
  color: #eaeaea;
  font-size: 12px;
  outline: none;
}

.vl-aw-input:focus {
  border-color: #13987f;
}
</style>
