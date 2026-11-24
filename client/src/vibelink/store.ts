import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { VibeLinkClient } from './client'
import {
  classifyEndpointKind,
  defaultPriorityForKind,
  loadStoredChannels,
  loadSwitchMode,
  makeChannelId,
  measureChannelSpeed,
  mergeEndpoints,
  parsePairingQrPayload,
  pickBestEndpoint,
  probeEndpointHealth,
  saveStoredChannels,
  saveSwitchMode
} from './channels'
import {
  ensureAndroidTailscaleBridge,
  getAndroidMihomoStatus,
  getDefaultServerUrl,
  getStoredAuthToken,
  getStoredSessionToken,
  isAndroidNativeBridgeAvailable,
  normalizeServerUrl,
  setServerConfig,
  setSessionToken,
  syncAndroidAgentConfig
} from './runtime'
import type {
  VlAccount,
  VlApproval,
  VlAuthUser,
  VlBotFileEntry,
  VlChannelEndpoint,
  VlChannelKind,
  VlChannelSpeedResult,
  VlChannelSwitchMode,
  VlClusterStatus,
  VlClusterSummary,
  VlConnectedDevice,
  VlDeviceCommandResult,
  VlGatewayUpstream,
  VlHealthStatus,
  VlInfraStatus,
  VlInviteCode,
  VlMagpieBridgeInfo,
  VlMessage,
  VlMyWelfarePayload,
  VlPairingInfo,
  VlPluginModelDescriptor,
  VlPluginSummary,
  VlPluginUpdateInfo,
  VlPluginUpdateResult,
  VlPresence,
  VlProviderOption,
  VlRealtimeEvent,
  VlRoomMember,
  VlRoomSummary,
  VlSendMode,
  VlTerminalSession,
  VlUserApiKey,
  VlWelfareGrant,
  VlWProxyStatus
} from './types'

export type VlDesktopNav = 'messages' | 'bots' | 'workspace' | 'account' | 'plugin'
export type VlRoomTab = 'chat' | 'terminal' | 'diff'

export interface EnrichedRoomMember {
  member: VlRoomMember
  account: VlAccount
}

export const useVibeLinkStore = defineStore('vibelink', () => {
  const serverUrl = ref(getDefaultServerUrl())
  const authToken = ref(getStoredAuthToken())
  const sessionToken = ref(getStoredSessionToken())
  const client = new VibeLinkClient(serverUrl.value, authToken.value, sessionToken.value)

  const initialized = ref(false)
  const connecting = ref(false)
  const connected = ref(false)
  const lastError = ref<string | null>(null)
  const mockBots = ref(false)
  const latestSeq = ref(0)

  const authUser = ref<VlAuthUser | null>(null)
  const authMode = ref<'owner_token' | 'loopback_admin' | 'user_session' | null>(null)
  const authRequired = ref(false)
  const clusterSummary = ref<VlClusterSummary | null>(null)
  const standbyMode = ref(false)
  const myWelfare = ref<VlMyWelfarePayload | null>(null)
  const myApiKeys = ref<VlUserApiKey[]>([])
  const adminUsers = ref<VlAuthUser[]>([])
  const adminInvites = ref<VlInviteCode[]>([])
  const adminWelfare = ref<VlWelfareGrant[]>([])
  const adminUpstreams = ref<VlGatewayUpstream[]>([])
  const adminMagpieBridge = ref<VlMagpieBridgeInfo | null>(null)
  const adminClusterStatus = ref<VlClusterStatus | null>(null)

  const me = ref<VlAccount | null>(null)
  const accounts = ref<VlAccount[]>([])
  const rooms = ref<VlRoomSummary[]>([])
  const messagesByRoom = ref<Record<string, VlMessage[]>>({})
  const checkpointsByRoom = ref<Record<string, VlMessage[]>>({})
  const terminalsByRoom = ref<Record<string, VlTerminalSession[]>>({})
  const infraStatus = ref<VlInfraStatus | null>(null)

  const activeNav = ref<VlDesktopNav>('messages')
  const activePluginId = ref<string | null>(null)
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
  const serverSettingsTab = ref<'connection' | 'plugins' | 'devices' | 'account'>('connection')

  const devices = ref<VlConnectedDevice[]>([])
  const devicesLoading = ref(false)

  const plugins = ref<VlPluginSummary[]>([])
  const userPluginsDir = ref('')
  const providerCatalog = ref<VlProviderOption[]>([])
  const modelCatalog = ref<VlPluginModelDescriptor[]>([])
  const pluginsLoading = ref(false)
  const lastPluginSync = ref<{ ok: boolean; message: string } | null>(null)
  const wproxyStatus = ref<VlWProxyStatus | null>(null)
  const wproxyLoading = ref(false)

  const channels = ref<VlChannelEndpoint[]>(loadStoredChannels(serverUrl.value))
  const channelSwitchMode = ref<VlChannelSwitchMode>(loadSwitchMode())
  const pairingInfo = ref<VlPairingInfo | null>(null)
  const channelTesting = ref(false)
  const autoSwitching = ref(false)
  const lastChannelSwitchNotice = ref<string | null>(null)

  let stopEventSocket: (() => void) | null = null
  let failoverTimer: ReturnType<typeof setTimeout> | null = null
  let primaryFailbackTimer: ReturnType<typeof setInterval> | null = null
  let lastFailoverAt = 0
  let networkHooksRegistered = false
  let removeNetworkListeners: (() => void) | null = null

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
      .filter((a) => a.kind === 'bot' && a.visible !== false)
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

  const dockedPlugins = computed(() => {
    return plugins.value
      .filter((p) => p.enabled && p.ui?.dock === 'rail')
      .slice()
      .sort((a, b) => (a.ui?.order ?? 100) - (b.ui?.order ?? 100))
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
      case 'plugins.synced': {
        void bootstrap()
        break
      }
      case 'plugin.updated': {
        void fetchPlugins()
        if (payload.pluginId === 'wproxy') {
          void fetchWProxyStatus()
        }
        break
      }
      default:
        break
    }
  }

  function clearFailoverTimer() {
    if (failoverTimer) {
      clearTimeout(failoverTimer)
      failoverTimer = null
    }
  }

  function scheduleAutoFailover() {
    if (channelSwitchMode.value !== 'auto' || autoSwitching.value) return
    if (channels.value.filter((c) => c.enabled).length <= 1) return
    if (Date.now() - lastFailoverAt < 8000) return
    clearFailoverTimer()
    failoverTimer = setTimeout(() => {
      failoverTimer = null
      if (!connected.value && channelSwitchMode.value === 'auto') {
        void autoSelectBestChannel({ forceReconnect: true })
      }
    }, 1500)
  }

  function registerNetworkHooks() {
    if (networkHooksRegistered || typeof window === 'undefined') return
    networkHooksRegistered = true

    const handleNetworkChange = () => {
      if (channelSwitchMode.value !== 'auto') return
      if (!connected.value) {
        void autoSelectBestChannel({ forceReconnect: true })
        return
      }
      const current = channels.value.find((c) => c.url === serverUrl.value)
      if (current && current.kind !== 'lan') {
        void autoSelectBestChannel({ preferLanOnly: true })
      }
    }

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        handleNetworkChange()
      }
    }

    window.addEventListener('online', handleNetworkChange)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }
    removeNetworkListeners = () => {
      window.removeEventListener('online', handleNetworkChange)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
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
        if (isUp) {
          clearFailoverTimer()
        } else {
          scheduleAutoFailover()
        }
        if (typeof seq === 'number' && seq > latestSeq.value) {
          latestSeq.value = seq
        }
      }
    )
  }

  async function fetchPairingInfo(): Promise<VlPairingInfo | null> {
    try {
      const info = await client.getPairingInfo()
      pairingInfo.value = info
      if (Array.isArray(info.endpoints) && info.endpoints.length > 0) {
        channels.value = mergeEndpoints(
          channels.value,
          info.endpoints.map((ep) => ({
            id: ep.id,
            label: ep.label,
            kind: ep.kind,
            url: ep.url,
            iface: ep.iface,
            serverRole: ep.serverRole,
            nodeId: ep.nodeId,
            priority: ep.priority
          }))
        )
        saveStoredChannels(channels.value)
      }
      return info
    } catch {
      return pairingInfo.value
    }
  }

  async function updatePairingConfig(customExternalUrl: string): Promise<VlPairingInfo> {
    const info = await client.updatePairingConfig({ customExternalUrl })
    pairingInfo.value = info
    channels.value = mergeEndpoints(
      channels.value,
      info.endpoints.map((ep) => ({
        id: ep.id,
        label: ep.label,
        kind: ep.kind,
        url: ep.url,
        iface: ep.iface,
        serverRole: ep.serverRole,
        nodeId: ep.nodeId,
        priority: ep.priority
      }))
    )
    saveStoredChannels(channels.value)
    return info
  }

  function stopPrimaryFailbackWatcher() {
    if (primaryFailbackTimer) {
      clearInterval(primaryFailbackTimer)
      primaryFailbackTimer = null
    }
  }

  function startPrimaryFailbackWatcher() {
    if (primaryFailbackTimer) return
    primaryFailbackTimer = setInterval(() => {
      if (channelSwitchMode.value !== 'auto') return
      const primaryCandidates = channels.value.filter(
        (c) => c.enabled && c.serverRole !== 'standby' && c.url !== serverUrl.value
      )
      if (primaryCandidates.length === 0) return
      void (async () => {
        for (const ep of primaryCandidates) {
          const probe = await probeEndpointHealth(
            ep,
            authToken.value,
            ep.kind === 'tailscale' ? 7500 : 2200
          )
          if (probe.ok) {
            await reconnect(ep.url, authToken.value)
            lastChannelSwitchNotice.value = `主服已恢复，已自动回切至 ${ep.label}`
            break
          }
        }
      })()
    }, 30_000)
  }

  async function bootstrap(): Promise<void> {
    connecting.value = true
    lastError.value = null
    try {
      let meResp: Awaited<ReturnType<VibeLinkClient['authMe']>>
      try {
        meResp = await client.authMe()
      } catch (err) {
        const status = (err as { status?: number })?.status
        if (status === 401) {
          if (sessionToken.value) {
            sessionToken.value = ''
            setSessionToken(null)
            client.setSessionToken(null)
            try {
              meResp = await client.authMe()
            } catch (retryErr) {
              if ((retryErr as { status?: number })?.status === 401) {
                authUser.value = null
                authMode.value = null
                authRequired.value = true
                connected.value = false
                initialized.value = true
                return
              }
              throw retryErr
            }
          } else {
            authUser.value = null
            authMode.value = null
            authRequired.value = true
            connected.value = false
            initialized.value = true
            return
          }
        } else {
          throw err
        }
      }

      authRequired.value = false
      authUser.value = meResp.user
      authMode.value = meResp.authMode
      clusterSummary.value = meResp.cluster

      if (Array.isArray(meResp.nodes) && meResp.nodes.length > 0) {
        channels.value = mergeEndpoints(
          channels.value,
          meResp.nodes.map((n) => ({
            id: n.id,
            label: n.label,
            kind: n.kind,
            url: n.url,
            serverRole: n.serverRole,
            nodeId: n.nodeId,
            priority: n.priority
          }))
        )
        saveStoredChannels(channels.value)
      }

      if (meResp.cluster?.role === 'standby') {
        startPrimaryFailbackWatcher()
      } else {
        stopPrimaryFailbackWatcher()
      }

      if (meResp.user.role !== 'admin') {
        standbyMode.value = meResp.cluster?.role === 'standby'
        me.value = {
          id: meResp.user.id,
          kind: 'human',
          slug: meResp.user.username,
          handle: meResp.user.username,
          displayName: meResp.user.displayName,
          avatar: 'preset:user',
          roleTitle: '用户',
          department: 'VibeLink',
          presence: 'online',
          statusText: '',
          provider: '',
          model: '',
          cwd: '',
          isolationMode: 'shared',
          approvalMode: 'ask',
          description: '',
          pinned: false,
          createdAt: meResp.user.createdAt,
          updatedAt: meResp.user.updatedAt
        }
        accounts.value = [me.value]
        rooms.value = []
        messagesByRoom.value = {}
        activeRoomId.value = null
        if (stopEventSocket) {
          stopEventSocket()
          stopEventSocket = null
        }
        connected.value = true
        initialized.value = true
        activeNav.value = 'account'
        void fetchMyWelfare()
        void fetchMyApiKeys()
        return
      }

      const data = await client.bootstrap()
      if (!Array.isArray(data.accounts) || !Array.isArray(data.rooms)) {
        throw new Error('控制面返回数据结构异常')
      }
      standbyMode.value = Boolean(data.standbyMode || meResp.cluster?.role === 'standby')
      me.value = data.me ?? null
      accounts.value = data.accounts
      rooms.value = data.rooms
      messagesByRoom.value = data.messagesByRoom ?? {}
      latestSeq.value = Number(data.latestSeq ?? 0)
      mockBots.value = Boolean(data.mockBots)

      const nextCheckpoints: Record<string, VlMessage[]> = {}
      for (const [rId, msgs] of Object.entries(messagesByRoom.value)) {
        nextCheckpoints[rId] = msgs.filter((m) => m.msgType === 'bot_diff_checkpoint')
      }
      checkpointsByRoom.value = nextCheckpoints

      if (!activeRoomId.value || !rooms.value.some((r) => r.id === activeRoomId.value)) {
        const firstGroup = sortedRooms.value.find((r) => r.kind === 'group')
        activeRoomId.value = firstGroup?.id ?? sortedRooms.value[0]?.id ?? null
      }

      connected.value = true
      initialized.value = true

      if (!standbyMode.value) {
        startEventStream()
        void fetchPlugins()
        void fetchPluginCatalog()
        void fetchWProxyStatus()
        void fetchPairingInfo()
        void fetchDevices()
        syncNativeAgentBridge()

        if (activeRoomId.value) {
          void client.markRead(activeRoomId.value).catch(() => {})
        }
      } else {
        if (stopEventSocket) {
          stopEventSocket()
          stopEventSocket = null
        }
      }

      void fetchMyWelfare()
      void fetchMyApiKeys()
      void fetchAdminClusterStatus()
    } catch (err) {
      connected.value = false
      lastError.value = err instanceof Error ? err.message : String(err)
      if (!autoSwitching.value) {
        scheduleAutoFailover()
      }
      throw err
    } finally {
      connecting.value = false
    }
  }

  async function init(force = false): Promise<void> {
    registerNetworkHooks()
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
      if (channelSwitchMode.value === 'auto' && channels.value.filter((c) => c.enabled).length > 1) {
        await autoSelectBestChannel({ forceReconnect: true })
      }
    }
  }

  async function reconnect(newUrl: string, newToken: string): Promise<VlHealthStatus> {
    const normalizedUrl = normalizeServerUrl(newUrl)
    const health = await testConnection(normalizedUrl, newToken)
    setServerConfig(normalizedUrl, newToken)
    serverUrl.value = getDefaultServerUrl()
    authToken.value = getStoredAuthToken()
    client.configure(serverUrl.value, authToken.value)
    const kind = classifyEndpointKind(normalizedUrl)
    channels.value = mergeEndpoints(channels.value, [
      {
        label: kind === 'lan' ? '内网通道' : kind === 'tailscale' ? '外网 · Tailscale' : '当前通道',
        kind,
        url: normalizedUrl,
        priority: defaultPriorityForKind(kind)
      }
    ])
    saveStoredChannels(channels.value)
    await bootstrap()
    return health
  }

  async function testConnection(url: string, token: string): Promise<VlHealthStatus> {
    const normalizedUrl = normalizeServerUrl(url)
    const probe = new VibeLinkClient(normalizedUrl, token)
    return probe.health()
  }

  function setChannelSwitchMode(mode: VlChannelSwitchMode) {
    channelSwitchMode.value = mode
    saveSwitchMode(mode)
  }

  function addChannelEndpoint(input: { label?: string; url: string; kind?: VlChannelKind; priority?: number }): VlChannelEndpoint {
    const normalized = normalizeServerUrl(input.url)
    const kind = input.kind ?? classifyEndpointKind(normalized)
    const entry: VlChannelEndpoint = {
      id: makeChannelId(normalized),
      label:
        input.label?.trim() ||
        (kind === 'lan' ? '自定义内网' : kind === 'tailscale' ? 'Tailscale 通道' : '自定义外网'),
      kind,
      url: normalized,
      priority: input.priority ?? defaultPriorityForKind(kind),
      enabled: true,
      lastStatus: 'unknown'
    }
    channels.value = mergeEndpoints(channels.value, [entry])
    saveStoredChannels(channels.value)
    return channels.value.find((c) => c.url === normalized) ?? entry
  }

  function removeChannelEndpoint(id: string) {
    channels.value = channels.value.filter((c) => c.id !== id)
    saveStoredChannels(channels.value)
  }

  async function ensureTailscaleBridgeForEndpoints(targets: VlChannelEndpoint[]): Promise<void> {
    if (!isAndroidNativeBridgeAvailable()) return
    const tsTargets = targets.filter((ep) => ep.kind === 'tailscale')
    if (tsTargets.length === 0) return
    const status = getAndroidMihomoStatus()
    if (!status.ok || !status.data || !status.data.hasConfig) return
    const preferred = tsTargets.find((t) => t.serverRole !== 'standby') ?? tsTargets[0]
    let hostPort = ''
    try {
      const u = new URL(preferred.url)
      hostPort = `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`
    } catch {
      hostPort = ''
    }
    ensureAndroidTailscaleBridge(hostPort)
  }

  async function switchToChannel(endpointId: string, tokenOverride?: string): Promise<VlChannelEndpoint> {
    const target = channels.value.find((c) => c.id === endpointId || c.url === endpointId)
    if (!target) {
      throw new Error('未找到指定通道')
    }
    if (target.kind === 'tailscale') {
      await ensureTailscaleBridgeForEndpoints([target])
    }
    const useToken = tokenOverride !== undefined ? tokenOverride : authToken.value
    const started = Date.now()
    await reconnect(target.url, useToken)
    const rtt = Math.max(1, Date.now() - started)
    channels.value = channels.value.map((c) =>
      c.id === target.id
        ? { ...c, lastStatus: 'ok', lastLatencyMs: c.lastLatencyMs ?? rtt, lastError: null, lastCheckedAt: Date.now() }
        : c
    )
    saveStoredChannels(channels.value)
    lastChannelSwitchNotice.value = `已切换至 ${target.label} (${target.url})`
    return target
  }

  async function autoSelectBestChannel(opts?: {
    forceReconnect?: boolean
    preferLanOnly?: boolean
    tokenOverride?: string
  }): Promise<VlChannelEndpoint | null> {
    if (autoSwitching.value) return null
    const enabled = channels.value.filter((c) => c.enabled && (!opts?.preferLanOnly || c.kind === 'lan'))
    if (enabled.length === 0) return null

    autoSwitching.value = true
    lastFailoverAt = Date.now()
    try {
      const useToken = opts?.tokenOverride !== undefined ? opts.tokenOverride : authToken.value
      const lanEndpoints = enabled.filter((ep) => ep.kind === 'lan')
      const nonLanEndpoints = enabled.filter((ep) => ep.kind !== 'lan')

      const lanResults =
        lanEndpoints.length > 0
          ? await Promise.all(lanEndpoints.map((ep) => probeEndpointHealth(ep, useToken)))
          : []
      const lanBest = pickBestEndpoint(lanResults)

      let nonLanResults: typeof lanResults = []
      if (!lanBest && !opts?.preferLanOnly && nonLanEndpoints.length > 0) {
        await ensureTailscaleBridgeForEndpoints(nonLanEndpoints)
        nonLanResults = await Promise.all(
          nonLanEndpoints.map((ep) => probeEndpointHealth(ep, useToken))
        )
      }

      const results = [...lanResults, ...nonLanResults]
      const resultById = new Map(results.map((r) => [r.endpoint.id, r]))
      channels.value = channels.value.map((c) => {
        const res = resultById.get(c.id)
        if (!res) return c
        return {
          ...c,
          lastStatus: res.ok ? 'ok' : 'error',
          lastLatencyMs: res.ok ? res.latencyMs : null,
          lastError: res.ok ? null : res.error ?? '不可达',
          lastCheckedAt: Date.now()
        }
      })
      saveStoredChannels(channels.value)

      const best = lanBest ?? pickBestEndpoint(results)
      if (!best) return null

      const updatedBest = channels.value.find((c) => c.id === best.endpoint.id) ?? best.endpoint

      if (updatedBest.url === serverUrl.value && connected.value && !opts?.forceReconnect) {
        return updatedBest
      }

      const prevUrl = serverUrl.value
      await reconnect(updatedBest.url, useToken)
      if (prevUrl !== updatedBest.url) {
        lastChannelSwitchNotice.value = `已自动切换至 ${updatedBest.label} (${best.latencyMs ?? '-'}ms)`
      }
      return channels.value.find((c) => c.id === updatedBest.id) ?? updatedBest
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err)
      return null
    } finally {
      autoSwitching.value = false
    }
  }

  async function applyPairingQrPayload(raw: string): Promise<{
    endpoint: VlChannelEndpoint | null
    totalChannels: number
    hostName?: string
  }> {
    const parsed = parsePairingQrPayload(raw)
    channels.value = mergeEndpoints(channels.value, parsed.endpoints)
    saveStoredChannels(channels.value)

    const nextToken = parsed.token ?? authToken.value
    const chosen = await autoSelectBestChannel({
      forceReconnect: true,
      tokenOverride: nextToken
    })

    if (!chosen && parsed.endpoints.length > 0) {
      const first = channels.value.find((c) => c.url === parsed.endpoints[0].url) ?? channels.value[0]
      if (first) {
        await reconnect(first.url, nextToken)
        lastChannelSwitchNotice.value = `已导入 ${parsed.endpoints.length} 条通道并连接 ${first.label}`
        return { endpoint: first, totalChannels: channels.value.length, hostName: parsed.hostName }
      }
    }

    if (!chosen) {
      throw new Error('已识别二维码中的通道，但均无法连通，请检查手机与电脑网络或 Tailscale 状态')
    }

    lastChannelSwitchNotice.value = `扫码配对成功 · ${chosen.label} (${chosen.lastLatencyMs ?? '-'}ms)`
    return {
      endpoint: chosen,
      totalChannels: channels.value.length,
      hostName: parsed.hostName
    }
  }

  async function runChannelSpeed(endpointId: string): Promise<VlChannelSpeedResult> {
    const target = channels.value.find((c) => c.id === endpointId)
    if (!target) {
      throw new Error('未找到目标通道')
    }
    channels.value = channels.value.map((c) =>
      c.id === endpointId ? { ...c, lastStatus: 'testing', lastError: null } : c
    )
    if (target.kind === 'tailscale') {
      await ensureTailscaleBridgeForEndpoints([target])
    }
    const res = await measureChannelSpeed(target, authToken.value)
    channels.value = channels.value.map((c) =>
      c.id === endpointId
        ? {
            ...c,
            lastStatus: res.ok ? 'ok' : 'error',
            lastLatencyMs: res.latencyMs,
            lastJitterMs: res.jitterMs,
            lastDownloadMbps: res.downloadMbps,
            lastUploadMbps: res.uploadMbps,
            lastError: res.error ?? null,
            lastCheckedAt: res.checkedAt
          }
        : c
    )
    saveStoredChannels(channels.value)
    return res
  }

  async function testChannelSpeed(endpointId: string): Promise<VlChannelSpeedResult> {
    channelTesting.value = true
    try {
      return await runChannelSpeed(endpointId)
    } finally {
      channelTesting.value = false
    }
  }

  async function testAllChannelsSpeed(): Promise<VlChannelSpeedResult[]> {
    channelTesting.value = true
    const results: VlChannelSpeedResult[] = []
    try {
      const ids = channels.value.filter((c) => c.enabled).map((c) => c.id)
      for (const id of ids) {
        results.push(await runChannelSpeed(id))
      }
      return results
    } finally {
      channelTesting.value = false
    }
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
    lastPluginSync.value = res.pluginSync ?? null
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

  async function fetchPlugins(): Promise<VlPluginSummary[]> {
    pluginsLoading.value = true
    try {
      const res = await client.listPlugins()
      plugins.value = res.plugins
      userPluginsDir.value = res.userPluginsDir
      return res.plugins
    } catch {
      return plugins.value
    } finally {
      pluginsLoading.value = false
    }
  }

  async function fetchPluginCatalog(): Promise<void> {
    try {
      const res = await client.getPluginCatalog()
      providerCatalog.value = res.providers
      modelCatalog.value = res.models
    } catch {
      // Keep previous catalog on transient failure
    }
  }

  async function syncPlugins(pluginId?: string): Promise<void> {
    pluginsLoading.value = true
    try {
      if (pluginId) {
        await client.syncPlugin(pluginId)
      } else {
        await client.syncAllPlugins()
      }
      await bootstrap()
    } finally {
      pluginsLoading.value = false
    }
  }

  async function togglePlugin(pluginId: string, enabled: boolean): Promise<void> {
    pluginsLoading.value = true
    try {
      await client.togglePlugin(pluginId, enabled)
      if (!enabled && activeNav.value === 'plugin' && activePluginId.value === pluginId) {
        activeNav.value = 'messages'
        activePluginId.value = null
      }
      await bootstrap()
    } finally {
      pluginsLoading.value = false
    }
  }

  async function reloadPlugin(pluginId: string): Promise<void> {
    pluginsLoading.value = true
    try {
      await client.reloadPlugin(pluginId)
      await bootstrap()
    } finally {
      pluginsLoading.value = false
    }
  }

  async function ejectPlugin(pluginId: string): Promise<{ ok: boolean; message: string }> {
    pluginsLoading.value = true
    try {
      const res = await client.ejectPlugin(pluginId)
      await fetchPlugins()
      return { ok: res.ok, message: res.message }
    } finally {
      pluginsLoading.value = false
    }
  }

  async function checkPluginUpdate(pluginId: string): Promise<VlPluginUpdateInfo> {
    const res = await client.checkPluginUpdate(pluginId)
    return res.update
  }

  async function runPluginUpdate(
    pluginId: string,
    options?: { target?: 'host' | 'plugin'; force?: boolean }
  ): Promise<VlPluginUpdateResult> {
    pluginsLoading.value = true
    try {
      const updated = await client.runPluginUpdate(pluginId, options)
      if (updated.result.ok) {
        await bootstrap()
      }
      return updated.result
    } finally {
      pluginsLoading.value = false
    }
  }

  function openPluginView(pluginId: string) {
    activePluginId.value = pluginId
    activeNav.value = 'plugin'
    serverSettingsOpen.value = false
    if (pluginId === 'wproxy') {
      void fetchWProxyStatus()
    }
  }

  function openServerSettings(tab: 'connection' | 'plugins' | 'wproxy' | 'devices' | 'account' = 'connection') {
    if (tab === 'wproxy') {
      openPluginView('wproxy')
      return
    }
    serverSettingsTab.value = tab
    serverSettingsOpen.value = true
  }

  async function invokePluginAction<T = Record<string, unknown>>(
    pluginId: string,
    action: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> {
    return client.invokePluginAction<T>(pluginId, action, payload)
  }

  async function fetchWProxyStatus(): Promise<VlWProxyStatus | null> {
    wproxyLoading.value = true
    try {
      const status = await invokePluginAction<VlWProxyStatus>('wproxy', 'status')
      wproxyStatus.value = status
      return status
    } catch {
      wproxyStatus.value = null
      return null
    } finally {
      wproxyLoading.value = false
    }
  }

  async function selectWProxyNode(node: string, group = 'PROXY'): Promise<VlWProxyStatus> {
    wproxyLoading.value = true
    try {
      const res = await invokePluginAction<{ status: VlWProxyStatus }>('wproxy', 'selectNode', {
        group,
        node
      })
      wproxyStatus.value = res.status
      return res.status
    } finally {
      wproxyLoading.value = false
    }
  }

  async function testWProxyDelay(
    node?: string,
    group = 'PROXY'
  ): Promise<{ delays: Record<string, number | null>; probeUrl: string }> {
    wproxyLoading.value = true
    try {
      const res = await invokePluginAction<{
        delays: Record<string, number | null>
        probeUrl: string
      }>('wproxy', 'testDelay', { group, ...(node ? { node } : {}) })
      if (wproxyStatus.value) {
        wproxyStatus.value = {
          ...wproxyStatus.value,
          nodes: wproxyStatus.value.nodes.map((n) =>
            Object.prototype.hasOwnProperty.call(res.delays, n.name)
              ? { ...n, delay: res.delays[n.name] ?? null }
              : n
          )
        }
      }
      return res
    } finally {
      wproxyLoading.value = false
    }
  }

  async function setWProxyRouteMode(mode: 'rule' | 'global' | 'direct'): Promise<VlWProxyStatus> {
    wproxyLoading.value = true
    try {
      const res = await invokePluginAction<{ status: VlWProxyStatus }>('wproxy', 'setRouteMode', {
        mode
      })
      wproxyStatus.value = res.status
      return res.status
    } finally {
      wproxyLoading.value = false
    }
  }

  async function setWProxySystemProxy(enabled: boolean): Promise<{ output: string; status: VlWProxyStatus }> {
    wproxyLoading.value = true
    try {
      const res = await invokePluginAction<{ output: string; status: VlWProxyStatus }>(
        'wproxy',
        'setSystemProxy',
        { enabled }
      )
      wproxyStatus.value = res.status
      return res
    } finally {
      wproxyLoading.value = false
    }
  }

  async function healWProxyHysteria(): Promise<{ output: string }> {
    wproxyLoading.value = true
    try {
      const res = await invokePluginAction<{ output: string }>('wproxy', 'healHysteria')
      void fetchWProxyStatus()
      return res
    } finally {
      wproxyLoading.value = false
    }
  }

  async function probeWProxyEgress(): Promise<{ ip: string; latencyMs: number }> {
    wproxyLoading.value = true
    try {
      return await invokePluginAction<{ ip: string; latencyMs: number }>('wproxy', 'probeEgress')
    } finally {
      wproxyLoading.value = false
    }
  }

  async function reloadWProxyConfig(): Promise<{ message: string }> {
    wproxyLoading.value = true
    try {
      const res = await invokePluginAction<{ message: string }>('wproxy', 'reloadConfig')
      await fetchWProxyStatus()
      return res
    } finally {
      wproxyLoading.value = false
    }
  }

  async function getWProxyLanShareUri(
    host: string,
    scheme: 'http' | 'socks5' = 'http'
  ): Promise<{ uri: string; host: string; port: number; scheme: string; authRequired: boolean }> {
    return invokePluginAction('wproxy', 'getLanShareUri', { host, scheme })
  }

  function syncNativeAgentBridge(enabled = true) {
    if (!isAndroidNativeBridgeAvailable()) return
    const eps = channels.value.filter((c) => c.enabled).map((c) => c.url)
    syncAndroidAgentConfig({
      enabled,
      token: authToken.value,
      endpoints: eps.length > 0 ? eps : [serverUrl.value],
      activeUrl: serverUrl.value
    })
  }

  async function fetchDevices(): Promise<VlConnectedDevice[]> {
    devicesLoading.value = true
    try {
      const res = await client.listDevices()
      devices.value = res.devices ?? []
      return devices.value
    } catch {
      return devices.value
    } finally {
      devicesLoading.value = false
    }
  }

  async function invokeDeviceCommand(
    deviceId: string,
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = 20000
  ): Promise<VlDeviceCommandResult> {
    const res = await client.invokeDeviceCommand(deviceId, command, params, timeoutMs)
    void fetchDevices()
    return res
  }

  async function syncWProxyToDevice(
    deviceId: string,
    options?: {
      scheme?: 'socks5' | 'http'
      mode?: 'auto' | 'vpn_tun' | 'vpn_http' | 'system_proxy'
      dnsMode?: 'over_tcp' | 'virtual' | 'direct'
      host?: string
    }
  ): Promise<{ ok: true; deviceId: string; proxyUrl: string; host: string; scheme: string }> {
    const res = await client.syncWProxyToDevice(deviceId, options)
    void fetchDevices()
    return res
  }

  async function syncMihomoToDevice(
    deviceId: string,
    options?: {
      yaml?: string
      configName?: string
      tailscaleAuthKey?: string
      hostname?: string
      resetTailscaleState?: boolean
      start?: boolean
    }
  ) {
    const res = await client.syncDeviceMihomo(deviceId, options)
    void fetchDevices()
    return res
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

  async function authLogin(username: string, password: string, deviceLabel = ''): Promise<VlAuthUser> {
    const res = await client.authLogin({ username, password, deviceLabel })
    sessionToken.value = res.sessionToken
    setSessionToken(res.sessionToken)
    client.setSessionToken(res.sessionToken)
    authRequired.value = false
    await bootstrap()
    return res.user
  }

  async function authRegister(input: {
    username: string
    password: string
    displayName?: string
    inviteCode: string
    deviceLabel?: string
  }): Promise<{ user: VlAuthUser; welcomeTokens: number }> {
    const res = await client.authRegister(input)
    sessionToken.value = res.sessionToken
    setSessionToken(res.sessionToken)
    client.setSessionToken(res.sessionToken)
    authRequired.value = false
    await bootstrap()
    return { user: res.user, welcomeTokens: res.welcomeTokens }
  }

  async function authLogout(): Promise<void> {
    try {
      if (sessionToken.value) {
        await client.authLogout()
      }
    } catch {
      // ignore logout transport error
    }
    sessionToken.value = ''
    setSessionToken(null)
    client.setSessionToken(null)
    authUser.value = null
    authMode.value = null
    myWelfare.value = null
    myApiKeys.value = []
    if (stopEventSocket) {
      stopEventSocket()
      stopEventSocket = null
    }
    await bootstrap().catch(() => {
      authRequired.value = true
      connected.value = false
    })
  }

  async function authChangePassword(oldPassword: string, newPassword: string): Promise<void> {
    await client.authChangePassword(oldPassword, newPassword)
  }

  async function fetchMyWelfare(): Promise<VlMyWelfarePayload | null> {
    try {
      const res = await client.getMyWelfare()
      myWelfare.value = res
      authUser.value = res.user
      return res
    } catch {
      return myWelfare.value
    }
  }

  async function redeemWelfare(input: { code?: string; grantId?: string }) {
    const res = await client.redeemWelfare(input)
    await fetchMyWelfare()
    return res
  }

  async function fetchMyApiKeys(): Promise<VlUserApiKey[]> {
    try {
      const res = await client.listMyApiKeys()
      myApiKeys.value = res.keys
      return res.keys
    } catch {
      return myApiKeys.value
    }
  }

  async function createMyApiKey(input: {
    name?: string
    allowedModels?: string[]
    quotaLimit?: number
  }): Promise<VlUserApiKey> {
    const res = await client.createMyApiKey(input)
    await fetchMyApiKeys()
    return res.key
  }

  async function revokeMyApiKey(keyId: string): Promise<void> {
    await client.revokeMyApiKey(keyId)
    await fetchMyApiKeys()
  }

  async function adminFetchUsers(): Promise<VlAuthUser[]> {
    const res = await client.adminListUsers()
    adminUsers.value = res.users
    return res.users
  }

  async function adminCreateUser(input: Parameters<VibeLinkClient['adminCreateUser']>[0]): Promise<VlAuthUser> {
    const res = await client.adminCreateUser(input)
    await adminFetchUsers()
    return res.user
  }

  async function adminUpdateUser(
    userId: string,
    patch: Parameters<VibeLinkClient['adminUpdateUser']>[1]
  ): Promise<VlAuthUser> {
    const res = await client.adminUpdateUser(userId, patch)
    await adminFetchUsers()
    return res.user
  }

  async function adminDeleteUser(userId: string): Promise<void> {
    await client.adminDeleteUser(userId)
    await adminFetchUsers()
  }

  async function adminGrantUser(
    userId: string,
    input: Parameters<VibeLinkClient['adminGrantUser']>[1]
  ) {
    const res = await client.adminGrantUser(userId, input)
    await Promise.all([adminFetchUsers(), adminFetchWelfare(), fetchMyWelfare()])
    return res
  }

  async function adminFetchInvites(): Promise<VlInviteCode[]> {
    const res = await client.adminListInvites()
    adminInvites.value = res.invites
    return res.invites
  }

  async function adminCreateInvite(input: Parameters<VibeLinkClient['adminCreateInvite']>[0]) {
    const res = await client.adminCreateInvite(input)
    await adminFetchInvites()
    return res.invite
  }

  async function adminRevokeInvite(code: string, hard = false): Promise<void> {
    await client.adminRevokeInvite(code, hard)
    await adminFetchInvites()
  }

  async function adminFetchWelfare(): Promise<VlWelfareGrant[]> {
    const res = await client.adminListWelfare()
    adminWelfare.value = res.grants
    return res.grants
  }

  async function adminCreateWelfare(input: Parameters<VibeLinkClient['adminCreateWelfare']>[0]) {
    const res = await client.adminCreateWelfare(input)
    await adminFetchWelfare()
    return res.grant
  }

  async function adminRevokeWelfare(grantId: string, hard = false): Promise<void> {
    await client.adminRevokeWelfare(grantId, hard)
    await adminFetchWelfare()
  }

  async function adminFetchUpstreams(refresh = false): Promise<VlGatewayUpstream[]> {
    const res = await client.adminListUpstreams(refresh)
    adminUpstreams.value = res.upstreams
    if (res.magpieBridge) {
      adminMagpieBridge.value = res.magpieBridge
    }
    return res.upstreams
  }

  async function adminUpdateMagpieBridge(
    input: Parameters<VibeLinkClient['adminUpdateMagpieBridge']>[0]
  ): Promise<VlMagpieBridgeInfo> {
    const res = await client.adminUpdateMagpieBridge(input)
    adminMagpieBridge.value = res.magpieBridge
    await fetchMyWelfare()
    return res.magpieBridge
  }

  async function adminUpsertUpstream(input: Parameters<VibeLinkClient['adminUpsertUpstream']>[0]) {
    const res = await client.adminUpsertUpstream(input)
    await adminFetchUpstreams()
    return res.upstream
  }

  async function adminDeleteUpstream(id: string): Promise<void> {
    await client.adminDeleteUpstream(id)
    await adminFetchUpstreams()
  }

  async function fetchAdminClusterStatus(): Promise<VlClusterStatus | null> {
    try {
      const res = await client.adminGetCluster()
      adminClusterStatus.value = res
      clusterSummary.value = {
        role: res.role,
        nodeId: res.nodeId,
        nodeLabel: res.nodeLabel,
        syncRevision: res.syncRevision,
        standbyDirty: res.standbyDirty
      }
      if (Array.isArray(res.endpoints) && res.endpoints.length > 0) {
        channels.value = mergeEndpoints(
          channels.value,
          res.endpoints.map((ep) => ({
            id: ep.id,
            label: ep.label,
            kind: ep.kind,
            url: ep.url,
            serverRole: ep.serverRole,
            nodeId: ep.nodeId,
            priority: ep.priority
          }))
        )
        saveStoredChannels(channels.value)
      }
      return res
    } catch {
      return adminClusterStatus.value
    }
  }

  async function adminUpdateClusterConfig(
    patch: Parameters<VibeLinkClient['adminUpdateClusterConfig']>[0]
  ): Promise<VlClusterStatus> {
    const res = await client.adminUpdateClusterConfig(patch)
    adminClusterStatus.value = res.status
    return res.status
  }

  async function adminTriggerClusterSync(force = false) {
    const res = await client.adminTriggerClusterSync(force)
    adminClusterStatus.value = res.status
    return res
  }

  function dispose() {
    clearFailoverTimer()
    stopPrimaryFailbackWatcher()
    if (removeNetworkListeners) {
      removeNetworkListeners()
      removeNetworkListeners = null
    }
    networkHooksRegistered = false
    if (stopEventSocket) {
      stopEventSocket()
      stopEventSocket = null
    }
  }

  return {
    client,
    serverUrl,
    authToken,
    sessionToken,
    authUser,
    authMode,
    authRequired,
    clusterSummary,
    standbyMode,
    myWelfare,
    myApiKeys,
    adminUsers,
    adminInvites,
    adminWelfare,
    adminUpstreams,
    adminMagpieBridge,
    adminClusterStatus,
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
    activePluginId,
    activeTab,
    activeRoomId,
    activeRoom,
    activeMessages,
    activeRoomMembers,
    activeRoomBots,
    isActiveRoomBusy,
    dockedPlugins,
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
    serverSettingsTab,
    plugins,
    userPluginsDir,
    providerCatalog,
    modelCatalog,
    pluginsLoading,
    lastPluginSync,
    wproxyStatus,
    wproxyLoading,
    devices,
    devicesLoading,
    channels,
    channelSwitchMode,
    pairingInfo,
    channelTesting,
    autoSwitching,
    lastChannelSwitchNotice,
    init,
    bootstrap,
    reconnect,
    testConnection,
    fetchPairingInfo,
    updatePairingConfig,
    setChannelSwitchMode,
    addChannelEndpoint,
    removeChannelEndpoint,
    switchToChannel,
    autoSelectBestChannel,
    applyPairingQrPayload,
    testChannelSpeed,
    testAllChannelsSpeed,
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
    fetchPlugins,
    fetchPluginCatalog,
    syncPlugins,
    togglePlugin,
    reloadPlugin,
    ejectPlugin,
    checkPluginUpdate,
    runPluginUpdate,
    openPluginView,
    openServerSettings,
    invokePluginAction,
    fetchWProxyStatus,
    selectWProxyNode,
    testWProxyDelay,
    setWProxyRouteMode,
    setWProxySystemProxy,
    healWProxyHysteria,
    probeWProxyEgress,
    reloadWProxyConfig,
    getWProxyLanShareUri,
    syncNativeAgentBridge,
    fetchDevices,
    invokeDeviceCommand,
    syncWProxyToDevice,
    syncMihomoToDevice,
    authLogin,
    authRegister,
    authLogout,
    authChangePassword,
    fetchMyWelfare,
    redeemWelfare,
    fetchMyApiKeys,
    createMyApiKey,
    revokeMyApiKey,
    adminFetchUsers,
    adminCreateUser,
    adminUpdateUser,
    adminDeleteUser,
    adminGrantUser,
    adminFetchInvites,
    adminCreateInvite,
    adminRevokeInvite,
    adminFetchWelfare,
    adminCreateWelfare,
    adminRevokeWelfare,
    adminFetchUpstreams,
    adminUpdateMagpieBridge,
    adminUpsertUpstream,
    adminDeleteUpstream,
    fetchAdminClusterStatus,
    adminUpdateClusterConfig,
    adminTriggerClusterSync,
    openBotHomeDrawer,
    closeBotHomeDrawer,
    openProfileModal,
    closeProfileModal,
    dispose
  }
}, { persist: false })
