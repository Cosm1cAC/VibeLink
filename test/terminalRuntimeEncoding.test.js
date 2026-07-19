import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startTerminalSession, stopTerminalSession, writeTerminalSession } from "../src/terminalRuntime.js";

test("Windows spawn terminal emits a UTF-8 prompt for non-ASCII workspaces", { skip: process.platform !== "win32" }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-移动终端-"));
  let output = "";
  let resolveExit;
  let session;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });

  try {
    session = await startTerminalSession({
      cwd,
      mode: "spawn",
      onOutput: ({ text }) => {
        output += text;
      },
      onExit: resolveExit,
    });

    await writeTerminalSession(session.id, "Get-Location; exit\r\n");
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("terminal did not exit")), 3_000)),
    ]);
    assert.match(output, /vibelink-移动终端-/);
    assert.doesNotMatch(output, /�/);
  } finally {
    if (session) await stopTerminalSession(session.id, "encoding test cleanup");
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
