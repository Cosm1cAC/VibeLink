import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.VIBELINK_EXECUTION_HOST_TEST_BIN || "";
const fixture = path.join(root, "test", "fixtures", "slowProvider.mjs");

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function startExecd(dataDir, pipeName) {
  return spawn(binary, ["execd", "--data-dir", dataDir, "--pipe", pipeName], {
    cwd: root,
    env: {
      ...process.env,
      VIBELINK_TASK_CONCURRENCY: "1",
      VIBELINK_TASK_SCHEDULER_OWNER: "rust",
      VIBELINK_FAKE_PROVIDER_DELAY_MS: "2500"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
}

async function waitFor(read, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    try {
      value = read();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for Rust scheduler state: ${JSON.stringify(value)}`);
}

function seed(dataDir, taskId) {
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    JSON.stringify({
      defaultCwd: dataDir,
      claudeCommand: `${quote(process.execPath)} ${quote(fixture)}`,
      codexCommand: "disabled",
      doubaoCommand: "disabled"
    })
  );
  const db = new DatabaseSync(path.join(dataDir, "mobile-agent.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, title TEXT NOT NULL, cwd TEXT,
      workspace_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, exit_code INTEGER, session_id TEXT,
      command_label TEXT, log_path TEXT, meta_json TEXT
    );
    CREATE TABLE task_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      event_id TEXT NOT NULL, event_type TEXT, event_at TEXT NOT NULL,
      text TEXT, payload_json TEXT, event_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(task_id,event_id)
    );
    CREATE TABLE task_queue (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3, next_attempt_at TEXT,
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, last_error TEXT
    );
  `);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tasks
      (id,agent,title,cwd,status,created_at,updated_at,command_label,log_path,meta_json)
    VALUES (?, 'claude', 'restart acceptance', ?, 'queued', ?, ?, 'claude', '', '{}')
  `).run(taskId, dataDir, now, now);
  db.prepare(`
    INSERT INTO task_queue
      (id,task_id,status,priority,attempts,max_attempts,next_attempt_at,payload_json,created_at,updated_at)
    VALUES (?,?,'queued',0,0,3,?,?,?,?)
  `).run(
    crypto.randomUUID(),
    taskId,
    now,
    JSON.stringify({ agent: "claude", prompt: "restart acceptance", cwd: dataDir }),
    now,
    now
  );
  return db;
}

test(
  "Rust scheduler preserves task identity and drains replay after execd restart",
  { skip: process.platform !== "win32" || !binary || !fs.existsSync(binary), timeout: 25_000 },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-rust-task-restart-"));
    const pipeName = `\\\\.\\pipe\\vibelink-rust-task-restart-${process.pid}-${crypto.randomUUID()}`;
    const taskId = crypto.randomUUID();
    const db = seed(dataDir, taskId);
    let first;
    let second;
    let workerPid = 0;
    try {
      first = startExecd(dataDir, pipeName);
      const binding = await waitFor(() =>
        db.prepare("SELECT * FROM execution_bindings WHERE task_id=?").get(taskId)
      );
      workerPid = Number(binding.worker_pid || 0);
      assert.equal(binding.id, taskId);
      assert.equal(binding.owner, "execution-host");
      await stop(first);
      first = null;

      second = startExecd(dataDir, pipeName);
      const completed = await waitFor(() => {
        const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
        return task?.status === "done" ? task : null;
      });
      assert.equal(completed.id, taskId);

      const queue = db.prepare("SELECT * FROM task_queue WHERE task_id=?").get(taskId);
      assert.equal(queue.status, "completed");
      assert.equal(queue.attempts, 1);

      const events = db
        .prepare("SELECT host_seq,event_id FROM execution_host_events WHERE execution_id=? ORDER BY host_seq")
        .all(taskId);
      assert.ok(events.length >= 3);
      assert.deepEqual(events.map((event) => event.host_seq), events.map((_, index) => index + 1));
      assert.equal(new Set(events.map((event) => event.event_id)).size, events.length);

      const settledBinding = db.prepare("SELECT * FROM execution_bindings WHERE id=?").get(taskId);
      assert.equal(settledBinding.last_ingested_host_seq, events.at(-1).host_seq);
      assert.equal(settledBinding.last_acked_host_seq, events.at(-1).host_seq);
      assert.equal(settledBinding.last_seen_host_seq, events.at(-1).host_seq);

      const projected = db
        .prepare("SELECT event_id FROM task_events WHERE task_id=? AND event_id IN (SELECT event_id FROM execution_host_events)")
        .all(taskId);
      assert.equal(new Set(projected.map((event) => event.event_id)).size, events.length);
    } finally {
      await stop(first);
      await stop(second);
      if (workerPid) {
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {}
      }
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
);
