// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUrl from "node:url";

import { BotHomeManager, sanitizeBotSlug } from "../bots/botHome.ts";
import type { VibeLinkDatabase } from "../db.ts";
import type { VlAccount, VlBotConfigJson } from "../types.ts";
import type {
  VibeLinkPluginInstance,
  VibeLinkPluginModule,
  VlPluginAgentDescriptor,
  VlPluginDiscoveryResult,
  VlPluginHealth,
  VlPluginManifest,
  VlPluginModelDescriptor,
  VlPluginSummary,
  VlPluginSyncResult,
  VlPluginUpdateInfo,
  VlPluginUpdateResult,
  VlProviderOption,
} from "./pluginTypes.ts";

export interface PluginManagerOptions {
  readonly userPluginsDir?: string;
  readonly bundledPluginsDir?: string;
  readonly disableBundled?: boolean;
  readonly watchIntervalMs?: number;
}

interface DiscoveredPluginDir {
  readonly manifest: VlPluginManifest;
  readonly pluginDir: string;
  readonly entryPath: string;
  readonly source: "user" | "bundled";
}

interface LoadedPluginRecord {
  manifest: VlPluginManifest;
  pluginDir: string;
  entryPath: string;
  source: "user" | "bundled";
  instance: VibeLinkPluginInstance | null;
  health: VlPluginHealth;
  configuredAgents: ReadonlyArray<VlPluginAgentDescriptor>;
  unconfiguredAgents: ReadonlyArray<VlPluginAgentDescriptor>;
  models: ReadonlyArray<VlPluginModelDescriptor>;
  watchMtimes: Map<string, number>;
}

const NATIVE_PROVIDER_DEFS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly description: string;
}> = [
  { id: "codex", label: "codex (Codex CLI)", description: "T3 Code 原生 Codex 驱动（Worktree / Diff / 审批）" },
  { id: "claude", label: "claude (Claude Code)", description: "T3 Code 原生 Claude Code 驱动" },
  { id: "opencode", label: "opencode (OpenCode)", description: "T3 Code 原生 OpenCode 驱动" },
  { id: "antigravity", label: "antigravity (Antigravity / Gemini)", description: "T3 Code 原生 Antigravity 驱动" },
  { id: "cursor", label: "cursor (Cursor CLI)", description: "T3 Code 原生 Cursor 驱动" },
  { id: "grok", label: "grok (Grok)", description: "T3 Code 原生 Grok 驱动" },
  { id: "kiro", label: "kiro (Kiro)", description: "T3 Code 原生 Kiro 驱动" },
  { id: "pi", label: "pi (Pi)", description: "T3 Code 原生 Pi 驱动" },
];

function resolveDefaultBundledPluginsDir(): string | null {
  const candidates: string[] = [];
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 7; i += 1) {
    candidates.push(NodePath.join(dir, "plugins"));
    const parent = NodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(NodePath.join(process.cwd(), "plugins"));

  for (const candidate of candidates) {
    if (!NodeFS.existsSync(candidate)) continue;
    try {
      const stat = NodeFS.statSync(candidate);
      if (!stat.isDirectory()) continue;
      const entries = NodeFS.readdirSync(candidate, { withFileTypes: true });
      if (
        entries.some(
          (e) =>
            e.isDirectory() &&
            NodeFS.existsSync(NodePath.join(candidate, e.name, "plugin.json")),
        )
      ) {
        return NodePath.resolve(candidate);
      }
    } catch {
      // Ignore unreadable candidate dirs
    }
  }
  return null;
}

function copyDirRecursive(srcDir: string, dstDir: string): void {
  NodeFS.mkdirSync(dstDir, { recursive: true });
  const entries = NodeFS.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = NodePath.join(srcDir, entry.name);
    const dstPath = NodePath.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      NodeFS.copyFileSync(srcPath, dstPath);
    }
  }
}

function buildPluginBotSoul(agent: VlPluginAgentDescriptor, pluginName: string): string {
  return [
    `# Role (T3 Code: ${agent.roleTitle || "general"})`,
    `你是通过 ${pluginName} 插件接入的「${agent.displayName}」协作 Bot（引擎 \`${agent.provider}\`${agent.model ? `，当前模型 \`${agent.model}\`` : ""}）。`,
    "",
    "## 工作规范",
    "1. 修改或分析代码前先读取相关源码、配置与调用链，汇报时只陈述实测观察到的文件、符号与命令输出。",
    "2. 在群聊需要其他成员接力时，直接在正文中通过 `@Handle` 点名协作。",
    "3. 涉及破坏性操作或需要人工决策的歧义时，先说明选项与影响并请求确认。",
  ].join("\n");
}

function readManifestFromDir(pluginDir: string): {
  readonly manifest: VlPluginManifest;
  readonly entryPath: string;
} | null {
  const manifestPath = NodePath.join(pluginDir, "plugin.json");
  if (!NodeFS.existsSync(manifestPath)) return null;
  const raw = NodeFS.readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<VlPluginManifest>;
  const id = String(parsed.id ?? "").trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid plugin id in ${manifestPath}: ${id}`);
  }
  const entry = String(parsed.entry ?? "").trim();
  if (!entry) {
    throw new Error(`Missing plugin entry in ${manifestPath}`);
  }
  const resolvedPluginDir = NodePath.resolve(pluginDir);
  const entryPath = NodePath.resolve(resolvedPluginDir, entry);
  if (
    entryPath !== resolvedPluginDir &&
    !entryPath.startsWith(resolvedPluginDir + NodePath.sep)
  ) {
    throw new Error(`Plugin entry path traversal rejected: ${entry}`);
  }
  if (!NodeFS.existsSync(entryPath)) {
    throw new Error(`Plugin entry file does not exist: ${entryPath}`);
  }
  const manifest: VlPluginManifest = {
    id,
    name: String(parsed.name ?? id),
    version: String(parsed.version ?? "0.0.0"),
    description: String(parsed.description ?? ""),
    entry,
    capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
    ...(typeof parsed.homepage === "string" ? { homepage: parsed.homepage } : {}),
    defaultEnabled: parsed.defaultEnabled !== false,
  };
  return { manifest, entryPath };
}

export class VibeLinkPluginManager {
  readonly db: VibeLinkDatabase;
  readonly botHome: BotHomeManager;
  readonly userPluginsDir: string;
  readonly bundledPluginsDir: string | null;
  private readonly watchIntervalMs: number;
  private readonly records = new Map<string, LoadedPluginRecord>();
  private reloadNonce = 0;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watchTickBusy = false;

  constructor(
    db: VibeLinkDatabase,
    botHome: BotHomeManager,
    options?: PluginManagerOptions,
  ) {
    this.db = db;
    this.botHome = botHome;
    this.userPluginsDir = NodePath.resolve(
      options?.userPluginsDir ?? NodePath.join(db.homeDir, "plugins"),
    );
    this.bundledPluginsDir = options?.disableBundled
      ? null
      : options?.bundledPluginsDir
        ? NodePath.resolve(options.bundledPluginsDir)
        : resolveDefaultBundledPluginsDir();
    this.watchIntervalMs = options?.watchIntervalMs ?? 15000;
  }

  async initialize(): Promise<void> {
    NodeFS.mkdirSync(this.userPluginsDir, { recursive: true });
    this.scanManifests();
    for (const id of this.records.keys()) {
      const enabled = this.isPluginEnabled(id);
      if (enabled) {
        try {
          await this.ensureInstance(id);
        } catch (err) {
          this.db.upsertPluginState({
            id,
            enabled: true,
            lastError: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    await this.syncAll();
    this.startWatchTimer();
  }

  stop(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  private startWatchTimer(): void {
    if (this.watchTimer || this.watchIntervalMs <= 0) return;
    this.watchTimer = setInterval(() => {
      if (this.watchTickBusy) return;
      this.watchTickBusy = true;
      void this.pollWatchedPaths().finally(() => {
        this.watchTickBusy = false;
      });
    }, this.watchIntervalMs);
  }

  private async pollWatchedPaths(): Promise<void> {
    for (const [id, rec] of this.records.entries()) {
      if (!this.isPluginEnabled(id) || !rec.instance?.getWatchPaths) continue;
      let changed = false;
      for (const watchPath of rec.instance.getWatchPaths()) {
        const mtime = NodeFS.existsSync(watchPath)
          ? NodeFS.statSync(watchPath).mtimeMs
          : -1;
        const prev = rec.watchMtimes.get(watchPath);
        if (prev !== undefined && prev !== mtime) {
          changed = true;
        }
        rec.watchMtimes.set(watchPath, mtime);
      }
      if (changed) {
        try {
          await this.syncPlugin(id);
        } catch {
          // Keep watcher resilient
        }
      }
    }
  }

  private captureWatchMtimes(rec: LoadedPluginRecord): void {
    if (!rec.instance?.getWatchPaths) return;
    for (const watchPath of rec.instance.getWatchPaths()) {
      const mtime = NodeFS.existsSync(watchPath)
        ? NodeFS.statSync(watchPath).mtimeMs
        : -1;
      rec.watchMtimes.set(watchPath, mtime);
    }
  }

  private scanManifests(): void {
    const discovered = new Map<string, DiscoveredPluginDir>();

    const scanRoot = (rootDir: string | null, source: "bundled" | "user") => {
      if (!rootDir || !NodeFS.existsSync(rootDir)) return;
      const entries = NodeFS.readdirSync(rootDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subDir = NodePath.join(rootDir, entry.name);
        try {
          const loaded = readManifestFromDir(subDir);
          if (!loaded) continue;
          discovered.set(loaded.manifest.id, {
            manifest: loaded.manifest,
            pluginDir: NodePath.resolve(subDir),
            entryPath: loaded.entryPath,
            source,
          });
        } catch {
          // Skip malformed plugin directories gracefully
        }
      }
    };

    scanRoot(this.bundledPluginsDir, "bundled");
    scanRoot(this.userPluginsDir, "user");

    for (const existingId of [...this.records.keys()]) {
      if (!discovered.has(existingId)) {
        this.records.delete(existingId);
      }
    }

    for (const [id, info] of discovered.entries()) {
      const prev = this.records.get(id);
      if (
        prev &&
        prev.pluginDir === info.pluginDir &&
        prev.entryPath === info.entryPath &&
        prev.source === info.source
      ) {
        prev.manifest = info.manifest;
      } else {
        this.records.set(id, {
          manifest: info.manifest,
          pluginDir: info.pluginDir,
          entryPath: info.entryPath,
          source: info.source,
          instance: null,
          health: {
            ok: false,
            status: this.isPluginEnabled(id) ? "installed_idle" : "disabled",
            version: "",
            message: this.isPluginEnabled(id) ? "未初始化" : "插件已停用",
          },
          configuredAgents: [],
          unconfiguredAgents: [],
          models: [],
          watchMtimes: new Map(),
        });
      }

      if (!this.db.getPluginState(id)) {
        this.db.upsertPluginState({
          id,
          enabled: info.manifest.defaultEnabled !== false,
        });
      }
    }
  }

  private isPluginEnabled(pluginId: string): boolean {
    const dbState = this.db.getPluginState(pluginId);
    if (dbState) return dbState.enabled;
    const rec = this.records.get(pluginId);
    return rec ? rec.manifest.defaultEnabled !== false : false;
  }

  private async ensureInstance(
    pluginId: string,
    forceReload = false,
  ): Promise<LoadedPluginRecord | null> {
    const rec = this.records.get(pluginId);
    if (!rec) return null;
    if (rec.instance && !forceReload) return rec;

    this.reloadNonce += 1;
    const fileUrl = `${NodeUrl.pathToFileURL(rec.entryPath).href}?v=${this.reloadNonce}`;
    const mod = (await import(fileUrl)) as Partial<VibeLinkPluginModule>;
    if (typeof mod.createPlugin !== "function") {
      throw new Error(`Plugin ${pluginId} entry does not export createPlugin()`);
    }
    rec.instance = await mod.createPlugin({
      pluginDir: rec.pluginDir,
      vibelinkHome: this.db.homeDir,
    });
    this.captureWatchMtimes(rec);
    return rec;
  }

  async syncAll(): Promise<ReadonlyArray<VlPluginSyncResult>> {
    this.scanManifests();
    const results: VlPluginSyncResult[] = [];
    for (const id of this.records.keys()) {
      if (!this.isPluginEnabled(id)) continue;
      const res = await this.syncPlugin(id);
      if (res) results.push(res);
    }
    return results;
  }

  async syncPlugin(pluginId: string): Promise<VlPluginSyncResult | null> {
    this.scanManifests();
    const rec = this.records.get(pluginId);
    if (!rec) return null;
    if (!this.isPluginEnabled(pluginId)) {
      rec.health = {
        ok: false,
        status: "disabled",
        version: rec.health.version,
        message: "插件已停用",
      };
      return null;
    }

    const syncedAt = Date.now();
    try {
      await this.ensureInstance(pluginId);
      const instance = rec.instance!;
      const [health, discovery, models] = await Promise.all([
        instance.health(),
        instance.discoverAgents
          ? instance.discoverAgents()
          : Promise.resolve<VlPluginDiscoveryResult>({
              configuredAgents: [],
              unconfiguredAgents: [],
              hostApps: [],
              detectedAt: syncedAt,
            }),
        instance.listModels ? instance.listModels() : Promise.resolve<ReadonlyArray<VlPluginModelDescriptor>>([]),
      ]);

      rec.health = health;
      rec.configuredAgents = discovery.configuredAgents;
      rec.unconfiguredAgents = discovery.unconfiguredAgents;
      rec.models = models;
      this.captureWatchMtimes(rec);

      const hasDiscoveryCap = rec.manifest.capabilities.includes("agentDiscovery");
      const authoritative =
        hasDiscoveryCap &&
        health.status !== "not_installed" &&
        (health.ok || discovery.configuredAgents.length > 0);

      const visibleBotIds: string[] = [];
      const hiddenBotIds: string[] = [];
      const createdBotIds: string[] = [];

      if (authoritative) {
        const configuredBotIds = new Set<string>();
        const usedHandles = new Set<string>(["me"]);
        for (const acc of this.db.listAccounts(undefined, { includeHidden: true })) {
          usedHandles.add(acc.handle.toLowerCase());
        }

        for (const agent of discovery.configuredAgents) {
          const existing =
            this.db.getAccount(agent.botId) ??
            this.db.findAccountByPluginExternalId(pluginId, agent.externalId) ??
            this.db.getAccountBySlugOrHandle(agent.slug);

          let targetBotId: string;
          if (existing) {
            targetBotId = existing.id;
            const statusText =
              existing.presence === "working"
                ? existing.statusText
                : agent.model
                  ? `${agent.provider} · ${agent.model}`
                  : existing.roleTitle || `${agent.provider} · 就绪`;
            const updated = this.db.updateAccountFields(
              existing.id,
              {
                visible: true,
                source: `plugin:${pluginId}`,
                pluginId,
                externalId: agent.externalId,
                provider: agent.provider,
                model: agent.model || existing.model,
                statusText,
              },
              true,
            );
            if (updated) {
              this.botHome.syncAccountToBotJson(updated);
              this.ensureDmRoomForBot(updated);
            }
          } else {
            targetBotId = agent.botId;
            let handle = agent.handle.trim() || sanitizeBotSlug(agent.slug);
            if (usedHandles.has(handle.toLowerCase())) {
              let idx = 2;
              while (usedHandles.has(`${handle}-${idx}`.toLowerCase())) idx += 1;
              handle = `${handle}-${idx}`;
            }
            usedHandles.add(handle.toLowerCase());

            const baseSlug = sanitizeBotSlug(agent.slug);
            let slug = baseSlug;
            let slugIdx = 2;
            while (
              this.db
                .listAccounts("bot", { includeHidden: true })
                .some((a) => a.slug === slug && a.id !== targetBotId)
            ) {
              slug = `${baseSlug}-${slugIdx}`;
              slugIdx += 1;
            }

            const config: VlBotConfigJson = {
              id: targetBotId,
              slug,
              handle,
              displayName: agent.displayName,
              avatar: agent.avatar,
              roleTitle: agent.roleTitle || "general",
              department: agent.department || rec.manifest.name,
              provider: agent.provider,
              model: agent.model,
              thinkingEffort: "medium",
              cwd: "D:\\AI\\VibeLink",
              isolationMode: agent.isolationMode || "shared",
              approvalMode: agent.approvalMode || "ask",
              manageOtherBots: false,
              dailyCheckIns: false,
              disabledTools: [],
              exampleRequests: [],
              description: agent.description,
              section: rec.manifest.name,
              pinned: Boolean(agent.pinned),
            };

            this.botHome.ensureBotScaffold(config, {
              soulMarkdown: buildPluginBotSoul(agent, rec.manifest.name),
              overwriteExisting: false,
            });

            const created = this.db.upsertAccount({
              id: targetBotId,
              kind: "bot",
              slug,
              handle,
              displayName: agent.displayName,
              avatar: config.avatar,
              roleTitle: config.roleTitle,
              department: config.department,
              presence: "idle",
              statusText: agent.model
                ? `${agent.provider} · ${agent.model}`
                : `${agent.provider} · 就绪`,
              provider: agent.provider,
              model: agent.model,
              cwd: config.cwd,
              isolationMode: config.isolationMode,
              approvalMode: config.approvalMode,
              description: config.description,
              pinned: config.pinned,
              source: `plugin:${pluginId}`,
              pluginId,
              externalId: agent.externalId,
              visible: true,
            });
            this.ensureDmRoomForBot(
              created,
              `${created.displayName} (${created.provider}${created.model ? ` · ${created.model}` : ""}) 已通过 ${rec.manifest.name} 就绪。`,
            );
            this.db.appendEvent("account.updated", null, { account: created });
            createdBotIds.push(created.id);
          }

          configuredBotIds.add(targetBotId);
          visibleBotIds.push(targetBotId);

          if (this.db.getRoom("grp_workspace")) {
            const members = this.db.listRoomMembers("grp_workspace");
            if (!members.some((m) => m.accountId === targetBotId)) {
              this.db.addRoomMember("grp_workspace", targetBotId, "member");
            }
          }
        }

        const allBots = this.db.listAccounts("bot", { includeHidden: true });
        for (const bot of allBots) {
          if (
            !configuredBotIds.has(bot.id) &&
            bot.source !== "manual" &&
            (bot.source === "seed" || bot.pluginId === pluginId)
          ) {
            if (bot.visible) {
              this.db.updateAccountFields(bot.id, { visible: false }, true);
            }
            hiddenBotIds.push(bot.id);
          }
        }

        if (this.db.getRoom("grp_workspace")) {
          const updatedGroup = this.db.getRoomSummary("grp_workspace", "me");
          if (updatedGroup) {
            this.db.appendEvent("room.updated", "grp_workspace", { room: updatedGroup });
          }
        }
      }

      this.db.upsertPluginState({
        id: pluginId,
        enabled: true,
        lastSyncAt: syncedAt,
        lastError: health.ok ? null : health.message,
      });

      this.db.appendEvent("plugins.synced", null, {
        pluginId,
        visibleBotIds,
        hiddenBotIds,
        syncedAt,
      });

      return {
        pluginId,
        visibleBotIds,
        hiddenBotIds,
        createdBotIds,
        syncedAt,
        authoritative,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rec.health = {
        ok: false,
        status: "error",
        version: rec.health.version,
        message,
      };
      this.db.upsertPluginState({
        id: pluginId,
        enabled: true,
        lastSyncAt: syncedAt,
        lastError: message,
      });
      return {
        pluginId,
        visibleBotIds: [],
        hiddenBotIds: [],
        createdBotIds: [],
        syncedAt,
        authoritative: false,
      };
    }
  }

  private ensureDmRoomForBot(bot: VlAccount, introText?: string): void {
    const dmId = `dm_${bot.id}`;
    const existed = this.db.getRoom(dmId) !== null;
    if (!existed) {
      this.db.upsertRoom({
        id: dmId,
        kind: "dm",
        name: bot.displayName,
        notice: bot.description,
        avatar: bot.avatar,
        muted: false,
        pinned: bot.pinned,
        cwd: bot.cwd || "D:\\AI\\VibeLink",
      });
      this.db.addRoomMember(dmId, "me", "owner");
      this.db.addRoomMember(dmId, bot.id, "member");
      if (introText) {
        const msg = this.db.createMessage({
          roomId: dmId,
          senderId: bot.id,
          msgType: "bot_markdown",
          content: introText,
          emitEvent: false,
        });
        this.db.markRoomRead(dmId, "me", msg.id);
      }
      const room = this.db.getRoomSummary(dmId, "me");
      if (room) {
        this.db.appendEvent("room.created", dmId, { room });
      }
    }
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<VlPluginSummary | null> {
    this.scanManifests();
    const rec = this.records.get(pluginId);
    if (!rec) return null;

    this.db.upsertPluginState({ id: pluginId, enabled });

    if (enabled) {
      await this.syncPlugin(pluginId);
    } else {
      if (rec.manifest.capabilities.includes("agentDiscovery")) {
        const otherDiscoveryEnabled = [...this.records.entries()].some(
          ([id, other]) =>
            id !== pluginId &&
            this.isPluginEnabled(id) &&
            other.manifest.capabilities.includes("agentDiscovery"),
        );
        const allBots = this.db.listAccounts("bot", { includeHidden: true });
        const visibleBotIds: string[] = [];
        const hiddenBotIds: string[] = [];

        for (const bot of allBots) {
          if (bot.source === "seed" && !otherDiscoveryEnabled) {
            if (!bot.visible) {
              this.db.updateAccountFields(bot.id, { visible: true }, true);
            }
            visibleBotIds.push(bot.id);
          } else if (bot.source === `plugin:${pluginId}` || bot.pluginId === pluginId) {
            if (bot.visible) {
              this.db.updateAccountFields(bot.id, { visible: false }, true);
            }
            hiddenBotIds.push(bot.id);
          }
        }

        this.db.appendEvent("plugins.synced", null, {
          pluginId,
          visibleBotIds,
          hiddenBotIds,
          syncedAt: Date.now(),
        });
      }

      rec.health = {
        ok: false,
        status: "disabled",
        version: rec.health.version,
        message: "插件已停用",
      };
      this.db.appendEvent("plugin.updated", null, {
        pluginId,
        action: "toggle",
        enabled: false,
        at: Date.now(),
      });
    }

    return this.getPluginSummary(pluginId);
  }

  async reloadPlugin(pluginId: string): Promise<VlPluginSummary | null> {
    this.scanManifests();
    const rec = this.records.get(pluginId);
    if (!rec) return null;
    rec.instance = null;
    if (this.isPluginEnabled(pluginId)) {
      await this.ensureInstance(pluginId, true);
      await this.syncPlugin(pluginId);
    }
    return this.getPluginSummary(pluginId);
  }

  async ejectPlugin(pluginId: string): Promise<{
    readonly ok: boolean;
    readonly message: string;
    readonly plugin: VlPluginSummary | null;
  }> {
    this.scanManifests();
    const rec = this.records.get(pluginId);
    if (!rec) {
      return { ok: false, message: `Plugin not found: ${pluginId}`, plugin: null };
    }
    const targetDir = NodePath.join(this.userPluginsDir, pluginId);
    if (rec.source === "user") {
      return {
        ok: true,
        message: `插件已位于独立目录：${rec.pluginDir}`,
        plugin: this.getPluginSummary(pluginId),
      };
    }
    if (NodeFS.existsSync(targetDir)) {
      if (NodeFS.existsSync(NodePath.join(targetDir, ".git"))) {
        return {
          ok: false,
          message: `目标目录已存在独立 Git 仓库 (${targetDir})，已拒绝覆盖`,
          plugin: this.getPluginSummary(pluginId),
        };
      }
      const existingFiles = NodeFS.readdirSync(targetDir);
      if (existingFiles.length > 0) {
        return {
          ok: false,
          message: `目标目录非空 (${targetDir})，请手动清理后再迁出`,
          plugin: this.getPluginSummary(pluginId),
        };
      }
    }

    copyDirRecursive(rec.pluginDir, targetDir);
    const reloaded = await this.reloadPlugin(pluginId);
    return {
      ok: true,
      message: `已迁出至独立插件目录：${targetDir}`,
      plugin: reloaded,
    };
  }

  getPluginSummary(pluginId: string): VlPluginSummary | null {
    const rec = this.records.get(pluginId);
    if (!rec) return null;
    const state = this.db.getPluginState(pluginId);
    return {
      id: rec.manifest.id,
      name: rec.manifest.name,
      version: rec.manifest.version,
      description: rec.manifest.description,
      ...(rec.manifest.homepage ? { homepage: rec.manifest.homepage } : {}),
      capabilities: rec.manifest.capabilities,
      source: rec.source,
      pluginDir: rec.pluginDir,
      enabled: state?.enabled ?? rec.manifest.defaultEnabled !== false,
      health: rec.health,
      configuredAgents: rec.configuredAgents,
      unconfiguredAgents: rec.unconfiguredAgents,
      modelsCount: rec.models.length,
      lastSyncAt: state?.lastSyncAt ?? null,
      lastError: state?.lastError ?? null,
    };
  }

  listPlugins(): ReadonlyArray<VlPluginSummary> {
    this.scanManifests();
    return [...this.records.keys()]
      .map((id) => this.getPluginSummary(id))
      .filter((item): item is VlPluginSummary => item !== null);
  }

  async checkUpdate(pluginId: string): Promise<VlPluginUpdateInfo | null> {
    this.scanManifests();
    const rec = this.records.get(pluginId);
    if (!rec) return null;
    const loaded = await this.ensureInstance(pluginId);
    if (!loaded?.instance?.checkUpdate) {
      return {
        ok: true,
        currentVersion: rec.manifest.version,
        latestVersion: rec.manifest.version,
        updateAvailable: false,
        supportsHostUpdate: false,
        supportsPluginGitUpdate: NodeFS.existsSync(NodePath.join(rec.pluginDir, ".git")),
        summary: "该插件未实现独立更新检查接口",
      };
    }
    return loaded.instance.checkUpdate();
  }

  async runUpdate(
    pluginId: string,
    options?: { readonly target?: "host" | "plugin"; readonly force?: boolean },
  ): Promise<VlPluginUpdateResult | null> {
    this.scanManifests();
    const rec = this.records.get(pluginId);
    if (!rec) return null;
    const loaded = await this.ensureInstance(pluginId);
    if (!loaded?.instance?.runUpdate) {
      return {
        ok: false,
        target: options?.target ?? "host",
        beforeVersion: rec.manifest.version,
        afterVersion: rec.manifest.version,
        output: "该插件不支持自动更新",
      };
    }
    const res = await loaded.instance.runUpdate(options);
    if (res.ok) {
      if (res.target === "plugin") {
        await this.reloadPlugin(pluginId);
      } else {
        await this.syncPlugin(pluginId);
      }
    }
    return res;
  }

  listCatalog(): {
    readonly providers: ReadonlyArray<VlProviderOption>;
    readonly models: ReadonlyArray<VlPluginModelDescriptor>;
  } {
    const enabledRecs = [...this.records.entries()]
      .filter(([id]) => this.isPluginEnabled(id))
      .map(([, rec]) => rec);

    const activeConfiguredProviders = new Set<string>();
    const modelMap = new Map<string, VlPluginModelDescriptor>();

    for (const rec of enabledRecs) {
      for (const agent of rec.configuredAgents) {
        activeConfiguredProviders.add(agent.provider.toLowerCase());
      }
      for (const m of rec.models) {
        if (!modelMap.has(m.id)) {
          modelMap.set(m.id, m);
        }
      }
    }

    const models = [...modelMap.values()].toSorted((a, b) => {
      if (a.isRoutingGroup !== b.isRoutingGroup) {
        return a.isRoutingGroup ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });

    const magpieRec = this.records.get("magpie");
    const magpieEnabled = magpieRec !== undefined && this.isPluginEnabled("magpie");
    const hasAuthoritativeDiscovery = enabledRecs.some(
      (rec) =>
        rec.manifest.capabilities.includes("agentDiscovery") &&
        rec.health.status !== "not_installed" &&
        (rec.health.ok || rec.configuredAgents.length > 0),
    );

    const providers: VlProviderOption[] = [
      {
        id: "magpie-gateway",
        label: "Magpie Gateway (本地统一网关)",
        configured:
          magpieEnabled &&
          Boolean(magpieRec && (magpieRec.health.ok || magpieRec.models.length > 0)),
        source: "plugin:magpie",
        description: "通过 Magpie 本地 OpenAI 兼容网关调用所有已激活模型或 auto/* 路由组",
      },
      ...NATIVE_PROVIDER_DEFS.map((def) => ({
        id: def.id,
        label: def.label,
        configured: hasAuthoritativeDiscovery
          ? activeConfiguredProviders.has(def.id)
          : ["codex", "claude", "antigravity", "opencode"].includes(def.id),
        source: "t3_native",
        description: def.description,
      })),
    ];

    return { providers, models };
  }

  hasGatewayChat(): boolean {
    for (const [id, rec] of this.records.entries()) {
      if (
        this.isPluginEnabled(id) &&
        rec.manifest.capabilities.includes("gatewayChat") &&
        (rec.instance === null || typeof rec.instance.chatCompletion === "function")
      ) {
        return true;
      }
    }
    return false;
  }

  async runGatewayChat(input: {
    readonly model: string;
    readonly systemPrompt?: string;
    readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly content: string;
    readonly model: string;
    readonly usage?: Record<string, unknown>;
  }> {
    for (const [id, rec] of this.records.entries()) {
      if (!this.isPluginEnabled(id)) continue;
      if (!rec.manifest.capabilities.includes("gatewayChat")) continue;
      const loaded = await this.ensureInstance(id);
      if (loaded?.instance?.chatCompletion) {
        return loaded.instance.chatCompletion(input);
      }
    }
    throw new Error("未找到已启用的 gatewayChat 插件（如 Magpie）");
  }

  async syncBotModelToPlugin(
    bot: VlAccount,
    model: string,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const pluginId = bot.pluginId || "magpie";
    const externalId = bot.externalId || bot.slug;
    const rec = this.records.get(pluginId);
    if (!rec || !this.isPluginEnabled(pluginId)) {
      return { ok: false, message: `插件 ${pluginId} 未启用或不存在` };
    }
    const loaded = await this.ensureInstance(pluginId);
    if (!loaded?.instance?.syncBotModel) {
      return { ok: false, message: `插件 ${pluginId} 不支持写回配置` };
    }
    return loaded.instance.syncBotModel({ externalId, model });
  }

  async invokePluginAction(
    pluginId: string,
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    this.scanManifests();
    const rec = this.records.get(pluginId);
    if (!rec) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }
    if (!this.isPluginEnabled(pluginId)) {
      throw new Error(`Plugin ${pluginId} is disabled`);
    }
    const loaded = await this.ensureInstance(pluginId);
    if (!loaded?.instance || typeof loaded.instance.invokeAction !== "function") {
      throw new Error(`Plugin ${pluginId} does not support invokeAction`);
    }
    const result = await loaded.instance.invokeAction(action, payload);
    const readOnlyActions = new Set(["status", "getLanShareUri", "probeEgress", "testDelay"]);
    if (!readOnlyActions.has(action)) {
      rec.health = await loaded.instance.health().catch(() => rec.health);
      this.db.appendEvent("plugin.updated", null, {
        pluginId,
        action,
        at: Date.now(),
      });
    }
    return result;
  }
}
