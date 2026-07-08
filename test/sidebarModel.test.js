import assert from "node:assert/strict";
import test from "node:test";

import { buildConversationTree } from "../apps/web/src/sidebarModel.js";

test("buildConversationTree limits project conversations to five by default", () => {
  const items = Array.from({ length: 6 }, (_, index) => ({
    key: `thread:${index}`,
    kind: "history",
    provider: "codex",
    title: `Conversation ${index + 1}`,
    cwd: "C:/work/project-a",
    updatedAt: `2026-07-08T0${index}:00:00.000Z`,
    sessionId: `session-${index}`
  })).reverse();

  const nodes = buildConversationTree(items, {});

  assert.equal(nodes.filter((item) => item.kind === "history").length, 5);
  assert.equal(nodes.some((item) => item.kind === "project-more" && item.hiddenCount === 1), true);
});
