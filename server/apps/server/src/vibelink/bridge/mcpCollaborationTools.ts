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

export const VibeLinkCollaborationToolkit = Toolkit.make(
  ListBotsTool,
  ListRoomsTool,
  ReadRoomMessagesTool,
  PostRoomMessageTool,
  HandoffToBotTool,
  ReadBotMemoryTool,
  UpdateBotMemoryTool,
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
    } satisfies McpToolAccess.Handlers<typeof VibeLinkCollaborationToolkit.tools>;
  }),
);
