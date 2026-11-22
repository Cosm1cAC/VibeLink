// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { VibeLinkDatabase } from "../db.ts";
import type { VlBotConfigJson } from "../types.ts";
import { BotHomeManager, sanitizeBotSlug } from "./botHome.ts";

export const DEFAULT_SEED_PATH = "D:\\AI\\VibeLink\\seeds\\bots_fleet.seed.json";

interface SeedSkill {
  readonly name?: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly playbook?: string;
  readonly enabled?: boolean;
}

interface SeedMemory {
  readonly content?: string;
  readonly archived?: boolean;
}

interface SeedBot {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  readonly jobTitle?: string;
  readonly department?: string;
  readonly engine?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly cwd?: string;
  readonly isolationMode?: string;
  readonly approvalMode?: string;
  readonly publicDescription?: string;
  readonly rolePrompt?: string;
  readonly manageOtherBots?: boolean;
  readonly dailyCheckIns?: boolean;
  readonly disabledTools?: ReadonlyArray<string>;
  readonly exampleRequests?: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<SeedSkill>;
  readonly memories?: ReadonlyArray<SeedMemory>;
  readonly section?: string;
  readonly pinned?: boolean;
  readonly lastText?: string;
  readonly lastAt?: number;
}

interface SeedGroup {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly botIds?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly pinned?: boolean;
  readonly lastAt?: number;
}

interface SeedGroupMessage {
  readonly id: string;
  readonly senderId: string;
  readonly text: string;
  readonly at?: number;
}

interface SeedFile {
  readonly bots?: ReadonlyArray<SeedBot>;
  readonly groups?: ReadonlyArray<SeedGroup>;
  readonly groupMessages?: Record<string, ReadonlyArray<SeedGroupMessage>>;
}

export interface MigrationSummary {
  readonly seedLoaded: boolean;
  readonly botsMigrated: number;
  readonly roomsCreated: number;
  readonly messagesSeeded: number;
}

export function resolveSeedPath(override?: string): string {
  return override ?? process.env.VIBELINK_SEED_PATH ?? DEFAULT_SEED_PATH;
}

export function runSeedMigration(
  db: VibeLinkDatabase,
  botHome: BotHomeManager,
  seedPathOverride?: string,
): MigrationSummary {
  if (!db.getAccount("me")) {
    db.upsertAccount({
      id: "me",
      kind: "human",
      slug: "me",
      handle: "me",
      displayName: "我",
      avatar: "preset:me",
      roleTitle: "群主",
      department: "VibeLink",
      presence: "online",
      statusText: "搬砖中",
      provider: "",
      model: "",
      cwd: "D:\\AI\\VibeLink",
      isolationMode: "shared",
      approvalMode: "ask",
      description: "VibeLink 工作区主人",
      pinned: true,
    });
  }

  const seedPath = NodePath.resolve(resolveSeedPath(seedPathOverride));
  if (!NodeFS.existsSync(seedPath)) {
    return { seedLoaded: false, botsMigrated: 0, roomsCreated: 0, messagesSeeded: 0 };
  }

  const raw = NodeFS.readFileSync(seedPath, "utf8");
  const parsed = JSON.parse(raw) as SeedFile;
  const seedBots = parsed.bots ?? [];
  const seedGroups = parsed.groups ?? [];
  const seedGroupMessages = parsed.groupMessages ?? {};

  let botsMigrated = 0;
  let roomsCreated = 0;
  let messagesSeeded = 0;

  const usedHandles = new Set<string>(["me"]);
  for (const existing of db.listAccounts("bot")) {
    usedHandles.add(existing.handle.toLowerCase());
  }

  for (const bot of seedBots) {
    const slug = sanitizeBotSlug(bot.id.replace(/^bot_/, "") || bot.name);
    const existingBot = db.getAccount(bot.id);

    let handle = bot.name.trim() || slug;
    if (!existingBot) {
      if (usedHandles.has(handle.toLowerCase())) {
        handle = slug.toUpperCase();
      }
      usedHandles.add(handle.toLowerCase());
    } else {
      handle = existingBot.handle;
    }

    const displayName =
      bot.name.trim() && bot.name.trim().toLowerCase() !== handle.toLowerCase()
        ? `${handle} (${bot.name.trim()})`
        : bot.name.trim() || handle;

    const botConfig: VlBotConfigJson = {
      id: bot.id,
      slug,
      handle,
      displayName,
      avatar: bot.avatar ?? `preset:${slug}`,
      roleTitle: bot.jobTitle ?? "",
      department: bot.department ?? "",
      provider: bot.engine ?? "codex",
      model: bot.model ?? "",
      thinkingEffort: bot.thinkingEffort ?? "medium",
      cwd: bot.cwd ?? "D:\\AI\\VibeLink",
      isolationMode: bot.isolationMode ?? "shared",
      approvalMode: bot.approvalMode ?? "ask",
      manageOtherBots: Boolean(bot.manageOtherBots),
      dailyCheckIns: Boolean(bot.dailyCheckIns),
      disabledTools: bot.disabledTools ?? [],
      exampleRequests: bot.exampleRequests ?? [],
      description: bot.publicDescription ?? "",
      section: bot.section ?? bot.department ?? "",
      pinned: Boolean(bot.pinned),
    };

    const memoryLines = (bot.memories ?? [])
      .filter((m) => !m.archived && typeof m.content === "string" && m.content.trim().length > 0)
      .map((m) => `- ${m.content!.trim()}`);
    const memoryMarkdown = [
      "# Long-Term Memory (MEMORY.md)",
      "",
      ...memoryLines,
      "",
    ].join("\n");

    const skillFiles = (bot.skills ?? [])
      .filter((s) => s.enabled !== false && s.name && s.playbook)
      .map((s) => ({
        name: s.name!,
        content: [
          `# ${s.name}`,
          s.description ? `\n> ${s.description}\n` : "",
          s.whenToUse ? `**When to use:** ${s.whenToUse}\n` : "",
          s.playbook ?? "",
        ].join("\n"),
      }));

    botHome.ensureBotScaffold(botConfig, {
      ...(bot.rolePrompt !== undefined ? { soulMarkdown: bot.rolePrompt } : {}),
      memoryMarkdown,
      skills: skillFiles,
      overwriteExisting: false,
    });

    if (!existingBot) {
      db.upsertAccount({
        id: bot.id,
        kind: "bot",
        slug,
        handle,
        displayName,
        avatar: botConfig.avatar,
        roleTitle: botConfig.roleTitle,
        department: botConfig.department,
        presence: "idle",
        statusText: botConfig.roleTitle || `${botConfig.provider} · 就绪`,
        provider: botConfig.provider,
        model: botConfig.model,
        cwd: botConfig.cwd,
        isolationMode: botConfig.isolationMode,
        approvalMode: botConfig.approvalMode,
        description: botConfig.description,
        pinned: botConfig.pinned,
      });
      botsMigrated += 1;
    }

    const dmRoomId = `dm_${bot.id}`;
    if (!db.getRoom(dmRoomId)) {
      db.upsertRoom({
        id: dmRoomId,
        kind: "dm",
        name: displayName,
        notice: botConfig.description,
        avatar: botConfig.avatar,
        muted: false,
        pinned: botConfig.pinned,
        cwd: botConfig.cwd,
        updatedAt: bot.lastAt ?? Date.now(),
      });
      db.addRoomMember(dmRoomId, "me", "owner");
      db.addRoomMember(dmRoomId, bot.id, "member");
      roomsCreated += 1;

      if (bot.lastText) {
        const introId = `msg_seed_dm_${bot.id}`;
        if (!db.getMessage(introId)) {
          db.createMessage({
            id: introId,
            roomId: dmRoomId,
            senderId: bot.id,
            msgType: "bot_markdown",
            content: bot.lastText,
            createdAt: bot.lastAt ?? Date.now(),
            emitEvent: false,
          });
          messagesSeeded += 1;
        }
        db.markRoomRead(dmRoomId, "me", introId);
      }
    }
  }

  for (const group of seedGroups) {
    const groupExisted = db.getRoom(group.id) !== null;
    if (!groupExisted) {
      db.upsertRoom({
        id: group.id,
        kind: "group",
        name: group.name,
        notice: group.description ?? "",
        avatar: "preset:group",
        muted: false,
        pinned: Boolean(group.pinned),
        cwd: group.cwd ?? "D:\\AI\\VibeLink",
        updatedAt: group.lastAt ?? Date.now(),
      });
      roomsCreated += 1;
    }

    db.addRoomMember(group.id, "me", "owner");
    for (const botId of group.botIds ?? []) {
      if (db.getAccount(botId)) {
        db.addRoomMember(group.id, botId, "member");
      }
    }

    const msgs = seedGroupMessages[group.id] ?? [];
    let lastMsgId: string | null = null;
    for (const msg of msgs) {
      if (!db.getMessage(msg.id)) {
        db.createMessage({
          id: msg.id,
          roomId: group.id,
          senderId: db.getAccount(msg.senderId) ? msg.senderId : "me",
          msgType: "bot_markdown",
          content: msg.text,
          createdAt: msg.at ?? Date.now(),
          emitEvent: false,
        });
        messagesSeeded += 1;
      }
      lastMsgId = msg.id;
    }
    if (!groupExisted && lastMsgId) {
      db.markRoomRead(group.id, "me", lastMsgId);
    }
  }

  return {
    seedLoaded: true,
    botsMigrated,
    roomsCreated,
    messagesSeeded,
  };
}
