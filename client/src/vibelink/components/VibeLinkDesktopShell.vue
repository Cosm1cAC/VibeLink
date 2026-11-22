<template>
  <div class="vl-root vl-theme-dark vl-desktop-shell" data-testid="vibelink-desktop-shell">
    <!-- Column 1: Left Navigation Rail (#233b37) -->
    <aside class="vl-col-rail" data-tauri-drag-region>
      <div class="flex flex-col items-center gap-4 pt-3 w-full">
        <!-- User Avatar & Presence Menu -->
        <div class="relative">
          <button
            type="button"
            class="vl-avatar-btn"
            :title="`我 (${store.me?.displayName ?? 'Me'}) - ${presenceLabel(store.me?.presence)}`"
            data-testid="me-rail-avatar-btn"
            @click="meMenuOpen = !meMenuOpen">
            <VlAvatar
              :avatar="store.me?.avatar ?? 'preset:user'"
              :name="store.me?.displayName ?? '我'"
              :size="38" />
            <span
              class="vl-status-dot"
              :style="{ backgroundColor: presenceColor(store.me?.presence ?? 'online') }"></span>
          </button>

          <div
            v-if="meMenuOpen"
            class="absolute left-52px top-0 z-40 w-215px rounded-10px bg-[#1f2322] border border-[#363d3b] shadow-2xl p-2.5 space-y-2 text-12px">
            <div class="flex items-center justify-between px-1">
              <span class="font-semibold text-[#eaeaea] truncate">{{ store.me?.displayName ?? '我' }}</span>
              <button
                type="button"
                data-testid="me-edit-profile-btn"
                class="bg-transparent border-0 text-[#5eead4] hover:text-[#99f6e4] text-11.5px cursor-pointer shrink-0"
                @click="openMeProfileModal">
                编辑头像/名字
              </button>
            </div>
            <div class="flex gap-1">
              <button
                v-for="opt in presenceOptions"
                :key="opt.value"
                type="button"
                class="flex-1 py-1 rounded-6px border-0 cursor-pointer text-11.5px"
                :class="store.me?.presence === opt.value ? 'bg-[#13987f] text-white' : 'bg-[#2a2f2e] text-[#cbd5e1]'"
                @click="setPresence(opt.value)">
                {{ opt.label }}
              </button>
            </div>
            <div class="flex gap-1">
              <input
                v-model="myStatusDraft"
                type="text"
                placeholder="个人签名状态..."
                class="flex-1 min-w-0 px-2 py-1 rounded bg-[#141616] border border-[#383e3d] text-[#eaeaea] text-11.5px outline-none" />
              <button
                type="button"
                class="px-2 py-1 rounded bg-[#13987f] border-0 text-white text-11.5px cursor-pointer"
                @click="saveMyStatusText">
                存
              </button>
            </div>
          </div>
        </div>

        <!-- Primary Rail Tabs -->
        <button
          type="button"
          class="vl-rail-item relative"
          :class="{ active: store.activeNav === 'messages' }"
          title="消息会话"
          data-testid="nav-messages"
          @click="switchNav('messages')">
          <svg viewBox="0 0 24 24" class="w-22px h-22px" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          <span v-if="store.totalUnreadCount > 0" class="vl-rail-badge">
            {{ store.totalUnreadCount > 99 ? '99+' : store.totalUnreadCount }}
          </span>
        </button>

        <button
          type="button"
          class="vl-rail-item"
          :class="{ active: store.activeNav === 'bots' }"
          title="Bot 好友舰队"
          data-testid="nav-bots"
          @click="switchNav('bots')">
          <svg viewBox="0 0 24 24" class="w-22px h-22px" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="4" y="7" width="16" height="12" rx="3" />
            <path d="M12 3v4M9 12h.01M15 12h.01M8 16h8" stroke-linecap="round" />
          </svg>
        </button>

        <button
          type="button"
          class="vl-rail-item"
          :class="{ active: store.activeNav === 'workspace' }"
          title="工作区终端 PTY"
          data-testid="nav-workspace"
          @click="switchNav('workspace')">
          <svg viewBox="0 0 24 24" class="w-22px h-22px" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M7 9l3 3-3 3M13 15h4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <!-- Bottom Utility Buttons -->
      <div class="flex flex-col items-center gap-3 pb-3 w-full">
        <div
          class="w-10px h-10px rounded-full"
          :class="store.connected ? 'bg-[#22c55e]' : 'bg-[#ef4444]'"
          :title="store.connected ? 'WebSocket 已连接' : '连接断开'"></div>

        <button
          type="button"
          class="vl-rail-item"
          title="服务器配置与运行态"
          data-testid="nav-settings"
          @click="store.serverSettingsOpen = true">
          <svg viewBox="0 0 24 24" class="w-20px h-20px" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </aside>

    <!-- Column 2: Session / Bot Fleet List (#1e1e1e) -->
    <section class="vl-col-list">
      <div class="vl-list-top" data-tauri-drag-region>
        <div class="flex items-center gap-2 w-full">
          <div class="flex-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-7px bg-[#2a2a2a] border border-[#343434]">
            <svg viewBox="0 0 24 24" class="w-14px h-14px text-[#888] shrink-0" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              v-model="store.searchQuery"
              type="text"
              placeholder="搜索会话 / @Bot"
              class="w-full min-w-0 bg-transparent border-0 text-12px text-[#eaeaea] outline-none placeholder:text-[#767676]" />
          </div>

          <div class="relative">
            <button
              type="button"
              class="w-28px h-28px rounded-7px bg-[#2a2a2a] hover:bg-[#343434] border border-[#383838] text-[#eaeaea] text-16px leading-none cursor-pointer flex items-center justify-center"
              title="新建 Bot 或协同群"
              data-testid="create-menu-btn"
              @click="createMenuOpen = !createMenuOpen">
              +
            </button>
            <div
              v-if="createMenuOpen"
              class="absolute right-0 top-34px z-40 w-160px rounded-8px bg-[#252827] border border-[#3a3f3e] shadow-xl py-1 text-12.5px">
              <button
                type="button"
                class="w-full text-left px-3 py-2 bg-transparent hover:bg-[#1d4940] border-0 text-[#eaeaea] cursor-pointer"
                @click="openCreateBot">
                + 新建 Bot 好友
              </button>
              <button
                type="button"
                class="w-full text-left px-3 py-2 bg-transparent hover:bg-[#1d4940] border-0 text-[#eaeaea] cursor-pointer"
                @click="openCreateGroup">
                + 新建多 Bot 协作群
              </button>
              <button
                type="button"
                class="w-full text-left px-3 py-2 bg-transparent hover:bg-[#2f3332] border-0 text-[#9ca3af] cursor-pointer"
                @click="refreshAll">
                ↻ 同步后端会话
              </button>
            </div>
          </div>
        </div>

        <div v-if="store.activeNav !== 'bots'" class="flex items-center gap-1 mt-2">
          <button
            v-for="tab in sessionFilterTabs"
            :key="tab.value"
            type="button"
            class="px-2.5 py-0.5 rounded-5px border-0 cursor-pointer text-11.5px"
            :class="store.sessionFilter === tab.value ? 'bg-[#1d4940] text-[#5eead4]' : 'bg-transparent text-[#888] hover:text-[#ccc]'"
            @click="store.sessionFilter = tab.value">
            {{ tab.label }}
          </button>
        </div>
      </div>

      <!-- Bot Fleet View when activeNav === 'bots' -->
      <div v-if="store.activeNav === 'bots'" class="flex-1 vl-scroll p-2 space-y-2" data-testid="bot-fleet-list">
        <div
          v-for="bot in filteredBots"
          :key="bot.id"
          class="rounded-10px bg-[#252525] border border-[#323232] p-2.5 space-y-2 hover:border-[#13987f]/60 transition-colors">
          <div class="flex items-center gap-2.5">
            <button
              type="button"
              class="relative shrink-0 p-0 border-0 bg-transparent rounded-full cursor-pointer"
              title="点击操作或编辑 Bot"
              @click="openAvatarMenu($event, bot)">
              <VlAvatar
                :avatar="bot.avatar"
                :name="bot.displayName"
                :provider="bot.provider"
                :size="36" />
              <span class="vl-status-dot-sm" :style="{ backgroundColor: presenceColor(bot.presence) }"></span>
            </button>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="text-13px font-medium truncate text-[#f0f0f0]">{{ bot.displayName }}</span>
                <span class="text-10.5px px-1.5 py-0.2 rounded bg-[#1d4940] text-[#5eead4]">@{{ bot.handle }}</span>
              </div>
              <div class="text-11px text-[#8c8c8c] truncate">{{ bot.provider }} · {{ bot.roleTitle }}</div>
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="flex-1 py-1 rounded-6px border-0 bg-[#13987f] hover:bg-[#17ad91] text-white text-11.5px cursor-pointer"
              @click="store.openDmWithBot(bot.id)">
              私聊
            </button>
            <button
              type="button"
              class="flex-1 py-1 rounded-6px border border-[#3a3a3a] bg-[#2c2c2c] hover:bg-[#353535] text-[#dcdcdc] text-11.5px cursor-pointer"
              @click="store.openBotHomeDrawer(bot.id)">
              Bot Home
            </button>
          </div>
        </div>
      </div>

      <!-- Session List -->
      <div v-else class="flex-1 vl-scroll py-1" data-testid="session-list">
        <div
          v-for="room in filteredRooms"
          :key="room.id"
          :data-testid="`session-item-${room.id}`"
          class="group flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors relative"
          :class="
            store.activeRoomId === room.id
              ? 'bg-[#283734] border-l-3 border-l-[#13987f]'
              : 'hover:bg-[#252525] border-l-3 border-l-transparent'
          "
          @click="handleSelectRoom(room.id)">
          <div class="relative shrink-0">
            <VlAvatar
              :avatar="roomAvatarProps(room).avatar"
              :name="roomAvatarProps(room).name"
              :provider="roomAvatarProps(room).provider"
              :size="40"
              :shape="room.kind === 'group' ? 'rounded' : 'circle'" />
            <span
              v-if="room.kind === 'dm'"
              class="vl-status-dot-sm"
              :style="{ backgroundColor: presenceColor(dmTargetBot(room)?.presence ?? 'idle') }"></span>
          </div>

          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-1">
              <div class="flex items-center gap-1 min-w-0">
                <span class="text-13.5px font-medium text-[#efefef] truncate">{{ room.name }}</span>
                <span v-if="room.pinned" class="text-10px text-[#5eead4]" title="已置顶">📌</span>
              </div>
              <span class="text-11px text-[#737373] shrink-0">
                {{ formatShortTime(room.lastMessage?.createdAt ?? room.updatedAt) }}
              </span>
            </div>

            <div class="flex items-center justify-between gap-1.5 mt-0.5">
              <span class="text-12px text-[#888] truncate">
                {{ formatLastMessagePreview(room) }}
              </span>
              <div class="flex items-center gap-1 shrink-0">
                <span v-if="room.muted" class="text-11px text-[#6f6f6f]" title="消息免打扰">🔕</span>
                <span
                  v-if="room.unreadCount > 0"
                  class="px-1.5 min-w-17px h-17px rounded-full text-10.5px text-white flex items-center justify-center leading-none"
                  :class="room.muted ? 'bg-[#52525b]' : 'bg-[#c14053]'">
                  {{ room.unreadCount > 99 ? '99+' : room.unreadCount }}
                </span>
              </div>
            </div>
          </div>

          <!-- Hover Quick Actions -->
          <div
            class="hidden group-hover:flex items-center gap-1 absolute right-2 bottom-1.5 bg-[#1e1e1e]/95 px-1.5 py-0.5 rounded border border-[#343434]"
            @click.stop>
            <button
              type="button"
              class="bg-transparent border-0 text-10.5px text-[#a3a3a3] hover:text-[#5eead4] cursor-pointer px-1"
              :title="room.pinned ? '取消置顶' : '置顶会话'"
              @click="store.updateRoomSettings(room.id, { pinned: !room.pinned })">
              {{ room.pinned ? '取消顶' : '置顶' }}
            </button>
            <button
              type="button"
              class="bg-transparent border-0 text-10.5px text-[#a3a3a3] hover:text-[#5eead4] cursor-pointer px-1"
              :title="room.muted ? '开启提醒' : '免打扰'"
              @click="store.updateRoomSettings(room.id, { muted: !room.muted })">
              {{ room.muted ? '提醒' : '静音' }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Column 3: Main Conversation / Terminal / Diff Canvas (#2a2a2a) -->
    <main class="vl-col-main">
      <!-- Top Title Bar -->
      <header class="vl-main-header" data-tauri-drag-region>
        <div class="flex items-center gap-2.5 min-w-0">
          <template v-if="store.activeRoom">
            <h1 class="m-0 text-15px font-semibold text-[#f3f3f3] truncate">
              {{ store.activeRoom.name }}
            </h1>
            <span
              v-if="store.activeRoom.kind === 'group'"
              class="px-1.5 py-0.5 rounded bg-[#333333] text-11.5px text-[#b3b3b3] font-mono shrink-0">
              [{{ store.activeRoom.memberCount }}]
            </span>
            <template v-else-if="activeDmBot">
              <button
                type="button"
                class="p-0 border-0 bg-transparent rounded-full cursor-pointer shrink-0 flex items-center"
                title="点击头像操作"
                @click="openAvatarMenu($event, activeDmBot)">
                <VlAvatar
                  :avatar="activeDmBot.avatar"
                  :name="activeDmBot.displayName"
                  :provider="activeDmBot.provider"
                  :size="26" />
              </button>
              <span class="px-1.5 py-0.5 rounded bg-[#1d4940] text-[#5eead4] text-11.5px shrink-0">
                @{{ activeDmBot.handle }}
              </span>
              <span class="text-12px text-[#9ca3af] truncate">
                {{ activeDmBot.provider }}{{ activeDmBot.model ? `/${activeDmBot.model}` : '' }} · {{ activeDmBot.statusText || presenceLabel(activeDmBot.presence) }}
              </span>
            </template>
          </template>
          <span v-else class="text-14px text-[#9ca3af]">VibeLink 协作控制台</span>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <!-- Mode Switcher: Chat | Terminal | Diff -->
          <div class="flex items-center p-0.5 rounded-8px bg-[#1c1c1c] border border-[#333]">
            <button
              type="button"
              data-testid="tab-chat"
              class="px-2.5 py-1 rounded-6px border-0 cursor-pointer text-12px transition-colors"
              :class="store.activeTab === 'chat' ? 'bg-[#13987f] text-white font-medium' : 'bg-transparent text-[#9ca3af] hover:text-[#eaeaea]'"
              @click="store.activeTab = 'chat'">
              聊天
            </button>
            <button
              type="button"
              data-testid="tab-terminal"
              class="px-2.5 py-1 rounded-6px border-0 cursor-pointer text-12px transition-colors"
              :class="store.activeTab === 'terminal' ? 'bg-[#13987f] text-white font-medium' : 'bg-transparent text-[#9ca3af] hover:text-[#eaeaea]'"
              @click="store.activeTab = 'terminal'">
              终端
            </button>
            <button
              type="button"
              data-testid="tab-diff"
              class="px-2.5 py-1 rounded-6px border-0 cursor-pointer text-12px transition-colors"
              :class="store.activeTab === 'diff' ? 'bg-[#13987f] text-white font-medium' : 'bg-transparent text-[#9ca3af] hover:text-[#eaeaea]'"
              @click="openDiffTab">
              Diff
            </button>
          </div>

          <button
            v-if="activeDmBot"
            type="button"
            data-testid="open-active-bot-home"
            class="px-2.5 py-1 rounded-6px bg-[#20332f] hover:bg-[#1d4940] border border-[#2d584e] text-[#99f6e4] text-12px cursor-pointer"
            @click="store.openBotHomeDrawer(activeDmBot.id)">
            Bot Home
          </button>

          <button
            type="button"
            data-testid="toggle-sidebar-btn"
            class="w-28px h-28px rounded-6px bg-transparent hover:bg-[#353535] border-0 text-[#cbd5e1] cursor-pointer text-15px"
            title="切换右侧信息栏"
            @click="store.sidebarVisible = !store.sidebarVisible">
            ···
          </button>

          <!-- Native Desktop Window Controls -->
          <div v-if="inTauri" class="flex items-center gap-1 ml-1 pl-2 border-l border-[#353535]">
            <button type="button" class="vl-win-btn" title="最小化" @click="minimizeWindowSafe">─</button>
            <button type="button" class="vl-win-btn" title="最大化" @click="toggleMaximizeWindowSafe">□</button>
            <button type="button" class="vl-win-btn hover:bg-[#c14053] hover:text-white" title="隐藏到托盘" @click="closeOrHideWindowSafe">×</button>
          </div>
        </div>
      </header>

      <!-- Connection warning bar -->
      <div
        v-if="store.lastError && !store.connected"
        class="px-4 py-2 bg-[#3a1f1f] border-b border-[#5b2c2c] flex items-center justify-between text-12px text-[#fecaca]">
        <span>未连接到后端控制面 ({{ store.serverUrl }})：{{ store.lastError }}</span>
        <div class="flex gap-2">
          <button
            type="button"
            class="px-2.5 py-0.5 rounded bg-[#572b2b] border-0 text-white cursor-pointer"
            @click="store.init(true)">
            重连
          </button>
          <button
            type="button"
            class="px-2.5 py-0.5 rounded bg-[#13987f] border-0 text-white cursor-pointer"
            @click="store.serverSettingsOpen = true">
            配置地址
          </button>
        </div>
      </div>

      <!-- Group Pinned Announcement Banner (HuLa pink megaphone + green 查看全部) -->
      <div
        v-if="store.activeRoom?.kind === 'group' && store.activeRoom.notice && store.activeTab === 'chat'"
        class="px-4 py-1.5 bg-[#242424] border-b border-[#323232] flex items-center justify-between gap-3 text-12.5px"
        data-testid="group-notice-banner">
        <div class="flex items-center gap-2 min-w-0">
          <svg viewBox="0 0 24 24" class="w-15px h-15px shrink-0 text-[#f472b6]" fill="currentColor">
            <path d="M3 10v4a1 1 0 0 0 1 1h2.2l3.8 4.2A1 1 0 0 0 11.7 18.5V15h.3l7.4 2.9A1 1 0 0 0 21 17V7a1 1 0 0 0-1.6-.8L12 9H4a1 1 0 0 0-1 1z" />
          </svg>
          <span class="truncate text-[#d4d4d4]">{{ store.activeRoom.notice }}</span>
        </div>
        <button
          type="button"
          data-testid="open-notice-modal-btn"
          class="shrink-0 bg-transparent border-0 text-[#13987f] hover:text-[#34d399] cursor-pointer text-12px font-medium"
          @click="openNoticeModal">
          查看全部
        </button>
      </div>

      <!-- Tab 1: Chat Timeline + Composer -->
      <template v-if="store.activeRoom && store.activeTab === 'chat'">
        <!-- Optional Inline History Filter Bar -->
        <div
          v-if="historySearchOpen"
          class="px-4 py-1.5 bg-[#242424] border-b border-[#323232] flex items-center gap-2 text-12px"
          data-testid="history-search-bar">
          <input
            v-model="historySearchQuery"
            type="text"
            placeholder="搜索当前会话历史消息..."
            class="flex-1 px-2.5 py-1 rounded bg-[#181818] border border-[#363636] text-[#eaeaea] outline-none focus:border-[#13987f]" />
          <button
            type="button"
            class="bg-transparent border-0 text-[#9ca3af] hover:text-white cursor-pointer text-12px"
            @click="closeHistorySearch">
            关闭
          </button>
        </div>

        <div ref="messageListRef" class="flex-1 vl-scroll px-4 py-3 space-y-3" data-testid="chat-message-list">
          <div v-if="displayedMessages.length === 0" class="text-center text-12.5px text-[#777] py-12">
            {{ historySearchQuery.trim() ? '未找到匹配的历史消息' : '暂无消息，发送内容或在群里输入 @Bot 发起协作。' }}
          </div>

          <template v-for="(msg, idx) in displayedMessages" :key="msg.id">
            <!-- Time divider -->
            <div v-if="shouldShowDateDivider(idx)" class="text-center py-1">
              <span class="px-2.5 py-0.5 rounded-full bg-[#222222] text-11px text-[#808080]">
                {{ formatMessageTime(msg.createdAt) }}
              </span>
            </div>

            <!-- Recalled Message -->
            <div v-if="msg.recalledAt" class="text-center py-1">
              <span class="px-3 py-1 rounded-full bg-[#242424] text-11.5px text-[#888]">
                {{ senderDisplayName(msg.senderId) }} 撤回了一条消息
              </span>
            </div>

            <!-- System / Handoff Pill (#3e362e) -->
            <div v-else-if="msg.msgType === 'system'" class="flex justify-center py-0.5">
              <div class="max-w-80% px-3.5 py-1 rounded-full bg-[#3e362e] text-[#dfd0bf] text-12px text-center leading-snug">
                {{ msg.content }}
              </div>
            </div>

            <!-- Outgoing User Bubble (#1d4940) -->
            <div v-else-if="msg.senderId === 'me'" class="group flex justify-end items-start gap-2.5">
              <div class="max-w-74% flex flex-col items-end">
                <div class="flex items-center gap-2 mb-1 text-11px text-[#858585]">
                  <div class="hidden group-hover:flex items-center gap-1.5 mr-1">
                    <button type="button" class="vl-msg-action" @click="copyMessage(msg.content)">复制</button>
                    <button type="button" class="vl-msg-action" @click="replyMessage(msg)">回复</button>
                    <button type="button" class="vl-msg-action text-[#fca5a5]" @click="store.recallMessage(msg.roomId, msg.id)">撤回</button>
                  </div>
                  <span>{{ formatClockTime(msg.createdAt) }}</span>
                </div>
                <div class="rounded-12px rounded-tr-3px px-3.5 py-2.5 bg-[#1d4940] text-[#eef7f5] shadow-sm">
                  <div v-if="msg.replyToId" class="mb-1.5 px-2 py-1 rounded bg-black/20 text-11.5px text-[#a7f3d0] border-l-2 border-[#34d399]">
                    {{ replySnippet(msg.replyToId) }}
                  </div>
                  <BotMarkdownMessage :content="msg.content" :server-url="store.serverUrl" />
                </div>
              </div>
              <button
                type="button"
                class="border-0 p-0 bg-transparent cursor-pointer shrink-0 mt-4 rounded-full"
                title="点击编辑个人资料与头像"
                @click="store.me && openAvatarMenu($event, store.me)">
                <VlAvatar
                  :avatar="store.me?.avatar ?? 'preset:user'"
                  :name="store.me?.displayName ?? '我'"
                  :size="34" />
              </button>
            </div>

            <!-- Incoming Bot Bubble (#1e1e1e) -->
            <div v-else class="group flex items-start gap-2.5">
              <button
                type="button"
                class="border-0 p-0 bg-transparent cursor-pointer shrink-0 mt-1 rounded-full"
                title="点击头像操作"
                :data-testid="`msg-avatar-${msg.senderId}`"
                @click="openAccountAvatarMenu($event, msg.senderId)">
                <VlAvatar
                  :avatar="accountAvatarProps(msg.senderId).avatar"
                  :name="accountAvatarProps(msg.senderId).name"
                  :provider="accountAvatarProps(msg.senderId).provider"
                  :size="34" />
              </button>

              <div class="max-w-76% min-w-0">
                <div class="flex items-center gap-1.5 mb-1 text-11.5px">
                  <span class="font-medium text-[#d4d4d4]">{{ senderDisplayName(msg.senderId) }}</span>
                  <span
                    v-if="senderHandle(msg.senderId)"
                    class="px-1.5 py-0.2 rounded bg-[#163831] text-[#5eead4] text-10.5px">
                    @{{ senderHandle(msg.senderId) }}
                  </span>
                  <span class="text-11px text-[#737373]">{{ formatClockTime(msg.createdAt) }}</span>
                  <div class="hidden group-hover:flex items-center gap-1.5 ml-1">
                    <button type="button" class="vl-msg-action" @click="copyMessage(msg.content)">复制</button>
                    <button type="button" class="vl-msg-action" @click="replyMessage(msg)">回复</button>
                  </div>
                </div>

                <BotToolCallCard v-if="msg.msgType === 'bot_tool_call'" :message="msg" />
                <BotApprovalCard
                  v-else-if="msg.msgType === 'bot_approval'"
                  :message="msg"
                  @respond="handleApprovalRespond" />
                <BotDiffCheckpointCard
                  v-else-if="msg.msgType === 'bot_diff_checkpoint'"
                  :message="msg"
                  @rollback="handleCheckpointRollback" />
                <div
                  v-else
                  class="rounded-12px rounded-tl-3px px-3.5 py-2.5 bg-[#1e1e1e] border border-[#303030] text-[#eaeaea]">
                  <BotMarkdownMessage
                    :content="msg.content"
                    :server-url="store.serverUrl"
                    :bot-handles="roomBotHandles" />
                </div>
              </div>
            </div>
          </template>

          <div
            v-if="store.isActiveRoomBusy"
            class="flex items-center gap-2 px-3 py-1.5 rounded-8px bg-[#222c2a] border border-[#2d4540] text-12px text-[#99f6e4] w-fit">
            <span class="inline-block w-2 h-2 rounded-full bg-[#f59e0b] animate-pulse"></span>
            <span>{{ workingBotsLabel }}</span>
          </div>
        </div>

        <!-- Composer -->
        <div class="border-t border-[#343434] bg-[#242424] px-3.5 pt-2 pb-2.5 relative">
          <!-- @Bot Autocomplete Popup -->
          <div
            v-if="mentionPopupOpen && mentionCandidates.length > 0"
            class="absolute left-4 bottom-full mb-1.5 z-30 w-240px rounded-8px bg-[#1f2322] border border-[#384240] shadow-2xl py-1 overflow-hidden"
            data-testid="mention-popup">
            <div class="px-2.5 py-1 text-10.5px text-[#888] border-b border-[#2e3332]">选择要 @ 的 Bot</div>
            <button
              v-for="(bot, bIdx) in mentionCandidates"
              :key="bot.id"
              type="button"
              class="w-full text-left px-3 py-1.5 border-0 cursor-pointer flex items-center justify-between text-12px"
              :class="bIdx === mentionCursor ? 'bg-[#1d4940] text-white' : 'bg-transparent text-[#ddd] hover:bg-[#2a2f2e]'"
              @mousedown.prevent="applyMention(bot.handle)">
              <span class="font-medium">@{{ bot.handle }}</span>
              <span class="text-11px text-[#9ca3af] truncate ml-2">{{ bot.roleTitle }}</span>
            </button>
          </div>

          <!-- Composer Toolbar (HuLa icon-only style, zero visible button text) -->
          <div class="flex items-center justify-between gap-2 pb-2" data-testid="composer-toolbar">
            <div class="flex items-center gap-4">
              <!-- Emoji Picker -->
              <div class="relative flex items-center">
                <button
                  type="button"
                  class="vl-icon-btn"
                  title="表情"
                  aria-label="表情"
                  @click="emojiOpen = !emojiOpen">
                  <svg viewBox="0 0 24 24" class="w-20px h-20px" fill="none" stroke="currentColor" stroke-width="1.7">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M8.5 14.5s1.3 2 3.5 2 3.5-2 3.5-2" stroke-linecap="round" />
                    <circle cx="9.2" cy="10" r="0.8" fill="currentColor" stroke="none" />
                    <circle cx="14.8" cy="10" r="0.8" fill="currentColor" stroke="none" />
                  </svg>
                </button>
                <div
                  v-if="emojiOpen"
                  class="absolute left-0 bottom-32px z-30 w-220px p-2 rounded-8px bg-[#1f2222] border border-[#363b3a] shadow-xl grid grid-cols-6 gap-1">
                  <button
                    v-for="em in emojiList"
                    :key="em"
                    type="button"
                    class="p-1 rounded bg-transparent hover:bg-[#303534] border-0 cursor-pointer text-16px"
                    @click="insertEmoji(em)">
                    {{ em }}
                  </button>
                </div>
              </div>

              <!-- Screenshot Split Icon Button -->
              <div class="relative flex items-center gap-0.5">
                <button
                  type="button"
                  class="vl-icon-btn"
                  title="截图"
                  aria-label="截图"
                  @click="handleScreenshotClick">
                  <svg viewBox="0 0 24 24" class="w-20px h-20px" fill="none" stroke="currentColor" stroke-width="1.7">
                    <circle cx="6" cy="7" r="2.5" />
                    <circle cx="6" cy="17" r="2.5" />
                    <path d="M8.2 8.2 19 18M8.2 15.8 19 6" stroke-linecap="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="vl-icon-chevron"
                  title="截图选项"
                  aria-label="截图选项"
                  @click="screenshotMenuOpen = !screenshotMenuOpen">
                  <svg viewBox="0 0 24 24" class="w-12px h-12px" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="m6 9 6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <div
                  v-if="screenshotMenuOpen"
                  class="absolute left-0 bottom-32px z-30 w-185px p-2 rounded-8px bg-[#1f2222] border border-[#363b3a] shadow-xl text-12px">
                  <label class="flex items-center gap-2 cursor-pointer text-[#ddd]">
                    <input v-model="concealOnCapture" type="checkbox" />
                    <span>截图时隐藏当前窗口</span>
                  </label>
                </div>
              </div>

              <!-- File Split Icon Button -->
              <div class="relative flex items-center gap-0.5">
                <button
                  type="button"
                  class="vl-icon-btn"
                  title="发送文件"
                  aria-label="发送文件"
                  @click="fileInputRef?.click()">
                  <svg viewBox="0 0 24 24" class="w-20px h-20px" fill="none" stroke="currentColor" stroke-width="1.7">
                    <path d="M3 7a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke-linejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="vl-icon-chevron"
                  title="文件与图片"
                  aria-label="文件与图片"
                  @click="fileMenuOpen = !fileMenuOpen">
                  <svg viewBox="0 0 24 24" class="w-12px h-12px" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="m6 9 6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <div
                  v-if="fileMenuOpen"
                  class="absolute left-0 bottom-32px z-30 w-130px rounded-8px bg-[#1f2222] border border-[#363b3a] shadow-xl py-1 text-12px">
                  <button
                    type="button"
                    class="w-full text-left px-3 py-1.5 bg-transparent hover:bg-[#1d4940] border-0 text-[#eaeaea] cursor-pointer"
                    @click="triggerFilePicker">
                    发送文件
                  </button>
                  <button
                    type="button"
                    class="w-full text-left px-3 py-1.5 bg-transparent hover:bg-[#1d4940] border-0 text-[#eaeaea] cursor-pointer"
                    @click="triggerImagePicker">
                    发送图片
                  </button>
                </div>
              </div>
              <input ref="fileInputRef" type="file" class="hidden" @change="handleFilePicked" />
              <input ref="imageInputRef" type="file" accept="image/*" class="hidden" @change="handleFilePicked" />

              <!-- Image Icon -->
              <button
                type="button"
                class="vl-icon-btn"
                title="发送图片"
                aria-label="发送图片"
                @click="imageInputRef?.click()">
                <svg viewBox="0 0 24 24" class="w-20px h-20px" fill="none" stroke="currentColor" stroke-width="1.7">
                  <rect x="3" y="5" width="18" height="14" rx="2.5" />
                  <circle cx="8.5" cy="10" r="1.4" />
                  <path d="m21 15-4.5-4.5L9 18" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>

              <!-- Microphone Voice Icon -->
              <button
                type="button"
                class="vl-icon-btn"
                title="语音输入"
                aria-label="语音输入"
                @click="handleVoiceClick">
                <svg viewBox="0 0 24 24" class="w-20px h-20px" fill="none" stroke="currentColor" stroke-width="1.7">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7" stroke-linecap="round" />
                </svg>
              </button>

              <!-- Quick @Bot Picker Icon -->
              <div class="relative flex items-center">
                <button
                  type="button"
                  class="vl-icon-btn"
                  title="@Bot 协同点名"
                  aria-label="艾特Bot"
                  @click="quickAtOpen = !quickAtOpen">
                  <svg viewBox="0 0 24 24" class="w-19px h-19px" fill="none" stroke="currentColor" stroke-width="1.7">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M16 8v5a2.5 2.5 0 0 0 5 0v-1a9 9 0 1 0-4.2 7.6" stroke-linecap="round" />
                  </svg>
                </button>
                <div
                  v-if="quickAtOpen"
                  class="absolute left-0 bottom-32px z-30 w-190px rounded-8px bg-[#1f2222] border border-[#363b3a] shadow-xl py-1">
                  <button
                    v-for="b in store.activeRoomBots"
                    :key="b.id"
                    type="button"
                    class="w-full text-left px-3 py-1.5 bg-transparent hover:bg-[#1d4940] border-0 text-12px text-[#eaeaea] cursor-pointer flex justify-between"
                    @click="insertQuickAt(b.handle)">
                    <span>@{{ b.handle }}</span>
                    <span class="text-[#8e9297]">{{ b.provider }}</span>
                  </button>
                </div>
              </div>

              <!-- Dispatch Mode Icon Popover -->
              <div class="relative flex items-center">
                <button
                  type="button"
                  class="vl-icon-btn relative"
                  :title="`Bot 调度模式 (${store.sendMode})`"
                  aria-label="调度模式"
                  @click="modeMenuOpen = !modeMenuOpen">
                  <svg viewBox="0 0 24 24" class="w-19px h-19px" fill="none" stroke="currentColor" stroke-width="1.7">
                    <path d="M4 7h10M18 7h2M14 5v4M4 17h4M12 17h8M8 15v4M4 12h16" stroke-linecap="round" />
                  </svg>
                  <span
                    v-if="store.sendMode !== 'auto'"
                    class="absolute -top-0.5 -right-0.5 w-6px h-6px rounded-full bg-[#13987f]"></span>
                </button>
                <div
                  v-if="modeMenuOpen"
                  class="absolute left-0 bottom-32px z-30 w-160px rounded-8px bg-[#1f2222] border border-[#363b3a] shadow-xl py-1 text-12px">
                  <button
                    v-for="m in sendModeOptions"
                    :key="m.value"
                    type="button"
                    class="w-full text-left px-3 py-1.5 bg-transparent hover:bg-[#1d4940] border-0 text-[#eaeaea] cursor-pointer flex items-center justify-between"
                    @click="selectSendMode(m.value)">
                    <span>{{ m.label }}</span>
                    <span v-if="store.sendMode === m.value" class="text-[#5eead4]">✓</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- Right Icons: Interrupt (when busy) & History Search Clock -->
            <div class="flex items-center gap-3">
              <button
                v-if="store.isActiveRoomBusy"
                type="button"
                data-testid="interrupt-btn"
                class="vl-icon-btn text-[#f87171] hover:text-[#fca5a5]"
                title="中断当前 Bot 生成"
                aria-label="中断生成"
                @click="store.interruptActiveRoom()">
                <svg viewBox="0 0 24 24" class="w-19px h-19px" fill="none" stroke="currentColor" stroke-width="1.8">
                  <circle cx="12" cy="12" r="9" />
                  <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
                </svg>
              </button>

              <button
                type="button"
                data-testid="toggle-history-search"
                class="vl-icon-btn"
                :class="{ 'text-[#13987f]': historySearchOpen }"
                title="聊天记录检索"
                aria-label="聊天记录"
                @click="historySearchOpen = !historySearchOpen">
                <svg viewBox="0 0 24 24" class="w-20px h-20px" fill="none" stroke="currentColor" stroke-width="1.7">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" stroke-linecap="round" stroke-linejoin="round" />
                  <path d="M3 3v5h5M12 7v5l3 2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Reply Target Banner -->
          <div
            v-if="activeReplyTarget"
            class="mb-1.5 px-2.5 py-1 rounded-6px bg-[#2d3432] flex items-center justify-between text-11.5px text-[#a7f3d0]">
            <span class="truncate">
              回复 {{ senderDisplayName(activeReplyTarget.senderId) }}: {{ activeReplyTarget.content }}
            </span>
            <button
              type="button"
              class="bg-transparent border-0 text-[#9ca3af] hover:text-white cursor-pointer"
              @click="clearReplyTarget">
              ×
            </button>
          </div>

          <!-- Input Box -->
          <textarea
            ref="composerRef"
            v-model="draftText"
            data-testid="chat-composer-input"
            rows="3"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行；群聊中输入 @Bot 可多专家接力协作..."
            class="w-full box-border resize-none bg-transparent border-0 text-13.5px text-[#f0f0f0] leading-relaxed outline-none placeholder:text-[#6e6e6e]"
            @input="updateMentionPopup"
            @keydown="handleComposerKeydown"></textarea>

          <!-- Bottom Send Bar -->
          <div class="flex items-center justify-between pt-1">
            <span class="text-11.5px text-[#5eead4]">
              {{ localNotice }}
            </span>

            <div class="relative flex items-center rounded-7px overflow-hidden shadow-sm">
              <button
                type="button"
                data-testid="send-message-btn"
                :disabled="!draftText.trim() || sendingMsg"
                class="px-4 py-1.5 bg-[#13987f] hover:bg-[#17ad91] disabled:opacity-50 border-0 text-white text-12.5px font-medium cursor-pointer"
                @click="handleSend">
                {{ sendingMsg ? '发送中...' : '发送' }}
              </button>
              <button
                type="button"
                class="px-2 py-1.5 bg-[#118670] hover:bg-[#159b82] border-0 border-l border-[#0e6b59] text-white text-11px cursor-pointer"
                @click="sendKeyMenuOpen = !sendKeyMenuOpen">
                ▾
              </button>
              <div
                v-if="sendKeyMenuOpen"
                class="fixed z-40 mt-10 w-155px rounded-8px bg-[#1f2222] border border-[#363b3a] shadow-xl py-1 text-12px"
                style="right: 260px; bottom: 52px;">
                <button
                  type="button"
                  class="w-full text-left px-3 py-1.5 bg-transparent hover:bg-[#2a3130] border-0 text-[#eaeaea] cursor-pointer"
                  @click="setSendKey(true)">
                  {{ sendOnEnter ? '✓ ' : '' }}Enter 发送
                </button>
                <button
                  type="button"
                  class="w-full text-left px-3 py-1.5 bg-transparent hover:bg-[#2a3130] border-0 text-[#eaeaea] cursor-pointer"
                  @click="setSendKey(false)">
                  {{ !sendOnEnter ? '✓ ' : '' }}Ctrl + Enter 发送
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- Tab 2: PTY Terminal -->
      <div v-else-if="store.activeRoom && store.activeTab === 'terminal'" class="flex-1 min-h-0">
        <BotTerminalPane :room-id="store.activeRoom.id" :bot-id="activeDmBot?.id ?? null" />
      </div>

      <!-- Tab 3: Diff / Checkpoints -->
      <div v-else-if="store.activeRoom && store.activeTab === 'diff'" class="flex-1 vl-scroll p-4 space-y-3" data-testid="diff-tab-pane">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-14px font-semibold text-[#eaeaea]">Turn 检查点与文件 Diff</div>
            <div class="text-12px text-[#8c8c8c]">工作区：{{ store.activeRoom.cwd }}</div>
          </div>
          <button
            type="button"
            class="px-3 py-1 rounded-6px bg-[#20332f] hover:bg-[#1d4940] border border-[#2d584e] text-[#99f6e4] text-12px cursor-pointer"
            @click="store.loadCheckpoints(store.activeRoom.id)">
            刷新检查点
          </button>
        </div>

        <div v-if="activeCheckpoints.length === 0" class="text-12.5px text-[#777] py-10 text-center">
          当前会话暂无 Turn 文件检查点记录；当 Bot 修改工作区代码时会自动在此生成可回滚检查点。
        </div>
        <BotDiffCheckpointCard
          v-for="cp in activeCheckpoints"
          :key="cp.id"
          :message="cp"
          @rollback="handleCheckpointRollback" />
      </div>
    </main>

    <!-- Column 4: Right Announcement & Online Members Sidebar (#262626) -->
    <aside
      v-if="store.sidebarVisible && store.activeRoom"
      class="vl-col-sidebar"
      data-testid="right-sidebar">
      <!-- Top Card: Group Notice or DM Bot Profile -->
      <div class="p-3 border-b border-[#313131]">
        <template v-if="store.activeRoom.kind === 'group'">
          <div class="flex items-center justify-between cursor-pointer" @click="openNoticeModal">
            <span class="text-13px font-semibold text-[#eaeaea]">群公告须知</span>
            <span class="text-12px text-[#888]">编辑 &gt;</span>
          </div>
          <div
            class="mt-1.5 text-12px text-[#9ca3af] line-clamp-3 cursor-pointer hover:text-[#d4d4d4]"
            @click="openNoticeModal">
            {{ store.activeRoom.notice || '暂无群公告，点击添加协作规范或群目标...' }}
          </div>
        </template>
        <template v-else-if="activeDmBot">
          <div class="flex items-center justify-between cursor-pointer" @click="store.openBotHomeDrawer(activeDmBot.id)">
            <span class="text-13px font-semibold text-[#eaeaea]">Bot 档案</span>
            <span class="text-12px text-[#5eead4]">Home &gt;</span>
          </div>
          <div class="mt-2 space-y-1 text-11.5px text-[#a3a3a3]">
            <div>定位：{{ activeDmBot.roleTitle }}</div>
            <div>引擎：{{ activeDmBot.provider }} / {{ activeDmBot.model || 'default' }}</div>
            <div class="font-mono truncate text-[#888]" :title="activeDmBot.cwd">目录：{{ activeDmBot.cwd }}</div>
          </div>
          <button
            type="button"
            class="mt-2.5 w-full py-1.5 rounded-6px bg-[#1d4940] hover:bg-[#13987f] border-0 text-[#ecfdf5] text-12px cursor-pointer"
            @click="store.openBotHomeDrawer(activeDmBot.id)">
            编辑 SOUL.md / MEMORY.md
          </button>
        </template>
      </div>

      <!-- Members Header & Search -->
      <div class="px-3 pt-3 pb-2 space-y-2">
        <div class="flex items-center justify-between text-12.5px">
          <span class="font-semibold text-[#e5e5e5]">
            在线成员 {{ store.activeRoom.onlineCount }}/{{ store.activeRoom.memberCount }}
          </span>
          <button
            v-if="store.activeRoom.kind === 'group' && availableBotsToInvite.length > 0"
            type="button"
            class="bg-transparent border-0 text-[#5eead4] hover:text-[#99f6e4] text-11.5px cursor-pointer"
            @click="inviteOpen = !inviteOpen">
            + 邀请 Bot
          </button>
        </div>

        <div v-if="inviteOpen && availableBotsToInvite.length > 0" class="p-2 rounded-6px bg-[#1d1f1f] border border-[#343837] space-y-1">
          <div class="text-11px text-[#9ca3af]">点击邀请加入当前群：</div>
          <button
            v-for="b in availableBotsToInvite"
            :key="b.id"
            type="button"
            class="w-full text-left px-2 py-1 rounded bg-[#272b2a] hover:bg-[#1d4940] border-0 text-11.5px text-[#eaeaea] cursor-pointer"
            @click="inviteBot(b.id)">
            + {{ b.displayName }} (@{{ b.handle }})
          </button>
        </div>

        <input
          v-model="memberSearch"
          type="text"
          placeholder="搜索群成员"
          class="w-full box-border px-2.5 py-1 rounded-6px bg-[#1e1e1e] border border-[#333] text-11.5px text-[#eaeaea] outline-none placeholder:text-[#6f6f6f]" />
      </div>

      <!-- Members List -->
      <div class="flex-1 vl-scroll px-2 pb-3 space-y-0.5" data-testid="sidebar-member-list">
        <div
          v-for="item in filteredMembers"
          :key="item.account.id"
          class="flex items-center gap-2 px-2 py-1.5 rounded-7px hover:bg-[#2f2f2f] cursor-pointer group"
          @click="handleMemberClick(item.account)"
          @contextmenu.prevent="openAvatarMenu($event, item.account)">
          <button
            type="button"
            class="relative shrink-0 p-0 border-0 bg-transparent rounded-full cursor-pointer"
            :data-testid="`member-avatar-${item.account.id}`"
            title="点击打开操作菜单"
            @click.stop="openAvatarMenu($event, item.account)">
            <VlAvatar
              :avatar="item.account.avatar"
              :name="item.account.displayName"
              :provider="item.account.provider"
              :size="28" />
            <span class="vl-status-dot-xs" :style="{ backgroundColor: presenceColor(item.account.presence) }"></span>
          </button>

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1">
              <span class="text-12px text-[#ececec] truncate">{{ item.account.displayName }}</span>
              <span
                v-if="item.member.role === 'owner'"
                class="px-1 py-0.1 rounded bg-[#c14053] text-white text-9.5px shrink-0">
                群主
              </span>
              <span
                v-else-if="item.account.kind === 'bot'"
                class="px-1 py-0.1 rounded bg-[#1d4940] text-[#5eead4] text-9.5px shrink-0">
                Bot
              </span>
            </div>
            <div class="text-10.5px text-[#888] truncate">
              @{{ item.account.handle }} · {{ item.account.statusText || presenceLabel(item.account.presence) }}
            </div>
          </div>

          <button
            v-if="item.account.kind === 'bot'"
            type="button"
            class="hidden group-hover:inline-block px-1.5 py-0.5 rounded bg-[#223531] border-0 text-[#5eead4] text-10px cursor-pointer"
            @click.stop="store.openBotHomeDrawer(item.account.id)">
            Home
          </button>
        </div>
      </div>
    </aside>

    <!-- Modals, Drawers & Context Menus -->
    <AvatarActionMenu
      :account="avatarMenuAccount"
      :anchor="avatarMenuAnchor"
      :in-group="store.activeRoom?.kind === 'group'"
      @close="closeAvatarMenu"
      @dm="onMenuDm"
      @poke="onMenuPoke"
      @view-profile="onMenuViewProfile"
      @edit-profile="onMenuEditProfile" />
    <AccountProfileModal
      :account-id="store.profileModalAccountId"
      @close="store.closeProfileModal()"
      @open-bot-home="store.openBotHomeDrawer($event)" />
    <BotHomeDrawer :bot-id="store.botHomeDrawerBotId" @close="store.closeBotHomeDrawer()" />
    <ServerSettingsModal :open="store.serverSettingsOpen" @close="store.serverSettingsOpen = false" />

    <!-- Group Notice Edit Modal -->
    <div
      v-if="noticeModalOpen && store.activeRoom"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      data-testid="notice-edit-modal"
      @click.self="noticeModalOpen = false">
      <div class="w-full max-w-460px rounded-12px bg-[#1f2222] border border-[#353a39] p-4 space-y-3 text-[#eaeaea]">
        <div class="flex items-center justify-between">
          <span class="text-15px font-semibold">群公告须知 · {{ store.activeRoom.name }}</span>
          <button
            type="button"
            class="bg-transparent border-0 text-[#9ca3af] cursor-pointer"
            @click="noticeModalOpen = false">
            ×
          </button>
        </div>
        <textarea
          v-model="noticeDraft"
          data-testid="notice-editor-textarea"
          rows="5"
          class="w-full box-border rounded-8px bg-[#141616] border border-[#383d3c] p-3 text-13px text-[#eaeaea] outline-none focus:border-[#13987f]"
          placeholder="输入本群职责边界、工作区约定或协作须知..."></textarea>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded-6px bg-[#2b2f2e] border-0 text-[#ddd] text-12px cursor-pointer"
            @click="noticeModalOpen = false">
            取消
          </button>
          <button
            type="button"
            data-testid="save-notice-btn"
            class="px-4 py-1.5 rounded-6px bg-[#13987f] hover:bg-[#17ad91] border-0 text-white text-12px font-medium cursor-pointer"
            @click="saveNotice">
            保存公告
          </button>
        </div>
      </div>
    </div>

    <!-- Create Bot Modal -->
    <div
      v-if="createBotModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      @click.self="createBotModalOpen = false">
      <div class="w-full max-w-460px rounded-12px bg-[#1f2222] border border-[#353a39] p-4 space-y-3 text-[#eaeaea]">
        <div class="flex items-center justify-between">
          <span class="text-15px font-semibold">新建 Bot 好友</span>
          <button type="button" class="bg-transparent border-0 text-[#9ca3af] cursor-pointer" @click="createBotModalOpen = false">×</button>
        </div>
        <div class="grid grid-cols-2 gap-2.5 text-12px">
          <label class="space-y-1">
            <span class="text-[#9ca3af]">名称 *</span>
            <input v-model="newBotForm.displayName" placeholder="例如 Reviewer" class="vl-input" />
          </label>
          <label class="space-y-1">
            <span class="text-[#9ca3af]">@Handle *</span>
            <input v-model="newBotForm.handle" placeholder="例如 Reviewer" class="vl-input" />
          </label>
          <label class="space-y-1">
            <span class="text-[#9ca3af]">Provider</span>
            <select v-model="newBotForm.provider" class="vl-input">
              <option value="codex">codex</option>
              <option value="claude">claude</option>
              <option value="antigravity">antigravity</option>
              <option value="opencode">opencode</option>
            </select>
          </label>
          <label class="space-y-1">
            <span class="text-[#9ca3af]">Model</span>
            <input v-model="newBotForm.model" placeholder="可选，如 gpt-5.3-codex" class="vl-input" />
          </label>
        </div>
        <label class="block space-y-1 text-12px">
          <span class="text-[#9ca3af]">工作目录 (cwd)</span>
          <input v-model="newBotForm.cwd" class="vl-input font-mono" />
        </label>
        <label class="block space-y-1 text-12px">
          <span class="text-[#9ca3af]">人设提示 (SOUL.md)</span>
          <textarea v-model="newBotForm.soulMarkdown" rows="3" class="vl-input"></textarea>
        </label>
        <div class="flex justify-end gap-2">
          <button type="button" class="px-3 py-1.5 rounded-6px bg-[#2b2f2e] border-0 text-[#ddd] text-12px cursor-pointer" @click="createBotModalOpen = false">取消</button>
          <button type="button" class="px-4 py-1.5 rounded-6px bg-[#13987f] border-0 text-white text-12px cursor-pointer" @click="submitCreateBot">创建并开启私聊</button>
        </div>
      </div>
    </div>

    <!-- Create Group Modal -->
    <div
      v-if="createGroupModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      @click.self="createGroupModalOpen = false">
      <div class="w-full max-w-460px rounded-12px bg-[#1f2222] border border-[#353a39] p-4 space-y-3 text-[#eaeaea]">
        <div class="flex items-center justify-between">
          <span class="text-15px font-semibold">新建多 Bot 协作群</span>
          <button type="button" class="bg-transparent border-0 text-[#9ca3af] cursor-pointer" @click="createGroupModalOpen = false">×</button>
        </div>
        <label class="block space-y-1 text-12px">
          <span class="text-[#9ca3af]">群名称 *</span>
          <input v-model="newGroupForm.name" placeholder="例如 PR 审查协同群" class="vl-input" />
        </label>
        <label class="block space-y-1 text-12px">
          <span class="text-[#9ca3af]">工作目录 (cwd)</span>
          <input v-model="newGroupForm.cwd" class="vl-input font-mono" />
        </label>
        <label class="block space-y-1 text-12px">
          <span class="text-[#9ca3af]">群公告</span>
          <textarea v-model="newGroupForm.notice" rows="2" class="vl-input"></textarea>
        </label>
        <div class="space-y-1 text-12px">
          <span class="text-[#9ca3af]">选择入群协作的 Bot 成员</span>
          <div class="max-h-140px vl-scroll grid grid-cols-2 gap-1.5 p-2 rounded bg-[#141616] border border-[#323635]">
            <label v-for="b in store.bots" :key="b.id" class="flex items-center gap-2 text-12px cursor-pointer">
              <input v-model="newGroupForm.botIds" type="checkbox" :value="b.id" />
              <span class="truncate">{{ b.displayName }} (@{{ b.handle }})</span>
            </label>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button type="button" class="px-3 py-1.5 rounded-6px bg-[#2b2f2e] border-0 text-[#ddd] text-12px cursor-pointer" @click="createGroupModalOpen = false">取消</button>
          <button type="button" class="px-4 py-1.5 rounded-6px bg-[#13987f] border-0 text-white text-12px cursor-pointer" @click="submitCreateGroup">创建协同群</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useSettingStore } from '@/stores/setting'
import { presenceColor, presenceLabel } from '../avatar'
import {
  closeOrHideWindowSafe,
  isTauriRuntime,
  listenScreenshotResult,
  minimizeWindowSafe,
  toggleMaximizeWindowSafe,
  triggerDesktopScreenshot
} from '../runtime'
import { useVibeLinkStore, type VlDesktopNav } from '../store'
import type { VlAccount, VlMessage, VlPresence, VlRoomSummary, VlSendMode } from '../types'
import '../vibelink.scss'
import AccountProfileModal from './AccountProfileModal.vue'
import AvatarActionMenu from './AvatarActionMenu.vue'
import BotApprovalCard from './BotApprovalCard.vue'
import BotDiffCheckpointCard from './BotDiffCheckpointCard.vue'
import BotHomeDrawer from './BotHomeDrawer.vue'
import BotMarkdownMessage from './BotMarkdownMessage.vue'
import BotTerminalPane from './BotTerminalPane.vue'
import BotToolCallCard from './BotToolCallCard.vue'
import ServerSettingsModal from './ServerSettingsModal.vue'
import VlAvatar from './VlAvatar.vue'

const store = useVibeLinkStore()
const settingStore = useSettingStore()
const route = useRoute()
const inTauri = isTauriRuntime()

const messageListRef = ref<HTMLElement | null>(null)
const composerRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const imageInputRef = ref<HTMLInputElement | null>(null)

const meMenuOpen = ref(false)
const myStatusDraft = ref('')
const createMenuOpen = ref(false)
const emojiOpen = ref(false)
const screenshotMenuOpen = ref(false)
const fileMenuOpen = ref(false)
const modeMenuOpen = ref(false)
const historySearchOpen = ref(false)
const historySearchQuery = ref('')
const avatarMenuAccount = ref<VlAccount | null>(null)
const avatarMenuAnchor = ref<{ x: number; y: number } | null>(null)
const quickAtOpen = ref(false)
const sendKeyMenuOpen = ref(false)
const sendOnEnter = ref(true)
const sendingMsg = ref(false)
const localNotice = ref('')
const memberSearch = ref('')
const inviteOpen = ref(false)

const noticeModalOpen = ref(false)
const noticeDraft = ref('')
const createBotModalOpen = ref(false)
const createGroupModalOpen = ref(false)

const mentionPopupOpen = ref(false)
const mentionQuery = ref('')
const mentionCursor = ref(0)

const presenceOptions: Array<{ value: VlPresence; label: string }> = [
  { value: 'online', label: '在线' },
  { value: 'idle', label: '忙碌' },
  { value: 'offline', label: '隐身' }
]

const sessionFilterTabs: Array<{ value: 'all' | 'dm' | 'group'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'dm', label: 'Bot 好友' },
  { value: 'group', label: '协作群' }
]

const sendModeOptions: Array<{ value: VlSendMode; label: string }> = [
  { value: 'auto', label: '自动调度 (auto)' },
  { value: 'queue', label: '排队执行 (queue)' },
  { value: 'steer', label: '插话引导 (steer)' }
]

const emojiList = ['👍', '🎉', '🔥', '🚀', '✅', '⚠️', '🐛', '🧠', '💡', '👀', '👏', '❤️', '😂', '🤔', '📌', '🛠️', '🧪', '📄']

const newBotForm = reactive({
  displayName: '',
  handle: '',
  provider: 'codex',
  model: '',
  cwd: 'D:\\AI\\VibeLink',
  soulMarkdown: ''
})

const newGroupForm = reactive({
  name: '',
  cwd: 'D:\\AI\\VibeLink',
  notice: '',
  botIds: [] as string[]
})

const concealOnCapture = computed({
  get: () => settingStore.screenshot?.isConceal ?? false,
  set: (v: boolean) => settingStore.setScreenshotConceal(v)
})

const filteredBots = computed(() => {
  const q = store.searchQuery.trim().toLowerCase()
  if (!q) return store.bots
  return store.bots.filter(
    (b) =>
      b.displayName.toLowerCase().includes(q) ||
      b.handle.toLowerCase().includes(q) ||
      b.roleTitle.toLowerCase().includes(q) ||
      b.provider.toLowerCase().includes(q)
  )
})

const filteredRooms = computed(() => {
  const q = store.searchQuery.trim().toLowerCase()
  return store.sortedRooms.filter((r) => {
    if (store.sessionFilter !== 'all' && r.kind !== store.sessionFilter) return false
    if (!q) return true
    if (r.name.toLowerCase().includes(q)) return true
    const preview = r.lastMessage?.content?.toLowerCase() ?? ''
    return preview.includes(q)
  })
})

function dmTargetBot(room: VlRoomSummary): VlAccount | null {
  if (room.kind !== 'dm') return null
  const member = room.members.find((m) => m.accountId !== 'me')
  return member ? store.accountsById[member.accountId] ?? null : null
}

const activeDmBot = computed(() => (store.activeRoom ? dmTargetBot(store.activeRoom) : null))

function accountAvatarProps(accountId: string) {
  const acc = store.accountsById[accountId]
  return {
    avatar: acc?.avatar ?? '',
    name: acc?.displayName ?? accountId,
    provider: acc?.provider ?? ''
  }
}

function roomAvatarProps(room: VlRoomSummary) {
  if (room.kind === 'dm') {
    const bot = dmTargetBot(room)
    if (bot) {
      return {
        avatar: bot.avatar,
        name: bot.displayName,
        provider: bot.provider
      }
    }
  }
  return {
    avatar: room.avatar,
    name: room.name,
    provider: ''
  }
}

const displayedMessages = computed(() => {
  const q = historySearchQuery.value.trim().toLowerCase()
  if (!q) return store.activeMessages
  return store.activeMessages.filter(
    (m) =>
      m.content.toLowerCase().includes(q) ||
      senderDisplayName(m.senderId).toLowerCase().includes(q)
  )
})

const draftText = computed({
  get: () => (store.activeRoomId ? store.composerDraftByRoom[store.activeRoomId] ?? '' : ''),
  set: (val: string) => {
    if (store.activeRoomId) {
      store.composerDraftByRoom[store.activeRoomId] = val
    }
  }
})

const activeReplyTarget = computed(() =>
  store.activeRoomId ? store.replyTargetByRoom[store.activeRoomId] ?? null : null
)

const activeCheckpoints = computed(() =>
  store.activeRoomId ? store.checkpointsByRoom[store.activeRoomId] ?? [] : []
)

const roomBotHandles = computed(() => store.activeRoomBots.map((b) => b.handle))

const workingBotsLabel = computed(() => {
  const working = store.activeRoomBots.filter((b) => b.presence === 'working')
  if (working.length === 0) return ''
  return working.map((b) => `${b.displayName} (${b.statusText || '运行中'})`).join(' · ')
})

const availableBotsToInvite = computed(() => {
  if (!store.activeRoom) return []
  const existing = new Set(store.activeRoom.members.map((m) => m.accountId))
  return store.bots.filter((b) => !existing.has(b.id))
})

const filteredMembers = computed(() => {
  const q = memberSearch.value.trim().toLowerCase()
  if (!q) return store.activeRoomMembers
  return store.activeRoomMembers.filter(
    (item) =>
      item.account.displayName.toLowerCase().includes(q) ||
      item.account.handle.toLowerCase().includes(q) ||
      item.account.roleTitle.toLowerCase().includes(q)
  )
})

const mentionCandidates = computed(() => {
  const pool = store.activeRoomBots.length > 0 ? store.activeRoomBots : store.bots
  const q = mentionQuery.value.trim().toLowerCase()
  if (!q) return pool
  return pool.filter(
    (b) => b.handle.toLowerCase().includes(q) || b.displayName.toLowerCase().includes(q)
  )
})

function showToast(msg: string) {
  localNotice.value = msg
  setTimeout(() => {
    if (localNotice.value === msg) localNotice.value = ''
  }, 2600)
}

function switchNav(nav: VlDesktopNav) {
  store.activeNav = nav
  if (nav === 'workspace') {
    store.activeTab = 'terminal'
  } else if (nav === 'messages' && store.activeTab === 'terminal') {
    store.activeTab = 'chat'
  }
}

function handleSelectRoom(roomId: string) {
  void store.selectRoom(roomId)
  if (store.activeNav === 'bots') {
    store.activeNav = 'messages'
  }
}

async function openDiffTab() {
  store.activeTab = 'diff'
  if (store.activeRoomId) {
    await store.loadCheckpoints(store.activeRoomId)
  }
}

function senderDisplayName(senderId: string): string {
  return store.accountsById[senderId]?.displayName ?? (senderId === 'me' ? '我' : senderId)
}

function senderHandle(senderId: string): string {
  return store.accountsById[senderId]?.handle ?? ''
}

function formatShortTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatClockTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatMessageTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${formatClockTime(ts)}`
}

function shouldShowDateDivider(index: number): boolean {
  if (index === 0) return true
  const prev = displayedMessages.value[index - 1]
  const curr = displayedMessages.value[index]
  return curr.createdAt - prev.createdAt > 15 * 60 * 1000
}

function formatLastMessagePreview(room: VlRoomSummary): string {
  const msg = room.lastMessage
  if (!msg) return room.notice || '暂无消息'
  if (msg.recalledAt) return '[已撤回]'
  const sender = msg.senderId === 'me' ? '' : `${senderDisplayName(msg.senderId)}: `
  return `${sender}${msg.content.replace(/\s+/g, ' ').slice(0, 48)}`
}

function replySnippet(replyToId: string): string {
  const target = store.activeMessages.find((m) => m.id === replyToId)
  if (!target) return '引用消息'
  return `${senderDisplayName(target.senderId)}: ${target.content.slice(0, 60)}`
}

function replyMessage(msg: VlMessage) {
  if (!store.activeRoomId) return
  store.replyTargetByRoom[store.activeRoomId] = msg
  composerRef.value?.focus()
}

function clearReplyTarget() {
  if (store.activeRoomId) {
    store.replyTargetByRoom[store.activeRoomId] = null
  }
}

async function copyMessage(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    showToast('已复制消息内容')
  } catch {
    showToast('复制失败')
  }
}

function scrollToBottom() {
  void nextTick(() => {
    const el = messageListRef.value
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  })
}

async function handleSend() {
  if (!store.activeRoomId) return
  const content = draftText.value.trim()
  if (!content || sendingMsg.value) return
  sendingMsg.value = true
  try {
    draftText.value = ''
    mentionPopupOpen.value = false
    await store.sendMessage(store.activeRoomId, content)
    scrollToBottom()
  } catch (err) {
    draftText.value = content
    showToast(`发送失败: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    sendingMsg.value = false
  }
}

function updateMentionPopup() {
  const el = composerRef.value
  if (!el) {
    mentionPopupOpen.value = false
    return
  }
  const cursorPos = el.selectionStart ?? el.value.length
  const before = el.value.slice(0, cursorPos)
  const match = /(?:^|\s)@([\w\u4e00-\u9fa5.-]*)$/.exec(before)
  if (match) {
    mentionQuery.value = match[1] ?? ''
    mentionCursor.value = 0
    mentionPopupOpen.value = true
  } else {
    mentionPopupOpen.value = false
  }
}

function applyMention(handle: string) {
  const el = composerRef.value
  const current = draftText.value
  const cursorPos = el?.selectionStart ?? current.length
  const before = current.slice(0, cursorPos)
  const after = current.slice(cursorPos)
  const replaced = before.replace(/@([\w\u4e00-\u9fa5.-]*)$/, `@${handle} `)
  draftText.value = `${replaced}${after}`
  mentionPopupOpen.value = false
  void nextTick(() => {
    if (el) {
      el.focus()
      el.setSelectionRange(replaced.length, replaced.length)
    }
  })
}

function insertQuickAt(handle: string) {
  draftText.value = `${draftText.value}${draftText.value && !draftText.value.endsWith(' ') ? ' ' : ''}@${handle} `
  quickAtOpen.value = false
  composerRef.value?.focus()
}

function insertEmoji(em: string) {
  draftText.value = `${draftText.value}${em}`
  emojiOpen.value = false
  composerRef.value?.focus()
}

function handleComposerKeydown(e: KeyboardEvent) {
  if (mentionPopupOpen.value && mentionCandidates.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      mentionCursor.value = (mentionCursor.value + 1) % mentionCandidates.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      mentionCursor.value =
        (mentionCursor.value - 1 + mentionCandidates.value.length) % mentionCandidates.value.length
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const chosen = mentionCandidates.value[mentionCursor.value]
      if (chosen) applyMention(chosen.handle)
      return
    }
    if (e.key === 'Escape') {
      mentionPopupOpen.value = false
      return
    }
  }

  if (e.key === 'Enter') {
    if (sendOnEnter.value && !e.shiftKey && !e.ctrlKey && !e.isComposing) {
      e.preventDefault()
      void handleSend()
    } else if (!sendOnEnter.value && e.ctrlKey) {
      e.preventDefault()
      void handleSend()
    }
  }
}

function setSendKey(enter: boolean) {
  sendOnEnter.value = enter
  sendKeyMenuOpen.value = false
}

async function handleScreenshotClick() {
  screenshotMenuOpen.value = false
  const ok = await triggerDesktopScreenshot(concealOnCapture.value)
  if (!ok) {
    showToast('当前为浏览器调试模式；桌面端 Tauri 运行时支持全局截图')
  }
}

async function handleFilePicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !store.activeRoomId) return
  try {
    await store.uploadAndSendFile(store.activeRoomId, file)
    scrollToBottom()
  } catch (err) {
    showToast(`上传失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function openNoticeModal() {
  noticeDraft.value = store.activeRoom?.notice ?? ''
  noticeModalOpen.value = true
}

async function saveNotice() {
  if (!store.activeRoomId) return
  await store.updateRoomNotice(store.activeRoomId, noticeDraft.value.trim())
  noticeModalOpen.value = false
  showToast('群公告已更新')
}

async function setPresence(presence: VlPresence) {
  await store.updateMeStatus({ presence })
  meMenuOpen.value = false
}

async function saveMyStatusText() {
  await store.updateMeStatus({ statusText: myStatusDraft.value.trim() })
  meMenuOpen.value = false
}

function openCreateBot() {
  createMenuOpen.value = false
  createBotModalOpen.value = true
}

function openCreateGroup() {
  createMenuOpen.value = false
  if (newGroupForm.botIds.length === 0 && store.bots.length > 0) {
    newGroupForm.botIds = store.bots.slice(0, 3).map((b) => b.id)
  }
  createGroupModalOpen.value = true
}

async function refreshAll() {
  createMenuOpen.value = false
  await store.bootstrap()
  showToast('已同步最新会话状态')
}

async function submitCreateBot() {
  if (!newBotForm.displayName.trim()) return
  await store.createBot({
    displayName: newBotForm.displayName.trim(),
    handle: newBotForm.handle.trim() || newBotForm.displayName.trim(),
    provider: newBotForm.provider,
    model: newBotForm.model.trim(),
    cwd: newBotForm.cwd.trim(),
    soulMarkdown: newBotForm.soulMarkdown
  })
  createBotModalOpen.value = false
  newBotForm.displayName = ''
  newBotForm.handle = ''
  newBotForm.soulMarkdown = ''
}

async function submitCreateGroup() {
  if (!newGroupForm.name.trim()) return
  await store.createGroup({
    name: newGroupForm.name.trim(),
    notice: newGroupForm.notice.trim(),
    cwd: newGroupForm.cwd.trim(),
    botIds: newGroupForm.botIds
  })
  createGroupModalOpen.value = false
  newGroupForm.name = ''
  newGroupForm.notice = ''
}

async function inviteBot(botId: string) {
  if (!store.activeRoomId) return
  await store.addBotToGroup(store.activeRoomId, botId)
  inviteOpen.value = false
}

function openBotIfBot(accountId: string) {
  const acc = store.accountsById[accountId]
  if (acc?.kind === 'bot') {
    store.openBotHomeDrawer(acc.id)
  }
}

function openMeProfileModal() {
  meMenuOpen.value = false
  store.openProfileModal('me')
}

function openAvatarMenu(ev: MouseEvent, acc: VlAccount) {
  const rect = (ev.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  avatarMenuAccount.value = acc
  avatarMenuAnchor.value = rect
    ? { x: rect.right + 8, y: rect.top }
    : { x: ev.clientX + 6, y: ev.clientY + 6 }
}

function openAccountAvatarMenu(ev: MouseEvent, accountId: string) {
  const acc = store.accountsById[accountId]
  if (acc) {
    openAvatarMenu(ev, acc)
  }
}

function closeAvatarMenu() {
  avatarMenuAccount.value = null
  avatarMenuAnchor.value = null
}

function onMenuDm(acc: VlAccount) {
  if (acc.kind === 'bot') {
    void store.openDmWithBot(acc.id)
  }
}

function onMenuPoke(acc: VlAccount) {
  if (store.activeRoom?.kind === 'group') {
    insertQuickAt(acc.handle)
    showToast(`已 @${acc.handle}`)
  } else if (store.activeRoomId) {
    void store.sendMessage(store.activeRoomId, `👋 戳了戳 ${acc.displayName}`)
  }
}

function onMenuViewProfile(acc: VlAccount) {
  openBotIfBot(acc.id)
}

function onMenuEditProfile(acc: VlAccount) {
  store.openProfileModal(acc.id)
}

function triggerFilePicker() {
  fileMenuOpen.value = false
  fileInputRef.value?.click()
}

function triggerImagePicker() {
  fileMenuOpen.value = false
  imageInputRef.value?.click()
}

function handleVoiceClick() {
  showToast('语音输入：请直接输入文字或上传音频文件')
}

function selectSendMode(mode: VlSendMode) {
  store.sendMode = mode
  modeMenuOpen.value = false
}

function closeHistorySearch() {
  historySearchOpen.value = false
  historySearchQuery.value = ''
}

function handleMemberClick(acc: VlAccount) {
  if (acc.kind !== 'bot') return
  if (store.activeRoom?.kind === 'group') {
    insertQuickAt(acc.handle)
  } else {
    store.openBotHomeDrawer(acc.id)
  }
}

async function handleApprovalRespond(payload: { approvalId: string; decision: 'approved' | 'rejected' }) {
  await store.respondApproval(payload.approvalId, payload.decision)
}

async function handleCheckpointRollback(msg: VlMessage) {
  if (!store.activeRoomId) return
  const res = await store.rollbackCheckpoint(store.activeRoomId, { messageId: msg.id })
  showToast(res.note)
}

let unlistenScreenshot: (() => void) | null = null

onMounted(async () => {
  await store.init()
  myStatusDraft.value = store.me?.statusText ?? ''
  const paramRoom = typeof route.params.roomId === 'string' ? route.params.roomId : ''
  if (paramRoom && store.rooms.some((r) => r.id === paramRoom)) {
    await store.selectRoom(paramRoom)
  }
  scrollToBottom()

  unlistenScreenshot = await listenScreenshotResult(async (file) => {
    if (store.activeRoomId) {
      await store.uploadAndSendFile(store.activeRoomId, file)
      scrollToBottom()
    }
  })
})

watch(
  () => store.activeMessages.length,
  () => {
    scrollToBottom()
  }
)

watch(
  () => store.activeRoomId,
  () => {
    inviteOpen.value = false
    scrollToBottom()
  }
)

onUnmounted(() => {
  unlistenScreenshot?.()
  unlistenScreenshot = null
})
</script>

<style scoped>
.vl-desktop-shell {
  display: flex;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--vl-canvas-bg);
}

.vl-col-rail {
  width: 62px;
  flex-shrink: 0;
  background: var(--vl-rail-bg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  border-right: 1px solid #1a2d29;
}

.vl-col-list {
  width: 264px;
  flex-shrink: 0;
  background: var(--vl-list-bg);
  border-right: 1px solid #2b2b2b;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.vl-list-top {
  padding: 10px 10px 8px;
  border-bottom: 1px solid #272727;
}

.vl-col-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--vl-canvas-bg);
  display: flex;
  flex-direction: column;
}

.vl-main-header {
  height: 52px;
  flex-shrink: 0;
  padding: 0 14px;
  background: var(--vl-header-bg);
  border-bottom: 1px solid #323232;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.vl-col-sidebar {
  width: 236px;
  flex-shrink: 0;
  background: var(--vl-sidebar-bg);
  border-left: 1px solid #202020;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.vl-avatar-btn {
  position: relative;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}

.vl-status-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 11px;
  height: 11px;
  border-radius: 999px;
  border: 2px solid #233b37;
}

.vl-status-dot-sm {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 10px;
  height: 10px;
  border-radius: 999px;
  border: 2px solid #1e1e1e;
}

.vl-status-dot-xs {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  border: 1.5px solid #262626;
}

.vl-rail-item {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  border: 0;
  background: transparent;
  color: var(--vl-rail-text);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s, color 0.15s;
}

.vl-rail-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}

.vl-rail-item.active {
  background: var(--vl-rail-active-bg);
  color: var(--vl-rail-active-text);
}

.vl-rail-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: #c14053;
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}

.vl-win-btn {
  width: 26px;
  height: 24px;
  border-radius: 5px;
  border: 0;
  background: transparent;
  color: #b3b3b3;
  cursor: pointer;
  font-size: 13px;
}

.vl-win-btn:hover {
  background: #363636;
  color: #fff;
}

.vl-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border-radius: 5px;
  border: 0;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;
}

.vl-icon-btn:hover {
  color: #13987f;
  background: rgba(255, 255, 255, 0.06);
}

.vl-icon-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border-radius: 4px;
  border: 0;
  background: transparent;
  color: #7c828a;
  cursor: pointer;
}

.vl-icon-chevron:hover {
  color: #e5e7eb;
}

.vl-msg-action {
  border: 0;
  background: transparent;
  color: #8f959e;
  font-size: 11px;
  cursor: pointer;
  padding: 0 2px;
}

.vl-msg-action:hover {
  color: #5eead4;
}

.vl-input {
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

.vl-input:focus {
  border-color: #13987f;
}
</style>
