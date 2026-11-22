import { getDefaultServerUrl, getStoredAuthToken } from './runtime'
import type {
  VlAccount,
  VlApproval,
  VlAttachment,
  VlBootstrapPayload,
  VlBotFileEntry,
  VlHealthStatus,
  VlInfraStatus,
  VlMessage,
  VlPresence,
  VlRealtimeEvent,
  VlRoom,
  VlRoomKind,
  VlRoomSummary,
  VlSendMode,
  VlTerminalSession
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

  constructor(baseUrl = getDefaultServerUrl(), authToken = getStoredAuthToken()) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '') || 'http://127.0.0.1:18990'
    this.authToken = authToken.trim()
  }

  getServerUrl(): string {
    return this.baseUrl
  }

  getAuthToken(): string {
    return this.authToken
  }

  configure(baseUrl: string, authToken: string): void {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '') || 'http://127.0.0.1:18990'
    this.authToken = authToken.trim()
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
    if (this.authToken) {
      httpUrl.searchParams.set('token', this.authToken)
    }
    return httpUrl.toString()
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {}
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`
      headers['X-VibeLink-Token'] = this.authToken
    }
    let bodyStr: string | undefined
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      bodyStr = JSON.stringify(body)
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

    return (parsed ?? {}) as T
  }

  health(): Promise<VlHealthStatus> {
    return this.request('GET', '/api/vl/health')
  }

  bootstrap(): Promise<VlBootstrapPayload> {
    return this.request('GET', '/api/vl/bootstrap')
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
    }
  ): Promise<{ bot: VlAccount }> {
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
