import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { VibeLinkClient } from './client'
import { getDefaultServerUrl, getStoredAuthToken, setServerConfig } from './runtime'
import type {
  VlAccount,
  VlApproval,
  VlBotFileEntry,
  VlHealthStatus,
  VlInfraStatus,
  VlMessage,
  VlPresence,
  VlRealtimeEvent,
  VlRoomMember,
  VlRoomSummary,
  VlSendMode,
  VlTerminalSession
} from './types'

export type VlDesktopNav = 'messages' | 'bots' | 'workspace'
export type VlRoomTab = 'chat' | 'terminal' | 'diff'

export interface EnrichedRoomMember {
  member: VlRoomMember
  account: VlAccount
}

export const useVibeLinkStore = defineStore('vibelink', () => {
  const serverUrl = ref(getDefaultServerUrl())
  const authToken = ref(getStoredAuthToken())
  const client = new VibeLinkClient(serverUrl.value, authToken.value)

  const initialized = ref(false)
  const connecting = ref(false)
  const connected = ref(false)
  const lastError = ref<string | null>(null)
  const mockBots = ref(false)
  const latestSeq = ref(0)

  const me = ref<VlAccount | null>(null)
  const accounts = ref<VlAccount[]>([])
  const rooms = ref<VlRoomSummary[]>([])
  const messagesByRoom = ref<Record<string, VlMessage[]>>({})
  const checkpointsByRoom = ref<Record<string, VlMessage[]>>({})
  const terminalsByRoom = ref<Record<string, VlTerminalSession[]>>({})
  const infraStatus = ref<VlInfraStatus | null>(null)

  const activeNav = ref<VlDesktopNav>('messages')
  const activeTab = ref<VlRoomTab>('chat')
  const activeRoomId = ref<string | null>(null)
  const sidebarVisible = ref(true)
  const searchQuery = ref('')
  const sessionFilter = ref<'all' | 'dm' | 'group'>('all')
  const composerDraftByRoom = ref<Record<string, string>>({})
  const replyTargetByRoom = ref<Record<string, VlMessage | null>>({})
  const sendMode = ref<VlSendMode>('auto')
  const botHomeDrawerBotId = ref<string | null>(null)
  const profileModalAccountId = ref<string | null>(null)
  const serverSettingsOpen = ref(false)

  let stopEventSocket: (() => void) | null = null

  const accountsById = computed<Record<string, VlAccount>>(() => {
    const map: Record<string, VlAccount> = {}
    if (me.value) {
      map[me.value.id] = me.value
    }
    for (const acc of accounts.value) {
      map[acc.id] = acc
    }
    return map
  })

  const bots = computed<VlAccount[]>(() => {
    return accounts.value
      .filter((a) => a.kind === 'bot')
      .slice()
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.displayName.localeCompare(b.displayName, 'zh-CN'))
  })

  const sortedRooms = computed<VlRoomSummary[]>(() => {
    return rooms.value.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const aTime = a.lastMessage?.createdAt ?? a.updatedAt ?? a.createdAt
      const bTime = b.lastMessage?.createdAt ?? b.updatedAt ?? b.createdAt
      return bTime - aTime
    })
  })

  const activeRoom = computed<VlRoomSummary | null>(() => {
    if (!activeRoomId.value) return null
    return rooms.value.find((r) => r.id === activeRoomId.value) ?? null
  })

  const activeMessages = computed<VlMessage[]>(() => {
    if (!activeRoomId.value) return []
    return messagesByRoom.value[activeRoomId.value] ?? []
  })

  const activeRoomMembers = computed<EnrichedRoomMember[]>(() => {
    const room = activeRoom.value
    if (!room) return []
    const roleRank: Record<string, number> = { owner: 0, admin: 1, member: 2 }
    const presenceRank: Record<string, number> = { working: 0, online: 1, idle: 2, error: 3, offline: 4 }
    const items: EnrichedRoomMember[] = []
    for (const member of room.members) {
      const account = accountsById.value[member.accountId]
      if (!account) continue
      items.push({ member, account })
    }
    return items.sort((a, b) => {
      const rr = (roleRank[a.member.role] ?? 9) - (roleRank[b.member.role] ?? 9)
      if (rr !== 0) return rr
      const pr = (presenceRank[a.account.presence] ?? 9) - (presenceRank[b.account.presence] ?? 9)
      if (pr !== 0) return pr
      return a.account.displayName.localeCompare(b.account.displayName, 'zh-CN')
    })
  })

  const activeRoomBots = computed<VlAccount[]>(() => {
    return activeRoomMembers.value.filter((item) => item.account.kind === 'bot').map((item) => item.account)
  })

  const isActiveRoomBusy = computed<boolean>(() => {
    return activeRoomBots.value.some((bot) => bot.presence === 'working')
  })

  const totalUnreadCount = computed<number>(() => {
    return rooms.value.reduce((sum, room) => sum + (room.muted ? 0 : room.unreadCount || 0), 0)
  })

  function upsertAccount(account: VlAccount) {
    if (account.id === 'me') {
      me.value = account
    }
    const idx = accounts.value.findIndex((a) => a.id === account.id)
    if (idx >= 0) {
      accounts.value[idx] = account
    } else {
      accounts.value.push(account)
    }
  }

  function upsertRoomSummary(room: VlRoomSummary) {
    const idx = rooms.value.findIndex((r) => r.id === room.id)
    if (idx >= 0) {
      rooms.value[idx] = room
    } else {
      rooms.value.push(room)
    }
    if (!activeRoomId.value) {
      activeRoomId.value = room.id
    }
  }

  function upsertMessage(msg: VlMessage, options?: { incrementUnread?: boolean }) {
    const list = messagesByRoom.value[msg.roomId] ?? []
    const idx = list.findIndex((m) => m.id === msg.id)
    const existed = idx >= 0
    if (existed) {
      list[idx] = msg
      messagesByRoom.value[msg.roomId] = list.slice()
    } else {
      const next = [...list, msg].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      messagesByRoom.value[msg.roomId] = next
    }

    const roomIdx = rooms.value.findIndex((r) => r.id === msg.roomId)
    if (roomIdx >= 0) {
      const targetRoom = rooms.value[roomIdx]
      const currentLast = targetRoom.lastMessage
      const isNewer = !currentLast || msg.createdAt >= currentLast.createdAt
      const shouldInc =
        Boolean(options?.incrementUnread) &&
        !existed &&
        msg.roomId !== activeRoomId.value &&
        msg.senderId !== 'me'
      rooms.value[roomIdx] = {
        ...targetRoom,
        lastMessage: isNewer || currentLast?.id === msg.id ? msg : currentLast,
        updatedAt: Math.max(targetRoom.updatedAt, msg.updatedAt),
        unreadCount: shouldInc ? (targetRoom.unreadCount || 0) + 1 : targetRoom.unreadCount
      }
    }

    if (msg.msgType === 'bot_diff_checkpoint') {
      const cpList = checkpointsByRoom.value[msg.roomId] ?? []
      const cpIdx = cpList.findIndex((c) => c.id === msg.id)
      if (cpIdx >= 0) {
        cpList[cpIdx] = msg
        checkpointsByRoom.value[msg.roomId] = cpList.slice()
      } else {
        checkpointsByRoom.value[msg.roomId] = [...cpList, msg].sort((a, b) => a.createdAt - b.createdAt)
      }
    }
  }

  function handleRealtimeEvent(event: VlRealtimeEvent) {
    if (event.seq > latestSeq.value) {
      latestSeq.value = event.seq
    }
    const payload = event.payload

    switch (event.eventType) {
      case 'account.updated': {
        const account = payload.account as VlAccount | undefined
        if (account) upsertAccount(account)
        break
      }
      case 'room.created':
      case 'room.updated': {
        const room = payload.room as VlRoomSummary | undefined
        if (room) upsertRoomSummary(room)
        break
      }
      case 'room.read': {
        const roomId = typeof payload.roomId === 'string' ? payload.roomId : event.roomId
        if (roomId) {
          const idx = rooms.value.findIndex((r) => r.id === roomId)
          if (idx >= 0) {
            rooms.value[idx] = { ...rooms.value[idx], unreadCount: 0 }
          }
        }
        break
      }
      case 'message.created': {
        const msg = payload.message as VlMessage | undefined
        if (msg) {
          upsertMessage(msg, { incrementUnread: true })
          if (msg.roomId === activeRoomId.value && msg.senderId !== 'me') {
            void client.markRead(msg.roomId, msg.id).catch(() => {})
          }
        }
        break
      }
      case 'message.updated':
      case 'message.recalled': {
        const msg = payload.message as VlMessage | undefined
        if (msg) upsertMessage(msg)
        break
      }
      case 'approval.resolved': {
        const approval = payload.approval as VlApproval | undefined
        if (approval) {
          const msgs = messagesByRoom.value[approval.roomId] ?? []
          const target = msgs.find((m) => m.id === approval.messageId)
          if (target) {
            upsertMessage({
              ...target,
              metadata: {
                ...target.metadata,
                approvalId: approval.id,
                status: approval.status,
                decision: approval.decision
              }
            })
          }
        }
        break
      }
      case 'terminal.opened': {
        const session = payload.session as VlTerminalSession | undefined
        if (session?.roomId) {
          const prev = terminalsByRoom.value[session.roomId] ?? []
          if (!prev.some((s) => s.sessionId === session.sessionId)) {
            terminalsByRoom.value[session.roomId] = [...prev, session]
          }
        }
        break
      }
      case 'terminal.closed': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
        if (sessionId) {
          for (const [rId, list] of Object.entries(terminalsByRoom.value)) {
            if (list.some((s) => s.sessionId === sessionId)) {
              terminalsByRoom.value[rId] = list.filter((s) => s.sessionId !== sessionId)
            }
          }
        }
        break
      }
      default:
        break
    }
  }

  function startEventStream() {
    if (stopEventSocket) {
      stopEventSocket()
      stopEventSocket = null
    }
    stopEventSocket = client.connectEvents(
      () => latestSeq.value,
      handleRealtimeEvent,
      (isUp, seq) => {
        connected.value = isUp
        if (typeof seq === 'number' && seq > latestSeq.value) {
          latestSeq.value = seq
        }
      }
    )
  }

  async function bootstrap(): Promise<void> {
    connecting.value = true
    lastError.value = null
    try {
      const data = await client.bootstrap()
      me.value = data.me
      accounts.value = data.accounts
      rooms.value = data.rooms
      messagesByRoom.value = data.messagesByRoom
      latestSeq.value = data.latestSeq
      mockBots.value = data.mockBots

      const nextCheckpoints: Record<string, VlMessage[]> = {}
      for (const [rId, msgs] of Object.entries(data.messagesByRoom)) {
        nextCheckpoints[rId] = msgs.filter((m) => m.msgType === 'bot_diff_checkpoint')
      }
      checkpointsByRoom.value = nextCheckpoints

      if (!activeRoomId.value || !rooms.value.some((r) => r.id === activeRoomId.value)) {
        const firstGroup = sortedRooms.value.find((r) => r.kind === 'group')
        activeRoomId.value = firstGroup?.id ?? sortedRooms.value[0]?.id ?? null
      }

      connected.value = true
      initialized.value = true
      startEventStream()

      if (activeRoomId.value) {
        void client.markRead(activeRoomId.value).catch(() => {})
      }
    } catch (err) {
      connected.value = false
      lastError.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      connecting.value = false
    }
  }

  async function init(force = false): Promise<void> {
    try {
      localStorage.removeItem('vibelink')
    } catch {
      // ignore storage access errors
    }
    if (initialized.value && !force) {
      if (!stopEventSocket) {
        startEventStream()
      }
      return
    }
    try {
      await bootstrap()
    } catch {
      // keep UI usable with error banner + server settings modal access
    }
  }

  async function reconnect(newUrl: string, newToken: string): Promise<VlHealthStatus> {
    setServerConfig(newUrl, newToken)
    serverUrl.value = getDefaultServerUrl()
    authToken.value = getStoredAuthToken()
    client.configure(serverUrl.value, authToken.value)
    const health = await client.health()
    await bootstrap()
    return health
  }

  async function testConnection(url: string, token: string): Promise<VlHealthStatus> {
    const probe = new VibeLinkClient(url, token)
    return probe.health()
  }

  async function selectRoom(roomId: string): Promise<void> {
    activeRoomId.value = roomId
    if (!messagesByRoom.value[roomId]) {
      try {
        const res = await client.getMessages(roomId)
        messagesByRoom.value[roomId] = res.messages
      } catch (err) {
        console.warn('[vibelink] load room messages failed:', err)
      }
    }
    const idx = rooms.value.findIndex((r) => r.id === roomId)
    if (idx >= 0 && rooms.value[idx].unreadCount > 0) {
      rooms.value[idx] = { ...rooms.value[idx], unreadCount: 0 }
    }
    void client.markRead(roomId).catch(() => {})
  }

  async function sendMessage(
    roomId: string,
    content: string,
    opts?: {
      replyToId?: string | null
      targetBotId?: string | null
      metadata?: Record<string, unknown>
      mode?: VlSendMode
    }
  ): Promise<VlMessage> {
    const res = await client.sendMessage(roomId, {
      content,
      replyToId: opts?.replyToId ?? replyTargetByRoom.value[roomId]?.id ?? null,
      targetBotId: opts?.targetBotId ?? null,
      metadata: opts?.metadata ?? {},
      mode: opts?.mode ?? sendMode.value
    })
    upsertMessage(res.message)
    replyTargetByRoom.value[roomId] = null
    return res.message
  }

  async function recallMessage(roomId: string, msgId: string): Promise<void> {
    const res = await client.recallMessage(roomId, msgId)
    upsertMessage(res.message)
  }

  async function interruptActiveRoom(): Promise<number> {
    if (!activeRoomId.value) return 0
    const res = await client.interruptRoom(activeRoomId.value)
    return res.interrupted
  }

  async function updateMeStatus(patch: {
    displayName?: string
    statusText?: string
    presence?: VlPresence
    avatar?: string
  }): Promise<void> {
    const res = await client.updateMe(patch)
    upsertAccount(res.account)
  }

  async function updateRoomNotice(roomId: string, notice: string): Promise<void> {
    const res = await client.updateRoom(roomId, { notice })
    const idx = rooms.value.findIndex((r) => r.id === roomId)
    if (idx >= 0) {
      rooms.value[idx] = { ...rooms.value[idx], ...res.room }
    }
  }

  async function updateRoomSettings(
    roomId: string,
    patch: { name?: string; notice?: string; muted?: boolean; pinned?: boolean; cwd?: string }
  ): Promise<void> {
    const res = await client.updateRoom(roomId, patch)
    const idx = rooms.value.findIndex((r) => r.id === roomId)
    if (idx >= 0) {
      rooms.value[idx] = { ...rooms.value[idx], ...res.room }
    }
  }

  async function addBotToGroup(roomId: string, accountId: string): Promise<void> {
    const res = await client.addRoomMember(roomId, accountId, 'member')
    upsertRoomSummary(res.room)
  }

  async function removeMemberFromGroup(roomId: string, accountId: string): Promise<void> {
    const res = await client.removeRoomMember(roomId, accountId)
    if (res.room) {
      upsertRoomSummary(res.room)
    }
  }

  async function createBot(input: {
    displayName: string
    handle?: string
    provider?: string
    model?: string
    cwd?: string
    roleTitle?: string
    department?: string
    description?: string
    soulMarkdown?: string
  }): Promise<{ bot: VlAccount; dmRoom: VlRoomSummary }> {
    const res = await client.createBot(input)
    upsertAccount(res.bot)
    upsertRoomSummary(res.dmRoom)
    activeRoomId.value = res.dmRoom.id
    activeNav.value = 'messages'
    activeTab.value = 'chat'
    return res
  }

  async function createGroup(input: {
    name: string
    notice?: string
    cwd?: string
    botIds: string[]
  }): Promise<VlRoomSummary> {
    const res = await client.createRoom({
      kind: 'group',
      name: input.name,
      notice: input.notice ?? '',
      cwd: input.cwd,
      botIds: input.botIds
    })
    upsertRoomSummary(res.room)
    activeRoomId.value = res.room.id
    activeNav.value = 'messages'
    activeTab.value = 'chat'
    return res.room
  }

  async function openDmWithBot(botId: string): Promise<VlRoomSummary> {
    const dmId = `dm_${botId}`
    const existing = rooms.value.find((r) => r.id === dmId)
    if (existing) {
      await selectRoom(existing.id)
      activeNav.value = 'messages'
      activeTab.value = 'chat'
      return existing
    }
    const res = await client.createRoom({ kind: 'dm', memberIds: [botId] })
    upsertRoomSummary(res.room)
    await selectRoom(res.room.id)
    activeNav.value = 'messages'
    activeTab.value = 'chat'
    return res.room
  }

  async function updateBotProfile(
    botId: string,
    patch: Parameters<VibeLinkClient['updateBot']>[1]
  ): Promise<VlAccount> {
    const res = await client.updateBot(botId, patch)
    upsertAccount(res.bot)
    return res.bot
  }

  async function listBotFiles(botId: string): Promise<VlBotFileEntry[]> {
    const res = await client.listBotFiles(botId)
    return res.files
  }

  async function readBotFile(botId: string, path: string): Promise<string> {
    const res = await client.readBotFile(botId, path)
    return res.content
  }

  async function writeBotFile(botId: string, path: string, content: string): Promise<void> {
    await client.writeBotFile(botId, path, content)
  }

  async function tidyBotMemory(botId: string): Promise<Record<string, unknown>> {
    return client.tidyBotMemory(botId)
  }

  async function respondApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    feedback?: string
  ): Promise<void> {
    const res = await client.respondApproval(approvalId, decision, feedback)
    const approval = res.approval
    const msgs = messagesByRoom.value[approval.roomId] ?? []
    const target = msgs.find((m) => m.id === approval.messageId)
    if (target) {
      upsertMessage({
        ...target,
        metadata: {
          ...target.metadata,
          approvalId: approval.id,
          status: approval.status,
          decision: approval.decision
        }
      })
    }
  }

  async function loadCheckpoints(roomId: string): Promise<VlMessage[]> {
    const res = await client.listCheckpoints(roomId)
    checkpointsByRoom.value[roomId] = res.checkpoints
    return res.checkpoints
  }

  async function rollbackCheckpoint(
    roomId: string,
    input: { messageId?: string; checkpointId?: string; scopeId?: string; threadId?: string }
  ): Promise<{ ok: boolean; note: string }> {
    return client.rollbackCheckpoint(roomId, input)
  }

  async function ensureRoomTerminal(roomId: string, botId?: string | null): Promise<VlTerminalSession> {
    const existingList = await client.listTerminals(roomId)
    terminalsByRoom.value[roomId] = existingList.sessions
    if (existingList.sessions.length > 0) {
      return existingList.sessions[0]
    }
    const opened = await client.openTerminal({
      roomId,
      botId: botId ?? null,
      cwd: activeRoom.value?.cwd ?? null
    })
    terminalsByRoom.value[roomId] = [opened.session]
    return opened.session
  }

  async function openNewRoomTerminal(roomId: string, botId?: string | null): Promise<VlTerminalSession> {
    const opened = await client.openTerminal({
      roomId,
      botId: botId ?? null,
      cwd: activeRoom.value?.cwd ?? null
    })
    const prev = terminalsByRoom.value[roomId] ?? []
    terminalsByRoom.value[roomId] = [...prev, opened.session]
    return opened.session
  }

  async function closeTerminal(roomId: string | null, sessionId: string): Promise<void> {
    await client.closeTerminal(sessionId)
    if (roomId) {
      terminalsByRoom.value[roomId] = (terminalsByRoom.value[roomId] ?? []).filter(
        (s) => s.sessionId !== sessionId
      )
    }
  }

  async function uploadAndSendFile(roomId: string, file: File): Promise<void> {
    const res = await client.uploadAttachment(roomId, file)
    const isImage = file.type.startsWith('image/')
    const fullUrl = client.resolveUrl(res.url)
    const markdown = isImage
      ? `![${res.attachment.filename}](${fullUrl})`
      : `📎 附件：[${res.attachment.filename}](${fullUrl}) (${Math.max(1, Math.round(res.attachment.sizeBytes / 1024))} KB)`
    await sendMessage(roomId, markdown, {
      metadata: {
        attachmentId: res.attachment.id,
        attachmentUrl: fullUrl,
        filename: res.attachment.filename,
        mimeType: res.attachment.mimeType
      }
    })
  }

  async function uploadAvatar(file: File): Promise<{ id: string; url: string }> {
    return client.uploadAvatar(file)
  }

  async function fetchInfraStatus(): Promise<VlInfraStatus | null> {
    try {
      infraStatus.value = await client.getInfraStatus()
      return infraStatus.value
    } catch {
      return null
    }
  }

  function openBotHomeDrawer(botId: string) {
    botHomeDrawerBotId.value = botId
  }

  function closeBotHomeDrawer() {
    botHomeDrawerBotId.value = null
  }

  function openProfileModal(accountId: string) {
    profileModalAccountId.value = accountId
  }

  function closeProfileModal() {
    profileModalAccountId.value = null
  }

  function dispose() {
    if (stopEventSocket) {
      stopEventSocket()
      stopEventSocket = null
    }
  }

  return {
    client,
    serverUrl,
    authToken,
    initialized,
    connecting,
    connected,
    lastError,
    mockBots,
    latestSeq,
    me,
    accounts,
    accountsById,
    bots,
    rooms,
    sortedRooms,
    messagesByRoom,
    checkpointsByRoom,
    terminalsByRoom,
    infraStatus,
    activeNav,
    activeTab,
    activeRoomId,
    activeRoom,
    activeMessages,
    activeRoomMembers,
    activeRoomBots,
    isActiveRoomBusy,
    totalUnreadCount,
    sidebarVisible,
    searchQuery,
    sessionFilter,
    composerDraftByRoom,
    replyTargetByRoom,
    sendMode,
    botHomeDrawerBotId,
    profileModalAccountId,
    serverSettingsOpen,
    init,
    bootstrap,
    reconnect,
    testConnection,
    selectRoom,
    sendMessage,
    recallMessage,
    interruptActiveRoom,
    updateMeStatus,
    updateRoomNotice,
    updateRoomSettings,
    addBotToGroup,
    removeMemberFromGroup,
    createBot,
    createGroup,
    openDmWithBot,
    updateBotProfile,
    listBotFiles,
    readBotFile,
    writeBotFile,
    tidyBotMemory,
    respondApproval,
    loadCheckpoints,
    rollbackCheckpoint,
    ensureRoomTerminal,
    openNewRoomTerminal,
    closeTerminal,
    uploadAndSendFile,
    uploadAvatar,
    fetchInfraStatus,
    openBotHomeDrawer,
    closeBotHomeDrawer,
    openProfileModal,
    closeProfileModal,
    dispose
  }
}, { persist: false })
