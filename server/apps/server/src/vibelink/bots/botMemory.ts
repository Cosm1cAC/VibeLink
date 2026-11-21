// @effect-diagnostics globalDate:off
import { BotHomeManager } from "./botHome.ts";

export const MAX_MEMORY_FACTS = 40;

export interface MemoryTidyResult {
  readonly slug: string;
  readonly activeCount: number;
  readonly archivedCount: number;
  readonly archiveFile: string | null;
}

export function extractMemoryFacts(markdown: string): ReadonlyArray<string> {
  const facts: string[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^[-*]\s+.+$/.test(trimmed)) {
      facts.push(trimmed);
    }
  }
  return facts;
}

export function tidyBotMemory(
  botHome: BotHomeManager,
  slug: string,
  maxFacts = MAX_MEMORY_FACTS,
  now = new Date(),
): MemoryTidyResult {
  const existing = botHome.readBotFile(slug, "MEMORY.md") ?? "";
  const allFacts = extractMemoryFacts(existing);

  // Deduplicate keeping the latest occurrence of identical bullet lines.
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (let i = allFacts.length - 1; i >= 0; i -= 1) {
    const fact = allFacts[i]!;
    if (!seen.has(fact)) {
      seen.add(fact);
      deduped.unshift(fact);
    }
  }

  if (deduped.length <= maxFacts) {
    const header = "# Long-Term Memory (MEMORY.md)\n\n";
    const body = deduped.join("\n");
    botHome.writeBotFile(slug, "MEMORY.md", `${header}${body}${body ? "\n" : ""}`);
    return {
      slug,
      activeCount: deduped.length,
      archivedCount: 0,
      archiveFile: null,
    };
  }

  const overflowCount = deduped.length - maxFacts;
  const archived = deduped.slice(0, overflowCount);
  const kept = deduped.slice(overflowCount);

  const dateStamp = now.toISOString().slice(0, 10);
  const archiveRelPath = `memory/${dateStamp}.md`;
  const existingArchive = botHome.readBotFile(slug, archiveRelPath) ?? `# Archived Memory (${dateStamp})\n`;
  const normalizedArchive = existingArchive.endsWith("\n") ? existingArchive : `${existingArchive}\n`;
  botHome.writeBotFile(slug, archiveRelPath, `${normalizedArchive}${archived.join("\n")}\n`);

  const header = "# Long-Term Memory (MEMORY.md)\n\n";
  botHome.writeBotFile(slug, "MEMORY.md", `${header}${kept.join("\n")}\n`);

  return {
    slug,
    activeCount: kept.length,
    archivedCount: archived.length,
    archiveFile: archiveRelPath,
  };
}

export function appendBotMemoryFact(
  botHome: BotHomeManager,
  slug: string,
  fact: string,
  maxFacts = MAX_MEMORY_FACTS,
  now = new Date(),
): MemoryTidyResult {
  const cleanFact = fact.trim().replace(/^[-*]\s*/, "");
  if (!cleanFact) {
    return tidyBotMemory(botHome, slug, maxFacts, now);
  }
  const current = botHome.readBotFile(slug, "MEMORY.md") ?? "# Long-Term Memory (MEMORY.md)\n\n";
  const prefix = current.endsWith("\n") ? current : `${current}\n`;
  botHome.writeBotFile(slug, "MEMORY.md", `${prefix}- ${cleanFact}\n`);
  return tidyBotMemory(botHome, slug, maxFacts, now);
}
