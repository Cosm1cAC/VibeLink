import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __testInternals, filterArchivedCodexTasks, listHistories } from "../src/history.js";

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

test("listHistories excludes Codex sessions archived by Codex Desktop", () => {
  const originalHome = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-history-"));
  const activeId = "active-codex-session";
  const archivedId = "archived-codex-session";

  process.env.USERPROFILE = home;
  try {
    writeJsonl(path.join(home, ".codex", "sessions", "active.jsonl"), [
      {
        timestamp: "2026-07-08T00:00:00.000Z",
        type: "session_meta",
        payload: { id: activeId, cwd: "C:\\work\\active" }
      },
      {
        timestamp: "2026-07-08T00:00:01.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "active prompt" }] }
      }
    ]);
    writeJsonl(path.join(home, ".codex", "sessions", "archived.jsonl"), [
      {
        timestamp: "2026-07-08T00:01:00.000Z",
        type: "session_meta",
        payload: { id: archivedId, cwd: "C:\\work\\archived" }
      },
      {
        timestamp: "2026-07-08T00:01:01.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "archived prompt" }] }
      }
    ]);
    writeJsonl(path.join(home, ".codex", "archived_sessions", "archived.jsonl"), [
      {
        timestamp: "2026-07-08T00:01:00.000Z",
        type: "session_meta",
        payload: { id: archivedId, cwd: "C:\\work\\archived" }
      }
    ]);
    writeJsonl(path.join(home, ".codex", "session_index.jsonl"), [
      { id: activeId, thread_name: "Active Codex", updated_at: "2026-07-08T00:00:01.000Z" },
      { id: archivedId, thread_name: "Archived Codex", updated_at: "2026-07-08T00:01:01.000Z" }
    ]);

    assert.deepEqual([...__testInternals.archivedCodexSessionIds(home)], [archivedId]);

    const histories = listHistories({ fresh: true });
    assert.equal(histories.some((item) => item.provider === "codex" && item.id === activeId), true);
    assert.equal(histories.some((item) => item.provider === "codex" && item.id === archivedId), false);

    const tasks = filterArchivedCodexTasks(
      [
        { id: "task-active", agent: "codex", sessionId: activeId },
        { id: "task-archived", agent: "codex", sessionId: archivedId },
        { id: "task-claude", agent: "claude", sessionId: archivedId },
        { id: "task-new", agent: "codex", sessionId: "" }
      ],
      home
    );
    assert.deepEqual(tasks.map((item) => item.id), ["task-active", "task-claude", "task-new"]);
  } finally {
    if (originalHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("history previews exclude internal reasoning and developer content", () => {
  const originalHome = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-history-preview-"));
  const sessionId = "visible-preview-session";

  process.env.USERPROFILE = home;
  try {
    writeJsonl(path.join(home, ".codex", "sessions", "preview.jsonl"), [
      {
        timestamp: "2026-07-12T00:00:00.000Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "C:\\work\\preview" }
      },
      {
        timestamp: "2026-07-12T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "agent_reasoning", text: "private chain of thought" }
      },
      {
        timestamp: "2026-07-12T00:00:02.000Z",
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "internal developer instruction" }] }
      },
      {
        timestamp: "2026-07-12T00:00:03.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "visible user prompt" }] }
      },
      {
        timestamp: "2026-07-12T00:00:04.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible assistant reply" }] }
      }
    ]);

    const item = listHistories({ fresh: true }).find((entry) => entry.id === sessionId);

    assert.ok(item);
    assert.match(item.preview, /user: visible user prompt/);
    assert.match(item.preview, /assistant: visible assistant reply/);
    assert.doesNotMatch(item.preview, /agent_reasoning|private chain of thought|developer instruction|\[object Object\]/i);
  } finally {
    if (originalHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
