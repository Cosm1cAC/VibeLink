// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { BotHomeManager } from "../bots/botHome.ts";
import { runSeedMigration } from "../bots/botMigration.ts";
import { VibeLinkAccountStore } from "../accounts.ts";
import { VibeLinkOrchestrationBridge } from "../bridge/orchestrationBridge.ts";
import { VibeLinkTerminalBridge } from "../bridge/terminalBridge.ts";
import { VibeLinkAuth } from "../auth.ts";
import { VibeLinkClusterManager } from "../cluster.ts";
import { VibeLinkDatabase } from "../db.ts";
import { VibeLinkDeviceHub } from "../devices.ts";
import { dispatchVibeLinkHttp } from "../http.ts";
import { VibeLinkPluginManager } from "../plugins/pluginManager.ts";
import type { VibeLinkServiceShape } from "../service.ts";

const tempDirs: string[] = [];

function createTestService() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vibelink-routes-"));
  tempDirs.push(home);
  process.env.VIBELINK_MOCK_BOTS = "1";
  process.env.VIBELINK_DISABLE_CLUSTER_SYNC = "1";

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

  const vl: VibeLinkServiceShape = { db, auth, accounts, cluster, botHome, plugins, orchestration, terminal, devices };
  return {
    vl,
    async cleanup() {
      devices.dispose();
      plugins.stop();
      await Effect.runPromise(orchestration.stop());
      db.close();
      delete process.env.VIBELINK_MOCK_BOTS;
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

async function callRoute(
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

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 3000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe("VibeLink IM HTTP routes & mock orchestration", () => {
  it("enforces bearer auth for non-loopback callers and serves bootstrap, DM, recall, read, Bot Home, attachments, and approvals", async () => {
    const { vl, cleanup } = createTestService();
    try {
      const unauth = await callRoute(
        vl,
        "GET",
        "/api/vl/bootstrap",
        undefined,
        { host: "192.168.1.50:18990" },
        "192.168.1.99",
      );
      expect(unauth.status).toBe(401);

      const authBootstrap = await callRoute(
        vl,
        "GET",
        "/api/vl/bootstrap",
        undefined,
        { host: "192.168.1.50:18990", authorization: `Bearer ${vl.auth.token}` },
        "192.168.1.99",
      );
      expect(authBootstrap.status).toBe(200);
      const bootData = authBootstrap.json as {
        me: { id: string };
        accounts: unknown[];
        rooms: unknown[];
      };
      expect(bootData.me.id).toBe("me");
      expect(bootData.accounts.length).toBe(5);
      expect(bootData.rooms.length).toBe(5);

      // Update group notice
      const noticeRes = await callRoute(vl, "PATCH", "/api/vl/rooms/grp_workspace", {
        notice: "今日目标：完成 VibeLink v3 联调",
      });
      expect(noticeRes.status).toBe(200);
      expect((noticeRes.json as { room: { notice: string } }).room.notice).toContain("VibeLink v3");

      // Send DM to bot_codex -> triggers mock tool call + markdown reply
      const sendRes = await callRoute(vl, "POST", "/api/vl/rooms/dm_bot_codex/messages", {
        content: "请给出今日开发拆分建议",
      });
      expect(sendRes.status).toBe(201);
      const userMsgId = (sendRes.json as { message: { id: string } }).message.id;

      const msgList = await waitFor(async () => {
        const dmMsgs = await callRoute(vl, "GET", "/api/vl/rooms/dm_bot_codex/messages");
        const list = (dmMsgs.json as { messages: Array<{ msgType: string; content: string }> }).messages;
        return list.some((m) => m.msgType === "bot_tool_call") &&
          list.some((m) => m.msgType === "bot_markdown" && m.content.includes("请给出今日开发拆分建议"))
          ? list
          : null;
      });
      expect(msgList.some((m) => m.msgType === "bot_tool_call")).toBe(true);
      expect(
        msgList.some(
          (m) => m.msgType === "bot_markdown" && m.content.includes("请给出今日开发拆分建议"),
        ),
      ).toBe(true);

      // Recall user message & mark room read
      const recallRes = await callRoute(
        vl,
        "POST",
        `/api/vl/rooms/dm_bot_codex/messages/${userMsgId}/recall`,
      );
      expect(recallRes.status).toBe(200);
      expect((recallRes.json as { message: { recalledAt: number | null } }).message.recalledAt).not.toBeNull();

      const readRes = await callRoute(vl, "POST", "/api/vl/rooms/dm_bot_codex/read", {});
      expect(readRes.status).toBe(200);
      expect((readRes.json as { room: { unreadCount: number } }).room.unreadCount).toBe(0);

      // Edit Bot Home SOUL.md
      const putSoul = await callRoute(vl, "PUT", "/api/vl/bots/bot_codex/files/SOUL.md", {
        content: "# Custom Soul\nAlways verify before asserting.\n",
      });
      expect(putSoul.status).toBe(200);
      const getSoul = await callRoute(vl, "GET", "/api/vl/bots/bot_codex/files/SOUL.md");
      expect(getSoul.status).toBe(200);
      expect((getSoul.json as { content: string }).content).toContain("Custom Soul");

      // Upload & fetch attachment
      const uploadRes = await callRoute(vl, "POST", "/api/vl/attachments", {
        roomId: "dm_bot_codex",
        filename: "hello.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from("vibelink-attachment", "utf8").toString("base64"),
      });
      expect(uploadRes.status).toBe(201);
      const attUrl = (uploadRes.json as { url: string }).url;
      const downloadRes = await callRoute(vl, "GET", attUrl);
      expect(downloadRes.status).toBe(200);
      expect(Buffer.from(downloadRes.binary!.bytes).toString("utf8")).toBe("vibelink-attachment");

      // Avatar upload + fetch + Bot rename/avatar DM sync
      const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
      const avatarUpload = await callRoute(vl, "POST", "/api/vl/avatars", {
        filename: "bot.png",
        mimeType: "image/png",
        dataBase64: pngBytes.toString("base64"),
      });
      expect(avatarUpload.status).toBe(201);
      const avatarUrl = (avatarUpload.json as { url: string }).url;
      expect(avatarUrl).toMatch(/^\/api\/vl\/avatars\/av_/);

      const avatarFetch = await callRoute(vl, "GET", avatarUrl);
      expect(avatarFetch.status).toBe(200);
      expect(avatarFetch.binary?.contentType).toBe("image/png");
      expect(Buffer.from(avatarFetch.binary!.bytes).equals(pngBytes)).toBe(true);

      const patchBot = await callRoute(vl, "PATCH", "/api/vl/bots/bot_codex", {
        displayName: "Codex 主力",
        avatar: avatarUrl,
      });
      expect(patchBot.status).toBe(200);
      expect((patchBot.json as { bot: { displayName: string; avatar: string } }).bot.displayName).toBe(
        "Codex 主力",
      );

      const roomsRes = await callRoute(vl, "GET", "/api/vl/rooms");
      expect(roomsRes.status).toBe(200);
      const dmRoom = (
        roomsRes.json as { rooms: Array<{ id: string; name: string; avatar: string }> }
      ).rooms.find((r) => r.id === "dm_bot_codex");
      expect(dmRoom?.name).toBe("Codex 主力");
      expect(dmRoom?.avatar).toBe(avatarUrl);

      // Approval response
      const aprMsg = vl.db.createMessage({
        roomId: "dm_bot_codex",
        senderId: "bot_codex",
        msgType: "bot_approval",
        content: "Approve mock write",
      });
      const apr = vl.db.createApproval({
        roomId: "dm_bot_codex",
        messageId: aprMsg.id,
        botId: "bot_codex",
        title: "Write check",
        detail: "Approve writing file",
      });
      const aprRes = await callRoute(vl, "POST", `/api/vl/approvals/${apr.id}/respond`, {
        decision: "approved",
      });
      expect(aprRes.status).toBe(200);
      expect((aprRes.json as { approval: { status: string } }).approval.status).toBe("approved");
    } finally {
      await cleanup();
    }
  });

  it("caps group @Bot recursive handoffs at MAX_GROUP_HANDOFFS = 4", async () => {
    const { vl, cleanup } = createTestService();
    try {
      const sendRes = await callRoute(vl, "POST", "/api/vl/rooms/grp_workspace/messages", {
        content: "@Codex 请启动接力检查 [chain-loop]",
      });
      expect(sendRes.status).toBe(201);

      const list = await waitFor(async () => {
        const grpMsgs = await callRoute(vl, "GET", "/api/vl/rooms/grp_workspace/messages");
        const msgs = (
          grpMsgs.json as {
            messages: Array<{ msgType: string; content: string; handoffDepth: number }>;
          }
        ).messages;
        return msgs.some((m) => m.msgType === "system" && m.content.includes("最大深度 (4 轮)"))
          ? msgs
          : null;
      });
      expect(
        list.some((m) => m.msgType === "system" && m.content.includes("最大深度 (4 轮)")),
      ).toBe(true);
      const maxDepth = Math.max(...list.map((m) => m.handoffDepth));
      expect(maxDepth).toBe(4);
    } finally {
      await cleanup();
    }
  });
});
