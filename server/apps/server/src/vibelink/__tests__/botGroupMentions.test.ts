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
    createdAt: 0,
    updatedAt: 0,
  };
}

const candidates = [
  makeBot("bot_cto", "cto", "Gemini"),
  makeBot("bot_pm", "pm", "Claude"),
  makeBot("bot_dev", "dev", "GPT"),
  makeBot("bot_qa", "qa", "GLM"),
];

describe("Markdown AST @Bot group mentions", () => {
  it("extracts prose mentions deduplicated in order while ignoring code, inlineCode, blockquotes, and links", () => {
    const markdown = [
      "Please check this requirement with @Claude and then hand off to @GPT.",
      "Do not trigger duplicate @Claude again.",
      "",
      "> Quoted reference: @GLM should stay quoted only.",
      "",
      "Inline code example `@GLM` and URL [@GLM](https://example.com/@GLM) should be ignored.",
      "Email contact dev@GLM.local should also be ignored.",
      "",
      "```ts",
      "// @GLM and @GPT inside fenced code must be ignored",
      "const mention = '@GLM';",
      "```",
    ].join("\n");

    const found = extractGroupBotMentions({
      markdown,
      candidates,
      excludeAccountId: "bot_cto",
    });

    expect(found.map((b) => b.id)).toEqual(["bot_pm", "bot_dev"]);
  });

  it("ignores self-mentions and enforces MAX_GROUP_HANDOFFS = 4", () => {
    const found = extractGroupBotMentions({
      markdown: "@Gemini will verify and ask @Claude.",
      candidates,
      excludeAccountId: "bot_cto",
    });

    expect(found.map((b) => b.id)).toEqual(["bot_pm"]);
    expect(MAX_GROUP_HANDOFFS).toBe(4);
    expect(canContinueGroupHandoff(0)).toBe(true);
    expect(canContinueGroupHandoff(3)).toBe(true);
    expect(canContinueGroupHandoff(4)).toBe(false);
  });
});
