// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { VlAccount, VlBotConfigJson, VlBotFileEntry } from "../types.ts";

export const DEFAULT_SOUL_TEMPLATE = `# Role & Persona (SOUL.md)

你是 VibeLink 协作团队中的专家 Bot。
请先核实上下文，保持简洁高信噪比，不在没有实证时编造结果。
`;

export const DEFAULT_MEMORY_TEMPLATE = `# Long-Term Memory (MEMORY.md)

<!-- Keep active curated bullet facts below (<= 40 facts). Overflow archives to memory/YYYY-MM-DD.md -->
`;

export function sanitizeBotSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "bot";
}

export class BotHomeManager {
  readonly botsRoot: string;

  constructor(vibelinkHome: string) {
    this.botsRoot = NodePath.join(vibelinkHome, "bots");
    NodeFS.mkdirSync(this.botsRoot, { recursive: true });
  }

  getBotDir(slug: string): string {
    const safeSlug = sanitizeBotSlug(slug);
    const dir = NodePath.resolve(this.botsRoot, safeSlug);
    if (!dir.startsWith(NodePath.resolve(this.botsRoot) + NodePath.sep)) {
      throw new Error(`Invalid bot slug path: ${slug}`);
    }
    return dir;
  }

  resolveBotFilePath(slug: string, relPath: string): string {
    const botDir = this.getBotDir(slug);
    const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleaned || cleaned.includes("..") || NodePath.isAbsolute(cleaned)) {
      throw new Error(`Unsafe bot file path rejected: ${relPath}`);
    }
    const resolved = NodePath.resolve(botDir, cleaned);
    const botRootPrefix = botDir + NodePath.sep;
    if (resolved !== botDir && !resolved.startsWith(botRootPrefix)) {
      throw new Error(`Path traversal rejected: ${relPath}`);
    }
    return resolved;
  }

  ensureBotScaffold(
    config: VlBotConfigJson,
    options?: {
      readonly soulMarkdown?: string;
      readonly memoryMarkdown?: string;
      readonly skills?: ReadonlyArray<{ readonly name: string; readonly content: string }>;
      readonly tools?: Record<string, unknown>;
      readonly overwriteExisting?: boolean;
    },
  ): string {
    const dir = this.getBotDir(config.slug);
    const memoryDir = NodePath.join(dir, "memory");
    const skillsDir = NodePath.join(dir, "skills");
    NodeFS.mkdirSync(memoryDir, { recursive: true });
    NodeFS.mkdirSync(skillsDir, { recursive: true });

    const writeIfNeeded = (filePath: string, content: string) => {
      if (options?.overwriteExisting || !NodeFS.existsSync(filePath)) {
        NodeFS.writeFileSync(filePath, content, "utf8");
      }
    };

    writeIfNeeded(NodePath.join(dir, "bot.json"), `${JSON.stringify(config, null, 2)}\n`);
    writeIfNeeded(
      NodePath.join(dir, "SOUL.md"),
      options?.soulMarkdown?.trim() ? `${options.soulMarkdown.trim()}\n` : DEFAULT_SOUL_TEMPLATE,
    );
    writeIfNeeded(
      NodePath.join(dir, "MEMORY.md"),
      options?.memoryMarkdown?.trim()
        ? `${options.memoryMarkdown.trim()}\n`
        : DEFAULT_MEMORY_TEMPLATE,
    );
    writeIfNeeded(
      NodePath.join(dir, "tools.json"),
      `${JSON.stringify(
        options?.tools ?? {
          disabledTools: config.disabledTools,
          approvalMode: config.approvalMode,
          isolationMode: config.isolationMode,
        },
        null,
        2,
      )}\n`,
    );

    if (options?.skills) {
      for (const skill of options.skills) {
        const safeName = `${sanitizeBotSlug(skill.name)}.md`;
        writeIfNeeded(NodePath.join(skillsDir, safeName), `${skill.content.trim()}\n`);
      }
    }

    return dir;
  }

  listBotFiles(slug: string): ReadonlyArray<VlBotFileEntry> {
    const botDir = this.getBotDir(slug);
    if (!NodeFS.existsSync(botDir)) return [];
    const results: VlBotFileEntry[] = [];

    const walk = (currentDir: string, prefix: string) => {
      const entries = NodeFS.readdirSync(currentDir, { withFileTypes: true }).toSorted((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = NodePath.join(currentDir, entry.name);
        const stat = NodeFS.statSync(full);
        if (entry.isDirectory()) {
          results.push({
            path: rel,
            name: entry.name,
            kind: "dir",
            sizeBytes: 0,
            updatedAt: stat.mtimeMs,
          });
          walk(full, rel);
        } else {
          results.push({
            path: rel,
            name: entry.name,
            kind: "file",
            sizeBytes: stat.size,
            updatedAt: stat.mtimeMs,
          });
        }
      }
    };

    walk(botDir, "");
    return results;
  }

  readBotFile(slug: string, relPath: string): string | null {
    const full = this.resolveBotFilePath(slug, relPath);
    if (!NodeFS.existsSync(full)) return null;
    const stat = NodeFS.statSync(full);
    if (!stat.isFile()) return null;
    return NodeFS.readFileSync(full, "utf8");
  }

  writeBotFile(slug: string, relPath: string, content: string): { path: string; sizeBytes: number } {
    const full = this.resolveBotFilePath(slug, relPath);
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    NodeFS.writeFileSync(full, content, "utf8");
    return { path: relPath.replace(/\\/g, "/"), sizeBytes: Buffer.byteLength(content, "utf8") };
  }

  readBotConfig(slug: string): VlBotConfigJson | null {
    const raw = this.readBotFile(slug, "bot.json");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as VlBotConfigJson;
    } catch {
      return null;
    }
  }

  syncAccountToBotJson(account: VlAccount): void {
    const dir = this.getBotDir(account.slug);
    if (!NodeFS.existsSync(dir)) return;
    const existing = this.readBotConfig(account.slug);
    const merged: VlBotConfigJson = {
      id: account.id,
      slug: account.slug,
      handle: account.handle,
      displayName: account.displayName,
      avatar: account.avatar,
      roleTitle: account.roleTitle,
      department: account.department,
      provider: account.provider,
      model: account.model,
      thinkingEffort: existing?.thinkingEffort ?? "medium",
      cwd: account.cwd,
      isolationMode: account.isolationMode,
      approvalMode: account.approvalMode,
      manageOtherBots: existing?.manageOtherBots ?? false,
      dailyCheckIns: existing?.dailyCheckIns ?? false,
      disabledTools: existing?.disabledTools ?? [],
      exampleRequests: existing?.exampleRequests ?? [],
      description: account.description,
      section: existing?.section ?? account.department,
      pinned: account.pinned,
    };
    this.writeBotFile(account.slug, "bot.json", `${JSON.stringify(merged, null, 2)}\n`);
  }

  composeBotSystemPrompt(
    account: VlAccount,
    roomContext: {
      readonly roomId: string;
      readonly roomKind: "dm" | "group";
      readonly roomName: string;
      readonly teammates: ReadonlyArray<VlAccount>;
    },
  ): string {
    const soul = this.readBotFile(account.slug, "SOUL.md")?.trim() || DEFAULT_SOUL_TEMPLATE;
    const memory = this.readBotFile(account.slug, "MEMORY.md")?.trim() || "";
    const files = this.listBotFiles(account.slug).filter(
      (f) => f.kind === "file" && f.path.startsWith("skills/") && f.path.endsWith(".md"),
    );
    const skillSummaries = files
      .map((f) => {
        const text = this.readBotFile(account.slug, f.path) ?? "";
        const heading = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? f.name;
        return `- ${f.name}: ${heading.replace(/^#+\s*/, "").slice(0, 120)}`;
      })
      .join("\n");

    const lines: string[] = [
      `[Bot Identity] id=${account.id} handle=@${account.handle} name=${account.displayName} (${account.roleTitle})`,
      soul,
    ];
    if (memory) {
      lines.push(`\n[Curated Memory]\n${memory}`);
    }
    if (skillSummaries) {
      lines.push(`\n[Loaded Skills]\n${skillSummaries}`);
    }
    if (roomContext.roomKind === "group") {
      const directory = roomContext.teammates
        .filter((t) => t.id !== account.id)
        .map((t) => `@${t.handle} (${t.displayName} · ${t.roleTitle || t.provider})`)
        .join(", ");
      lines.push(
        `\n[Group Room Context]\nYou are collaborating in group "${roomContext.roomName}" (${roomContext.roomId}).`,
        directory ? `Teammates in room: ${directory}. Mention @Handle in prose when handing off work.` : "",
      );
    }
    return lines.filter(Boolean).join("\n");
  }
}
