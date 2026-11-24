import { getDefaultServerUrl, getStoredAuthToken, getStoredSessionToken, normalizeServerUrl } from './runtime'
import type {
  VlAccount,
  VlApproval,
  VlAttachment,
  VlAuthMeResponse,
  VlAuthUser,
  VlBootstrapPayload,
  VlBotFileEntry,
  VlClusterNodeEndpoint,
  VlClusterStatus,
  VlClusterSummary,
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
  VlQuotaPool,
  VlRealtimeEvent,
  VlRoom,
  VlRoomKind,
  VlRoomSummary,
  VlSendMode,
  VlTerminalSession,
  VlUserApiKey,
  VlWelfareGrant,
  VlWelfareKind
} from './types'

export class VibeLinkHttpError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface TerminalWsHandlers {
  onAttached?: (session: VlTerminalSession | null) => void
  onSnapshot?: (snapshot: { snapshot?: string }) => void
  onOutput?: (data: string) => void
  onExited?: (info: unknown) => void
  onClosed?: () => void
  onCleared?: () => void
  onError?: (err: string) => void
  onStateChange?: (connected: boolean) => void
}

export class VibeLinkClient {
  private baseUrl: string
  private authToken: string
  private sessionToken: string

  constructor(
    baseUrl = getDefaultServerUrl(),
    authToken = getStoredAuthToken(),
    sessionToken = getStoredSessionToken()
  ) {
    this.baseUrl = this.sanitizeBaseUrl(baseUrl)
    this.authToken = authToken.trim()
    this.sessionToken = sessionToken.trim()
  }

  private effectiveToken(): string {
    return this.sessionToken || this.authToken
  }

  private sanitizeBaseUrl(raw: string): string {
    try {
      return normalizeServerUrl(raw)
    } catch {
      return raw.trim().replace(/\/+$/, '')
    }
  }

  getServerUrl(): string {
    return this.baseUrl
  }

  getAuthToken(): string {
    return this.authToken
  }

  getSessionToken(): string {
    return this.sessionToken
  }

  configure(baseUrl: string, authToken: string, sessionToken?: string): void {
    this.baseUrl = this.sanitizeBaseUrl(baseUrl)
    this.authToken = authToken.trim()
    if (sessionToken !== undefined) {
      this.sessionToken = sessionToken.trim()
    }
  }

  setSessionToken(sessionToken: string | null): void {
    this.sessionToken = (sessionToken ?? '').trim()
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path
    const suffix = path.startsWith('/') ? path : `/${path}`
    return `${this.baseUrl}${suffix}`
  }

  resolveWsUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const httpUrl = new URL(this.resolveUrl(path))
    httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && String(v).length > 0) {
          httpUrl.searchParams.set(k, String(v))
        }
      }
    }
    const tok = this.effectiveToken()
    if (tok) {
      httpUrl.searchParams.set('token', tok)
    }
    return httpUrl.toString()
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {}
    const tok = this.effectiveToken()
    if (tok) {
      headers.Authorization = `Bearer ${tok}`
      headers['X-VibeLink-Token'] = tok
    }
    let bodyStr: string | undefined
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      bodyStr = JSON.stringify(body)
    }

    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new VibeLinkHttpError(400, '请输入有效的 http:// 或 https:// 服务器地址')
    }

    const res = await fetch(this.resolveUrl(path), {
      method,
      headers,
      body: bodyStr
    })

    const text = await res.text()
    let parsed: Record<string, unknown> | null = null
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>
      } catch {
        parsed = null
      }
    }

    if (!res.ok) {
      const msg =
        (parsed && typeof parsed.message === 'string' && parsed.message) ||
        (parsed && typeof parsed.error === 'string' && parsed.error) ||
        `HTTP ${res.status}`
      const code = parsed && typeof parsed.error === 'string' ? parsed.error : undefined
      throw new VibeLinkHttpError(res.status, msg, code)
    }

    if (text.trim().length > 0 && parsed === null) {
      throw new VibeLinkHttpError(res.status, '服务端未返回有效的 VibeLink JSON 接口，请检查地址与端口')
    }

    return (parsed ?? {}) as T
  }

  async health(): Promise<VlHealthStatus> {
    const res = await this.request<VlHealthStatus>('GET', '/api/vl/health')
    if (!res || res.ok !== true || res.service !== 'vibelink') {
      throw new VibeLinkHttpError(502, '目标地址不是有效的 VibeLink 控制面服务')
    }
    return res
  }

  async bootstrap(): Promise<VlBootstrapPayload> {
    const res = await this.request<VlBootstrapPayload>('GET', '/api/vl/bootstrap')
    if (!res || !Array.isArray(res.accounts) || !Array.isArray(res.rooms)) {
      throw new VibeLinkHttpError(502, '控制面 bootstrap 数据格式异常')
    }
    return res
  }

  getPairingInfo(): Promise<VlPairingInfo> {
    return this.request('GET', '/api/vl/pairing/info')
  }

  updatePairingConfig(patch: { customExternalUrl?: string }): Promise<VlPairingInfo> {
    return this.request('POST', '/api/vl/pairing/config', patch)
  }

  listAccounts(): Promise<{ accounts: VlAccount[] }> {
    return this.request('GET', '/api/vl/accounts')
  }

  updateMe(patch: {
    displayName?: string
    statusText?: string
    presence?: VlPresence
    avatar?: string
  }): Promise<{ account: VlAccount }> {
    return this.request('PATCH', '/api/vl/accounts/me', patch)
  }

  listRooms(): Promise<{ rooms: VlRoomSummary[] }> {
    return this.request('GET', '/api/vl/rooms')
  }

  createRoom(input: {
    kind: VlRoomKind
    name?: string
    notice?: string
    cwd?: string
    memberIds?: string[]
    botIds?: string[]
  }): Promise<{ room: VlRoomSummary }> {
    return this.request('POST', '/api/vl/rooms', input)
  }

  updateRoom(
    roomId: string,
    patch: { name?: string; notice?: string; muted?: boolean; pinned?: boolean; cwd?: string }
  ): Promise<{ room: VlRoom }> {
    return this.request('PATCH', `/api/vl/rooms/${encodeURIComponent(roomId)}`, patch)
  }

  addRoomMember(roomId: string, accountId: string, role: 'member' | 'admin' | 'owner' = 'member'): Promise<{ room: VlRoomSummary }> {
    return this.request('POST', `/api/vl/rooms/${encodeURIComponent(roomId)}/members`, { accountId, role })
  }

  removeRoomMember(roomId: string, accountId: string): Promise<{ room: VlRoomSummary }> {
    return this.request(
      'DELETE',
      `/api/vl/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(accountId)}`
    )
  }

  getMessages(roomId: string, limit = 150, before?: number): Promise<{ messages: VlMessage[] }> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (before !== undefined) params.set('before', String(before))
    return this.request('GET', `/api/vl/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`)
  }

  sendMessage(
    roomId: string,
    input: {
      content: string
      msgType?: 'text' | 'system' | 'bot_markdown'
      replyToId?: string | null
      targetBotId?: string | null
      metadata?: Record<string, unknown>
      mode?: VlSendMode
    }
  ): Promise<{ message: VlMessage; triggeredBotIds: string[] }> {
    return this.request('POST', `/api/vl/rooms/${encodeURIComponent(roomId)}/messages`, input)
  }

  recallMessage(roomId: string, msgId: string): Promise<{ message: VlMessage }> {
    return this.request(
      'POST',
      `/api/vl/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(msgId)}/recall`
    )
  }

  markRead(roomId: string, lastReadMsgId?: string | null): Promise<{ lastReadAt: number; room: VlRoomSummary }> {
    return this.request('POST', `/api/vl/rooms/${encodeURIComponent(roomId)}/read`, {
      lastReadMsgId: lastReadMsgId ?? null
    })
  }

  interruptRoom(roomId: string): Promise<{ interrupted: number }> {
    return this.request('POST', `/api/vl/rooms/${encodeURIComponent(roomId)}/interrupt`)
  }

  listBots(): Promise<{ bots: VlAccount[] }> {
    return this.request('GET', '/api/vl/bots')
  }

  createBot(input: {
    displayName: string
    handle?: string
    slug?: string
    provider?: string
    model?: string
    cwd?: string
    roleTitle?: string
    department?: string
    description?: string
    approvalMode?: string
    soulMarkdown?: string
  }): Promise<{ bot: VlAccount; dmRoom: VlRoomSummary }> {
    return this.request('POST', '/api/vl/bots', input)
  }

  updateBot(
    botId: string,
    patch: {
      displayName?: string
      handle?: string
      avatar?: string
      roleTitle?: string
      department?: string
      provider?: string
      model?: string
      cwd?: string
      isolationMode?: string
      approvalMode?: string
      description?: string
      statusText?: string
      pinned?: boolean
      syncToPlugin?: boolean
    }
  ): Promise<{ bot: VlAccount; pluginSync?: { ok: boolean; message: string } }> {
    return this.request('PATCH', `/api/vl/bots/${encodeURIComponent(botId)}`, patch)
  }

  listBotFiles(botId: string): Promise<{ slug: string; files: VlBotFileEntry[] }> {
    return this.request('GET', `/api/vl/bots/${encodeURIComponent(botId)}/files`)
  }

  readBotFile(botId: string, relPath: string): Promise<{ slug: string; path: string; content: string }> {
    const encodedPath = relPath
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')
    return this.request('GET', `/api/vl/bots/${encodeURIComponent(botId)}/files/${encodedPath}`)
  }

  writeBotFile(
    botId: string,
    relPath: string,
    content: string
  ): Promise<{ path: string; sizeBytes: number }> {
    const encodedPath = relPath
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')
    return this.request('PUT', `/api/vl/bots/${encodeURIComponent(botId)}/files/${encodedPath}`, { content })
  }

  tidyBotMemory(botId: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/vl/bots/${encodeURIComponent(botId)}/memory/tidy`)
  }

  respondApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    feedback?: string
  ): Promise<{ approval: VlApproval }> {
    return this.request('POST', `/api/vl/approvals/${encodeURIComponent(approvalId)}/respond`, {
      decision,
      feedback
    })
  }

  listCheckpoints(roomId: string): Promise<{ checkpoints: VlMessage[] }> {
    return this.request('GET', `/api/vl/checkpoints/${encodeURIComponent(roomId)}`)
  }

  rollbackCheckpoint(
    roomId: string,
    input: { messageId?: string; checkpointId?: string; scopeId?: string; threadId?: string }
  ): Promise<{ ok: boolean; note: string }> {
    return this.request('POST', `/api/vl/checkpoints/${encodeURIComponent(roomId)}/rollback`, input)
  }

  listTerminals(roomId?: string | null): Promise<{ sessions: VlTerminalSession[] }> {
    const q = roomId ? `?roomId=${encodeURIComponent(roomId)}` : ''
    return this.request('GET', `/api/vl/terminals${q}`)
  }

  openTerminal(input: {
    roomId?: string | null
    botId?: string | null
    cwd?: string | null
    cols?: number
    rows?: number
  }): Promise<{ session: VlTerminalSession }> {
    return this.request('POST', '/api/vl/terminals', input)
  }

  closeTerminal(sessionId: string): Promise<{ closed: boolean }> {
    return this.request('DELETE', `/api/vl/terminals/${encodeURIComponent(sessionId)}`)
  }

  private async encodeFileBase64(file: File): Promise<string> {
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
    }
    return btoa(binary)
  }

  async uploadAttachment(roomId: string, file: File): Promise<{ attachment: VlAttachment; url: string }> {
    const dataBase64 = await this.encodeFileBase64(file)
    return this.request('POST', '/api/vl/attachments', {
      roomId,
      filename: file.name || 'attachment.bin',
      mimeType: file.type || 'application/octet-stream',
      dataBase64
    })
  }

  async uploadAvatar(file: File): Promise<{ id: string; url: string }> {
    const dataBase64 = await this.encodeFileBase64(file)
    return this.request('POST', '/api/vl/avatars', {
      filename: file.name || 'avatar.png',
      mimeType: file.type || 'image/png',
      dataBase64
    })
  }

  getInfraStatus(): Promise<VlInfraStatus> {
    return this.request('GET', '/api/vl/infra/status')
  }

  listPlugins(): Promise<{ plugins: VlPluginSummary[]; userPluginsDir: string }> {
    return this.request('GET', '/api/vl/plugins')
  }

  getPluginCatalog(): Promise<{ providers: VlProviderOption[]; models: VlPluginModelDescriptor[] }> {
    return this.request('GET', '/api/vl/plugins/catalog')
  }

  syncAllPlugins(): Promise<{ results: unknown[]; plugins: VlPluginSummary[] }> {
    return this.request('POST', '/api/vl/plugins/sync', {})
  }

  syncPlugin(pluginId: string): Promise<{ result: unknown; plugin: VlPluginSummary }> {
    return this.request('POST', `/api/vl/plugins/${encodeURIComponent(pluginId)}/sync`, {})
  }

  togglePlugin(pluginId: string, enabled: boolean): Promise<{ plugin: VlPluginSummary }> {
    return this.request('POST', `/api/vl/plugins/${encodeURIComponent(pluginId)}/toggle`, { enabled })
  }

  reloadPlugin(pluginId: string): Promise<{ plugin: VlPluginSummary }> {
    return this.request('POST', `/api/vl/plugins/${encodeURIComponent(pluginId)}/reload`, {})
  }

  ejectPlugin(pluginId: string): Promise<{ ok: boolean; message: string; plugin: VlPluginSummary }> {
    return this.request('POST', `/api/vl/plugins/${encodeURIComponent(pluginId)}/eject`, {})
  }

  checkPluginUpdate(pluginId: string): Promise<{ update: VlPluginUpdateInfo }> {
    return this.request('GET', `/api/vl/plugins/${encodeURIComponent(pluginId)}/update/check`)
  }

  runPluginUpdate(
    pluginId: string,
    options?: { target?: 'host' | 'plugin'; force?: boolean }
  ): Promise<{ result: VlPluginUpdateResult; plugin: VlPluginSummary }> {
    return this.request('POST', `/api/vl/plugins/${encodeURIComponent(pluginId)}/update`, options ?? {})
  }

  invokePluginAction<T = Record<string, unknown>>(
    pluginId: string,
    action: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> {
    return this.request('POST', `/api/vl/plugins/${encodeURIComponent(pluginId)}/action`, {
      action,
      payload
    })
  }

  async listDevices(): Promise<{ ok: true; devices: import('./types').VlConnectedDevice[] }> {
    return this.request('GET', '/api/vl/devices')
  }

  async invokeDeviceCommand(
    deviceId: string,
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = 20000
  ): Promise<import('./types').VlDeviceCommandResult> {
    return this.request('POST', `/api/vl/devices/${encodeURIComponent(deviceId)}/command`, {
      command,
      params,
      timeoutMs
    })
  }

  async syncWProxyToDevice(
    deviceId: string,
    options: {
      scheme?: 'socks5' | 'http'
      mode?: 'auto' | 'vpn_tun' | 'vpn_http' | 'system_proxy'
      dnsMode?: 'over_tcp' | 'virtual' | 'direct'
      host?: string
    } = {}
  ): Promise<{ ok: true; deviceId: string; proxyUrl: string; host: string; scheme: string }> {
    return this.request('POST', `/api/vl/devices/${encodeURIComponent(deviceId)}/sync-wproxy`, options)
  }

  async syncDeviceMihomo(
    deviceId: string,
    options: {
      yaml?: string
      configName?: string
      tailscaleAuthKey?: string
      hostname?: string
      resetTailscaleState?: boolean
      start?: boolean
    } = {}
  ): Promise<{
    ok: true
    deviceId: string
    configName: string
    sourcePath: string | null
    bytes: number
    started: boolean
    result: import('./types').VlDeviceCommandResult
  }> {
    return this.request('POST', `/api/vl/devices/${encodeURIComponent(deviceId)}/sync-mihomo`, options)
  }

  // ---- Account, Welfare, /v1 Gateway & Cluster HA API ----

  async authConfig(): Promise<{
    ok: true
    registrationMode: string
    cluster: VlClusterSummary
    nodes: VlClusterNodeEndpoint[]
  }> {
    return this.request('GET', '/api/vl/auth/config')
  }

  async authLogin(input: {
    username: string
    password: string
    deviceLabel?: string
  }): Promise<{ ok: true; user: VlAuthUser; sessionToken: string; expiresAt: number }> {
    return this.request('POST', '/api/vl/auth/login', input)
  }

  async authRegister(input: {
    username: string
    password: string
    displayName?: string
    inviteCode: string
    deviceLabel?: string
  }): Promise<{
    ok: true
    user: VlAuthUser
    sessionToken: string
    expiresAt: number
    welcomeTokens: number
  }> {
    return this.request('POST', '/api/vl/auth/register', input)
  }

  async authMe(): Promise<VlAuthMeResponse> {
    return this.request('GET', '/api/vl/auth/me')
  }

  async authLogout(): Promise<{ ok: true }> {
    return this.request('POST', '/api/vl/auth/logout', {})
  }

  async authChangePassword(oldPassword: string, newPassword: string): Promise<{ ok: true }> {
    return this.request('POST', '/api/vl/auth/password', { oldPassword, newPassword })
  }

  async getClusterNodes(): Promise<{
    ok: true
    cluster: VlClusterSummary
    endpoints: VlClusterNodeEndpoint[]
  }> {
    return this.request('GET', '/api/vl/cluster/nodes')
  }

  async getMyWelfare(): Promise<VlMyWelfarePayload> {
    return this.request('GET', '/api/vl/welfare/mine')
  }

  async redeemWelfare(input: { code?: string; grantId?: string }): Promise<{
    ok: true
    grant: VlWelfareGrant
    user: VlAuthUser
    creditedTokens: number
  }> {
    return this.request('POST', '/api/vl/welfare/redeem', input)
  }

  async listMyApiKeys(): Promise<{ ok: true; keys: VlUserApiKey[] }> {
    return this.request('GET', '/api/vl/welfare/keys')
  }

  async createMyApiKey(input: {
    name?: string
    allowedModels?: string[]
    quotaLimit?: number
  }): Promise<{ ok: true; key: VlUserApiKey }> {
    return this.request('POST', '/api/vl/welfare/keys', input)
  }

  async revokeMyApiKey(keyId: string): Promise<{ ok: true; keyId: string }> {
    return this.request('DELETE', `/api/vl/welfare/keys/${encodeURIComponent(keyId)}`)
  }

  async adminListUsers(): Promise<{ ok: true; users: VlAuthUser[] }> {
    return this.request('GET', '/api/vl/admin/users')
  }

  async adminCreateUser(input: {
    username: string
    password: string
    displayName?: string
    role?: 'admin' | 'user'
    tokenBalance?: number
    deepseekDailyQuota?: number
    gptBalance?: number
    dailyLimit?: number
    note?: string
  }): Promise<{ ok: true; user: VlAuthUser }> {
    return this.request('POST', '/api/vl/admin/users', input)
  }

  async adminUpdateUser(
    userId: string,
    patch: {
      displayName?: string
      role?: 'admin' | 'user'
      status?: 'active' | 'disabled'
      dailyLimit?: number
      deepseekDailyQuota?: number
      note?: string
      resetPassword?: string
      tokenBalanceDelta?: number
      gptBalanceDelta?: number
      reason?: string
    }
  ): Promise<{ ok: true; user: VlAuthUser }> {
    return this.request('PATCH', `/api/vl/admin/users/${encodeURIComponent(userId)}`, patch)
  }

  async adminDeleteUser(userId: string): Promise<{ ok: true; deletedId: string }> {
    return this.request('DELETE', `/api/vl/admin/users/${encodeURIComponent(userId)}`)
  }

  async adminGrantUser(
    userId: string,
    input: {
      kind?: VlWelfareKind
      title: string
      description?: string
      tokenAmount?: number
      quotaPool?: VlQuotaPool
      payload?: Record<string, unknown>
    }
  ): Promise<{ ok: true; grant: VlWelfareGrant; user: VlAuthUser }> {
    return this.request('POST', `/api/vl/admin/users/${encodeURIComponent(userId)}/grant`, input)
  }

  async adminListInvites(): Promise<{ ok: true; invites: VlInviteCode[] }> {
    return this.request('GET', '/api/vl/admin/invites')
  }

  async adminCreateInvite(input: {
    code?: string
    grantTokens?: number
    maxUses?: number
    expiresInDays?: number
    note?: string
  }): Promise<{ ok: true; invite: VlInviteCode }> {
    return this.request('POST', '/api/vl/admin/invites', input)
  }

  async adminRevokeInvite(code: string, hard = false): Promise<{ ok: true; code: string }> {
    return this.request(
      'DELETE',
      `/api/vl/admin/invites/${encodeURIComponent(code)}${hard ? '?hard=1' : ''}`
    )
  }

  async adminListWelfare(): Promise<{ ok: true; grants: VlWelfareGrant[] }> {
    return this.request('GET', '/api/vl/admin/welfare')
  }

  async adminCreateWelfare(input: {
    kind?: VlWelfareKind
    title: string
    description?: string
    targetUserId?: string
    code?: string
    tokenAmount?: number
    quotaPool?: VlQuotaPool
    payload?: Record<string, unknown>
    maxClaims?: number
    expiresInDays?: number
  }): Promise<{ ok: true; grant: VlWelfareGrant }> {
    return this.request('POST', '/api/vl/admin/welfare', input)
  }

  async adminRevokeWelfare(grantId: string, hard = false): Promise<{ ok: true; grantId: string }> {
    return this.request(
      'DELETE',
      `/api/vl/admin/welfare/${encodeURIComponent(grantId)}${hard ? '?hard=1' : ''}`
    )
  }

  async adminListUpstreams(refresh = false): Promise<{
    ok: true
    upstreams: VlGatewayUpstream[]
    magpieBridge?: VlMagpieBridgeInfo
  }> {
    return this.request('GET', `/api/vl/admin/upstreams${refresh ? '?refresh=1' : ''}`)
  }

  async adminUpdateMagpieBridge(input: {
    enabled?: boolean
    allowedModels?: string[]
    rateMultiplier?: number
    urlOverride?: string
  }): Promise<{ ok: true; magpieBridge: VlMagpieBridgeInfo }> {
    return this.request('POST', '/api/vl/admin/upstreams/magpie', input)
  }

  async adminUpsertUpstream(input: {
    id?: string
    name: string
    baseUrl: string
    apiKey?: string
    models: string[]
    priority?: number
    enabled?: boolean
    rateMultiplier?: number
  }): Promise<{ ok: true; upstream: VlGatewayUpstream }> {
    return this.request('POST', '/api/vl/admin/upstreams', input)
  }

  async adminDeleteUpstream(id: string): Promise<{ ok: true; upstreamId: string }> {
    return this.request('DELETE', `/api/vl/admin/upstreams/${encodeURIComponent(id)}`)
  }

  async adminGetCluster(): Promise<VlClusterStatus> {
    return this.request('GET', '/api/vl/admin/cluster/status')
  }

  async adminUpdateClusterConfig(patch: {
    peerUrl?: string
    primaryTailscaleUrl?: string
    primaryPublicUrl?: string
    standbyTailscaleUrl?: string
    standbyPublicUrl?: string
    syncIntervalMs?: number
  }): Promise<{ ok: true; status: VlClusterStatus }> {
    return this.request('POST', '/api/vl/admin/cluster/config', patch)
  }

  async adminTriggerClusterSync(force = false): Promise<{
    ok: boolean
    action: string
    syncRevision: number
    mergedRows?: number
    error?: string
    status: VlClusterStatus
  }> {
    return this.request('POST', '/api/vl/admin/cluster/sync', { force })
  }

  /** Connects to /ws/vl with automatic exponential backoff reconnect. Returns a close function. */
  connectEvents(
    getSinceSeq: () => number,
    onEvent: (event: VlRealtimeEvent) => void,
    onStateChange?: (connected: boolean, latestSeq?: number) => void
  ): () => void {
    let closed = false
    let ws: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let attempt = 0

    const clearTimers = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (pingTimer) {
        clearInterval(pingTimer)
        pingTimer = null
      }
    }

    const openSocket = () => {
      if (closed) return
      clearTimers()
      const wsUrl = this.resolveWsUrl('/ws/vl', { sinceSeq: getSinceSeq() })
      try {
        ws = new WebSocket(wsUrl)
      } catch {
        scheduleReconnect()
        return
      }

      ws.onopen = () => {
        attempt = 0
        pingTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, 25000)
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            type?: string
            event?: VlRealtimeEvent
            latestSeq?: number
          }
          if (msg.type === 'ready') {
            onStateChange?.(true, msg.latestSeq)
          } else if (msg.type === 'event' && msg.event) {
            onEvent(msg.event)
          }
        } catch {
          // ignore malformed frame
        }
      }

      ws.onclose = () => {
        clearTimers()
        onStateChange?.(false)
        if (!closed) {
          scheduleReconnect()
        }
      }

      ws.onerror = () => {
        // onclose handles reconnect
      }
    }

    const scheduleReconnect = () => {
      if (closed) return
      const delay = Math.min(12000, 800 * 2 ** Math.min(attempt, 4))
      attempt += 1
      retryTimer = setTimeout(openSocket, delay)
    }

    openSocket()

    return () => {
      closed = true
      clearTimers()
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close()
      }
      ws = null
    }
  }

  /** Attaches to /ws/vl/terminal/:sessionId for bidirectional PTY streaming. */
  connectTerminal(sessionId: string, handlers: TerminalWsHandlers): {
    sendInput: (data: string) => void
    resize: (cols: number, rows: number) => void
    clear: () => void
    close: () => void
  } {
    const url = this.resolveWsUrl(`/ws/vl/terminal/${encodeURIComponent(sessionId)}`)
    const ws = new WebSocket(url)

    ws.onopen = () => {
      handlers.onStateChange?.(true)
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>
        if (msg.type === 'attached') {
          handlers.onAttached?.((msg.session as VlTerminalSession | null) ?? null)
        } else if (msg.type === 'snapshot') {
          handlers.onSnapshot?.(msg as { snapshot?: string })
        } else if (msg.type === 'output' && typeof msg.data === 'string') {
          handlers.onOutput?.(msg.data)
        } else if (msg.type === 'exited') {
          handlers.onExited?.(msg)
        } else if (msg.type === 'closed') {
          handlers.onClosed?.()
        } else if (msg.type === 'cleared') {
          handlers.onCleared?.()
        } else if (msg.type === 'error') {
          handlers.onError?.(typeof msg.message === 'string' ? msg.message : 'Terminal error')
        }
      } catch {
        // ignore non-json frames
      }
    }

    ws.onclose = () => {
      handlers.onStateChange?.(false)
    }

    ws.onerror = () => {
      handlers.onError?.('WebSocket terminal connection error')
    }

    return {
      sendInput: (data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }))
        }
      },
      resize: (cols: number, rows: number) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }))
        }
      },
      clear: () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'clear' }))
        }
      },
      close: () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close()
        }
      }
    }
  }
}
