import { describe, expect, it } from "@effect/vitest";

import { canContinueGroupHandoff, extractGroupBotMentions, MAX_GROUP_HANDOFFS } from "../bots/botGroupMentions.ts";
import type { VlAccount } from "../types.ts";

function makeBot(id: string, slug: string, handle: string, displayName = handle): VlAccount {
  return {
    id,
    kind: "bot",
    slug,
    handle,
    displayName,
    avatar: "",
    roleTitle: "",
    department: "",
    presence: "idle",
    statusText: "",
    provider: "codex",
    model: "",
    cwd: "",
    isolationMode: "shared",
    approvalMode: "ask",
    description: "",
    pinned: false,
    source: "seed",
    pluginId: null,
    externalId: null,
    visible: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

const candidates = [
  makeBot("bot_codex", "codex", "Codex"),
  makeBot("bot_claude", "claude", "Claude"),
  makeBot("bot_antigravity", "antigravity", "Antigravity"),
  makeBot("bot_opencode", "opencode", "OpenCode"),
];

describe("Markdown AST @Bot group mentions", () => {
  it("extracts prose mentions deduplicated in order while ignoring code, inlineCode, blockquotes, and links", () => {
    const markdown = [
      "Please check this requirement with @Claude and then hand off to @Antigravity.",
      "Do not trigger duplicate @Claude again.",
      "",
      "> Quoted reference: @OpenCode should stay quoted only.",
      "",
      "Inline code example `@OpenCode` and URL [@OpenCode](https://example.com/@OpenCode) should be ignored.",
      "Email contact dev@OpenCode.local should also be ignored.",
      "",
      "```ts",
      "// @OpenCode and @Antigravity inside fenced code must be ignored",
      "const mention = '@OpenCode';",
      "```",
    ].join("\n");

    const found = extractGroupBotMentions({
      markdown,
      candidates,
      excludeAccountId: "bot_codex",
    });

    expect(found.map((b) => b.id)).toEqual(["bot_claude", "bot_antigravity"]);
  });

  it("ignores self-mentions and enforces MAX_GROUP_HANDOFFS = 4", () => {
    const found = extractGroupBotMentions({
      markdown: "@Codex will implement and ask @Claude.",
      candidates,
      excludeAccountId: "bot_codex",
    });

    expect(found.map((b) => b.id)).toEqual(["bot_claude"]);
    expect(MAX_GROUP_HANDOFFS).toBe(4);
    expect(canContinueGroupHandoff(0)).toBe(true);
    expect(canContinueGroupHandoff(3)).toBe(true);
    expect(canContinueGroupHandoff(4)).toBe(false);
  });
});
