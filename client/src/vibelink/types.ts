export type VlAccountKind = 'human' | 'bot'
export type VlPresence = 'online' | 'idle' | 'working' | 'offline' | 'error'
export type VlRoomKind = 'dm' | 'group'
export type VlMemberRole = 'owner' | 'admin' | 'member'
export type VlMessageType =
  | 'text'
  | 'bot_markdown'
  | 'bot_tool_call'
  | 'bot_diff_checkpoint'
  | 'bot_approval'
  | 'system'
export type VlSendMode = 'auto' | 'queue' | 'steer'
export type VlApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface VlAccount {
  id: string
  kind: VlAccountKind
  slug: string
  handle: string
  displayName: string
  avatar: string
  roleTitle: string
  department: string
  presence: VlPresence
  statusText: string
  provider: string
  model: string
  cwd: string
  isolationMode: string
  approvalMode: string
  description: string
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface VlRoom {
  id: string
  kind: VlRoomKind
  name: string
  notice: string
  avatar: string
  muted: boolean
  pinned: boolean
  cwd: string
  createdAt: number
  updatedAt: number
}

export interface VlRoomMember {
  roomId: string
  accountId: string
  role: VlMemberRole
  muted: boolean
  joinedAt: number
}

export interface VlMessage {
  id: string
  roomId: string
  senderId: string
  msgType: VlMessageType
  content: string
  metadata: Record<string, unknown>
  replyToId: string | null
  handoffChainId: string | null
  handoffDepth: number
  recalledAt: number | null
  createdAt: number
  updatedAt: number
}

export interface VlRoomSummary extends VlRoom {
  members: VlRoomMember[]
  memberCount: number
  onlineCount: number
  unreadCount: number
  lastMessage: VlMessage | null
}

export interface VlAttachment {
  id: string
  roomId: string
  uploaderId: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  createdAt: number
}

export interface VlRealtimeEvent {
  seq: number
  eventType: string
  roomId: string | null
  payload: Record<string, unknown>
  createdAt: number
}

export interface VlApproval {
  id: string
  roomId: string
  messageId: string
  botId: string
  threadId: string | null
  requestId: string | null
  title: string
  detail: string
  status: VlApprovalStatus
  decision: string | null
  createdAt: number
  resolvedAt: number | null
}

export interface VlBotConfigJson {
  id: string
  slug: string
  handle: string
  displayName: string
  avatar: string
  roleTitle: string
  department: string
  provider: string
  model: string
  thinkingEffort: string
  cwd: string
  isolationMode: string
  approvalMode: string
  manageOtherBots: boolean
  dailyCheckIns: boolean
  disabledTools: string[]
  exampleRequests: string[]
  description: string
  section: string
  pinned: boolean
}

export interface VlBotFileEntry {
  path: string
  name: string
  kind: 'file' | 'dir'
  sizeBytes: number
  updatedAt: number
}

export interface VlBootstrapPayload {
  me: VlAccount
  accounts: VlAccount[]
  rooms: VlRoomSummary[]
  messagesByRoom: Record<string, VlMessage[]>
  latestSeq: number
  mockBots: boolean
}

export interface VlTerminalSession {
  sessionId: string
  threadId: string
  terminalId: string
  roomId: string | null
  botId: string | null
  cwd: string
  createdAt: number
}

export interface VlInfraStatus {
  ok: boolean
  readOnly: boolean
  pid: number
  uptimeSec: number
  nodeVersion: string
  homeDir: string
  dbPath: string
  mockBots: boolean
  botsTotal: number
  botsWorking: number
  roomsTotal: number
  activeTerminals: number
  latestSeq: number
}

export interface VlHealthStatus {
  ok: boolean
  service: string
  version: number
  mockBots: boolean
  botsCount: number
  roomsCount: number
  latestSeq: number
}
