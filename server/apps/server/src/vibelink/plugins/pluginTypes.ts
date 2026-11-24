export type VlPluginCapability =
  | "agentDiscovery"
  | "modelCatalog"
  | "configSync"
  | "gatewayChat"
  | "selfUpdate"
  | "proxyControl";

export interface VlPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly entry: string;
  readonly capabilities: ReadonlyArray<VlPluginCapability>;
  readonly homepage?: string;
  readonly defaultEnabled?: boolean;
}

export interface VlPluginHealth {
  readonly ok: boolean;
  readonly status: "running" | "installed_idle" | "not_installed" | "disabled" | "error";
  readonly version: string;
  readonly gatewayUrl?: string;
  readonly configDir?: string;
  readonly binaryPath?: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface VlPluginAgentDescriptor {
  readonly externalId: string;
  readonly botId: string;
  readonly slug: string;
  readonly handle: string;
  readonly displayName: string;
  readonly agentName: string;
  readonly cliAlias: string;
  readonly kind: "coding_agent" | "host_app";
  readonly configured: boolean;
  readonly rawStatus: string;
  readonly configPath: string;
  readonly provider: string;
  readonly executionMode: "t3_driver" | "magpie_gateway";
  readonly model: string;
  readonly roleTitle: string;
  readonly isolationMode: string;
  readonly approvalMode: string;
  readonly avatar: string;
  readonly pinned: boolean;
  readonly department: string;
  readonly description: string;
}

export interface VlPluginModelDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly ownedBy: string;
  readonly isRoutingGroup: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
}

export interface VlProviderOption {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  readonly source: string;
  readonly description?: string;
}

export interface VlPluginDiscoveryResult {
  readonly configuredAgents: ReadonlyArray<VlPluginAgentDescriptor>;
  readonly unconfiguredAgents: ReadonlyArray<VlPluginAgentDescriptor>;
  readonly hostApps: ReadonlyArray<VlPluginAgentDescriptor>;
  readonly gatewayUrl?: string;
  readonly detectedAt: number;
}

export interface VlPluginUpdateInfo {
  readonly ok: boolean;
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly updateAvailable: boolean;
  readonly supportsHostUpdate: boolean;
  readonly supportsPluginGitUpdate: boolean;
  readonly summary: string;
}

export interface VlPluginUpdateResult {
  readonly ok: boolean;
  readonly target: "host" | "plugin";
  readonly beforeVersion: string;
  readonly afterVersion: string;
  readonly output: string;
}

export interface VlPluginDbState {
  readonly id: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
  readonly lastSyncAt: number | null;
  readonly lastError: string | null;
  readonly updatedAt: number;
}

export interface VlPluginSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly homepage?: string;
  readonly capabilities: ReadonlyArray<VlPluginCapability>;
  readonly source: "user" | "bundled";
  readonly pluginDir: string;
  readonly enabled: boolean;
  readonly health: VlPluginHealth;
  readonly configuredAgents: ReadonlyArray<VlPluginAgentDescriptor>;
  readonly unconfiguredAgents: ReadonlyArray<VlPluginAgentDescriptor>;
  readonly modelsCount: number;
  readonly lastSyncAt: number | null;
  readonly lastError: string | null;
}

export interface VlPluginSyncResult {
  readonly pluginId: string;
  readonly visibleBotIds: ReadonlyArray<string>;
  readonly hiddenBotIds: ReadonlyArray<string>;
  readonly createdBotIds: ReadonlyArray<string>;
  readonly syncedAt: number;
  readonly authoritative: boolean;
}

export interface VlPluginContext {
  readonly pluginDir: string;
  readonly vibelinkHome: string;
}

export interface VibeLinkPluginInstance {
  readonly health: () => Promise<VlPluginHealth>;
  readonly listModels?: () => Promise<ReadonlyArray<VlPluginModelDescriptor>>;
  readonly discoverAgents?: () => Promise<VlPluginDiscoveryResult>;
  readonly syncBotModel?: (input: {
    readonly externalId: string;
    readonly model: string;
  }) => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly chatCompletion?: (input: {
    readonly model: string;
    readonly systemPrompt?: string;
    readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly content: string;
    readonly model: string;
    readonly usage?: Record<string, unknown>;
  }>;
  readonly checkUpdate?: () => Promise<VlPluginUpdateInfo>;
  readonly runUpdate?: (options?: {
    readonly target?: "host" | "plugin";
    readonly force?: boolean;
  }) => Promise<VlPluginUpdateResult>;
  readonly getWatchPaths?: () => ReadonlyArray<string>;
  readonly invokeAction?: (
    action: string,
    payload?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

export interface VibeLinkPluginModule {
  readonly createPlugin: (
    context: VlPluginContext,
  ) => VibeLinkPluginInstance | Promise<VibeLinkPluginInstance>;
}
