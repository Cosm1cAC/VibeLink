import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { appendBotMemoryFact, tidyBotMemory } from "../bots/botMemory.ts";
import * as VibeLinkService from "../service.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

const failMcp = (code: "invalid_request" | "orchestration_error", message: string) =>
  new OrchestratorMcpFailure({ code, message });

const ListBotsTool = Tool.make("vl_list_bots", {
  description: "List all VibeLink Bots, their handles, providers, and live presence.",
  success: Schema.Struct({ bots: Schema.Array(Schema.Unknown) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List VibeLink Bots")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ListRoomsTool = Tool.make("vl_list_rooms", {
  description: "List VibeLink DM and group rooms with unread counts and members.",
  success: Schema.Struct({ rooms: Schema.Array(Schema.Unknown) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List VibeLink Rooms")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ReadRoomMessagesTool = Tool.make("vl_read_room_messages", {
  description: "Read recent messages from a VibeLink IM/group room.",
  parameters: Schema.Struct({
    roomId: Schema.String,
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.Struct({ messages: Schema.Array(Schema.Unknown) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read VibeLink Room Messages")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PostRoomMessageTool = Tool.make("vl_post_room_message", {
  description: "Post a message into a VibeLink room (as a bot or room collaborator).",
  parameters: Schema.Struct({
    roomId: Schema.String,
    content: Schema.String,
    senderBotId: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ message: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Post VibeLink Room Message")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const HandoffToBotTool = Tool.make("vl_handoff_to_bot", {
  description: "Explicitly hand off a task to a named Bot in a room.",
  parameters: Schema.Struct({
    roomId: Schema.String,
    targetBotIdOrHandle: Schema.String,
    task: Schema.String,
    fromBotId: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    message: Schema.Unknown,
    triggeredBotIds: Schema.Array(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Handoff Task to VibeLink Bot")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ReadBotMemoryTool = Tool.make("vl_read_bot_memory", {
  description: "Read SOUL.md or MEMORY.md for a VibeLink Bot.",
  parameters: Schema.Struct({
    botIdOrSlug: Schema.String,
    file: Schema.optional(Schema.Literals(["SOUL.md", "MEMORY.md"])),
  }),
  success: Schema.Struct({
    slug: Schema.String,
    file: Schema.String,
    content: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read VibeLink Bot Memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const UpdateBotMemoryTool = Tool.make("vl_update_bot_memory", {
  description: "Append a concise fact to a Bot's MEMORY.md and enforce the 40-fact archive budget.",
  parameters: Schema.Struct({
    botIdOrSlug: Schema.String,
    fact: Schema.String,
  }),
  success: Schema.Struct({
    slug: Schema.String,
    activeCount: Schema.Number,
    archivedCount: Schema.Number,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update VibeLink Bot Memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PhoneListDevicesTool = Tool.make("vl_phone_list_devices", {
  description:
    "List paired Android phones, online state, active channel, Root/Shizuku/Accessibility/VPN capabilities, and current proxy mode.",
  success: Schema.Struct({ devices: Schema.Array(Schema.Unknown) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List Paired Android Phones")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PhoneGetStatusTool = Tool.make("vl_phone_get_status", {
  description: "Query live hardware, battery, foreground app, capability flags, and proxy status from a paired Android phone.",
  parameters: Schema.Struct({
    deviceId: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    deviceId: Schema.String,
    status: Schema.Unknown,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get Android Phone Status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PhoneSyncWProxyTool = Tool.make("vl_phone_sync_wproxy", {
  description:
    "Push PC WProxy proxy configuration to a paired Android phone and silently activate it (Root/Shizuku system proxy or non-root VpnService TUN/HTTP).",
  parameters: Schema.Struct({
    deviceId: Schema.optional(Schema.String),
    scheme: Schema.optional(Schema.Literals(["socks5", "http"])),
    mode: Schema.optional(Schema.Literals(["auto", "vpn_tun", "vpn_http", "system_proxy"])),
    dnsMode: Schema.optional(Schema.Literals(["over_tcp", "virtual", "direct"])),
    host: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    deviceId: Schema.String,
    proxyUrl: Schema.String,
    host: Schema.String,
    scheme: Schema.String,
    result: Schema.Unknown,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Sync PC WProxy to Android Phone")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PhoneSetProxyTool = Tool.make("vl_phone_set_proxy", {
  description: "Apply or clear a custom proxy configuration on the paired Android phone without user intervention.",
  parameters: Schema.Struct({
    action: Schema.Literals(["apply", "clear"]),
    deviceId: Schema.optional(Schema.String),
    proxyUrl: Schema.optional(Schema.String),
    mode: Schema.optional(Schema.Literals(["auto", "vpn_tun", "vpn_http", "system_proxy"])),
    dnsMode: Schema.optional(Schema.Literals(["over_tcp", "virtual", "direct"])),
    bypassPackages: Schema.optional(Schema.Array(Schema.String)),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    data: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Configure Android Phone Proxy")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PhoneUiTreeTool = Tool.make("vl_phone_ui_tree", {
  description: "Inspect the current Android UI view hierarchy (elements, text, bounds, clickable/editable flags) via AccessibilityService.",
  parameters: Schema.Struct({
    deviceId: Schema.optional(Schema.String),
    maxDepth: Schema.optional(Schema.Number),
  }),
  success: Schema.Struct({
    packageName: Schema.optional(Schema.String),
    nodes: Schema.Array(Schema.Unknown),
    raw: Schema.Unknown,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Inspect Android Phone UI Tree")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PhoneScreenshotTool = Tool.make("vl_phone_screenshot", {
  description: "Capture the current Android screen (Root screencap or AccessibilityService API 30+, no prompt) and save to ~/.vibelink/screenshots/.",
  parameters: Schema.Struct({
    deviceId: Schema.optional(Schema.String),
    quality: Schema.optional(Schema.Number),
    maxWidth: Schema.optional(Schema.Number),
    includeBase64: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    filePath: Schema.String,
    mimeType: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    bytes: Schema.Number,
    backend: Schema.String,
    base64: Schema.optional(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Capture Android Phone Screenshot")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PhoneUiActionTool = Tool.make("vl_phone_ui_action", {
  description:
    "Control Android phone UI or apps: tap(x,y or text/resourceId/contentDesc), swipe, input(text), key(home/back/recents/notifications/quick_settings), launch_app, list_apps, clipboard_get/set, or wake.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "tap",
      "swipe",
      "input",
      "key",
      "launch_app",
      "list_apps",
      "clipboard_get",
      "clipboard_set",
      "wake",
    ]),
    deviceId: Schema.optional(Schema.String),
    x: Schema.optional(Schema.Number),
    y: Schema.optional(Schema.Number),
    x2: Schema.optional(Schema.Number),
    y2: Schema.optional(Schema.Number),
    durationMs: Schema.optional(Schema.Number),
    text: Schema.optional(Schema.String),
    resourceId: Schema.optional(Schema.String),
    contentDesc: Schema.optional(Schema.String),
    index: Schema.optional(Schema.Number),
    clearFirst: Schema.optional(Schema.Boolean),
    key: Schema.optional(Schema.String),
    packageName: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    action: Schema.String,
    data: Schema.optional(Schema.Unknown),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Perform Android Phone UI Action")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PhoneShellTool = Tool.make("vl_phone_shell", {
  description: "Execute a shell command on a paired Android phone via Root (su) or Shizuku privileged service.",
  parameters: Schema.Struct({
    command: Schema.String,
    deviceId: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Number),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    backend: Schema.String,
    exitCode: Schema.Number,
    stdout: Schema.String,
    stderr: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Execute Privileged Android Shell Command")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PhoneMihomoTool = Tool.make("vl_phone_mihomo", {
  description:
    "Control the embedded Mihomo core inside the VibeLink Android app: check status, push merged Clash/Tailscale config, start/stop single-app VPN, list/select nodes, switch route mode (rule/global/direct), or run delay tests.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "status",
      "sync_config",
      "start",
      "stop",
      "proxies",
      "select",
      "mode",
      "delay",
    ]),
    deviceId: Schema.optional(Schema.String),
    group: Schema.optional(Schema.String),
    node: Schema.optional(Schema.String),
    mode: Schema.optional(Schema.Literals(["rule", "global", "direct"])),
    yaml: Schema.optional(Schema.String),
    configName: Schema.optional(Schema.String),
    tailscaleAuthKey: Schema.optional(Schema.String),
    resetTailscaleState: Schema.optional(Schema.Boolean),
    start: Schema.optional(Schema.Boolean),
    url: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Number),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    action: Schema.String,
    data: Schema.optional(Schema.Unknown),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Control Android Embedded Mihomo Core")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const VibeLinkCollaborationToolkit = Toolkit.make(
  ListBotsTool,
  ListRoomsTool,
  ReadRoomMessagesTool,
  PostRoomMessageTool,
  HandoffToBotTool,
  ReadBotMemoryTool,
  UpdateBotMemoryTool,
  PhoneListDevicesTool,
  PhoneGetStatusTool,
  PhoneSyncWProxyTool,
  PhoneSetProxyTool,
  PhoneUiTreeTool,
  PhoneScreenshotTool,
  PhoneUiActionTool,
  PhoneShellTool,
  PhoneMihomoTool,
);

export const layerVibeLinkCollaborationHandlers = McpToolAccess.toLayer(
  VibeLinkCollaborationToolkit,
  Effect.gen(function* () {
    const vlOpt = yield* Effect.serviceOption(VibeLinkService.VibeLinkService);

    const requireVl = () =>
      Effect.fromOption(vlOpt).pipe(
        Effect.mapError(() => failMcp("orchestration_error", "VibeLinkService is not available.")),
      );

    return {
      vl_list_bots: McpToolAccess.actsAsCaller(() =>
        Effect.map(requireVl(), (vl) => ({ bots: vl.db.listAccounts("bot") })),
      ),
      vl_list_rooms: McpToolAccess.actsAsCaller(() =>
        Effect.map(requireVl(), (vl) => ({ rooms: vl.db.listRoomSummaries("me") })),
      ),
      vl_read_room_messages: McpToolAccess.actsAsCaller((input) =>
        Effect.map(requireVl(), (vl) => ({
          messages: vl.db.listMessages(input.roomId, { limit: input.limit ?? 50 }),
        })),
      ),
      vl_post_room_message: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.sync(() => {
            const msg = vl.db.createMessage({
              roomId: input.roomId,
              senderId: input.senderBotId ?? "me",
              msgType: input.senderBotId ? "bot_markdown" : "text",
              content: input.content,
            });
            return { message: msg };
          }),
        ),
      ),
      vl_handoff_to_bot: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.gen(function* () {
            const target = vl.db.getAccountBySlugOrHandle(input.targetBotIdOrHandle);
            if (!target || target.kind !== "bot") {
              return yield* failMcp(
                "invalid_request",
                `Target bot not found: ${input.targetBotIdOrHandle}`,
              );
            }
            const res = yield* vl.orchestration
              .sendRoomMessage({
                roomId: input.roomId,
                senderId: input.fromBotId ?? "me",
                targetBotId: target.id,
                content: `@${target.handle} ${input.task}`,
                msgType: input.fromBotId ? "bot_markdown" : "text",
              })
              .pipe(Effect.mapError((err) => failMcp("orchestration_error", err.message)));
            return {
              message: res.userMessage,
              triggeredBotIds: [...res.triggeredBotIds],
            };
          }),
        ),
      ),
      vl_read_bot_memory: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.gen(function* () {
            const bot = vl.db.getAccountBySlugOrHandle(input.botIdOrSlug);
            if (!bot || bot.kind !== "bot") {
              return yield* failMcp("invalid_request", `Bot not found: ${input.botIdOrSlug}`);
            }
            const file = input.file ?? "MEMORY.md";
            const content = vl.botHome.readBotFile(bot.slug, file) ?? "";
            return { slug: bot.slug, file, content };
          }),
        ),
      ),
      vl_update_bot_memory: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.gen(function* () {
            const bot = vl.db.getAccountBySlugOrHandle(input.botIdOrSlug);
            if (!bot || bot.kind !== "bot") {
              return yield* failMcp("invalid_request", `Bot not found: ${input.botIdOrSlug}`);
            }
            const res = appendBotMemoryFact(vl.botHome, bot.slug, input.fact);
            tidyBotMemory(vl.botHome, bot.slug);
            return {
              slug: res.slug,
              activeCount: res.activeCount,
              archivedCount: res.archivedCount,
            };
          }),
        ),
      ),
      vl_phone_list_devices: McpToolAccess.actsAsCaller(() =>
        Effect.map(requireVl(), (vl) => ({ devices: vl.devices.listDevices() })),
      ),
      vl_phone_get_status: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.tryPromise({
            try: async () => {
              const dev = vl.devices.getDevice(input.deviceId);
              const res = await vl.devices.invokeCommand(dev.deviceId, "device.info", {}, 15_000);
              return { deviceId: dev.deviceId, status: res.data ?? dev };
            },
            catch: (err) => failMcp("orchestration_error", err instanceof Error ? err.message : String(err)),
          }),
        ),
      ),
      vl_phone_sync_wproxy: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.tryPromise({
            try: () =>
              vl.devices.syncWProxyToDevice(vl.plugins, input.deviceId, {
                scheme: input.scheme,
                mode: input.mode,
                dnsMode: input.dnsMode,
                host: input.host,
              }),
            catch: (err) => failMcp("orchestration_error", err instanceof Error ? err.message : String(err)),
          }),
        ),
      ),
      vl_phone_set_proxy: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.tryPromise({
            try: async () => {
              if (input.action === "clear") {
                const res = await vl.devices.invokeCommand(input.deviceId, "proxy.clear", {}, 20_000);
                return { ok: res.ok, data: res.data, error: res.error };
              }
              const res = await vl.devices.invokeCommand(
                input.deviceId,
                "proxy.apply",
                {
                  mode: input.mode ?? "auto",
                  proxyUrl: input.proxyUrl ?? "",
                  dnsMode: input.dnsMode ?? "over_tcp",
                  bypassPackages: input.bypassPackages ?? [],
                },
                25_000,
              );
              return { ok: res.ok, data: res.data, error: res.error };
            },
            catch: (err) => failMcp("orchestration_error", err instanceof Error ? err.message : String(err)),
          }),
        ),
      ),
      vl_phone_ui_tree: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.tryPromise({
            try: async () => {
              const res = await vl.devices.invokeCommand(
                input.deviceId,
                "ui.tree",
                { maxDepth: input.maxDepth ?? 12 },
                20_000,
              );
              if (!res.ok) {
                throw new Error(res.error || "Failed to inspect phone UI tree");
              }
              const data = (res.data ?? {}) as { packageName?: string; nodes?: unknown[] };
              return {
                packageName: data.packageName,
                nodes: Array.isArray(data.nodes) ? data.nodes : [],
                raw: res.data ?? {},
              };
            },
            catch: (err) => failMcp("orchestration_error", err instanceof Error ? err.message : String(err)),
          }),
        ),
      ),
      vl_phone_screenshot: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.tryPromise({
            try: async () => {
              const res = await vl.devices.invokeCommand(
                input.deviceId,
                "ui.screenshot",
                {
                  quality: input.quality ?? 85,
                  maxWidth: input.maxWidth ?? 1080,
                },
                25_000,
              );
              if (!res.ok) {
                throw new Error(res.error || "Failed to capture phone screenshot");
              }
              const data = (res.data ?? {}) as {
                base64?: string;
                mimeType?: string;
                width?: number;
                height?: number;
                backend?: string;
              };
              const b64 = String(data.base64 || "");
              const buf = Buffer.from(b64, "base64");
              const shotsDir = NodePath.join(vl.db.homeDir, "screenshots");
              NodeFS.mkdirSync(shotsDir, { recursive: true });
              const ext = (data.mimeType || "").includes("jpeg") ? "jpg" : "png";
              const filePath = NodePath.join(shotsDir, `phone-${Date.now()}.${ext}`);
              NodeFS.writeFileSync(filePath, buf);
              return {
                filePath,
                mimeType: data.mimeType || "image/png",
                width: Number(data.width || 0),
                height: Number(data.height || 0),
                bytes: buf.length,
                backend: data.backend || "unknown",
                ...(input.includeBase64 ? { base64: b64 } : {}),
              };
            },
            catch: (err) => failMcp("orchestration_error", err instanceof Error ? err.message : String(err)),
          }),
        ),
      ),
      vl_phone_ui_action: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.tryPromise({
            try: async () => {
              const cmdMap: Record<string, string> = {
                tap: "ui.tap",
                swipe: "ui.swipe",
                input: "ui.input",
                key: "ui.key",
                launch_app: "app.launch",
                list_apps: "app.list",
                clipboard_get: "clipboard.get",
                clipboard_set: "clipboard.set",
                wake: "device.wake",
              };
              const command = cmdMap[input.action];
              const res = await vl.devices.invokeCommand(
                input.deviceId,
                command,
                {
                  x: input.x,
                  y: input.y,
                  x2: input.x2,
                  y2: input.y2,
                  durationMs: input.durationMs,
                  text: input.text,
                  resourceId: input.resourceId,
                  contentDesc: input.contentDesc,
                  index: input.index,
                  clearFirst: input.clearFirst,
                  key: input.key,
                  packageName: input.packageName,
                },
                20_000,
              );
              if (!res.ok) {
                throw new Error(res.error || `Phone UI action ${input.action} failed`);
              }
              return { ok: true, action: input.action, data: res.data };
            },
            catch: (err) => failMcp("orchestration_error", err instanceof Error ? err.message : String(err)),
          }),
        ),
      ),
      vl_phone_shell: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.tryPromise({
            try: async () => {
              const res = await vl.devices.invokeCommand(
                input.deviceId,
                "shell.exec",
                {
                  command: input.command,
                  timeoutMs: input.timeoutMs ?? 15_000,
                },
                (input.timeoutMs ?? 15_000) + 5_000,
              );
              const data = (res.data ?? {}) as {
                backend?: string;
                exitCode?: number;
                stdout?: string;
                stderr?: string;
              };
              if (!res.ok && !data.backend) {
                throw new Error(res.error || "Privileged shell command failed");
              }
              return {
                ok: res.ok,
                backend: data.backend || "none",
                exitCode: typeof data.exitCode === "number" ? data.exitCode : res.ok ? 0 : -1,
                stdout: data.stdout || "",
                stderr: data.stderr || res.error || "",
              };
            },
            catch: (err) => failMcp("orchestration_error", err instanceof Error ? err.message : String(err)),
          }),
        ),
      ),
      vl_phone_mihomo: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(requireVl(), (vl) =>
          Effect.tryPromise({
            try: async () => {
              if (input.action === "sync_config") {
                const res = await vl.devices.pushMihomoConfigToDevice(vl.plugins, input.deviceId, {
                  ...(input.yaml ? { yaml: input.yaml } : {}),
                  ...(input.configName ? { configName: input.configName } : {}),
                  ...(input.tailscaleAuthKey ? { tailscaleAuthKey: input.tailscaleAuthKey } : {}),
                  ...(input.resetTailscaleState !== undefined
                    ? { resetTailscaleState: input.resetTailscaleState }
                    : {}),
                  ...(input.start !== undefined ? { start: input.start } : {}),
                });
                return { ok: true, action: input.action, data: res };
              }
              const cmdMap: Record<string, string> = {
                status: "mihomo.status",
                start: "mihomo.start",
                stop: "mihomo.stop",
                proxies: "mihomo.proxies",
                select: "mihomo.select",
                mode: "mihomo.mode",
                delay: "mihomo.delay",
              };
              const command = cmdMap[input.action] ?? "mihomo.status";
              const res = await vl.devices.invokeCommand(
                input.deviceId,
                command,
                {
                  group: input.group,
                  node: input.node,
                  mode: input.mode,
                  yaml: input.yaml,
                  configName: input.configName,
                  resetTailscaleState: input.resetTailscaleState,
                  url: input.url,
                  timeoutMs: input.timeoutMs,
                },
                30_000,
              );
              if (!res.ok) {
                throw new Error(res.error || `Phone mihomo ${input.action} failed`);
              }
              return { ok: true, action: input.action, data: res.data };
            },
            catch: (err) => failMcp("orchestration_error", err instanceof Error ? err.message : String(err)),
          }),
        ),
      ),
    } satisfies McpToolAccess.Handlers<typeof VibeLinkCollaborationToolkit.tools>;
  }),
);
