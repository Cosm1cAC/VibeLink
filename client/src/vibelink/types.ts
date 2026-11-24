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
  source?: string
  pluginId?: string | null
  externalId?: string | null
  visible?: boolean
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
  standbyMode?: boolean
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
  pluginsCount?: number
  userPluginsDir?: string
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

export type VlPluginCapability =
  | 'agentDiscovery'
  | 'modelCatalog'
  | 'configSync'
  | 'gatewayChat'
  | 'selfUpdate'
  | 'proxyControl'

export interface VlPluginHealth {
  ok: boolean
  status: 'running' | 'installed_idle' | 'not_installed' | 'disabled' | 'error'
  version: string
  gatewayUrl?: string
  configDir?: string
  binaryPath?: string
  message: string
  details?: Record<string, unknown>
}

export interface VlPluginAgentDescriptor {
  externalId: string
  botId: string
  slug: string
  handle: string
  displayName: string
  agentName: string
  cliAlias: string
  kind: 'coding_agent' | 'host_app'
  configured: boolean
  rawStatus: string
  configPath: string
  provider: string
  executionMode: 't3_driver' | 'magpie_gateway'
  model: string
  roleTitle: string
  isolationMode: string
  approvalMode: string
  avatar: string
  pinned: boolean
  department: string
  description: string
}

export interface VlPluginModelDescriptor {
  id: string
  displayName: string
  ownedBy: string
  isRoutingGroup: boolean
  reasoning?: boolean
  toolCall?: boolean
}

export interface VlProviderOption {
  id: string
  label: string
  configured: boolean
  source: string
  description?: string
}

export interface VlPluginSummary {
  id: string
  name: string
  version: string
  description: string
  homepage?: string
  capabilities: VlPluginCapability[]
  source: 'user' | 'bundled'
  pluginDir: string
  enabled: boolean
  health: VlPluginHealth
  configuredAgents: VlPluginAgentDescriptor[]
  unconfiguredAgents: VlPluginAgentDescriptor[]
  modelsCount: number
  lastSyncAt: number | null
  lastError: string | null
}

export interface VlPluginUpdateInfo {
  ok: boolean
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  supportsHostUpdate: boolean
  supportsPluginGitUpdate: boolean
  summary: string
}

export interface VlPluginUpdateResult {
  ok: boolean
  target: 'host' | 'plugin'
  beforeVersion: string
  afterVersion: string
  output: string
}

export interface VlWProxyNode {
  name: string
  type: string
  alive: boolean
  delay: number | null
}

export interface VlWProxyLanEndpoint {
  kind: 'lan' | 'tailscale'
  iface: string
  ip: string
  address: string
}

export interface VlWProxyStatus {
  ok: boolean
  running: boolean
  version: string
  routeMode: 'rule' | 'global' | 'direct' | string
  tunEnabled: boolean
  sysProxy: {
    enable: boolean
    server: string
  }
  hysteriaRunning: boolean
  activeGroup: string
  activeNode: string
  nodes: VlWProxyNode[]
  connections: {
    count: number
    uploadTotal: number
    downloadTotal: number
  }
  localProxy: {
    host: string
    port: number
  }
  lanShare: {
    enabled: boolean
    port: number
    type: string
    username: string
    authRequired: boolean
    endpoints: VlWProxyLanEndpoint[]
  }
  wproxyDir: string
  updatedAt: number
}

export type VlChannelKind = 'lan' | 'tailscale' | 'wan' | 'custom'
export type VlChannelSwitchMode = 'auto' | 'manual'

export interface VlChannelEndpoint {
  id: string
  label: string
  kind: VlChannelKind
  url: string
  iface?: string
  serverRole?: 'primary' | 'standby'
  nodeId?: string
  priority: number
  enabled: boolean
  lastLatencyMs?: number | null
  lastJitterMs?: number | null
  lastDownloadMbps?: number | null
  lastUploadMbps?: number | null
  lastStatus?: 'ok' | 'error' | 'testing' | 'unknown'
  lastError?: string | null
  lastCheckedAt?: number | null
}

export interface VlPairingEndpoint {
  id: string
  label: string
  kind: 'lan' | 'tailscale' | 'wan'
  url: string
  iface?: string
  serverRole?: 'primary' | 'standby'
  nodeId?: string
  priority: number
}

export interface VlPairingInfo {
  ok: true
  version: number
  hostName: string
  port: number
  token: string
  customExternalUrl: string
  endpoints: VlPairingEndpoint[]
  qrPayload: string
}

export interface VlChannelSpeedResult {
  endpointId: string
  url: string
  ok: boolean
  latencyMs: number | null
  jitterMs: number | null
  downloadMbps: number | null
  uploadMbps: number | null
  error?: string
  checkedAt: number
}

export interface VlDeviceCapabilities {
  root: boolean
  shizukuInstalled: boolean
  shizukuRunning: boolean
  shizukuGranted: boolean
  accessibilityEnabled: boolean
  vpnPrepared: boolean
  vpnRunning: boolean
  otherVpnActive: boolean
  foregroundService: boolean
  batteryOptimizationIgnored: boolean
  activeProxyMode: 'off' | 'vpn_tun' | 'vpn_http' | 'system_proxy' | 'mihomo'
  activeProxyUrl: string | null
  systemHttpProxy: string | null
  activeEndpointUrl: string | null
  mihomoAvailable?: boolean
  mihomoRunning?: boolean
  mihomoVersion?: string | null
  mihomoActiveNode?: string | null
  mihomoTailscaleLoginUrl?: string | null
  mihomoHasConfig?: boolean
}

export interface VlMihomoStatus {
  available: boolean
  running: boolean
  vpnActive?: boolean
  runMode?: 'off' | 'bridge' | 'vpn'
  version: string | null
  hasConfig: boolean
  configName: string | null
  updatedAt: number
  routeMode: 'rule' | 'global' | 'direct' | string
  activeNode: string | null
  effectiveNode?: string | null
  entryGroupNow?: string | null
  mixedPort: number
  tailscaleStateExists: boolean
  tailscaleLoginUrl: string | null
  autoHealNotice?: string | null
  lastError: string | null
}

export interface VlMihomoProbeResult {
  ok: boolean
  googleOk: boolean
  googleCode: number
  googleMs: number | null
  googleError?: string | null
  xOk: boolean
  xCode: number
  xMs: number | null
  xError?: string | null
  activeNode: string | null
  effectiveNode?: string | null
  routeMode: string
}

export interface VlMihomoProxyGroup {
  name: string
  type: string
  now: string
  all: string[]
}

export interface VlMihomoNodeMeta {
  type: string
  alive: boolean
  delay: number | null
}

export interface VlMihomoProxiesPayload {
  ok: boolean
  routeMode: string
  activeNode: string | null
  effectiveNode?: string | null
  entryGroupNow?: string | null
  groups: VlMihomoProxyGroup[]
  nodes: Record<string, VlMihomoNodeMeta>
}

export interface VlLocalAndroidCapabilities extends VlDeviceCapabilities {
  deviceId: string
  agentEnabled: boolean
  socketConnected: boolean
}

export interface VlConnectedDevice {
  deviceId: string
  name: string
  model: string
  manufacturer: string
  androidVersion: string
  sdkInt: number
  appVersion: string
  online: boolean
  connectedAt: number
  lastSeenAt: number
  remoteAddress: string | null
  capabilities: VlDeviceCapabilities
}

export interface VlDeviceCommandResult {
  callId: string
  ok: boolean
  data?: unknown
  error?: string
  durationMs: number
}

export type VlUserRole = 'admin' | 'user'
export type VlUserStatus = 'active' | 'disabled'
export type VlWelfareKind = 'token_credit' | 'redeem_code' | 'custom_secret' | 'notice_gift'
export type VlQuotaPool = 'deepseek' | 'gpt'
export type VlClusterRole = 'primary' | 'standby'

export interface VlAuthUser {
  id: string
  username: string
  displayName: string
  role: VlUserRole
  status: VlUserStatus
  imAccountId: string | null
  tokenBalance: number
  tokenUsed: number
  tokenGrantedTotal: number
  deepseekDailyQuota: number
  deepseekDailyUsed: number
  deepseekDailyRemaining: number
  deepseekDailyDate: string
  deepseekTotalAvailable: number
  gptBalance: number
  gptUsed: number
  gptGrantedTotal: number
  dailyLimit: number
  note: string
  createdAt: number
  updatedAt: number
  lastLoginAt: number | null
}

export interface VlClusterSummary {
  role: VlClusterRole
  nodeId: string
  nodeLabel: string
  syncRevision: number
  standbyDirty: boolean
}

export interface VlClusterNodeEndpoint {
  id: string
  label: string
  kind: 'lan' | 'tailscale' | 'wan'
  url: string
  serverRole: VlClusterRole
  nodeId: string
  priority: number
}

export interface VlClusterStatus {
  ok: true
  role: VlClusterRole
  nodeId: string
  nodeLabel: string
  peerUrl: string
  primaryTailscaleUrl: string
  primaryPublicUrl: string
  standbyTailscaleUrl: string
  standbyPublicUrl: string
  syncIntervalMs: number
  syncRevision: number
  standbyDirty: boolean
  lastSyncAt: number | null
  lastSyncOk: boolean | null
  lastSyncError: string | null
  peerStatus: {
    reachable: boolean
    role?: VlClusterRole
    nodeId?: string
    nodeLabel?: string
    syncRevision?: number
    standbyDirty?: boolean
    latencyMs?: number | null
  } | null
  endpoints: VlClusterNodeEndpoint[]
}

export interface VlAuthMeResponse {
  ok: true
  authMode: 'owner_token' | 'loopback_admin' | 'user_session'
  user: VlAuthUser
  cluster: VlClusterSummary
  nodes: VlClusterNodeEndpoint[]
}

export interface VlInviteCode {
  code: string
  createdBy: string
  note: string
  grantTokens: number
  maxUses: number
  usedCount: number
  expiresAt: number | null
  disabled: boolean
  createdAt: number
  updatedAt: number
}

export interface VlWelfareGrant {
  id: string
  kind: VlWelfareKind
  title: string
  description: string
  targetUserId: string | null
  code: string | null
  tokenAmount: number
  quotaPool: VlQuotaPool
  payload: Record<string, unknown>
  maxClaims: number
  claimedCount: number
  expiresAt: number | null
  status: 'active' | 'claimed' | 'revoked'
  createdBy: string
  createdAt: number
  updatedAt: number
  alreadyClaimed?: boolean
}

export interface VlWelfareClaim {
  id: string
  grantId: string
  userId: string
  tokenAmount: number
  claimedAt: number
}

export interface VlTokenLedgerEntry {
  id: string
  userId: string
  quotaPool: VlQuotaPool
  delta: number
  balanceAfter: number
  reason: string
  refId: string | null
  model: string | null
  promptTokens: number
  completionTokens: number
  meta: Record<string, unknown>
  createdAt: number
}

export interface VlUserApiKey {
  id: string
  userId: string
  name: string
  keyPrefix: string
  key?: string
  allowedModels: string[]
  quotaLimit: number
  tokensUsed: number
  revoked: boolean
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export interface VlGatewayUpstream {
  id: string
  name: string
  baseUrl: string
  apiKeyMasked: string
  models: string[]
  priority: number
  enabled: boolean
  rateMultiplier: number
  createdAt: number
  updatedAt: number
}

export interface VlMagpieBridgeConfig {
  enabled: boolean
  allowedModels: string[]
  rateMultiplier: number
  urlOverride: string
}

export interface VlMagpieBridgeStatus {
  enabled: boolean
  running: boolean
  source: 'builtin_plugin' | 'local_gateway' | 'url_override' | 'disabled'
  pluginEnabled: boolean | null
  version: string
  gatewayUrl: string
  modelsCount: number
  totalLocalModels?: number
  sampleModels: string[]
  protocols: string[]
  message: string
}

export interface VlMagpieBridgeInfo {
  config: VlMagpieBridgeConfig
  status: VlMagpieBridgeStatus
}

export interface VlMyWelfarePayload {
  ok: true
  user: VlAuthUser
  grants: VlWelfareGrant[]
  claims: VlWelfareClaim[]
  ledger: VlTokenLedgerEntry[]
  availableModels: string[]
}
