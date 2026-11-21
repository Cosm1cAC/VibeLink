// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectService from "../../project/ProjectService.ts";
import { BotHomeManager } from "../bots/botHome.ts";
import {
  canContinueGroupHandoff,
  extractGroupBotMentions,
  MAX_GROUP_HANDOFFS,
} from "../bots/botGroupMentions.ts";
import type { VibeLinkDatabase } from "../db.ts";
import {
  VibeLinkError,
  type VlAccount,
  type VlApproval,
  type VlMessage,
  type VlRoom,
  type VlSendMode,
} from "../types.ts";

function mapEngineToProviderInstance(engine: string): {
  readonly instanceId: ProviderInstanceId;
  readonly defaultModel: string;
} {
  switch (engine.trim().toLowerCase()) {
    case "claude":
    case "claudeagent":
      return { instanceId: ProviderInstanceId.make("claudeAgent"), defaultModel: "claude-sonnet-4-5" };
    case "opencode":
      return { instanceId: ProviderInstanceId.make("opencode"), defaultModel: "zai/glm-4.7" };
    case "codex":
      return { instanceId: ProviderInstanceId.make("codex"), defaultModel: "gpt-5.3-codex" };
    case "antigravity":
    default:
      return { instanceId: ProviderInstanceId.make("antigravity"), defaultModel: "gemini-2.5-pro" };
  }
}

function stableUuidFromSeed(seed: string): string {
  const hash = NodeCrypto.createHash("sha256").update(seed).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function isMockBotsMode(): boolean {
  return process.env.VIBELINK_MOCK_BOTS === "1";
}

export interface SendMessageResult {
  readonly userMessage: VlMessage;
  readonly triggeredBotIds: ReadonlyArray<string>;
}

export class VibeLinkOrchestrationBridge {
  private readonly db: VibeLinkDatabase;
  private readonly botHome: BotHomeManager;
  private readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"] | null;
  private readonly projectStore: ProjectStore.ProjectStoreV2["Service"] | null;
  private readonly projectService: ProjectService.ProjectService["Service"] | null;
  private readonly turnItemMsgIds = new Map<string, string>();
  private readonly processedRunHandoffs = new Set<string>();
  private readonly threadRunContext = new Map<
    string,
    { readonly chainId: string; readonly depth: number }
  >();
  private readonly activeMockFibers = new Map<string, Set<Fiber.Fiber<void, never>>>();
  private domainEventFiber: Fiber.Fiber<void, unknown> | null = null;

  constructor(
    db: VibeLinkDatabase,
    botHome: BotHomeManager,
    threadManagement: ThreadManagementService.ThreadManagementService["Service"] | null,
    projectStore: ProjectStore.ProjectStoreV2["Service"] | null,
    projectService: ProjectService.ProjectService["Service"] | null = null,
  ) {
    this.db = db;
    this.botHome = botHome;
    this.threadManagement = threadManagement;
    this.projectStore = projectStore;
    this.projectService = projectService;
  }

  startEventRelay(): Effect.Effect<void> {
    if (!this.threadManagement || this.domainEventFiber) {
      return Effect.void;
    }
    const bridge = this;
    return Effect.gen(function* () {
      const stream = bridge.threadManagement!.streamDomainEvents;
      const fiber = yield* stream.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            bridge.handleDomainEvent(event);
          }),
        ),
        Effect.ignoreCause,
        Effect.forkDetach,
      );
      bridge.domainEventFiber = fiber;
    });
  }

  stop(): Effect.Effect<void> {
    const bridge = this;
    return Effect.gen(function* () {
      for (const fibers of bridge.activeMockFibers.values()) {
        for (const f of fibers) {
          yield* Fiber.interrupt(f).pipe(Effect.ignore);
        }
      }
      bridge.activeMockFibers.clear();
      const fiber = bridge.domainEventFiber;
      bridge.domainEventFiber = null;
      if (fiber) {
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
      }
    });
  }

  sendRoomMessage(input: {
    readonly roomId: string;
    readonly content: string;
    readonly senderId?: string;
    readonly msgType?: VlMessage["msgType"];
    readonly metadata?: Record<string, unknown>;
    readonly replyToId?: string | null;
    readonly mode?: VlSendMode;
    readonly targetBotId?: string | null;
  }): Effect.Effect<SendMessageResult, VibeLinkError> {
    const bridge = this;
    return Effect.gen(function* () {
      const room = bridge.db.getRoom(input.roomId);
      if (!room) {
        return yield* new VibeLinkError({ message: `Room not found: ${input.roomId}` });
      }
      const senderId = input.senderId ?? "me";
      const userMessage = bridge.db.createMessage({
        roomId: room.id,
        senderId,
        msgType: input.msgType ?? "text",
        content: input.content,
        metadata: input.metadata ?? {},
        replyToId: input.replyToId ?? null,
      });

      if (senderId === "me") {
        bridge.db.markRoomRead(room.id, "me", userMessage.id);
      }

      if (senderId !== "me" && !input.targetBotId) {
        return { userMessage, triggeredBotIds: [] };
      }

      const roomBots = bridge.db.getRoomBotAccounts(room.id);
      let targets: ReadonlyArray<VlAccount> = [];
      if (input.targetBotId) {
        const direct = roomBots.find((b) => b.id === input.targetBotId);
        if (direct) targets = [direct];
      } else if (room.kind === "dm") {
        targets = roomBots.slice(0, 1);
      } else {
        targets = extractGroupBotMentions({
          markdown: input.content,
          candidates: roomBots,
          excludeAccountId: senderId,
        });
      }

      if (targets.length === 0) {
        return { userMessage, triggeredBotIds: [] };
      }

      const chainId = `chain_${NodeCrypto.randomUUID().slice(0, 12)}`;
      for (const bot of targets) {
        yield* bridge
          .dispatchToBot({
            room,
            bot,
            userText: input.content,
            roomBots,
            mode: input.mode ?? "auto",
            handoffChainId: chainId,
            handoffDepth: 0,
            replyToId: userMessage.id,
          })
          .pipe(Effect.forkDetach);
      }

      return {
        userMessage,
        triggeredBotIds: targets.map((b) => b.id),
      };
    });
  }

  interruptRoom(roomId: string): Effect.Effect<number> {
    const bridge = this;
    return Effect.gen(function* () {
      let interrupted = 0;
      const fibers = bridge.activeMockFibers.get(roomId);
      if (fibers) {
        for (const f of fibers) {
          yield* Fiber.interrupt(f).pipe(Effect.ignore);
        }
        fibers.clear();
        interrupted += 1;
      }

      const bindings = bridge.db.listRoomBotThreads(roomId);
      if (bridge.threadManagement) {
        for (const binding of bindings) {
          const res = yield* bridge.threadManagement
            .interruptThread({
              projectId: ProjectId.make(binding.projectId),
              commandId: CommandId.make(`vl_int_${NodeCrypto.randomUUID()}`),
              threadId: ThreadId.make(binding.threadId),
              reason: "User interrupted from VibeLink chat",
            })
            .pipe(Effect.result);
          if (res._tag === "Success" && res.success.type === "interrupt_requested") {
            interrupted += 1;
          }
        }
      }

      for (const bot of bridge.db.getRoomBotAccounts(roomId)) {
        if (bot.presence === "working") {
          bridge.db.updateAccountFields(bot.id, {
            presence: "idle",
            statusText: bot.roleTitle || "已暂停",
          });
        }
      }

      bridge.db.createMessage({
        roomId,
        senderId: "me",
        msgType: "system",
        content: "已发送中断信号，Bot 当前轮次已停止。",
        metadata: { systemKind: "interrupt" },
      });

      return interrupted;
    });
  }

  respondApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    feedback?: string,
  ): Effect.Effect<VlApproval | null> {
    const bridge = this;
    return Effect.gen(function* () {
      const existing = bridge.db.getApproval(approvalId);
      if (!existing) return null;

      if (bridge.threadManagement && existing.threadId && existing.requestId) {
        const providerDecision: ProviderApprovalDecision =
          decision === "approved" ? "accept" : "decline";
        yield* bridge.threadManagement
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(`vl_apr_${NodeCrypto.randomUUID()}`),
            threadId: ThreadId.make(existing.threadId),
            requestId: RuntimeRequestId.make(existing.requestId),
            decision: providerDecision,
            ...(feedback ? { feedback } : {}),
          })
          .pipe(Effect.ignore);
      }

      return bridge.db.resolveApproval(approvalId, decision, decision);
    });
  }

  listRoomCheckpoints(roomId: string): ReadonlyArray<VlMessage> {
    return this.db
      .listMessages(roomId, { limit: 300 })
      .filter((msg) => msg.msgType === "bot_diff_checkpoint");
  }

  rollbackCheckpoint(input: {
    readonly roomId: string;
    readonly messageId?: string;
    readonly checkpointId?: string;
    readonly scopeId?: string;
    readonly threadId?: string;
  }): Effect.Effect<{ readonly ok: boolean; readonly note: string }> {
    const bridge = this;
    return Effect.gen(function* () {
      const targetMsg = input.messageId
        ? bridge.db.getMessage(input.messageId)
        : bridge.listRoomCheckpoints(input.roomId).at(-1) ?? null;

      const meta = targetMsg?.metadata ?? {};
      const threadId =
        input.threadId ?? (typeof meta.threadId === "string" ? meta.threadId : null);
      const scopeId = input.scopeId ?? (typeof meta.scopeId === "string" ? meta.scopeId : null);
      const checkpointId =
        input.checkpointId ?? (typeof meta.checkpointId === "string" ? meta.checkpointId : null);

      if (bridge.threadManagement && threadId && scopeId && checkpointId) {
        const res = yield* bridge.threadManagement
          .dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make(`vl_rb_${NodeCrypto.randomUUID()}`),
            threadId: ThreadId.make(threadId),
            scopeId: CheckpointScopeId.make(scopeId),
            checkpointId: CheckpointId.make(checkpointId),
            restoreFiles: true,
          })
          .pipe(Effect.result);
        if (res._tag === "Failure") {
          const errNote = `检查点回滚失败：${String(res.failure)}`;
          bridge.db.createMessage({
            roomId: input.roomId,
            senderId: "me",
            msgType: "system",
            content: errNote,
          });
          return { ok: false, note: errNote };
        }
      }

      const note = checkpointId
        ? `已回滚工作区检查点 ${checkpointId}`
        : "已记录检查点回滚操作";
      bridge.db.createMessage({
        roomId: input.roomId,
        senderId: "me",
        msgType: "system",
        content: note,
        metadata: { systemKind: "checkpoint_rollback", checkpointId },
      });
      return { ok: true, note };
    });
  }

  private dispatchToBot(input: {
    readonly room: VlRoom;
    readonly bot: VlAccount;
    readonly userText: string;
    readonly roomBots: ReadonlyArray<VlAccount>;
    readonly mode: VlSendMode;
    readonly handoffChainId: string;
    readonly handoffDepth: number;
    readonly replyToId: string | null;
  }): Effect.Effect<void> {
    const bridge = this;

    if (!canContinueGroupHandoff(input.handoffDepth)) {
      return Effect.sync(() => {
        bridge.db.createMessage({
          roomId: input.room.id,
          senderId: "me",
          msgType: "system",
          content: `群聊 @Bot 接力已达到最大深度 (${MAX_GROUP_HANDOFFS} 轮)，已自动停止以防循环。`,
          handoffChainId: input.handoffChainId,
          handoffDepth: input.handoffDepth,
        });
      });
    }

    if (isMockBotsMode() || !bridge.threadManagement || !bridge.projectStore) {
      return bridge.runMockBotTurn(input);
    }

    return Effect.gen(function* () {
      bridge.db.updateAccountFields(input.bot.id, {
        presence: "working",
        statusText: `运行中 (${input.bot.provider || "agent"})...`,
      });

      const bindingResult = yield* bridge
        .ensureRoomBotThread(input.room, input.bot)
        .pipe(Effect.result);

      if (bindingResult._tag === "Failure") {
        bridge.postFallbackNotice(input, bindingResult.failure.message);
        return;
      }

      const binding = bindingResult.success;
      bridge.threadRunContext.set(binding.threadId, {
        chainId: input.handoffChainId,
        depth: input.handoffDepth,
      });

      const systemPersona = bridge.botHome.composeBotSystemPrompt(input.bot, {
        roomId: input.room.id,
        roomKind: input.room.kind,
        roomName: input.room.name,
        teammates: input.roomBots,
      });

      const fullPrompt = `${systemPersona}\n\n---\n[User / Room Message]\n${input.userText}`;
      const mapped = mapEngineToProviderInstance(input.bot.provider);
      const sendRes = yield* bridge.threadManagement!
        .sendToThread({
          projectId: ProjectId.make(binding.projectId),
          threadId: ThreadId.make(binding.threadId),
          commandId: CommandId.make(`vl_send_${NodeCrypto.randomUUID()}`),
          messageId: MessageId.make(`vl_u_${NodeCrypto.randomUUID()}`),
          text: fullPrompt,
          attachments: [],
          modelSelection: {
            instanceId: mapped.instanceId,
            model: input.bot.model.trim() || mapped.defaultModel,
          },
          mode: input.mode,
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.result);

      if (sendRes._tag === "Failure") {
        bridge.postFallbackNotice(input, String(sendRes.failure));
      }
    });
  }

  private postFallbackNotice(
    input: {
      readonly room: VlRoom;
      readonly bot: VlAccount;
      readonly replyToId: string | null;
      readonly handoffChainId: string;
      readonly handoffDepth: number;
    },
    reason: string,
  ): void {
    this.db.createMessage({
      roomId: input.room.id,
      senderId: input.bot.id,
      msgType: "bot_markdown",
      content: `⚠️ **${input.bot.displayName}** 暂时无法拉起底层引擎 \`${input.bot.provider || "default"}\`。\n\n> 原因：${reason}\n\n可在终端 Tab 启动 CLI 检查登录态，或设置 \`VIBELINK_MOCK_BOTS=1\` 使用离线模拟联调模式。`,
      replyToId: input.replyToId,
      handoffChainId: input.handoffChainId,
      handoffDepth: input.handoffDepth,
      metadata: { fallback: true },
    });
    this.db.updateAccountFields(input.bot.id, {
      presence: "idle",
      statusText: input.bot.roleTitle || "就绪",
    });
  }

  private ensureRoomBotThread(
    room: VlRoom,
    bot: VlAccount,
  ): Effect.Effect<{ readonly projectId: string; readonly threadId: string }, VibeLinkError> {
    const bridge = this;
    return Effect.gen(function* () {
      const existing = bridge.db.getRoomBotThread(room.id, bot.id);
      if (existing) {
        return { projectId: existing.projectId, threadId: existing.threadId };
      }

      const candidateCwd =
        [bot.cwd, room.cwd, process.cwd()].find(
          (dir) => Boolean(dir) && NodeFS.existsSync(dir!) && NodeFS.statSync(dir!).isDirectory(),
        ) ?? process.cwd();
      const workspaceRoot = NodePath.resolve(candidateCwd);

      const activeProject = yield* bridge.projectStore!.findActiveByWorkspaceRoot(workspaceRoot);

      let projectId: string;
      if (activeProject._tag === "Some") {
        projectId = activeProject.value.projectId;
      } else if (bridge.projectService) {
        const bootstrapped = yield* bridge.projectService.bootstrap({
          commandId: CommandId.make(`vl_pc_${NodeCrypto.randomUUID()}`),
          projectId: ProjectId.make(stableUuidFromSeed(`vl_project:${workspaceRoot}`)),
          title: NodePath.basename(workspaceRoot) || "VibeLink",
          workspaceRoot,
        });
        projectId = bootstrapped.project.id;
      } else {
        return yield* new VibeLinkError({
          message: `Workspace project is not initialized and ProjectService is unavailable for ${workspaceRoot}`,
        });
      }

      const threadId = `vl_${room.id}_${bot.id}_${NodeCrypto.randomUUID().slice(0, 8)}`;
      const mapped = mapEngineToProviderInstance(bot.provider);
      yield* bridge.threadManagement!.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`vl_tc_${NodeCrypto.randomUUID()}`),
        threadId: ThreadId.make(threadId),
        projectId: ProjectId.make(projectId),
        title: `${room.name} · ${bot.displayName}`,
        modelSelection: {
          instanceId: mapped.instanceId,
          model: bot.model.trim() || mapped.defaultModel,
        },
        runtimeMode:
          bot.approvalMode === "accept_edits" || bot.approvalMode === "full_access"
            ? "auto-accept-edits"
            : "approval-required",
        interactionMode: bot.approvalMode === "plan" ? "plan" : "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      bridge.db.upsertRoomBotThread({
        roomId: room.id,
        botId: bot.id,
        projectId,
        threadId,
      });
      return { projectId, threadId };
    }).pipe(Effect.mapError((cause) => new VibeLinkError({ message: String(cause) })));
  }

  private runMockBotTurn(input: {
    readonly room: VlRoom;
    readonly bot: VlAccount;
    readonly userText: string;
    readonly roomBots: ReadonlyArray<VlAccount>;
    readonly handoffChainId: string;
    readonly handoffDepth: number;
    readonly replyToId: string | null;
  }): Effect.Effect<void> {
    const bridge = this;
    return Effect.gen(function* () {
      bridge.db.updateAccountFields(input.bot.id, {
        presence: "working",
        statusText: "正在思考...",
      });

      const fiber = yield* Effect.sleep("60 millis").pipe(
        Effect.andThen(
          Effect.gen(function* () {
            bridge.db.createMessage({
              roomId: input.room.id,
              senderId: input.bot.id,
              msgType: "bot_tool_call",
              content: `inspect(${input.bot.slug}): 读取 SOUL.md 与 MEMORY.md`,
              handoffChainId: input.handoffChainId,
              handoffDepth: input.handoffDepth,
              metadata: {
                toolName: "bot_home_context",
                status: "completed",
                durationMs: 36,
                botSlug: input.bot.slug,
              },
            });

            const soulFirstLine =
              (bridge.botHome.readBotFile(input.bot.slug, "SOUL.md") ?? "")
                .split(/\r?\n/)
                .find((line) => line.trim() && !line.trim().startsWith("#"))
                ?.trim() ?? "";

            let handoffLine = "";
            if (input.room.kind === "group") {
              const lower = input.userText.toLowerCase();
              if (lower.includes("[chain-loop]")) {
                const idx = input.roomBots.findIndex((b) => b.id === input.bot.id);
                const nextBot = input.roomBots[(idx + 1) % input.roomBots.length];
                if (nextBot && nextBot.id !== input.bot.id) {
                  handoffLine = `\n\n请 @${nextBot.handle} [chain-loop] 继续第 ${input.handoffDepth + 1} 棒检查。`;
                }
              } else if (input.handoffDepth === 0) {
                const nextTeammate = input.roomBots.find(
                  (b) =>
                    b.id !== input.bot.id &&
                    (lower.includes(`转交 ${b.handle.toLowerCase()}`) ||
                      lower.includes(`交给 ${b.handle.toLowerCase()}`) ||
                      lower.includes(`handoff:${b.handle.toLowerCase()}`)),
                );
                if (nextTeammate) {
                  handoffLine = `\n\n我已完成本阶段拆解，请 @${nextTeammate.handle} 接力核查与跟进。`;
                }
              }
            }

            const cleanSummary = input.userText
              .replace(/\[chain-loop\]/gi, "")
              .replace(/@([a-zA-Z0-9_\-\u4e00-\u9fa5]+)/gu, "$1")
              .trim();
            const replyText = [
              `**${input.bot.displayName}**（${input.bot.roleTitle || input.bot.provider}）已处理请求：`,
              soulFirstLine ? `> 角色设定：${soulFirstLine}` : "",
              `- 输入摘要：${cleanSummary.slice(0, 180)}`,
              `- 执行模式：Mock 协同响应 · \`${input.bot.provider || "mock"}\`${handoffLine}`,
            ]
              .filter(Boolean)
              .join("\n");

            const replyMsg = bridge.db.createMessage({
              roomId: input.room.id,
              senderId: input.bot.id,
              msgType: "bot_markdown",
              content: replyText,
              replyToId: input.replyToId,
              handoffChainId: input.handoffChainId,
              handoffDepth: input.handoffDepth,
              metadata: {
                provider: input.bot.provider,
                mock: true,
              },
            });

            bridge.db.updateAccountFields(input.bot.id, {
              presence: "idle",
              statusText: input.bot.roleTitle || "就绪",
            });

            if (input.room.kind === "group") {
              const nextBots = extractGroupBotMentions({
                markdown: replyText,
                candidates: input.roomBots,
                excludeAccountId: input.bot.id,
              });
              for (const nextBot of nextBots) {
                yield* bridge
                  .dispatchToBot({
                    room: input.room,
                    bot: nextBot,
                    userText: `[来自 @${input.bot.handle} 的接力]\n${replyText}`,
                    roomBots: input.roomBots,
                    mode: "auto",
                    handoffChainId: input.handoffChainId,
                    handoffDepth: input.handoffDepth + 1,
                    replyToId: replyMsg.id,
                  })
                  .pipe(Effect.forkDetach);
              }
            }
          }),
        ),
        Effect.forkDetach,
      );

      let set = bridge.activeMockFibers.get(input.room.id);
      if (!set) {
        set = new Set();
        bridge.activeMockFibers.set(input.room.id, set);
      }
      set.add(fiber);
    });
  }

  private handleDomainEvent(event: OrchestrationV2DomainEvent): void {
    const binding = this.db.findRoomBotThreadByThreadId(event.threadId);
    if (!binding) return;
    const room = this.db.getRoom(binding.roomId);
    const bot = this.db.getAccount(binding.botId);
    if (!room || !bot) return;

    const chainCtx = this.threadRunContext.get(event.threadId) ?? {
      chainId: `chain_${event.threadId}`,
      depth: 0,
    };

    if (event.type === "run.created" || event.type === "run.updated") {
      const status = event.payload.status;
      if (status === "preparing" || status === "starting" || status === "running") {
        this.db.updateAccountFields(bot.id, { presence: "working", statusText: "正在执行..." });
      } else if (status === "waiting") {
        this.db.updateAccountFields(bot.id, { presence: "working", statusText: "等待确认..." });
      } else {
        this.db.updateAccountFields(bot.id, {
          presence: status === "failed" ? "error" : "idle",
          statusText: status === "failed" ? "执行失败" : bot.roleTitle || "就绪",
        });
      }
      return;
    }

    if (event.type === "turn-item.updated") {
      this.projectTurnItem(room, bot, event.payload, chainCtx);
    }
  }

  private projectTurnItem(
    room: VlRoom,
    bot: VlAccount,
    item: OrchestrationV2TurnItem,
    chainCtx: { readonly chainId: string; readonly depth: number },
  ): void {
    const itemKey = `${room.id}:${item.id}`;
    const existingMsgId = this.turnItemMsgIds.get(itemKey);

    if (item.type === "assistant_message") {
      if (existingMsgId) {
        this.db.updateMessageContent(existingMsgId, {
          content: item.text,
          metadata: {
            streaming: item.streaming,
            threadId: item.threadId,
            runId: item.runId,
            itemId: item.id,
          },
        });
      } else {
        const msg = this.db.createMessage({
          roomId: room.id,
          senderId: bot.id,
          msgType: "bot_markdown",
          content: item.text,
          handoffChainId: chainCtx.chainId,
          handoffDepth: chainCtx.depth,
          metadata: {
            streaming: item.streaming,
            threadId: item.threadId,
            runId: item.runId,
            itemId: item.id,
          },
        });
        this.turnItemMsgIds.set(itemKey, msg.id);
      }

      if (!item.streaming && room.kind === "group") {
        const dedupeKey = `${item.runId}:${item.id}`;
        if (!this.processedRunHandoffs.has(dedupeKey)) {
          this.processedRunHandoffs.add(dedupeKey);
          const roomBots = this.db.getRoomBotAccounts(room.id);
          const nextBots = extractGroupBotMentions({
            markdown: item.text,
            candidates: roomBots,
            excludeAccountId: bot.id,
          });
          for (const nextBot of nextBots) {
            Effect.runFork(
              this.dispatchToBot({
                room,
                bot: nextBot,
                userText: `[来自 @${bot.handle} 的接力]\n${item.text}`,
                roomBots,
                mode: "auto",
                handoffChainId: chainCtx.chainId,
                handoffDepth: chainCtx.depth + 1,
                replyToId: this.turnItemMsgIds.get(itemKey) ?? null,
              }),
            );
          }
        }
      }
      return;
    }

    if (item.type === "command_execution" || item.type === "file_search" || item.type === "web_search") {
      const label =
        item.type === "command_execution"
          ? `$ ${item.input}`
          : item.type === "file_search"
            ? `search: ${item.pattern ?? ""}`
            : `web_search: ${(item.patterns ?? []).join(", ")}`;
      const metadata = {
        toolType: item.type,
        status: item.status,
        output: item.type === "command_execution" ? item.output ?? "" : undefined,
        exitCode: item.type === "command_execution" ? item.exitCode : undefined,
      };
      if (existingMsgId) {
        this.db.updateMessageContent(existingMsgId, { content: label, metadata });
      } else {
        const msg = this.db.createMessage({
          roomId: room.id,
          senderId: bot.id,
          msgType: "bot_tool_call",
          content: label,
          handoffChainId: chainCtx.chainId,
          handoffDepth: chainCtx.depth,
          metadata,
        });
        this.turnItemMsgIds.set(itemKey, msg.id);
      }
      return;
    }

    if (item.type === "file_change" || item.type === "checkpoint") {
      const content =
        item.type === "file_change"
          ? `修改文件 ${item.fileName} (+${item.additions ?? 0}/-${item.deletions ?? 0})`
          : `检查点 ${item.checkpointId}（变更 ${item.files.length} 个文件）`;
      const metadata =
        item.type === "file_change"
          ? {
              kind: "file_change",
              fileName: item.fileName,
              additions: item.additions ?? 0,
              deletions: item.deletions ?? 0,
              diffStr: item.diffStr ?? "",
              threadId: item.threadId,
            }
          : {
              kind: "checkpoint",
              checkpointId: item.checkpointId,
              scopeId: item.scopeId,
              threadId: item.threadId,
              files: item.files,
            };
      if (existingMsgId) {
        this.db.updateMessageContent(existingMsgId, { content, metadata });
      } else {
        const msg = this.db.createMessage({
          roomId: room.id,
          senderId: bot.id,
          msgType: "bot_diff_checkpoint",
          content,
          handoffChainId: chainCtx.chainId,
          handoffDepth: chainCtx.depth,
          metadata,
        });
        this.turnItemMsgIds.set(itemKey, msg.id);
      }
      return;
    }

    if (item.type === "approval_request" && !existingMsgId) {
      const detail = item.prompt ?? item.reason ?? `${item.requestKind} 需要人工确认`;
      const msg = this.db.createMessage({
        roomId: room.id,
        senderId: bot.id,
        msgType: "bot_approval",
        content: detail,
        handoffChainId: chainCtx.chainId,
        handoffDepth: chainCtx.depth,
        metadata: {
          requestId: item.requestId,
          requestKind: item.requestKind,
          status: "pending",
        },
      });
      this.turnItemMsgIds.set(itemKey, msg.id);
      const approval = this.db.createApproval({
        roomId: room.id,
        messageId: msg.id,
        botId: bot.id,
        threadId: item.threadId,
        requestId: item.requestId,
        title: `审批请求 · ${item.requestKind}`,
        detail,
      });
      this.db.updateMessageContent(msg.id, { metadata: { approvalId: approval.id } });
    }
  }
}
