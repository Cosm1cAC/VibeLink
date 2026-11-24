// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { resetAuthRateLimits } from "../accountRoutes.ts";
import { VibeLinkAccountStore } from "../accounts.ts";
import { VibeLinkAuth } from "../auth.ts";
import { BotHomeManager } from "../bots/botHome.ts";
import { runSeedMigration } from "../bots/botMigration.ts";
import { VibeLinkOrchestrationBridge } from "../bridge/orchestrationBridge.ts";
import { VibeLinkTerminalBridge } from "../bridge/terminalBridge.ts";
import { VibeLinkClusterManager } from "../cluster.ts";
import { VibeLinkDatabase } from "../db.ts";
import { VibeLinkDeviceHub } from "../devices.ts";
import { invalidateMagpieModelCache } from "../gateway.ts";
import { dispatchVibeLinkHttp } from "../http.ts";
import { VibeLinkPluginManager } from "../plugins/pluginManager.ts";
import type { VibeLinkServiceShape } from "../service.ts";
import { startStandbyServer } from "../standbyServer.ts";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const fn of cleanups.splice(0, cleanups.length)) {
    await fn();
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.VIBELINK_CLUSTER_ROLE;
  delete process.env.VIBELINK_CLUSTER_SECRET;
  delete process.env.VIBELINK_CLUSTER_PEER_URL;
  delete process.env.VIBELINK_ADMIN_PASSWORD;
  delete process.env.VIBELINK_DISABLE_CLUSTER_SYNC;
  delete process.env.VIBELINK_DISABLE_MAGPIE_BRIDGE;
  delete process.env.MAGPIE_ADDR;
  delete process.env.MAGPIE_GATEWAY_KEY;
  invalidateMagpieModelCache();
  resetAuthRateLimits();
});

function createPrimaryFixture(clusterSecret = "test_cluster_secret_0123456789abcdef") {
  process.env.VIBELINK_DISABLE_CLUSTER_SYNC = "1";
  process.env.VIBELINK_DISABLE_MAGPIE_BRIDGE = "1";
  process.env.VIBELINK_ADMIN_PASSWORD = "AdminPass123!";
  process.env.VIBELINK_CLUSTER_ROLE = "primary";
  process.env.VIBELINK_CLUSTER_SECRET = clusterSecret;
  process.env.VIBELINK_CLUSTER_PEER_URL = "";

  const home = makeTempDir("vibelink-acct-primary-");
  const db = new VibeLinkDatabase(home);
  const auth = new VibeLinkAuth(home);
  const accounts = new VibeLinkAccountStore(db, home);
  const cluster = new VibeLinkClusterManager(home, accounts);
  const botHome = new BotHomeManager(home);
  runSeedMigration(db, botHome);
  const plugins = new VibeLinkPluginManager(db, botHome, {
    disableBundled: true,
    watchIntervalMs: 0,
  });
  const orchestration = new VibeLinkOrchestrationBridge(db, botHome, null, null, null, plugins);
  const terminal = new VibeLinkTerminalBridge(db, null);
  const devices = new VibeLinkDeviceHub();
  const vl: VibeLinkServiceShape = {
    db,
    auth,
    accounts,
    cluster,
    botHome,
    plugins,
    orchestration,
    terminal,
    devices,
  };

  cleanups.push(async () => {
    cluster.stop();
    devices.dispose();
    plugins.stop();
    await Effect.runPromise(orchestration.stop());
    db.close();
  });

  return { home, vl };
}

async function callPrimary(
  vl: VibeLinkServiceShape,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  remoteAddress = "127.0.0.1",
) {
  return Effect.runPromise(
    dispatchVibeLinkHttp(vl, {
      method,
      url,
      headers: { host: "127.0.0.1:18990", ...headers },
      remoteAddress,
      bodyText: body !== undefined ? JSON.stringify(body) : "",
    }),
  );
}

describe("VibeLink Account, Welfare, /v1 Gateway & Primary/Standby Cluster", () => {
  it("handles invite registration, RBAC isolation, direct welfare grant, CDK redeem, and OpenAI /v1 token billing", async () => {
    const { vl } = createPrimaryFixture();

    // 1. Admin logs in via username/password
    const adminLogin = await callPrimary(vl, "POST", "/api/vl/auth/login", {
      username: "admin",
      password: "AdminPass123!",
    });
    expect(adminLogin.status).toBe(200);
    const adminSession = (adminLogin.json as { sessionToken: string }).sessionToken;
    expect(adminSession).toMatch(/^vls_/);

    // 2. Admin creates an invite code with 5000 welcome tokens, maxUses = 1
    const invRes = await callPrimary(
      vl,
      "POST",
      "/api/vl/admin/invites",
      { code: "VIP2026", grantTokens: 5000, maxUses: 1, note: "测试邀请" },
      { authorization: `Bearer ${adminSession}` },
    );
    expect(invRes.status).toBe(201);

    // 3. Regular user registers with invite code -> receives 5000 welcome tokens
    const regRes = await callPrimary(
      vl,
      "POST",
      "/api/vl/auth/register",
      { username: "alice", password: "alicePassword1", displayName: "Alice", inviteCode: "vip2026" },
      { host: "192.168.5.2:18990" },
      "192.168.5.50",
    );
    expect(regRes.status).toBe(201);
    const regData = regRes.json as { user: { id: string; role: string; tokenBalance: number }; sessionToken: string };
    expect(regData.user.role).toBe("user");
    expect(regData.user.tokenBalance).toBe(5000);
    const aliceToken = regData.sessionToken;

    // Second registration with exhausted invite code fails
    const regAgain = await callPrimary(vl, "POST", "/api/vl/auth/register", {
      username: "bob",
      password: "bobPassword1",
      inviteCode: "VIP2026",
    });
    expect(regAgain.status).toBe(400);

    // 4. RBAC: regular user cannot access admin or PC host control endpoints even from loopback
    const forbiddenAdmin = await callPrimary(
      vl,
      "GET",
      "/api/vl/admin/users",
      undefined,
      { authorization: `Bearer ${aliceToken}` },
      "127.0.0.1",
    );
    expect(forbiddenAdmin.status).toBe(403);

    const forbiddenBootstrap = await callPrimary(
      vl,
      "GET",
      "/api/vl/bootstrap",
      undefined,
      { authorization: `Bearer ${aliceToken}` },
      "127.0.0.1",
    );
    expect(forbiddenBootstrap.status).toBe(403);

    // 5. Admin grants custom secret + tokens directly & creates a CDK redeem code
    const directGrant = await callPrimary(
      vl,
      "POST",
      `/api/vl/admin/users/${regData.user.id}/grant`,
      {
        kind: "custom_secret",
        title: "专属中转福利",
        tokenAmount: 2000,
        payload: { secret: "sk-custom-partner-xyz", note: "仅限本人" },
      },
      { authorization: `Bearer ${adminSession}` },
    );
    expect(directGrant.status).toBe(201);

    const cdkRes = await callPrimary(
      vl,
      "POST",
      "/api/vl/admin/welfare",
      { kind: "redeem_code", title: "免费额度包", code: "FREE3000", tokenAmount: 3000, maxClaims: 5 },
      { authorization: `Bearer ${adminSession}` },
    );
    expect(cdkRes.status).toBe(201);

    const redeemRes = await callPrimary(
      vl,
      "POST",
      "/api/vl/welfare/redeem",
      { code: "free3000" },
      { authorization: `Bearer ${aliceToken}` },
    );
    expect(redeemRes.status).toBe(200);
    expect((redeemRes.json as { user: { tokenBalance: number } }).user.tokenBalance).toBe(10000);

    // Duplicate claim fails
    const dupRedeem = await callPrimary(
      vl,
      "POST",
      "/api/vl/welfare/redeem",
      { code: "FREE3000" },
      { authorization: `Bearer ${aliceToken}` },
    );
    expect(dupRedeem.status).toBe(400);

    // 6. Create personal sk-vl-... API Key & test /v1 OpenAI-compatible gateway against mock upstream
    const mockOpenAi = NodeHttp.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        expect(req.headers.authorization).toBe("Bearer sk-upstream-secret-999");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            model: "gpt-4o-mini",
            choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 },
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockOpenAi.listen(0, "127.0.0.1", () => resolve()));
    const mockPort = (mockOpenAi.address() as { port: number }).port;
    cleanups.push(() => new Promise<void>((resolve) => mockOpenAi.close(() => resolve())));

    const upsRes = await callPrimary(
      vl,
      "POST",
      "/api/vl/admin/upstreams",
      {
        name: "Mock OpenAI",
        baseUrl: `http://127.0.0.1:${mockPort}`,
        apiKey: "sk-upstream-secret-999",
        models: ["gpt-4o-mini", "deepseek-chat"],
        priority: 10,
        enabled: true,
        rateMultiplier: 2,
      },
      { authorization: `Bearer ${adminSession}` },
    );
    expect(upsRes.status).toBe(200);
    expect((upsRes.json as { upstream: { apiKeyMasked: string } }).upstream.apiKeyMasked).not.toContain(
      "sk-upstream-secret-999",
    );

    const keyCreateRes = await callPrimary(
      vl,
      "POST",
      "/api/vl/welfare/keys",
      { name: "Alice Key", allowedModels: ["gpt-4o-mini"] },
      { authorization: `Bearer ${aliceToken}` },
    );
    expect(keyCreateRes.status).toBe(201);
    const aliceApiKey = (keyCreateRes.json as { key: { key: string } }).key.key;
    expect(aliceApiKey).toMatch(/^sk-vl-/);

    const modelsRes = await callPrimary(vl, "GET", "/v1/models", undefined, {
      authorization: `Bearer ${aliceApiKey}`,
    });
    expect(modelsRes.status).toBe(200);
    expect((modelsRes.json as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(["gpt-4o-mini"]);

    const chatRes = await callPrimary(
      vl,
      "POST",
      "/v1/chat/completions",
      { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] },
      { authorization: `Bearer ${aliceApiKey}` },
    );
    expect(chatRes.status).toBe(200);

    // Balance should deduct 250 * 2 (rateMultiplier) = 500 -> 10000 - 500 = 9500
    const mineRes = await callPrimary(vl, "GET", "/api/vl/welfare/mine", undefined, {
      authorization: `Bearer ${aliceToken}`,
    });
    expect((mineRes.json as { user: { tokenBalance: number; tokenUsed: number } }).user.tokenBalance).toBe(9500);
    expect((mineRes.json as { user: { tokenUsed: number } }).user.tokenUsed).toBe(500);

    // Exhaust balance and confirm 402 insufficient_quota
    await callPrimary(
      vl,
      "PATCH",
      `/api/vl/admin/users/${regData.user.id}`,
      { tokenBalanceDelta: -9500, reason: "test_zero" },
      { authorization: `Bearer ${adminSession}` },
    );
    const depletedRes = await callPrimary(
      vl,
      "POST",
      "/v1/chat/completions",
      { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] },
      { authorization: `Bearer ${aliceApiKey}` },
    );
    expect(depletedRes.status).toBe(402);
  });

  it("replicates Primary -> Standby and merges Standby failover claims back to Primary", async () => {
    const clusterSecret = "cluster_secret_ha_test_0123456789abcdef";
    const standbyHome = makeTempDir("vibelink-standby-ha-");

    process.env.VIBELINK_CLUSTER_ROLE = "standby";
    process.env.VIBELINK_CLUSTER_SECRET = clusterSecret;
    process.env.VIBELINK_CLUSTER_PEER_URL = "";
    process.env.VIBELINK_ADMIN_PASSWORD = "AdminPass123!";
    const standby = await startStandbyServer({
      homeDir: standbyHome,
      host: "127.0.0.1",
      port: 0,
      disableSyncLoop: true,
    });
    cleanups.push(() => standby.close());

    const { vl } = createPrimaryFixture(clusterSecret);
    vl.cluster.updateConfig({
      role: "primary",
      peerUrl: `http://127.0.0.1:${standby.port}`,
      standbyTailscaleUrl: `http://127.0.0.1:${standby.port}`,
    });

    // Create invite, register user, create CDK on Primary
    const inv = vl.accounts.createInvite("usr_admin", { code: "HAINV", grantTokens: 1200, maxUses: 2 });
    expect(inv.code).toBe("HAINV");
    const reg = vl.accounts.registerWithInvite({
      username: "charlie",
      password: "charliePassword1",
      inviteCode: "HAINV",
    });
    vl.accounts.createWelfareGrant("usr_admin", {
      kind: "redeem_code",
      title: "HA 备用福利",
      code: "HAEXTRA800",
      tokenAmount: 800,
      maxClaims: 2,
    });

    // Sync Primary -> Standby
    const syncRes = await vl.cluster.syncWithPeerNow({ force: true });
    expect(syncRes.ok).toBe(true);

    // Simulate Primary offline: redeem HAEXTRA800 directly on Standby over HTTP
    const standbyLogin = await fetch(`http://127.0.0.1:${standby.port}/api/vl/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "charlie", password: "charliePassword1" }),
    });
    expect(standbyLogin.status).toBe(200);
    const standbyLoginJson = (await standbyLogin.json()) as {
      sessionToken: string;
      user: { tokenBalance: number };
    };
    expect(standbyLoginJson.user.tokenBalance).toBe(1200);

    const standbyRedeem = await fetch(`http://127.0.0.1:${standby.port}/api/vl/welfare/redeem`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${standbyLoginJson.sessionToken}`,
      },
      body: JSON.stringify({ code: "HAEXTRA800" }),
    });
    expect(standbyRedeem.status).toBe(200);
    expect(standby.accounts.isStandbyDirty()).toBe(true);

    // Primary reconnects & syncs -> should merge Standby failover claim (1200 + 800 = 2000) cleanly
    const resync = await vl.cluster.syncWithPeerNow({ force: false });
    expect(resync.ok).toBe(true);
    expect(resync.action).toBe("merged_and_pushed");
    expect(vl.accounts.getUserByUsername("charlie")?.tokenBalance).toBe(2000);
    expect(standby.accounts.getUserByUsername("charlie")?.tokenBalance).toBe(2000);
    expect(standby.accounts.isStandbyDirty()).toBe(false);
  });

  it("hard-blocks Claude/Gemini proxy via Magpie, enforces 10M/day non-cumulative DeepSeek V4.1 & admin-only GPT-6.1 Sol quotas, and replicates cleanly", async () => {
    const clusterSecret = "cluster_secret_magpie_bridge_0123456789";
    const standbyHome = makeTempDir("vibelink-standby-magpie-");

    // Start mock Magpie gateway exposing all models (including forbidden Claude/Gemini ones)
    const mockMagpie = NodeHttp.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const rawBody = Buffer.concat(chunks).toString("utf8");

      if (req.url === "/v1/models" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "auto/deepseek-v4.1-flash", owned_by: "workbuddy", display_name: "DeepSeek V4.1 Flash" },
              { id: "auto/gpt-6.1-sol", owned_by: "codex", display_name: "GPT 6.1 Sol" },
              { id: "auto/claude-sonnet-5-5", owned_by: "anthropic", display_name: "Claude Sonnet 5.5" },
              { id: "auto/gemini-4-argon", owned_by: "google", display_name: "Gemini 4 Argon" },
              { id: "anthropic/claude-opus-5-5", owned_by: "anthropic", display_name: "Claude Opus 5.5" },
            ],
          }),
        );
        return;
      }

      // User sk-vl-... API Key must never leak upstream to Magpie
      expect(String(req.headers.authorization || "")).not.toContain("sk-vl-");
      expect(String(req.headers["x-api-key"] || "")).not.toContain("sk-vl-");

      const body = JSON.parse(rawBody || "{}") as { model?: string; stream?: boolean };
      expect(String(body.model || "")).not.toMatch(/^magpie\//);
      // Mock Magpie should NEVER even receive Claude or Gemini traffic
      expect(String(body.model || "")).not.toMatch(/claude|anthropic|gemini|google|antigravity/i);

      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-magpie-1",
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "OK" } }],
            usage: { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 },
          }),
        );
        return;
      }

      if (req.url === "/v1/responses" && req.method === "POST") {
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          res.end(
            [
              'event: response.output_text.delta',
              'data: {"type":"response.output_text.delta","delta":"hello"}',
              '',
              'event: response.completed',
              'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":15,"output_tokens":25,"total_tokens":40}}}',
              '',
            ].join("\n"),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "resp_1",
            output_text: "Responses OK",
            usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 },
          }),
        );
        return;
      }

      if (req.url === "/v1/messages" && req.method === "POST") {
        expect(req.headers["anthropic-version"]).toBe("2023-06-01");
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          res.end(
            [
              'event: message_start',
              'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":18,"cache_read_input_tokens":2,"output_tokens":0}}}',
              '',
              'event: content_block_delta',
              'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"DS"}}',
              '',
              'event: message_delta',
              'data: {"type":"message_delta","usage":{"output_tokens":30}}',
              '',
            ].join("\n"),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            content: [{ type: "text", text: "DS OK" }],
            usage: { input_tokens: 25, output_tokens: 35 },
          }),
        );
        return;
      }

      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockMagpie.listen(0, "127.0.0.1", () => resolve()));
    const mockMagpiePort = (mockMagpie.address() as { port: number }).port;
    cleanups.push(() => new Promise<void>((resolve) => mockMagpie.close(() => resolve())));

    process.env.VIBELINK_CLUSTER_ROLE = "standby";
    process.env.VIBELINK_CLUSTER_SECRET = clusterSecret;
    process.env.VIBELINK_CLUSTER_PEER_URL = "";
    process.env.VIBELINK_ADMIN_PASSWORD = "AdminPass123!";
    const standby = await startStandbyServer({
      homeDir: standbyHome,
      host: "127.0.0.1",
      port: 0,
      disableSyncLoop: true,
    });
    cleanups.push(() => standby.close());

    const { vl } = createPrimaryFixture(clusterSecret);
    vl.cluster.updateConfig({
      role: "primary",
      peerUrl: `http://127.0.0.1:${standby.port}`,
      standbyTailscaleUrl: `http://127.0.0.1:${standby.port}`,
    });

    const baseDayMs = new Date(2026, 10, 24, 10, 0, 0).getTime();
    let mockNowMs = baseDayMs;
    vl.accounts.setNowProvider(() => mockNowMs);

    const adminLogin = await callPrimary(vl, "POST", "/api/vl/auth/login", {
      username: "admin",
      password: "AdminPass123!",
    });
    const adminSession = (adminLogin.json as { sessionToken: string }).sessionToken;

    // Attempting to allow wildcard or Claude/Gemini MUST be rejected (400)
    const badWildcard = await callPrimary(
      vl,
      "POST",
      "/api/vl/admin/upstreams/magpie",
      { allowedModels: ["*"] },
      { authorization: `Bearer ${adminSession}` },
    );
    expect(badWildcard.status).toBe(400);

    const badClaude = await callPrimary(
      vl,
      "POST",
      "/api/vl/admin/upstreams/magpie",
      { allowedModels: ["auto/claude-sonnet-5-5"] },
      { authorization: `Bearer ${adminSession}` },
    );
    expect(badClaude.status).toBe(400);

    // Valid Magpie bridge config locked to the two approved channels
    const bridgeSet = await callPrimary(
      vl,
      "POST",
      "/api/vl/admin/upstreams/magpie",
      {
        enabled: true,
        allowedModels: ["auto/deepseek-v4.1-flash", "auto/gpt-6.1-sol"],
        rateMultiplier: 1,
        urlOverride: `http://127.0.0.1:${mockMagpiePort}`,
      },
      { authorization: `Bearer ${adminSession}` },
    );
    expect(bridgeSet.status).toBe(200);
    const bridgeJson = bridgeSet.json as {
      magpieBridge: { status: { running: boolean; modelsCount: number; totalLocalModels: number } };
    };
    expect(bridgeJson.magpieBridge.status.running).toBe(true);
    expect(bridgeJson.magpieBridge.status.modelsCount).toBe(2);
    expect(bridgeJson.magpieBridge.status.totalLocalModels).toBe(5);

    // Register regular user -> 10M daily DeepSeek V4.1, 0 bonus, 0 GPT
    vl.accounts.createInvite("usr_admin", { code: "MAGPIE1", grantTokens: 0, maxUses: 1 });
    const reg = vl.accounts.registerWithInvite({
      username: "magpie_user",
      password: "userPassword1",
      inviteCode: "MAGPIE1",
    });
    expect(reg.user.deepseekDailyQuota).toBe(10_000_000);
    expect(reg.user.deepseekDailyRemaining).toBe(10_000_000);
    expect(reg.user.tokenBalance).toBe(0);
    expect(reg.user.gptBalance).toBe(0);

    const userKey = vl.accounts.createUserApiKey(reg.user.id, { name: "Beta Key" }).key!;

    // /api/vl/welfare/mine and /v1/models expose ONLY auto/deepseek-v4.1-flash (NO Claude, NO Gemini, NO GPT yet)
    const mineBefore = await callPrimary(
      vl,
      "GET",
      "/api/vl/welfare/mine",
      undefined,
      { authorization: `Bearer ${reg.sessionToken}` },
    );
    expect((mineBefore.json as { availableModels: string[] }).availableModels).toEqual([
      "auto/deepseek-v4.1-flash",
    ]);

    const modelsRes = await callPrimary(vl, "GET", "/v1/models", undefined, {
      authorization: `Bearer ${userKey}`,
    });
    expect(modelsRes.status).toBe(200);
    expect((modelsRes.json as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual([
      "auto/deepseek-v4.1-flash",
    ]);

    // Hard-block Claude & Gemini -> 403 model_prohibited_by_policy
    const blockClaude = await callPrimary(
      vl,
      "POST",
      "/v1/messages",
      { model: "auto/claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] },
      { "x-api-key": userKey },
    );
    expect(blockClaude.status).toBe(403);

    const blockGemini = await callPrimary(
      vl,
      "POST",
      "/v1/chat/completions",
      { model: "auto/gemini-4-argon", messages: [{ role: "user", content: "hi" }] },
      { authorization: `Bearer ${userKey}` },
    );
    expect(blockGemini.status).toBe(403);

    // GPT blocked with 402 insufficient_gpt_quota until admin explicitly grants GPT quota
    const blockGpt = await callPrimary(
      vl,
      "POST",
      "/v1/responses",
      { model: "auto/gpt-6.1-sol", input: "hi" },
      { authorization: `Bearer ${userKey}` },
    );
    expect(blockGpt.status).toBe(402);

    // DeepSeek V4.1 works across /v1/chat/completions (100) + /v1/messages (60 + 50 SSE) = 210 deducted from daily pool
    const dsChat = await callPrimary(
      vl,
      "POST",
      "/v1/chat/completions",
      { model: "magpie/auto/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] },
      { authorization: `Bearer ${userKey}` },
    );
    expect(dsChat.status).toBe(200);

    const dsMsgJson = await callPrimary(
      vl,
      "POST",
      "/v1/messages",
      { model: "auto/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] },
      { "x-api-key": userKey },
    );
    expect(dsMsgJson.status).toBe(200);

    const dsMsgSse = await callPrimary(
      vl,
      "POST",
      "/v1/messages",
      { model: "auto/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true },
      { "x-api-key": userKey },
    );
    expect(dsMsgSse.status).toBe(200);

    const afterDs = vl.accounts.getUserById(reg.user.id)!;
    expect(afterDs.deepseekDailyUsed).toBe(210);
    expect(afterDs.deepseekDailyRemaining).toBe(10_000_000 - 210);
    expect(afterDs.tokenBalance).toBe(0);

    // Next-day non-cumulative refresh resets daily used back to 0 (and remaining to 10_000_000)
    mockNowMs = baseDayMs + 24 * 60 * 60 * 1000;
    const nextDayUser = vl.accounts.getUserById(reg.user.id)!;
    expect(nextDayUser.deepseekDailyUsed).toBe(0);
    expect(nextDayUser.deepseekDailyRemaining).toBe(10_000_000);

    // DeepSeek daily -> bonus spillover test
    await callPrimary(
      vl,
      "PATCH",
      `/api/vl/admin/users/${reg.user.id}`,
      { deepseekDailyQuota: 80, tokenBalanceDelta: 200, reason: "test_spillover" },
      { authorization: `Bearer ${adminSession}` },
    );
    const spilloverRes = await callPrimary(
      vl,
      "POST",
      "/v1/chat/completions",
      { model: "auto/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] },
      { authorization: `Bearer ${userKey}` },
    );
    expect(spilloverRes.status).toBe(200);
    const afterSpill = vl.accounts.getUserById(reg.user.id)!;
    expect(afterSpill.deepseekDailyRemaining).toBe(0);
    expect(afterSpill.tokenBalance).toBe(180); // 80 from daily + 20 from bonus

    // Admin grants 500 GPT tokens -> unlocks auto/gpt-6.1-sol & deducts strictly from gptBalance
    const gptGrant = await callPrimary(
      vl,
      "POST",
      `/api/vl/admin/users/${reg.user.id}/grant`,
      { quotaPool: "gpt", title: "内测 GPT 专项额度", tokenAmount: 500 },
      { authorization: `Bearer ${adminSession}` },
    );
    expect(gptGrant.status).toBe(201);

    const modelsWithGpt = await callPrimary(vl, "GET", "/v1/models", undefined, {
      authorization: `Bearer ${userKey}`,
    });
    expect((modelsWithGpt.json as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual([
      "auto/deepseek-v4.1-flash",
      "auto/gpt-6.1-sol",
    ]);

    const gptJson = await callPrimary(
      vl,
      "POST",
      "/v1/responses",
      { model: "auto/gpt-6.1-sol", input: "hi" },
      { authorization: `Bearer ${userKey}` },
    );
    expect(gptJson.status).toBe(200);

    const gptSse = await callPrimary(
      vl,
      "POST",
      "/v1/responses",
      { model: "auto/gpt-6.1-sol", input: "hi", stream: true },
      { authorization: `Bearer ${userKey}` },
    );
    expect(gptSse.status).toBe(200);

    const afterGpt = vl.accounts.getUserById(reg.user.id)!;
    expect(afterGpt.gptBalance).toBe(410); // 500 - 50 - 40
    expect(afterGpt.gptUsed).toBe(90);

    // Sync Primary -> Standby and verify quota pools + locked Magpie config replicate cleanly
    const syncRes = await vl.cluster.syncWithPeerNow({ force: true });
    expect(syncRes.ok).toBe(true);
    expect(standby.accounts.getMagpieBridgeConfig()).toEqual({
      enabled: true,
      allowedModels: ["auto/deepseek-v4.1-flash", "auto/gpt-6.1-sol"],
      rateMultiplier: 1,
      urlOverride: `http://127.0.0.1:${mockMagpiePort}`,
    });
    const standbyUser = standby.accounts.getUserById(reg.user.id)!;
    expect(standbyUser.gptBalance).toBe(410);
    expect(standbyUser.tokenBalance).toBe(180);
  });

  it("enforces scrypt2/gcm2 cryptography, .master-key, session revocation, loopback proxy guards, rate limits, and body cap", async () => {
    const standaloneHome = makeTempDir("vibelink-standalone-sec-");
    delete process.env.VIBELINK_ADMIN_PASSWORD;
    delete process.env.VIBELINK_CLUSTER_SECRET;
    process.env.VIBELINK_DISABLE_CLUSTER_SYNC = "1";
    const standaloneDb = new VibeLinkDatabase(standaloneHome);
    const standaloneAccounts = new VibeLinkAccountStore(standaloneDb, standaloneHome);
    cleanups.push(() => standaloneDb.close());

    expect(NodeFS.existsSync(NodePath.join(standaloneHome, ".master-key"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(standaloneHome, "admin-bootstrap.txt"))).toBe(true);

    // Changing usr_admin password removes admin-bootstrap.txt
    standaloneAccounts.changePassword("usr_admin", "", "NewStrongAdminPass99!", true);
    expect(NodeFS.existsSync(NodePath.join(standaloneHome, "admin-bootstrap.txt"))).toBe(false);

    const { vl } = createPrimaryFixture();

    // New user password hash uses scrypt2$ and API keys / upstreams use gcm2$ (HKDF-SHA256 + AAD)
    const user = vl.accounts.createUserByAdmin({
      username: "crypto_tester",
      password: "InitialUserPass1!",
    });
    const hashRow = vl.db.db
      .prepare("SELECT password_hash FROM vl_users WHERE id = ?")
      .get(user.id) as { password_hash: string };
    expect(hashRow.password_hash.startsWith("scrypt2$32768$8$1$")).toBe(true);

    const minted = vl.accounts.createUserApiKey(user.id, { name: "hkdf-key" });
    const keyRow = vl.db.db
      .prepare("SELECT key_ciphertext FROM vl_user_api_keys WHERE id = ?")
      .get(minted.id) as { key_ciphertext: string };
    expect(keyRow.key_ciphertext.startsWith("gcm2$")).toBe(true);
    expect(vl.accounts.listUserApiKeys(user.id)[0]?.key).toBe(minted.key);

    const upstream = vl.accounts.upsertUpstream({
      name: "HKDF Upstream",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-hkdf-secret-value-1234",
      models: ["auto/deepseek-v4.1-flash"],
    });
    const upRow = vl.db.db
      .prepare("SELECT api_key_enc FROM vl_gateway_upstreams WHERE id = ?")
      .get(upstream.id) as { api_key_enc: string };
    expect(upRow.api_key_enc.startsWith("gcm2$")).toBe(true);
    expect(vl.accounts.pickUpstreamForModel("auto/deepseek-v4.1-flash")?.apiKey).toBe(
      "sk-test-hkdf-secret-value-1234",
    );

    // Legacy scrypt$ hash is accepted and auto-upgraded to scrypt2$ on login
    const legacySalt = NodeCrypto.randomBytes(16).toString("hex");
    const legacyHash = NodeCrypto.scryptSync("LegacyPass123!", legacySalt, 64).toString("hex");
    vl.db.db
      .prepare("UPDATE vl_users SET password_hash = ? WHERE id = ?")
      .run(`scrypt$${legacySalt}$${legacyHash}`, user.id);

    const sessA = vl.accounts.login("crypto_tester", "LegacyPass123!", "deviceA");
    const upgradedRow = vl.db.db
      .prepare("SELECT password_hash FROM vl_users WHERE id = ?")
      .get(user.id) as { password_hash: string };
    expect(upgradedRow.password_hash.startsWith("scrypt2$32768$8$1$")).toBe(true);

    const sessB = vl.accounts.login("crypto_tester", "LegacyPass123!", "deviceB");

    // Password change over HTTP keeps caller session (sessB) alive and revokes other sessions (sessA)
    const pwdResp = await callPrimary(
      vl,
      "POST",
      "/api/vl/auth/password",
      { oldPassword: "LegacyPass123!", newPassword: "RotatedUserPass2!" },
      { authorization: `Bearer ${sessB.sessionToken}` },
      "192.168.5.50",
    );
    expect(pwdResp.status).toBe(200);
    expect(vl.accounts.resolveSessionToken(sessA.sessionToken)).toBeNull();
    expect(vl.accounts.resolveSessionToken(sessB.sessionToken)).not.toBeNull();

    // Admin password reset revokes all sessions
    vl.accounts.updateUserByAdmin(user.id, { resetPassword: "AdminResetPass3!" });
    expect(vl.accounts.resolveSessionToken(sessB.sessionToken)).toBeNull();

    // Loopback bypass prevention: missing remoteAddress, proxy forwarding headers, or public Host must reject with 401
    const noRemote = await Effect.runPromise(
      dispatchVibeLinkHttp(vl, {
        method: "GET",
        url: "/api/vl/admin/users",
        headers: { host: "localhost:18990" },
        remoteAddress: null,
        bodyText: "",
      }),
    );
    expect(noRemote.status).toBe(401);

    const forwardedBypass = await callPrimary(
      vl,
      "GET",
      "/api/vl/admin/users",
      undefined,
      { "x-forwarded-for": "203.0.113.5" },
      "127.0.0.1",
    );
    expect(forwardedBypass.status).toBe(401);

    const cfBypass = await callPrimary(
      vl,
      "GET",
      "/api/vl/admin/users",
      undefined,
      { "cf-connecting-ip": "1.2.3.4" },
      "127.0.0.1",
    );
    expect(cfBypass.status).toBe(401);

    const dnsRebindBypass = await Effect.runPromise(
      dispatchVibeLinkHttp(vl, {
        method: "GET",
        url: "/api/vl/admin/users",
        headers: { host: "evil.example.com" },
        remoteAddress: "127.0.0.1",
        bodyText: "",
      }),
    );
    expect(dnsRebindBypass.status).toBe(401);

    // Brute-force login rate limit returns 429 after 10 failed attempts on same (ip, username)
    for (let i = 0; i < 10; i += 1) {
      const failResp = await callPrimary(
        vl,
        "POST",
        "/api/vl/auth/login",
        { username: "crypto_tester", password: "WrongPassword!" },
        {},
        "198.51.100.77",
      );
      expect(failResp.status).toBe(401);
    }
    const lockedResp = await callPrimary(
      vl,
      "POST",
      "/api/vl/auth/login",
      { username: "crypto_tester", password: "AdminResetPass3!" },
      {},
      "198.51.100.77",
    );
    expect(lockedResp.status).toBe(429);

    // Standby server rejects oversized request body with 413
    const standbyHome = makeTempDir("vibelink-standby-cap-");
    process.env.VIBELINK_CLUSTER_ROLE = "standby";
    const standby = await startStandbyServer({
      homeDir: standbyHome,
      host: "127.0.0.1",
      port: 0,
      disableSyncLoop: true,
    });
    cleanups.push(() => standby.close());

    const bigBody = JSON.stringify({ username: "x", padding: "a".repeat(2_200_000) });
    const tooLargeResp = await fetch(`http://127.0.0.1:${standby.port}/api/vl/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bigBody,
    });
    expect(tooLargeResp.status).toBe(413);
  });
});
