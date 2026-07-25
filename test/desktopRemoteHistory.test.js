import assert from "node:assert/strict";
import test from "node:test";
import { resolveDesktopHistoryTranscript } from "../src/desktopRemoteHistory.js";

test("desktop remote prefers structured Codex history over fragmented visible text", () => {
  const histories = [
    { provider: "codex", id: "other", title: "Other", projectPath: "C:\\repo", updatedAt: "2026-07-25T00:00:00.000Z" },
    { provider: "codex", id: "current", title: "Current", projectPath: "C:\\repo", updatedAt: new Date().toISOString() },
  ];
  const historyById = {
    other: { transcript: [{ role: "assistant", text: "unrelated" }] },
    current: {
      transcript: [
        { role: "user", text: "然后？" },
        { role: "assistant", text: "hit\nweight\n完整解释" },
      ],
    },
  };

  const resolved = resolveDesktopHistoryTranscript({
    desktop: { visibleTranscript: [{ text: "hit" }, { text: "weight" }] },
    histories,
    getHistory: (_provider, id) => historyById[id],
    workspacePath: "C:\\repo",
  });

  assert.equal(resolved.sessionId, "current");
  assert.deepEqual(resolved.transcript.map((entry) => entry.text), ["然后？", "hit weight 完整解释"]);
});

test("desktop remote does not bind ambiguous visible text to arbitrary history", () => {
  const histories = [
    { provider: "codex", id: "a", title: "A", projectPath: "C:\\repo", updatedAt: "2026-07-25T00:00:00.000Z" },
    { provider: "codex", id: "b", title: "B", projectPath: "C:\\repo", updatedAt: "2026-07-25T00:01:00.000Z" },
  ];

  const resolved = resolveDesktopHistoryTranscript({
    desktop: { visibleTranscript: [{ text: "ok" }] },
    histories,
    getHistory: () => ({ transcript: [{ role: "assistant", text: "nothing useful" }] }),
    workspacePath: "C:\\repo",
  });

  assert.equal(resolved, null);
});
