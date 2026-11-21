import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { VlAccount } from "../types.ts";

export const MAX_GROUP_HANDOFFS = 4;

const IGNORED_NODE_TYPES = new Set([
  "code",
  "inlineCode",
  "blockquote",
  "link",
  "linkReference",
  "definition",
  "html",
  "yaml",
]);

const MENTION_PATTERN = /(^|[^a-zA-Z0-9._%+-])@([a-zA-Z0-9_\-\u4e00-\u9fa5]+)/gu;

function hasChildren(node: unknown): node is { readonly children: ReadonlyArray<RootContent> } {
  return (
    typeof node === "object" &&
    node !== null &&
    "children" in node &&
    Array.isArray((node as { children?: unknown }).children)
  );
}

function collectProseTextChunks(node: Root | RootContent, chunks: string[]): void {
  if (IGNORED_NODE_TYPES.has(node.type)) {
    return;
  }
  if (node.type === "text") {
    chunks.push(node.value);
    return;
  }
  if (hasChildren(node)) {
    for (const child of node.children) {
      collectProseTextChunks(child, chunks);
    }
  }
}

export function extractMarkdownProseText(markdown: string): string {
  if (!markdown.trim()) return "";
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  const chunks: string[] = [];
  collectProseTextChunks(tree, chunks);
  return chunks.join(" ");
}

export function extractGroupBotMentions(input: {
  readonly markdown: string;
  readonly candidates: ReadonlyArray<VlAccount>;
  readonly excludeAccountId?: string | null;
}): ReadonlyArray<VlAccount> {
  const prose = extractMarkdownProseText(input.markdown);
  if (!prose) return [];

  const lookup = new Map<string, VlAccount>();
  for (const bot of input.candidates) {
    if (bot.kind !== "bot") continue;
    for (const key of [bot.id, bot.slug, bot.handle, bot.displayName]) {
      const normalized = key.trim().toLowerCase();
      if (normalized && !lookup.has(normalized)) {
        lookup.set(normalized, bot);
      }
    }
  }

  const matched: VlAccount[] = [];
  const seenIds = new Set<string>();
  for (const match of prose.matchAll(MENTION_PATTERN)) {
    const token = match[2]?.trim().toLowerCase();
    if (!token) continue;
    const bot = lookup.get(token);
    if (!bot) continue;
    if (input.excludeAccountId && bot.id === input.excludeAccountId) continue;
    if (seenIds.has(bot.id)) continue;
    seenIds.add(bot.id);
    matched.push(bot);
  }

  return matched;
}

export function canContinueGroupHandoff(handoffDepth: number, maxHandoffs = MAX_GROUP_HANDOFFS): boolean {
  return handoffDepth < maxHandoffs;
}
