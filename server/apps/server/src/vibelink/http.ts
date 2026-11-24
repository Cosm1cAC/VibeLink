// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { BotHomeManager, sanitizeBotSlug } from "./bots/botHome.ts";
import { tidyBotMemory } from "./bots/botMemory.ts";
import { dispatchAccountAndClusterHttp, resolveAuthContext } from "./accountRoutes.ts";
import type { VlMagpieRuntimeAdapter } from "./gateway.ts";
import { buildPairingInfo, getSpeedTestPayload, writePairingConfig } from "./pairing.ts";
import type { VibeLinkServiceShape } from "./service.ts";
import * as VibeLinkService from "./service.ts";
import { VibeLinkError, type VlBotConfigJson, type VlPresence, type VlRoomKind, type VlSendMode } from "./types.ts";

export interface VibeLinkHttpResponseSpec {
  readonly status: number;
  readonly json?: unknown;
  readonly rawText?: {
    readonly body: string;
    readonly contentType: string;
  };
  readonly binary?: {
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly contentDisposition?: string;
  };
}

function jsonResp(status: number, json: unknown): VibeLinkHttpResponseSpec {
  return { status, json };
}

function isMockBotsEnv(): boolean {
  return process.env.VIBELINK_MOCK_BOTS === "1";
}

function parseJsonBodySafe(
  raw: string,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly message: string } {
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, message: "Request JSON body must be an object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Invalid JSON body" };
  }
}

function readBotFileSafe(
  botHome: BotHomeManager,
  slug: string,
  relPath: string,
): { readonly ok: true; readonly content: string | null } | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, content: botHome.readBotFile(slug, relPath) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Invalid path" };
  }
}

function writeBotFileSafe(
  botHome: BotHomeManager,
  slug: string,
  relPath: string,
  content: string,
):
  | { readonly ok: true; readonly saved: { path: string; sizeBytes: number } }
  | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, saved: botHome.writeBotFile(slug, relPath, content) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Invalid path" };
  }
}

function getHeader(
  headers: Record<string, string | ReadonlyArray<string> | undefined>,
  name: string,
): string | null {
  const val = headers[name.toLowerCase()];
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0];
  return null;
}

export function dispatchVibeLinkHttp(
  vl: VibeLinkServiceShape,
  input: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string | ReadonlyArray<string> | undefined>;
    readonly remoteAddress?: string | null;
    readonly bodyText?: string;
  },
): Effect.Effect<VibeLinkHttpResponseSpec> {
  return Effect.gen(function* () {
    const parsedUrl = new URL(input.url, "http://127.0.0.1");
    const pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";
    const method = input.method.toUpperCase();

    if (method === "OPTIONS") {
      return { status: 204 };
    }

    if (method === "GET" && pathname === "/api/vl/health") {
      return jsonResp(200, {
        ok: true,
        service: "vibelink",
        version: 3,
        mockBots: isMockBotsEnv(),
        botsCount: vl.db.listAccounts("bot").length,
        roomsCount: vl.db.listRoomSummaries("me").length,
        latestSeq: vl.db.getLatestSeq(),
        cluster: vl.cluster.getPublicSummary(),
      });
    }

    const magpieAdapter: VlMagpieRuntimeAdapter = {
      getPluginMagpieInfo: () => {
        const summary = vl.plugins.getPluginSummary("magpie");
        if (!summary) return null;
        const catalog = vl.plugins.listCatalog();
        return {
          pluginEnabled: summary.enabled,
          ...(summary.health.gatewayUrl ? { gatewayUrl: summary.health.gatewayUrl } : {}),
          ...(summary.health.version ? { version: summary.health.version } : {}),
          status: summary.health.status,
          cachedModels: catalog.models.map((m) => ({
            id: m.id,
            ownedBy: m.ownedBy,
            displayName: m.displayName,
          })),
        };
      },
    };

    const accountOrGatewayResp = yield* Effect.promise(() =>
      dispatchAccountAndClusterHttp(
        { auth: vl.auth, accounts: vl.accounts, cluster: vl.cluster, magpie: magpieAdapter },
        {
          method,
          url: input.url,
          headers: input.headers,
          ...(input.remoteAddress !== undefined ? { remoteAddress: input.remoteAddress } : {}),
          ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
        },
      ),
    );
    if (accountOrGatewayResp !== null) {
      return accountOrGatewayResp;
    }

    const authCtx = resolveAuthContext(vl.auth, vl.accounts, {
      headers: input.headers,
      queryToken: parsedUrl.searchParams.get("token"),
      ...(input.remoteAddress !== undefined ? { remoteAddress: input.remoteAddress } : {}),
    });
    if (!authCtx) {
      return jsonResp(401, { error: "unauthorized", message: "Valid VibeLink token required." });
    }
    if (!authCtx.isAdmin) {
      return jsonResp(403, { error: "forbidden", message: "仅管理员账号可访问控制面与 Bot 会话" });
    }

    const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== "api" || segments[1] !== "vl") {
      return jsonResp(404, { error: "not_found" });
    }

    const resource = segments[2];

    if (resource === "speedtest") {
      if (method === "GET" && segments[3] === "ping" && segments.length === 4) {
        return jsonResp(200, {
          ok: true,
          service: "vibelink",
          serverTime: Date.now(),
        });
      }
      if (method === "GET" && segments[3] === "download" && segments.length === 4) {
        const bytesParam = Number.parseInt(parsedUrl.searchParams.get("bytes") ?? "", 10);
        return {
          status: 200,
          binary: {
            bytes: getSpeedTestPayload(Number.isFinite(bytesParam) ? bytesParam : undefined),
            contentType: "application/octet-stream",
          },
        };
      }
      if (method === "POST" && segments[3] === "upload" && segments.length === 4) {
        const receivedBytes = Buffer.byteLength(input.bodyText ?? "", "utf8");
        return jsonResp(200, {
          ok: true,
          receivedBytes,
          serverTime: Date.now(),
        });
      }
    }

    let body: Record<string, unknown> = {};
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const parsedBody = parseJsonBodySafe(input.bodyText ?? "");
      if (!parsedBody.ok) {
        return jsonResp(400, { error: "invalid_json", message: parsedBody.message });
      }
      body = parsedBody.value;
    }

    if (resource === "pairing") {
      const hostHeader = getHeader(input.headers, "host");
      const clusterExtras = vl.cluster.getClusterEndpoints(hostHeader).map((ep) => ({
        id: ep.id,
        label: ep.label,
        kind: ep.kind,
        url: ep.url,
        priority: ep.priority,
        serverRole: ep.serverRole,
        nodeId: ep.nodeId,
      }));
      if (method === "GET" && segments[3] === "info" && segments.length === 4) {
        return jsonResp(
          200,
          buildPairingInfo({
            homeDir: vl.db.homeDir,
            token: vl.auth.token,
            hostHeader,
            extraEndpoints: clusterExtras,
          }),
        );
      }
      if (method === "POST" && segments[3] === "config" && segments.length === 4) {
        const customExternalUrl =
          typeof body.customExternalUrl === "string" ? body.customExternalUrl : "";
        writePairingConfig(vl.db.homeDir, { customExternalUrl });
        return jsonResp(
          200,
          buildPairingInfo({
            homeDir: vl.db.homeDir,
            token: vl.auth.token,
            hostHeader,
            extraEndpoints: clusterExtras,
          }),
        );
      }
    }

    if (method === "GET" && resource === "bootstrap" && segments.length === 3) {
      return jsonResp(200, vl.db.getBootstrapPayload("me"));
    }

    if (resource === "accounts") {
      if (method === "GET" && segments.length === 3) {
        return jsonResp(200, { accounts: vl.db.listAccounts() });
      }
      if (method === "PATCH" && segments[3] === "me" && segments.length === 4) {
        const updated = vl.db.updateAccountFields("me", {
          ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
          ...(typeof body.statusText === "string" ? { statusText: body.statusText } : {}),
          ...(typeof body.presence === "string" ? { presence: body.presence as VlPresence } : {}),
          ...(typeof body.avatar === "string" ? { avatar: body.avatar } : {}),
        });
        return updated ? jsonResp(200, { account: updated }) : jsonResp(404, { error: "not_found" });
      }
    }

    if (resource === "rooms") {
      if (method === "GET" && segments.length === 3) {
        return jsonResp(200, { rooms: vl.db.listRoomSummaries("me") });
      }
      if (method === "POST" && segments.length === 3) {
        const kind = (body.kind === "dm" ? "dm" : "group") as VlRoomKind;
        const memberIdsRaw = Array.isArray(body.memberIds)
          ? body.memberIds.filter((x): x is string => typeof x === "string")
          : [];
        const botIdsRaw = Array.isArray(body.botIds)
          ? body.botIds.filter((x): x is string => typeof x === "string")
          : [];
        const allMembers = [...new Set(["me", ...memberIdsRaw, ...botIdsRaw])];

        if (kind === "dm") {
          const targetId = allMembers.find((id) => id !== "me");
          if (!targetId) {
            return jsonResp(400, { error: "invalid_request", message: "DM requires a target accountId" });
          }
          const dmId = `dm_${targetId}`;
          const existing = vl.db.getRoomSummary(dmId, "me");
          if (existing) {
            return jsonResp(200, { room: existing });
          }
          const target = vl.db.getAccount(targetId);
          if (!target) {
            return jsonResp(404, { error: "account_not_found" });
          }
          vl.db.upsertRoom({
            id: dmId,
            kind: "dm",
            name: target.displayName,
            notice: target.description,
            avatar: target.avatar,
            muted: false,
            pinned: false,
            cwd: target.cwd || "D:\\AI\\VibeLink",
          });
          vl.db.addRoomMember(dmId, "me", "owner");
          vl.db.addRoomMember(dmId, target.id, "member");
          const room = vl.db.getRoomSummary(dmId, "me")!;
          vl.db.appendEvent("room.created", dmId, { room });
          return jsonResp(201, { room });
        }

        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "新建协同群";
        const roomId = `grp_${NodeCrypto.randomUUID().slice(0, 8)}`;
        vl.db.upsertRoom({
          id: roomId,
          kind: "group",
          name,
          notice: typeof body.notice === "string" ? body.notice : "",
          avatar: "preset:group",
          muted: false,
          pinned: false,
          cwd: typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : "D:\\AI\\VibeLink",
        });
        vl.db.addRoomMember(roomId, "me", "owner");
        for (const accountId of allMembers) {
          if (accountId !== "me" && vl.db.getAccount(accountId)) {
            vl.db.addRoomMember(roomId, accountId, "member");
          }
        }
        vl.db.createMessage({
          roomId,
          senderId: "me",
          msgType: "system",
          content: `群聊「${name}」已创建，输入 @Bot 即可召唤对应专家协作。`,
          emitEvent: false,
        });
        const room = vl.db.getRoomSummary(roomId, "me")!;
        vl.db.appendEvent("room.created", roomId, { room });
        return jsonResp(201, { room });
      }

      const roomId = segments[3];
      if (!roomId) return jsonResp(404, { error: "not_found" });

      if (method === "PATCH" && segments.length === 4) {
        const updated = vl.db.updateRoom(roomId, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.notice === "string" ? { notice: body.notice } : {}),
          ...(typeof body.muted === "boolean" ? { muted: body.muted } : {}),
          ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
          ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
        });
        return updated ? jsonResp(200, { room: updated }) : jsonResp(404, { error: "room_not_found" });
      }

      if (segments[4] === "members") {
        if (method === "POST" && segments.length === 5) {
          const accountId = typeof body.accountId === "string" ? body.accountId : "";
          const role = body.role === "admin" || body.role === "owner" ? body.role : "member";
          if (!vl.db.getRoom(roomId) || !vl.db.getAccount(accountId)) {
            return jsonResp(404, { error: "not_found" });
          }
          vl.db.addRoomMember(roomId, accountId, role);
          const room = vl.db.getRoomSummary(roomId, "me")!;
          vl.db.appendEvent("room.updated", roomId, { room });
          return jsonResp(200, { room });
        }
        if (method === "DELETE" && segments.length === 6 && segments[5]) {
          const removed = vl.db.removeRoomMember(roomId, segments[5]);
          if (!removed) return jsonResp(404, { error: "member_not_found" });
          return jsonResp(200, { room: vl.db.getRoomSummary(roomId, "me") });
        }
      }

      if (segments[4] === "messages") {
        if (method === "GET" && segments.length === 5) {
          if (!vl.db.getRoom(roomId)) return jsonResp(404, { error: "room_not_found" });
          const limitParam = Number(parsedUrl.searchParams.get("limit") ?? "150");
          const beforeParam = parsedUrl.searchParams.get("before");
          const messages = vl.db.listMessages(roomId, {
            limit: Number.isFinite(limitParam) ? limitParam : 150,
            ...(beforeParam ? { before: Number(beforeParam) } : {}),
          });
          return jsonResp(200, { messages });
        }

        if (method === "POST" && segments.length === 5) {
          const content = typeof body.content === "string" ? body.content : "";
          if (!content.trim()) {
            return jsonResp(400, { error: "empty_content", message: "Message content cannot be empty" });
          }
          const mode =
            body.mode === "queue" || body.mode === "steer" || body.mode === "auto"
              ? (body.mode as VlSendMode)
              : "auto";
          const res = yield* vl.orchestration
            .sendRoomMessage({
              roomId,
              content,
              msgType:
                body.msgType === "system" || body.msgType === "bot_markdown"
                  ? body.msgType
                  : "text",
              replyToId: typeof body.replyToId === "string" ? body.replyToId : null,
              targetBotId: typeof body.targetBotId === "string" ? body.targetBotId : null,
              metadata:
                typeof body.metadata === "object" && body.metadata !== null
                  ? (body.metadata as Record<string, unknown>)
                  : {},
              mode,
            })
            .pipe(Effect.result);
          if (res._tag === "Failure") {
            return jsonResp(404, { error: "send_failed", message: res.failure.message });
          }
          return jsonResp(201, {
            message: res.success.userMessage,
            triggeredBotIds: res.success.triggeredBotIds,
          });
        }

        if (method === "POST" && segments.length === 7 && segments[6] === "recall" && segments[5]) {
          const msg = vl.db.recallMessage(segments[5]);
          if (!msg || msg.roomId !== roomId) {
            return jsonResp(404, { error: "message_not_found" });
          }
          return jsonResp(200, { message: msg });
        }
      }

      if (method === "POST" && segments.length === 5 && segments[4] === "read") {
        if (!vl.db.getRoom(roomId)) return jsonResp(404, { error: "room_not_found" });
        const lastReadAt = vl.db.markRoomRead(
          roomId,
          "me",
          typeof body.lastReadMsgId === "string" ? body.lastReadMsgId : null,
        );
        return jsonResp(200, { lastReadAt, room: vl.db.getRoomSummary(roomId, "me") });
      }

      if (method === "POST" && segments.length === 5 && segments[4] === "interrupt") {
        if (!vl.db.getRoom(roomId)) return jsonResp(404, { error: "room_not_found" });
        const interrupted = yield* vl.orchestration.interruptRoom(roomId);
        return jsonResp(200, { interrupted });
      }
    }

    if (resource === "bots") {
      if (method === "GET" && segments.length === 3) {
        return jsonResp(200, { bots: vl.db.listAccounts("bot") });
      }

      if (method === "POST" && segments.length === 3) {
        const displayName =
          typeof body.displayName === "string" && body.displayName.trim()
            ? body.displayName.trim()
            : typeof body.name === "string" && body.name.trim()
              ? body.name.trim()
              : "CustomBot";
        const slugBase = sanitizeBotSlug(
          typeof body.slug === "string" && body.slug.trim() ? body.slug : displayName,
        );
        let slug = slugBase;
        let idx = 1;
        while (vl.db.getAccountBySlugOrHandle(slug)) {
          idx += 1;
          slug = `${slugBase}-${idx}`;
        }
        const id = `bot_${slug}`;
        const handle =
          typeof body.handle === "string" && body.handle.trim() ? body.handle.trim() : displayName;
        const provider =
          typeof body.provider === "string" && body.provider.trim()
            ? body.provider.trim()
            : "codex";
        const model = typeof body.model === "string" ? body.model.trim() : "";
        const cwd =
          typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : "D:\\AI\\VibeLink";

        const config: VlBotConfigJson = {
          id,
          slug,
          handle,
          displayName,
          avatar: typeof body.avatar === "string" ? body.avatar : `preset:${provider}`,
          roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : "自定义助手",
          department: typeof body.department === "string" ? body.department : "自定义组",
          provider,
          model,
          thinkingEffort: "medium",
          cwd,
          isolationMode: "shared",
          approvalMode: typeof body.approvalMode === "string" ? body.approvalMode : "ask",
          manageOtherBots: false,
          dailyCheckIns: false,
          disabledTools: [],
          exampleRequests: [],
          description: typeof body.description === "string" ? body.description : "",
          section: "自定义助手",
          pinned: false,
        };
        vl.botHome.ensureBotScaffold(config, {
          ...(typeof body.soulMarkdown === "string" ? { soulMarkdown: body.soulMarkdown } : {}),
          overwriteExisting: true,
        });
        const bot = vl.db.upsertAccount({
          id,
          kind: "bot",
          slug,
          handle,
          displayName,
          avatar: config.avatar,
          roleTitle: config.roleTitle,
          department: config.department,
          presence: "idle",
          statusText: config.roleTitle || "就绪",
          provider,
          model,
          cwd,
          isolationMode: config.isolationMode,
          approvalMode: config.approvalMode,
          description: config.description,
          pinned: false,
          source: "manual",
          pluginId: null,
          externalId: null,
          visible: true,
        });
        const dmRoomId = `dm_${id}`;
        vl.db.upsertRoom({
          id: dmRoomId,
          kind: "dm",
          name: bot.displayName,
          notice: bot.description,
          avatar: bot.avatar,
          muted: false,
          pinned: false,
          cwd,
        });
        vl.db.addRoomMember(dmRoomId, "me", "owner");
        vl.db.addRoomMember(dmRoomId, bot.id, "member");
        const dmRoom = vl.db.getRoomSummary(dmRoomId, "me")!;
        vl.db.appendEvent("account.updated", null, { account: bot });
        vl.db.appendEvent("room.created", dmRoomId, { room: dmRoom });
        return jsonResp(201, { bot, dmRoom });
      }

      const botId = segments[3];
      const bot = botId ? vl.db.getAccountBySlugOrHandle(botId) : null;
      if (!bot || bot.kind !== "bot") {
        return jsonResp(404, { error: "bot_not_found" });
      }

      if (method === "PATCH" && segments.length === 4) {
        const updated = vl.db.updateAccountFields(bot.id, {
          ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
          ...(typeof body.handle === "string" ? { handle: body.handle } : {}),
          ...(typeof body.avatar === "string" ? { avatar: body.avatar } : {}),
          ...(typeof body.roleTitle === "string" ? { roleTitle: body.roleTitle } : {}),
          ...(typeof body.department === "string" ? { department: body.department } : {}),
          ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
          ...(typeof body.isolationMode === "string" ? { isolationMode: body.isolationMode } : {}),
          ...(typeof body.approvalMode === "string" ? { approvalMode: body.approvalMode } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.statusText === "string" ? { statusText: body.statusText } : {}),
          ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        });
        let pluginSync: { readonly ok: boolean; readonly message: string } | undefined;
        if (updated) {
          vl.botHome.syncAccountToBotJson(updated);
          if (typeof body.displayName === "string" || typeof body.avatar === "string") {
            const dmRoomId = `dm_${bot.id}`;
            if (vl.db.getRoom(dmRoomId)) {
              vl.db.updateRoom(dmRoomId, {
                name: updated.displayName,
                avatar: updated.avatar,
              });
            }
          }
          if (body.syncToPlugin === true && updated.pluginId && updated.model) {
            pluginSync = yield* Effect.promise(() =>
              vl.plugins.syncBotModelToPlugin(updated, updated.model),
            );
          }
        }
        return jsonResp(200, {
          bot: updated,
          ...(pluginSync ? { pluginSync } : {}),
        });
      }

      if (segments[4] === "files") {
        if (method === "GET" && segments.length === 5) {
          return jsonResp(200, { slug: bot.slug, files: vl.botHome.listBotFiles(bot.slug) });
        }
        const relPath = segments.slice(5).join("/");
        if (!relPath) {
          return jsonResp(400, { error: "invalid_path" });
        }
        if (method === "GET") {
          const readRes = readBotFileSafe(vl.botHome, bot.slug, relPath);
          if (!readRes.ok) {
            return jsonResp(400, { error: "unsafe_path", message: readRes.message });
          }
          if (readRes.content === null) return jsonResp(404, { error: "file_not_found" });
          return jsonResp(200, { slug: bot.slug, path: relPath, content: readRes.content });
        }
        if (method === "PUT") {
          if (typeof body.content !== "string") {
            return jsonResp(400, { error: "invalid_content" });
          }
          const writeRes = writeBotFileSafe(vl.botHome, bot.slug, relPath, body.content);
          if (!writeRes.ok) {
            return jsonResp(400, { error: "unsafe_path", message: writeRes.message });
          }
          vl.db.appendEvent("bot.home.updated", null, { botId: bot.id, path: writeRes.saved.path });
          return jsonResp(200, writeRes.saved);
        }
      }

      if (method === "POST" && segments[4] === "memory" && segments[5] === "tidy") {
        const res = tidyBotMemory(vl.botHome, bot.slug);
        return jsonResp(200, res);
      }
    }

    if (resource === "approvals" && segments[3] && segments[4] === "respond" && method === "POST") {
      const decision = body.decision === "rejected" ? "rejected" : "approved";
      const feedback = typeof body.feedback === "string" ? body.feedback : undefined;
      const approval = yield* vl.orchestration.respondApproval(segments[3], decision, feedback);
      if (!approval) return jsonResp(404, { error: "approval_not_found" });
      return jsonResp(200, { approval });
    }

    if (resource === "checkpoints" && segments[3]) {
      const roomId = segments[3];
      if (method === "GET" && segments.length === 4) {
        return jsonResp(200, { checkpoints: vl.orchestration.listRoomCheckpoints(roomId) });
      }
      if (method === "POST" && segments[4] === "rollback") {
        const res = yield* vl.orchestration.rollbackCheckpoint({
          roomId,
          ...(typeof body.messageId === "string" ? { messageId: body.messageId } : {}),
          ...(typeof body.checkpointId === "string" ? { checkpointId: body.checkpointId } : {}),
          ...(typeof body.scopeId === "string" ? { scopeId: body.scopeId } : {}),
          ...(typeof body.threadId === "string" ? { threadId: body.threadId } : {}),
        });
        return jsonResp(res.ok ? 200 : 400, res);
      }
    }

    if (resource === "terminals") {
      if (method === "GET" && segments.length === 3) {
        const roomId = parsedUrl.searchParams.get("roomId");
        return jsonResp(200, { sessions: vl.terminal.listSessions(roomId) });
      }
      if (method === "POST" && segments.length === 3) {
        const opened = yield* vl.terminal
          .openSession({
            roomId: typeof body.roomId === "string" ? body.roomId : null,
            botId: typeof body.botId === "string" ? body.botId : null,
            cwd: typeof body.cwd === "string" ? body.cwd : null,
            ...(typeof body.cols === "number" ? { cols: body.cols } : {}),
            ...(typeof body.rows === "number" ? { rows: body.rows } : {}),
          })
          .pipe(Effect.result);
        if (opened._tag === "Failure") {
          return jsonResp(500, { error: "terminal_open_failed", message: opened.failure.message });
        }
        return jsonResp(201, { session: opened.success });
      }
      if (method === "DELETE" && segments.length === 4 && segments[3]) {
        const closed = yield* vl.terminal.closeSession(segments[3]).pipe(Effect.orElseSucceed(() => false));
        return closed
          ? jsonResp(200, { closed: true })
          : jsonResp(404, { error: "terminal_not_found" });
      }
    }

    if (resource === "attachments") {
      if (method === "POST" && segments.length === 3) {
        const roomId = typeof body.roomId === "string" ? body.roomId : "";
        const filename = typeof body.filename === "string" ? body.filename : "attachment.bin";
        const mimeType =
          typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream";
        const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
        if (!roomId || !vl.db.getRoom(roomId)) {
          return jsonResp(404, { error: "room_not_found" });
        }
        if (!dataBase64) {
          return jsonResp(400, { error: "missing_data" });
        }
        const bytes = Uint8Array.from(Buffer.from(dataBase64, "base64"));
        const attachment = vl.db.saveAttachment({
          roomId,
          uploaderId: "me",
          filename,
          mimeType,
          data: bytes,
        });
        return jsonResp(201, {
          attachment,
          url: `/api/vl/attachments/${attachment.id}`,
        });
      }
      if (method === "GET" && segments.length === 4 && segments[3]) {
        const att = vl.db.getAttachment(segments[3]);
        if (!att || !NodeFS.existsSync(att.storagePath)) {
          return jsonResp(404, { error: "attachment_not_found" });
        }
        const bytes = new Uint8Array(NodeFS.readFileSync(att.storagePath));
        const safeMime = /(?:text\/html|svg)/i.test(att.mimeType)
          ? "application/octet-stream"
          : att.mimeType;
        return {
          status: 200,
          binary: {
            bytes,
            contentType: safeMime,
            contentDisposition: `inline; filename="${att.filename}"`,
          },
        };
      }
    }

    if (resource === "avatars") {
      const AVATAR_MIME_EXT: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
      };
      const EXT_TO_MIME: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
      };

      if (method === "POST" && segments.length === 3) {
        const mimeType =
          typeof body.mimeType === "string" ? body.mimeType.trim().toLowerCase() : "";
        const ext = AVATAR_MIME_EXT[mimeType];
        if (!ext) {
          return jsonResp(400, {
            error: "unsupported_image_type",
            message: "Avatar must be PNG, JPEG, WEBP, or GIF.",
          });
        }
        const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
        if (!dataBase64) {
          return jsonResp(400, { error: "missing_data" });
        }
        const bytes = Uint8Array.from(Buffer.from(dataBase64, "base64"));
        if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024) {
          return jsonResp(400, {
            error: "invalid_avatar_size",
            message: "Avatar size must be between 1 byte and 5 MiB.",
          });
        }
        const fileName = `av_${NodeCrypto.randomUUID().slice(0, 12)}.${ext}`;
        NodeFS.writeFileSync(NodePath.join(vl.db.avatarsDir, fileName), bytes);
        return jsonResp(201, {
          id: fileName,
          url: `/api/vl/avatars/${fileName}`,
        });
      }

      if (method === "GET" && segments.length === 4 && segments[3]) {
        const fileName = segments[3];
        const match = /^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/i.exec(fileName);
        if (!match?.[1]) {
          return jsonResp(400, { error: "invalid_avatar_name" });
        }
        const filePath = NodePath.join(vl.db.avatarsDir, fileName);
        if (!NodeFS.existsSync(filePath)) {
          return jsonResp(404, { error: "avatar_not_found" });
        }
        const bytes = new Uint8Array(NodeFS.readFileSync(filePath));
        const contentType = EXT_TO_MIME[match[1].toLowerCase()] ?? "application/octet-stream";
        return {
          status: 200,
          binary: {
            bytes,
            contentType,
          },
        };
      }
    }

    if (resource === "plugins") {
      if (method === "GET" && segments.length === 3) {
        return jsonResp(200, {
          plugins: vl.plugins.listPlugins(),
          userPluginsDir: vl.plugins.userPluginsDir,
        });
      }
      if (method === "GET" && segments.length === 4 && segments[3] === "catalog") {
        return jsonResp(200, vl.plugins.listCatalog());
      }
      if (method === "POST" && segments.length === 4 && segments[3] === "sync") {
        const results = yield* Effect.promise(() => vl.plugins.syncAll());
        return jsonResp(200, {
          results,
          plugins: vl.plugins.listPlugins(),
        });
      }

      const pluginId = segments[3];
      if (!pluginId) {
        return jsonResp(404, { error: "plugin_not_found" });
      }

      if (method === "POST" && segments.length === 5 && segments[4] === "sync") {
        const result = yield* Effect.promise(() => vl.plugins.syncPlugin(pluginId));
        if (!result) {
          return jsonResp(404, { error: "plugin_not_found_or_disabled" });
        }
        return jsonResp(200, {
          result,
          plugin: vl.plugins.getPluginSummary(pluginId),
        });
      }

      if (method === "POST" && segments.length === 5 && segments[4] === "toggle") {
        const enabled = body.enabled !== false;
        const plugin = yield* Effect.promise(() => vl.plugins.setPluginEnabled(pluginId, enabled));
        if (!plugin) {
          return jsonResp(404, { error: "plugin_not_found" });
        }
        return jsonResp(200, { plugin });
      }

      if (method === "POST" && segments.length === 5 && segments[4] === "reload") {
        const plugin = yield* Effect.promise(() => vl.plugins.reloadPlugin(pluginId));
        if (!plugin) {
          return jsonResp(404, { error: "plugin_not_found" });
        }
        return jsonResp(200, { plugin });
      }

      if (method === "POST" && segments.length === 5 && segments[4] === "eject") {
        const res = yield* Effect.promise(() => vl.plugins.ejectPlugin(pluginId));
        if (!res.plugin) {
          return jsonResp(404, { error: "plugin_not_found", message: res.message });
        }
        return jsonResp(res.ok ? 200 : 400, res);
      }

      if (
        method === "GET" &&
        segments.length === 6 &&
        segments[4] === "update" &&
        segments[5] === "check"
      ) {
        const update = yield* Effect.promise(() => vl.plugins.checkUpdate(pluginId));
        if (!update) {
          return jsonResp(404, { error: "plugin_not_found" });
        }
        return jsonResp(200, { update });
      }

      if (method === "POST" && segments.length === 5 && segments[4] === "update") {
        const target = body.target === "plugin" ? "plugin" : "host";
        const force = body.force === true;
        const result = yield* Effect.promise(() =>
          vl.plugins.runUpdate(pluginId, { target, force }),
        );
        if (!result) {
          return jsonResp(404, { error: "plugin_not_found" });
        }
        return jsonResp(result.ok ? 200 : 500, {
          result,
          plugin: vl.plugins.getPluginSummary(pluginId),
        });
      }

      if (method === "POST" && segments.length === 5 && segments[4] === "action") {
        const action = typeof body.action === "string" ? body.action.trim() : "";
        if (!action) {
          return jsonResp(400, { error: "invalid_action", message: "Action name is required" });
        }
        const payload =
          typeof body.payload === "object" && body.payload !== null && !Array.isArray(body.payload)
            ? (body.payload as Record<string, unknown>)
            : {};
        const res = yield* Effect.tryPromise({
          try: () => vl.plugins.invokePluginAction(pluginId, action, payload),
          catch: (err) =>
            new VibeLinkError({
              message: err instanceof Error ? err.message : String(err),
            }),
        }).pipe(Effect.result);
        if (res._tag === "Failure") {
          const msg = res.failure.message;
          const status = /not found/i.test(msg)
            ? 404
            : /disabled|invalid|unsupported|required|not allowed/i.test(msg)
              ? 400
              : 500;
          return jsonResp(status, { error: "plugin_action_failed", message: msg });
        }
        return jsonResp(200, res.success);
      }
    }

    if (resource === "devices") {
      if (method === "GET" && segments.length === 3) {
        return jsonResp(200, {
          ok: true,
          devices: vl.devices.listDevices(),
        });
      }

      const deviceId = segments[3];
      if (!deviceId) {
        return jsonResp(404, { error: "device_not_found" });
      }

      if (method === "POST" && segments.length === 5 && segments[4] === "command") {
        const command = typeof body.command === "string" ? body.command.trim() : "";
        if (!command) {
          return jsonResp(400, { error: "invalid_command", message: "Device command is required" });
        }
        const params =
          typeof body.params === "object" && body.params !== null && !Array.isArray(body.params)
            ? (body.params as Record<string, unknown>)
            : {};
        const timeoutMs =
          typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
            ? body.timeoutMs
            : 20_000;

        const res = yield* Effect.tryPromise({
          try: () => vl.devices.invokeCommand(deviceId, command, params, timeoutMs),
          catch: (err) =>
            new VibeLinkError({
              message: err instanceof Error ? err.message : String(err),
            }),
        }).pipe(Effect.result);

        if (res._tag === "Failure") {
          const msg = res.failure.message;
          const status = /not found/i.test(msg)
            ? 404
            : /offline|没有在线/i.test(msg)
              ? 503
              : /timed out/i.test(msg)
                ? 504
                : 500;
          return jsonResp(status, { error: "device_command_failed", message: msg });
        }

        return jsonResp(200, res.success);
      }

      if (method === "POST" && segments.length === 5 && segments[4] === "sync-wproxy") {
        const scheme = body.scheme === "http" ? "http" : "socks5";
        const modeRaw = typeof body.mode === "string" ? body.mode : "auto";
        const mode =
          modeRaw === "vpn_tun" || modeRaw === "vpn_http" || modeRaw === "system_proxy"
            ? modeRaw
            : "auto";
        const dnsRaw = typeof body.dnsMode === "string" ? body.dnsMode : "over_tcp";
        const dnsMode =
          dnsRaw === "virtual" || dnsRaw === "direct" ? dnsRaw : "over_tcp";
        const host = typeof body.host === "string" ? body.host : undefined;

        const res = yield* Effect.tryPromise({
          try: () =>
            vl.devices.syncWProxyToDevice(vl.plugins, deviceId, {
              scheme,
              mode,
              dnsMode,
              ...(host ? { host } : {}),
            }),
          catch: (err) =>
            new VibeLinkError({
              message: err instanceof Error ? err.message : String(err),
            }),
        }).pipe(Effect.result);

        if (res._tag === "Failure") {
          const msg = res.failure.message;
          const status = /not found/i.test(msg)
            ? 404
            : /offline|没有在线|未运行/i.test(msg)
              ? 503
              : 400;
          return jsonResp(status, { error: "device_wproxy_sync_failed", message: msg });
        }

        return jsonResp(200, res.success);
      }

      if (method === "POST" && segments.length === 5 && segments[4] === "sync-mihomo") {
        const res = yield* Effect.tryPromise({
          try: () =>
            vl.devices.pushMihomoConfigToDevice(vl.plugins, deviceId, {
              ...(typeof body.yaml === "string" ? { yaml: body.yaml } : {}),
              ...(typeof body.configName === "string" ? { configName: body.configName } : {}),
              ...(typeof body.tailscaleAuthKey === "string"
                ? { tailscaleAuthKey: body.tailscaleAuthKey }
                : {}),
              ...(typeof body.hostname === "string" ? { hostname: body.hostname } : {}),
              ...(typeof body.resetTailscaleState === "boolean"
                ? { resetTailscaleState: body.resetTailscaleState }
                : {}),
              ...(typeof body.start === "boolean" ? { start: body.start } : {}),
            }),
          catch: (err) =>
            new VibeLinkError({
              message: err instanceof Error ? err.message : String(err),
            }),
        }).pipe(Effect.result);

        if (res._tag === "Failure") {
          const msg = res.failure.message;
          const status = /not found/i.test(msg)
            ? 404
            : /offline|没有在线/i.test(msg)
              ? 503
              : 400;
          return jsonResp(status, { error: "device_mihomo_sync_failed", message: msg });
        }

        return jsonResp(200, res.success);
      }
    }

    if (method === "GET" && resource === "infra" && segments[3] === "status") {
      const bots = vl.db.listAccounts("bot");
      const workingCount = bots.filter((b) => b.presence === "working").length;
      return jsonResp(200, {
        ok: true,
        readOnly: true,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        nodeVersion: process.version,
        homeDir: vl.db.homeDir,
        dbPath: vl.db.dbPath,
        mockBots: isMockBotsEnv(),
        botsTotal: bots.length,
        botsWorking: workingCount,
        roomsTotal: vl.db.listRoomSummaries("me").length,
        activeTerminals: vl.terminal.listSessions().length,
        pluginsCount: vl.plugins.listPlugins().length,
        userPluginsDir: vl.plugins.userPluginsDir,
        latestSeq: vl.db.getLatestSeq(),
      });
    }

    return jsonResp(404, { error: "not_found", path: pathname });
  });
}

function getRemoteAddressSafely(request: HttpServerRequest.HttpServerRequest): string | null {
  try {
    return NodeHttpServerRequest.toIncomingMessage(request).socket?.remoteAddress ?? null;
  } catch {
    return null;
  }
}

export const vibelinkHttpRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const vl = yield* VibeLinkService.VibeLinkService;
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const bodyText =
        request.method === "POST" || request.method === "PUT" || request.method === "PATCH"
          ? yield* request.text.pipe(Effect.orElseSucceed(() => ""))
          : "";
      const result = yield* dispatchVibeLinkHttp(vl, {
        method: request.method,
        url: request.url,
        headers: request.headers as Record<string, string | ReadonlyArray<string> | undefined>,
        remoteAddress: getRemoteAddressSafely(request),
        bodyText,
      });
      if (result.binary) {
        return HttpServerResponse.uint8Array(result.binary.bytes, {
          status: result.status,
          headers: {
            "content-type": result.binary.contentType,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
            ...(result.binary.contentDisposition
              ? { "content-disposition": result.binary.contentDisposition }
              : {}),
          },
        });
      }
      if (result.rawText) {
        return HttpServerResponse.text(result.rawText.body, {
          status: result.status,
          headers: {
            "content-type": result.rawText.contentType,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (result.json !== undefined) {
        return HttpServerResponse.jsonUnsafe(result.json, {
          status: result.status,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
          },
        });
      }
      return HttpServerResponse.empty({ status: result.status });
    });

    return Layer.mergeAll(
      HttpRouter.add("GET", "/api/vl/*", handler),
      HttpRouter.add("POST", "/api/vl/*", handler),
      HttpRouter.add("PUT", "/api/vl/*", handler),
      HttpRouter.add("PATCH", "/api/vl/*", handler),
      HttpRouter.add("DELETE", "/api/vl/*", handler),
      HttpRouter.add("OPTIONS", "/api/vl/*", handler),
      HttpRouter.add("GET", "/v1/*", handler),
      HttpRouter.add("POST", "/v1/*", handler),
      HttpRouter.add("OPTIONS", "/v1/*", handler),
    );
  }),
);
