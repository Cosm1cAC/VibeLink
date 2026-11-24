// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "@effect/vitest";

// @ts-expect-error Pure ESM JS plugin module without .d.ts
import {
  createLoopbackCookieProxy,
  createPlugin as createMagpiePlugin,
  parseMagpieLsOutput,
} from "../../../../../../plugins/vibelink-plugin-magpie/index.mjs";
import { VibeLinkAccountStore } from "../accounts.ts";
import { VibeLinkAuth } from "../auth.ts";
import { BotHomeManager } from "../bots/botHome.ts";
import { runSeedMigration } from "../bots/botMigration.ts";
import { VibeLinkOrchestrationBridge } from "../bridge/orchestrationBridge.ts";
import { VibeLinkTerminalBridge } from "../bridge/terminalBridge.ts";
import { VibeLinkClusterManager } from "../cluster.ts";
import { VibeLinkDatabase } from "../db.ts";
import { VibeLinkDeviceHub } from "../devices.ts";
import { dispatchVibeLinkHttp } from "../http.ts";
import { VibeLinkPluginManager } from "../plugins/pluginManager.ts";
import type { VibeLinkServiceShape } from "../service.ts";

const tempDirs: string[] = [];
const activeServers: NodeHttp.Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTestPlugin(
  rootDir: string,
  folderName: string,
  manifest: Record<string, unknown>,
  entryCode: string,
): string {
  const pluginDir = NodePath.join(rootDir, folderName);
  NodeFS.mkdirSync(pluginDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(pluginDir, "plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  NodeFS.writeFileSync(NodePath.join(pluginDir, String(manifest.entry ?? "index.mjs")), entryCode, "utf8");
  return pluginDir;
}

async function callRoute(
  vl: VibeLinkServiceShape,
  method: string,
  url: string,
  body?: unknown,
) {
  return Effect.runPromise(
    dispatchVibeLinkHttp(vl, {
      method,
      url,
      headers: { host: "127.0.0.1:18990" },
      remoteAddress: "127.0.0.1",
      bodyText: body !== undefined ? JSON.stringify(body) : "",
    }),
  );
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

afterEach(async () => {
  for (const srv of activeServers.splice(0, activeServers.length)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("VibeLink Plugin Architecture & Magpie Integration", () => {
  it("parses magpie ls output strictly: shows configured coding agents and hides unconfigured/GLM/host apps", () => {
    const sampleStdout = [
      "  Claude Code       opus  ·  effort —                                                             ~\\.claude\\settings.json",
      "  Codex             gpt-6.2-sol  ·  effort medium                                                 ~\\.codex\\config.toml",
      "  Gemini CLI        auth google  ·  —                                                             ~\\.gemini\\settings.json",
      "  Antigravity       —  ·  effort —                                                                ~\\.antigravity\\settings.json",
      "  OpenCode          magpie/auto/deepseek-v4.1-flash  ·  small magpie/workbuddy-api/glm-5.3-flash  ~\\.config\\opencode\\opencode.json",
      "  VS Code           —                                                                             ~\\AppData\\Roaming\\Code\\User\\settings.json",
      "  DeepSeek Harness  magpie/auto/deepseek-v4.1-flash  ·  thinking high                             ~\\.dsh\\profiles\\web\\cordis.patch.yml",
      "  Grok Build        —  ·  effort —                                                                ~\\.grok\\config.toml",
      "  Grok App          relay                                                                         ~\\AppData\\Roaming\\grokapp\\config.toml",
      "  ZCode             provider —                                                                    ~\\.zcode\\v2\\config.json",
      "  WorkBuddy         provider —                                                                    ~\\.workbuddy\\models.json",
      "  T3 Code           provider —                                                                    ~\\.t3\\userdata\\settings.json",
      "  Cindy             magpie cindy add  to add magpie                                               ~\\AppData\\Roaming\\Cindy",
      "  Antigravity CLI   Orchestrator (Neon)  ·  effort —                                              ~\\.gemini\\antigravity-cli\\magpie-settings.json",
      "  GLM CLI           not detected",
      "  GLM Agent         —                                                                             ~\\.glm\\config.json",
    ].join("\n");

    const parsed = parseMagpieLsOutput(sampleStdout, {
      availableModels: [{ id: "auto/gemini-4-argon" }, { id: "google/models/gemini-3.8-flash" }],
    });

    const configuredIds = parsed.configuredAgents.map((a: { botId: string }) => a.botId);
    expect(configuredIds).toEqual([
      "bot_claude",
      "bot_codex",
      "bot_gemini",
      "bot_opencode",
      "bot_dsh",
      "bot_antigravity",
    ]);

    const opencode = parsed.configuredAgents.find((a: { botId: string }) => a.botId === "bot_opencode");
    expect(opencode?.model).toBe("auto/deepseek-v4.1-flash");

    const gemini = parsed.configuredAgents.find((a: { botId: string }) => a.botId === "bot_gemini");
    expect(gemini?.model).toBe("auto/gemini-4-argon");
    expect(gemini?.provider).toBe("magpie-gateway");

    const dsh = parsed.configuredAgents.find((a: { botId: string }) => a.botId === "bot_dsh");
    expect(dsh?.model).toBe("auto/deepseek-v4.1-flash");
    expect(dsh?.provider).toBe("magpie-gateway");

    const unconfiguredNames = parsed.unconfiguredAgents.map((a: { agentName: string }) => a.agentName);
    expect(unconfiguredNames).toEqual(
      expect.arrayContaining(["Antigravity", "Grok Build", "ZCode", "WorkBuddy", "GLM CLI", "GLM Agent"]),
    );

    const hostNames = parsed.hostApps.map((a: { agentName: string }) => a.agentName);
    expect(hostNames).toEqual(expect.arrayContaining(["VS Code", "Grok App", "T3 Code", "Cindy"]));
  });

  it("prefers user plugin directory over bundled directory and hot-reloads version changes", async () => {
    const home = makeTempDir("vl-plugin-prec-");
    const bundledDir = NodePath.join(home, "bundled");
    const userDir = NodePath.join(home, "user-plugins");

    writeTestPlugin(
      bundledDir,
      "demo",
      {
        id: "demo",
        name: "Demo Plugin",
        version: "0.1.0",
        description: "Bundled version",
        entry: "index.mjs",
        capabilities: ["modelCatalog"],
      },
      `export function createPlugin() {
        return {
          async health() { return { ok: true, status: "running", version: "0.1.0", message: "bundled" }; },
          async listModels() { return []; }
        };
      }`,
    );

    writeTestPlugin(
      userDir,
      "demo",
      {
        id: "demo",
        name: "Demo Plugin",
        version: "0.2.0",
        description: "User override version",
        entry: "index.mjs",
        capabilities: ["modelCatalog"],
      },
      `export function createPlugin() {
        return {
          async health() { return { ok: true, status: "running", version: "0.2.0", message: "user-v2" }; },
          async listModels() { return []; }
        };
      }`,
    );

    const db = new VibeLinkDatabase(home);
    const botHome = new BotHomeManager(home);
    const plugins = new VibeLinkPluginManager(db, botHome, {
      bundledPluginsDir: bundledDir,
      userPluginsDir: userDir,
      watchIntervalMs: 0,
    });

    try {
      await plugins.initialize();
      const first = plugins.getPluginSummary("demo");
      expect(first?.source).toBe("user");
      expect(first?.version).toBe("0.2.0");
      expect(first?.health.version).toBe("0.2.0");

      writeTestPlugin(
        userDir,
        "demo",
        {
          id: "demo",
          name: "Demo Plugin",
          version: "0.3.0",
          description: "Hot-reloaded version",
          entry: "index.mjs",
          capabilities: ["modelCatalog"],
        },
        `export function createPlugin() {
          return {
            async health() { return { ok: true, status: "running", version: "0.3.0", message: "user-v3" }; },
            async listModels() { return []; }
          };
        }`,
      );

      const reloaded = await plugins.reloadPlugin("demo");
      expect(reloaded?.version).toBe("0.3.0");
      expect(reloaded?.health.version).toBe("0.3.0");
    } finally {
      plugins.stop();
      db.close();
    }
  });

  it("reconciles bot visibility from plugin discovery, preserves user edits, and preserves manual bots", async () => {
    const home = makeTempDir("vl-plugin-vis-");
    const userDir = NodePath.join(home, "plugins");
    const stateFile = NodePath.join(home, "mock-discovery.json");

    const writeDiscoveryState = (configured: Array<Record<string, unknown>>) => {
      NodeFS.writeFileSync(
        stateFile,
        JSON.stringify({
          configuredAgents: configured,
          unconfiguredAgents: [
            { externalId: "opencode", agentName: "OpenCode", rawStatus: "—" },
            { externalId: "glm", agentName: "GLM", rawStatus: "not detected" },
          ],
        }),
        "utf8",
      );
    };

    const codexDesc = {
      externalId: "codex",
      botId: "bot_codex",
      slug: "codex",
      handle: "Codex",
      displayName: "Codex",
      agentName: "Codex",
      cliAlias: "codex",
      kind: "coding_agent",
      configured: true,
      rawStatus: "gpt-6.2-sol",
      configPath: "~/.codex/config.toml",
      provider: "codex",
      executionMode: "t3_driver",
      model: "gpt-6.2-sol",
      roleTitle: "implementation",
      isolationMode: "worktree",
      approvalMode: "accept_edits",
      avatar: "/AI/openai.svg",
      pinned: true,
      department: "Magpie · T3 Code",
      description: "Codex via Magpie",
    };
    const claudeDesc = {
      externalId: "claude",
      botId: "bot_claude",
      slug: "claude",
      handle: "Claude",
      displayName: "Claude Code",
      agentName: "Claude Code",
      cliAlias: "claude",
      kind: "coding_agent",
      configured: true,
      rawStatus: "opus",
      configPath: "~/.claude/settings.json",
      provider: "claude",
      executionMode: "t3_driver",
      model: "opus",
      roleTitle: "research",
      isolationMode: "shared",
      approvalMode: "plan",
      avatar: "preset:claude",
      pinned: true,
      department: "Magpie · T3 Code",
      description: "Claude via Magpie",
    };
    const dshDesc = {
      externalId: "dsh",
      botId: "bot_dsh",
      slug: "deepseek",
      handle: "DeepSeek",
      displayName: "DeepSeek Harness",
      agentName: "DeepSeek Harness",
      cliAlias: "dsh",
      kind: "coding_agent",
      configured: true,
      rawStatus: "auto/deepseek-v4.1-flash",
      configPath: "~/.dsh/profile.yml",
      provider: "magpie-gateway",
      executionMode: "magpie_gateway",
      model: "auto/deepseek-v4.1-flash",
      roleTitle: "general",
      isolationMode: "shared",
      approvalMode: "ask",
      avatar: "/AI/deepseek.png",
      pinned: false,
      department: "Magpie · Gateway",
      description: "DSH via Magpie",
    };

    writeDiscoveryState([codexDesc, claudeDesc, dshDesc]);

    writeTestPlugin(
      userDir,
      "magpie",
      {
        id: "magpie",
        name: "Magpie Mock",
        version: "0.1.0",
        description: "Test discovery plugin",
        entry: "index.mjs",
        capabilities: ["agentDiscovery", "modelCatalog"],
      },
      `import fs from "node:fs";
      export function createPlugin() {
        return {
          async health() { return { ok: true, status: "running", version: "0.1.4657", message: "ok" }; },
          async listModels() { return [{ id: "auto/deepseek-v4.1-flash", displayName: "DeepSeek", ownedBy: "auto", isRoutingGroup: true }]; },
          async discoverAgents() {
            const data = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
            return { ...data, hostApps: [], detectedAt: Date.now() };
          }
        };
      }`,
    );

    process.env.VIBELINK_DISABLE_CLUSTER_SYNC = "1";
    const db = new VibeLinkDatabase(home);
    const auth = new VibeLinkAuth(home);
    const accounts = new VibeLinkAccountStore(db, home);
    const cluster = new VibeLinkClusterManager(home, accounts);
    const botHome = new BotHomeManager(home);
    runSeedMigration(db, botHome);
    const plugins = new VibeLinkPluginManager(db, botHome, {
      userPluginsDir: userDir,
      disableBundled: true,
      watchIntervalMs: 0,
    });
    const orchestration = new VibeLinkOrchestrationBridge(db, botHome, null, null, null, plugins);
    const terminal = new VibeLinkTerminalBridge(db, null);
    const devices = new VibeLinkDeviceHub();
    const vl: VibeLinkServiceShape = { db, auth, accounts, cluster, botHome, plugins, orchestration, terminal, devices };

    try {
      await plugins.initialize();

      const boot1 = await callRoute(vl, "GET", "/api/vl/bootstrap");
      expect(boot1.status).toBe(200);
      const data1 = boot1.json as {
        accounts: Array<{ id: string }>;
        rooms: Array<{ id: string; kind: string; memberCount: number; members: Array<{ accountId: string }> }>;
      };

      const visibleBotIds1 = data1.accounts.filter((a) => a.id !== "me").map((a) => a.id);
      expect(visibleBotIds1).toEqual(expect.arrayContaining(["bot_codex", "bot_claude", "bot_dsh"]));
      expect(visibleBotIds1).not.toContain("bot_opencode");
      expect(visibleBotIds1).not.toContain("bot_antigravity");
      expect(visibleBotIds1).not.toContain("bot_glm");

      const roomIds1 = data1.rooms.map((r) => r.id);
      expect(roomIds1).toEqual(expect.arrayContaining(["grp_workspace", "dm_bot_codex", "dm_bot_claude", "dm_bot_dsh"]));
      expect(roomIds1).not.toContain("dm_bot_opencode");
      expect(roomIds1).not.toContain("dm_bot_antigravity");

      const grp1 = data1.rooms.find((r) => r.id === "grp_workspace");
      expect(grp1?.memberCount).toBe(4);
      expect(grp1?.members.map((m) => m.accountId)).not.toContain("bot_opencode");

      // Customize bot_codex and SOUL.md, plus add a manual bot
      await callRoute(vl, "PATCH", "/api/vl/bots/bot_codex", {
        displayName: "Codex 自定义",
        avatar: "/avatar/005.webp",
      });
      await callRoute(vl, "PUT", "/api/vl/bots/bot_codex/files/SOUL.md", {
        content: "# Custom Codex Soul\nKeep my edits.\n",
      });
      const manualRes = await callRoute(vl, "POST", "/api/vl/bots", {
        displayName: "MyManualBot",
        handle: "ManualBot",
        provider: "magpie-gateway",
        model: "auto/deepseek-v4.1-flash",
      });
      expect(manualRes.status).toBe(201);

      // Re-sync with DeepSeek Harness now removed/unconfigured
      writeDiscoveryState([codexDesc, claudeDesc]);
      const resync = await callRoute(vl, "POST", "/api/vl/plugins/magpie/sync", {});
      expect(resync.status).toBe(200);

      const botsRes = await callRoute(vl, "GET", "/api/vl/bots");
      const bots2 = (botsRes.json as { bots: Array<{ id: string; displayName: string; avatar: string }> }).bots;
      expect(bots2.map((b) => b.id)).toEqual(expect.arrayContaining(["bot_codex", "bot_claude", "bot_mymanualbot"]));
      expect(bots2.map((b) => b.id)).not.toContain("bot_dsh");

      const editedCodex = bots2.find((b) => b.id === "bot_codex");
      expect(editedCodex?.displayName).toBe("Codex 自定义");
      expect(editedCodex?.avatar).toBe("/avatar/005.webp");
      const soulRes = await callRoute(vl, "GET", "/api/vl/bots/bot_codex/files/SOUL.md");
      expect((soulRes.json as { content: string }).content).toContain("Keep my edits.");

      // Hidden bot still exists in DB without losing history
      expect(db.getAccount("bot_dsh")?.visible).toBe(false);
    } finally {
      plugins.stop();
      await Effect.runPromise(orchestration.stop());
      db.close();
    }
  });

  it("supports ejecting a bundled plugin to ~/.vibelink/plugins/<id>", async () => {
    const home = makeTempDir("vl-plugin-eject-");
    const bundledDir = NodePath.join(home, "bundled");
    const userDir = NodePath.join(home, "user-plugins");

    writeTestPlugin(
      bundledDir,
      "vibelink-plugin-magpie",
      {
        id: "magpie",
        name: "Magpie Bundled",
        version: "0.1.0",
        description: "Bundled test plugin",
        entry: "index.mjs",
        capabilities: ["modelCatalog"],
      },
      `export function createPlugin() {
        return {
          async health() { return { ok: true, status: "running", version: "0.1.0", message: "ok" }; },
          async listModels() { return []; }
        };
      }`,
    );

    process.env.VIBELINK_DISABLE_CLUSTER_SYNC = "1";
    const db = new VibeLinkDatabase(home);
    const auth = new VibeLinkAuth(home);
    const accounts = new VibeLinkAccountStore(db, home);
    const cluster = new VibeLinkClusterManager(home, accounts);
    const botHome = new BotHomeManager(home);
    const plugins = new VibeLinkPluginManager(db, botHome, {
      bundledPluginsDir: bundledDir,
      userPluginsDir: userDir,
      watchIntervalMs: 0,
    });
    const orchestration = new VibeLinkOrchestrationBridge(db, botHome, null, null, null, plugins);
    const terminal = new VibeLinkTerminalBridge(db, null);
    const devices = new VibeLinkDeviceHub();
    const vl: VibeLinkServiceShape = { db, auth, accounts, cluster, botHome, plugins, orchestration, terminal, devices };

    try {
      await plugins.initialize();
      expect(plugins.getPluginSummary("magpie")?.source).toBe("bundled");

      const ejectRes = await callRoute(vl, "POST", "/api/vl/plugins/magpie/eject", {});
      expect(ejectRes.status).toBe(200);
      expect(NodeFS.existsSync(NodePath.join(userDir, "magpie", "plugin.json"))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(userDir, "magpie", "index.mjs"))).toBe(true);

      const listRes = await callRoute(vl, "GET", "/api/vl/plugins");
      const magpieSummary = (
        listRes.json as { plugins: Array<{ id: string; source: string }> }
      ).plugins.find((p) => p.id === "magpie");
      expect(magpieSummary?.source).toBe("user");
    } finally {
      plugins.stop();
      await Effect.runPromise(orchestration.stop());
      db.close();
    }
  });

  it("routes magpie-gateway bots to live local OpenAI-compatible HTTP gateway and triggers group @Handle handoffs", async () => {
    const home = makeTempDir("vl-plugin-gw-");
    const userDir = NodePath.join(home, "plugins");

    const receivedCalls: Array<{ model: string; userPrompt: string }> = [];
    const server = NodeHttp.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "auto/deepseek-v4.1-flash", display_name: "DeepSeek", owned_by: "auto" },
              { id: "auto/gpt-6.1-sol", display_name: "GPT 6.1", owned_by: "auto" },
            ],
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (chunk) => {
          body += String(chunk);
        });
        req.on("end", () => {
          const parsed = JSON.parse(body) as {
            model: string;
            messages: Array<{ role: string; content: string }>;
          };
          const lastUser = parsed.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
          receivedCalls.push({ model: parsed.model, userPrompt: lastUser });
          const isPrimary = parsed.model === "auto/deepseek-v4.1-flash";
          const reply = isPrimary
            ? "已完成初步排查，请 @Verifier 收尾确认。"
            : "Verifier 已通过网关完成最终确认。";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              model: parsed.model,
              choices: [{ message: { role: "assistant", content: reply } }],
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServers.push(server);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const prevMagpieAddr = process.env.MAGPIE_ADDR;
    const prevMockBots = process.env.VIBELINK_MOCK_BOTS;
    delete process.env.VIBELINK_MOCK_BOTS;
    process.env.MAGPIE_ADDR = `http://127.0.0.1:${port}`;

    // Verify the real bundled Magpie plugin's listModels + chatCompletion works against ephemeral HTTP gateway
    const realMagpie = createMagpiePlugin({});
    const liveModels = await realMagpie.listModels();
    expect(liveModels.map((m: { id: string }) => m.id)).toContain("auto/deepseek-v4.1-flash");

    // Mount a lightweight gatewayChat wrapper plugin delegating to realMagpie.chatCompletion
    writeTestPlugin(
      userDir,
      "gateway-e2e",
      {
        id: "gateway-e2e",
        name: "Magpie Gateway E2E",
        version: "0.1.0",
        description: "Gateway test",
        entry: "index.mjs",
        capabilities: ["gatewayChat", "modelCatalog"],
      },
      `import { createPlugin as createReal } from ${JSON.stringify(
        NodePath.resolve("D:/AI/VibeLink/plugins/vibelink-plugin-magpie/index.mjs"),
      ).replace(/\\/g, "\\\\")};
      export function createPlugin(ctx) {
        const real = createReal(ctx);
        return {
          health: async () => ({ ok: true, status: "running", version: "0.1.4657", message: "e2e" }),
          listModels: () => real.listModels(),
          chatCompletion: (input) => real.chatCompletion(input)
        };
      }`,
    );

    process.env.VIBELINK_DISABLE_CLUSTER_SYNC = "1";
    const db = new VibeLinkDatabase(home);
    const auth = new VibeLinkAuth(home);
    const accounts = new VibeLinkAccountStore(db, home);
    const cluster = new VibeLinkClusterManager(home, accounts);
    const botHome = new BotHomeManager(home);
    runSeedMigration(db, botHome);
    const plugins = new VibeLinkPluginManager(db, botHome, {
      userPluginsDir: userDir,
      disableBundled: true,
      watchIntervalMs: 0,
    });
    const orchestration = new VibeLinkOrchestrationBridge(db, botHome, null, null, null, plugins);
    const terminal = new VibeLinkTerminalBridge(db, null);
    const devices = new VibeLinkDeviceHub();
    const vl: VibeLinkServiceShape = { db, auth, accounts, cluster, botHome, plugins, orchestration, terminal, devices };

    try {
      await plugins.initialize();

      const gwBotRes = await callRoute(vl, "POST", "/api/vl/bots", {
        displayName: "Planner",
        handle: "Planner",
        provider: "magpie-gateway",
        model: "auto/deepseek-v4.1-flash",
      });
      const gwBotId = (gwBotRes.json as { bot: { id: string } }).bot.id;

      const followBotRes = await callRoute(vl, "POST", "/api/vl/bots", {
        displayName: "Verifier",
        handle: "Verifier",
        provider: "magpie-gateway",
        model: "auto/gpt-6.1-sol",
      });
      const followBotId = (followBotRes.json as { bot: { id: string } }).bot.id;

      const grpRes = await callRoute(vl, "POST", "/api/vl/rooms", {
        kind: "group",
        name: "网关协作群",
        botIds: [gwBotId, followBotId],
      });
      const grpId = (grpRes.json as { room: { id: string } }).room.id;

      const sendRes = await callRoute(vl, "POST", `/api/vl/rooms/${grpId}/messages`, {
        content: "@Planner 请走 Magpie 网关分析并接力",
      });
      expect(sendRes.status).toBe(201);

      const msgs = await waitFor(async () => {
        const res = await callRoute(vl, "GET", `/api/vl/rooms/${grpId}/messages`);
        const list = (res.json as { messages: Array<{ senderId: string; content: string; metadata: Record<string, unknown> }> }).messages;
        const hasPlanner = list.some((m) => m.senderId === gwBotId && m.content.includes("已完成初步排查"));
        const hasVerifier = list.some((m) => m.senderId === followBotId && m.content.includes("Verifier 已通过网关完成最终确认"));
        return hasPlanner && hasVerifier ? list : null;
      });

      expect(msgs.some((m) => m.metadata?.mock === true)).toBe(false);
      expect(receivedCalls.map((c) => c.model)).toEqual([
        "auto/deepseek-v4.1-flash",
        "auto/gpt-6.1-sol",
      ]);
    } finally {
      plugins.stop();
      await Effect.runPromise(orchestration.stop());
      db.close();
      if (prevMagpieAddr === undefined) delete process.env.MAGPIE_ADDR;
      else process.env.MAGPIE_ADDR = prevMagpieAddr;
      if (prevMockBots === undefined) delete process.env.VIBELINK_MOCK_BOTS;
      else process.env.VIBELINK_MOCK_BOTS = prevMockBots;
    }
  });

  it("parses manifest.ui dock entries and exposes them on listPlugins() + calls dispose() on stop", async () => {
    const home = makeTempDir("vl-plugin-ui-home-");
    const bundledDir = makeTempDir("vl-plugin-ui-bundled-");
    const userDir = makeTempDir("vl-plugin-ui-user-");

    let disposed = false;
    writeTestPlugin(
      userDir,
      "docked-magpie",
      {
        id: "docked-magpie",
        name: "Magpie 控制台",
        version: "0.1.0",
        description: "Test docked plugin",
        entry: "index.mjs",
        capabilities: ["gatewayChat"],
        ui: {
          dock: "rail",
          label: "Magpie",
          icon: "magpie",
          viewMode: "iframe",
          order: 10,
          embedAction: "ensureWebUi",
        },
        defaultEnabled: true,
      },
      `export function createPlugin() {
        return {
          health: async () => ({ ok: true, status: "running", version: "0.1.4728", message: "ok" }),
          dispose: async () => { globalThis.__vlPluginDisposed = true; },
        };
      }`,
    );

    const db = new VibeLinkDatabase(home);
    const botHome = new BotHomeManager(home);
    const manager = new VibeLinkPluginManager(db, botHome, {
      bundledPluginsDir: bundledDir,
      userPluginsDir: userDir,
      disableBundled: true,
      watchIntervalMs: 0,
    });

    try {
      (globalThis as { __vlPluginDisposed?: boolean }).__vlPluginDisposed = false;
      await manager.initialize();
      const summary = manager.listPlugins().find((p) => p.id === "docked-magpie");
      expect(summary?.ui).toEqual({
        dock: "rail",
        label: "Magpie",
        icon: "magpie",
        viewMode: "iframe",
        order: 10,
        embedAction: "ensureWebUi",
      });
    } finally {
      manager.stop();
      disposed = Boolean((globalThis as { __vlPluginDisposed?: boolean }).__vlPluginDisposed);
      delete (globalThis as { __vlPluginDisposed?: boolean }).__vlPluginDisposed;
      db.close();
    }

    expect(disposed).toBe(true);
  });

  it("createLoopbackCookieProxy injects auth cookie, rewrites Host/Origin, and strips frame-blocking headers", async () => {
    let seenHeaders: NodeHttp.IncomingHttpHeaders = {};
    const upstream = NodeHttp.createServer((req, res) => {
      seenHeaders = req.headers;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
      });
      res.end("<html><title>magpie</title></html>");
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await createLoopbackCookieProxy({
      targetPort: upstreamPort,
      cookieName: `magpie_web_${upstreamPort}`,
      cookieValue: "secret_cookie_value_1234",
      preferredPort: 0,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`, {
        headers: {
          Origin: "http://tauri.localhost",
          Cookie: "other=1",
        },
      });
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("<title>magpie</title>");
      expect(seenHeaders.host).toBe(`127.0.0.1:${upstreamPort}`);
      expect(seenHeaders.origin).toBe(`http://127.0.0.1:${upstreamPort}`);
      expect(seenHeaders.cookie).toContain(`magpie_web_${upstreamPort}=secret_cookie_value_1234`);
      expect(seenHeaders.cookie).toContain("other=1");
      expect(res.headers.get("x-frame-options")).toBeNull();
      expect(res.headers.get("content-security-policy")).toBe("default-src 'self'; script-src 'self'");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
