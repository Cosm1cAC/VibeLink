import type { VibeLinkDatabase } from "../db.ts";
import type { BotHomeManager } from "./botHome.ts";
import { tidyBotMemory } from "./botMemory.ts";

export interface LookAroundResult {
  readonly status: "NO_RESPONSE" | "ACTION_TAKEN";
  readonly checkedBots: number;
  readonly tidiedSlugs: ReadonlyArray<string>;
}

/**
 * Orca-style zero-noise periodic look-around: performs silent maintenance (such
 * as archiving overflow MEMORY.md facts) without posting noise to chat rooms
 * unless genuine pending work exists.
 */
export function runBotLookAroundPass(
  db: VibeLinkDatabase,
  botHome: BotHomeManager,
): LookAroundResult {
  if (process.env.VIBELINK_DISABLE_LOOK_AROUND === "1") {
    return { status: "NO_RESPONSE", checkedBots: 0, tidiedSlugs: [] };
  }
  const bots = db.listAccounts("bot");
  const tidiedSlugs: string[] = [];
  for (const bot of bots) {
    const res = tidyBotMemory(botHome, bot.slug);
    if (res.archivedCount > 0) {
      tidiedSlugs.push(bot.slug);
    }
  }
  return {
    status: tidiedSlugs.length > 0 ? "ACTION_TAKEN" : "NO_RESPONSE",
    checkedBots: bots.length,
    tidiedSlugs,
  };
}
