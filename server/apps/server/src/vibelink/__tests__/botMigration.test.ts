// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { BotHomeManager } from "../bots/botHome.ts";
import { appendBotMemoryFact, MAX_MEMORY_FACTS, tidyBotMemory } from "../bots/botMemory.ts";
import { runSeedMigration } from "../bots/botMigration.ts";
import { VibeLinkDatabase } from "../db.ts";

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vibelink-mig-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("VibeLink seed migration & Bot Home", () => {
  it("migrates 6 bots, human account me, 6 DM rooms, and 2 group rooms idempotently", () => {
    const home = makeTempHome();
    const db = new VibeLinkDatabase(home);
    const botHome = new BotHomeManager(home);

    try {
      const first = runSeedMigration(db, botHome);
      expect(first.seedLoaded).toBe(true);
      expect(first.botsMigrated).toBe(6);
      expect(first.roomsCreated).toBe(8);

      const accounts = db.listAccounts();
      expect(accounts.find((a) => a.id === "me")?.displayName).toBe("我");
      const bots = db.listAccounts("bot");
      expect(bots).toHaveLength(6);
      expect(bots.map((b) => b.id)).toEqual(
        expect.arrayContaining(["bot_cto", "bot_pm", "bot_dev", "bot_qa", "bot_sre", "bot_ui"]),
      );

      // Bot Home files created under ~/.vibelink/bots/<slug>/
      const ctoFiles = botHome.listBotFiles("cto").map((f) => f.path);
      expect(ctoFiles).toEqual(
        expect.arrayContaining([
          "bot.json",
          "SOUL.md",
          "MEMORY.md",
          "tools.json",
          "skills/cross-bot-decomposition.md",
        ]),
      );

      const rooms = db.listRoomSummaries("me");
      expect(rooms).toHaveLength(8);
      const grpAllHands = rooms.find((r) => r.id === "grp_all_hands");
      expect(grpAllHands?.kind).toBe("group");
      expect(grpAllHands?.memberCount).toBe(5);
      expect(db.listMessages("grp_all_hands")).toHaveLength(1);

      // Re-running migration must not duplicate accounts, rooms, or messages.
      const second = runSeedMigration(db, botHome);
      expect(second.botsMigrated).toBe(0);
      expect(second.roomsCreated).toBe(0);
      expect(second.messagesSeeded).toBe(0);
      expect(db.listAccounts("bot")).toHaveLength(6);
      expect(db.listRoomSummaries("me")).toHaveLength(8);
      expect(db.listMessages("grp_all_hands")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("blocks path traversal on Bot Home files and enforces 40-fact memory budget", () => {
    const home = makeTempHome();
    const db = new VibeLinkDatabase(home);
    const botHome = new BotHomeManager(home);

    try {
      runSeedMigration(db, botHome);
      expect(() => botHome.readBotFile("cto", "../../auth-token.txt")).toThrow();
      expect(() => botHome.writeBotFile("cto", "../dev/SOUL.md", "bad")).toThrow();

      const fixedDate = new Date("2026-11-22T00:00:00.000Z");
      for (let i = 1; i <= 45; i += 1) {
        appendBotMemoryFact(botHome, "cto", `fact number ${i}`, MAX_MEMORY_FACTS, fixedDate);
      }
      const res = appendBotMemoryFact(botHome, "cto", "fact number 46", MAX_MEMORY_FACTS, fixedDate);
      expect(res.activeCount).toBe(MAX_MEMORY_FACTS);
      expect(tidyBotMemory(botHome, "cto", MAX_MEMORY_FACTS, fixedDate).activeCount).toBe(
        MAX_MEMORY_FACTS,
      );

      const archiveContent = botHome.readBotFile("cto", "memory/2026-11-22.md");
      expect(archiveContent).toBeTruthy();
      expect(archiveContent).toContain("fact number");
    } finally {
      db.close();
    }
  });
});
