import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifySessionOrigin,
  loadSessionOriginBindings,
  recordSessionOrigin,
  resolveSessionOriginFilter
} from "../src/sessionOrigins.js";

function writeTaskLog(filePath, events) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

test("new VibeLink tasks backfill a CLI creation binding while resumed tasks do not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-session-origins-"));
  const tasksDir = path.join(root, "tasks");
  const registryPath = path.join(root, "session-origins.json");

  try {
    writeTaskLog(path.join(tasksDir, "new.jsonl"), [
      {
        type: "system",
        text: "Starting codex in C:\\work",
        payload: { agent: "codex", launchMode: "new" }
      },
      { type: "json", payload: { type: "thread.started", thread_id: "cli-created" } }
    ]);
    writeTaskLog(path.join(tasksDir, "resume.jsonl"), [
      {
        type: "system",
        text: "Starting codex in C:\\work",
        payload: { agent: "codex", launchMode: "resume" }
      },
      { type: "json", payload: { type: "thread.started", thread_id: "desktop-resumed" } }
    ]);

    const bindings = loadSessionOriginBindings({ tasksDir, registryPath, persistBackfill: false });

    assert.equal(bindings.get("codex:cli-created")?.sessionOrigin, "vibelink-cli");
    assert.equal(bindings.has("codex:desktop-resumed"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSessionOriginFilter accepts supported values and rejects invalid input", () => {
  assert.equal(resolveSessionOriginFilter(null), "all");
  assert.equal(resolveSessionOriginFilter("all"), "all");
  assert.equal(resolveSessionOriginFilter("vibelink-cli"), "vibelink-cli");
  assert.equal(resolveSessionOriginFilter("codex-desktop"), "codex-desktop");
  assert.equal(resolveSessionOriginFilter("unknown"), "unknown");
  assert.throws(() => resolveSessionOriginFilter("desktop"), /Unsupported sessionOrigin/);
});

test("legacy task logs distinguish new runs from exec resume", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-session-origins-legacy-"));
  const tasksDir = path.join(root, "tasks");

  try {
    writeTaskLog(path.join(tasksDir, "new.jsonl"), [
      { type: "system", text: "Starting codex in C:\\work" },
      { type: "system", text: "codex.exe exec --json build it" },
      { type: "json", payload: { thread_id: "legacy-new" } }
    ]);
    writeTaskLog(path.join(tasksDir, "resume.jsonl"), [
      { type: "system", text: "Starting codex in C:\\work" },
      { type: "system", text: "codex.exe exec resume --json desktop-session continue" },
      { type: "json", payload: { thread_id: "desktop-session" } }
    ]);

    const bindings = loadSessionOriginBindings({
      tasksDir,
      registryPath: path.join(root, "missing.json"),
      persistBackfill: false
    });

    assert.equal(bindings.get("codex:legacy-new")?.sessionOrigin, "vibelink-cli");
    assert.equal(bindings.has("codex:desktop-session"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit creation bindings take precedence over Codex Desktop metadata", () => {
  const bindings = new Map([
    ["codex:cli-session", { provider: "codex", sessionId: "cli-session", sessionOrigin: "vibelink-cli" }]
  ]);

  assert.equal(
    classifySessionOrigin(
      { provider: "codex", id: "cli-session", originator: "Codex Desktop" },
      bindings
    ),
    "vibelink-cli"
  );
  assert.equal(
    classifySessionOrigin(
      { provider: "codex", id: "desktop-session", originator: "Codex Desktop" },
      bindings
    ),
    "codex-desktop"
  );
  assert.equal(classifySessionOrigin({ provider: "codex", id: "unknown" }, bindings), "unknown");
});

test("recordSessionOrigin persists an explicit binding", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-session-origin-record-"));
  const registryPath = path.join(root, "session-origins.json");

  try {
    recordSessionOrigin(
      { provider: "codex", sessionId: "created-now", sessionOrigin: "vibelink-cli", taskId: "task-1" },
      { registryPath }
    );
    const bindings = loadSessionOriginBindings({
      tasksDir: path.join(root, "tasks"),
      registryPath,
      persistBackfill: false
    });

    assert.equal(bindings.get("codex:created-now")?.taskId, "task-1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
