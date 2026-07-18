import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { upsertWorkspace } from "../src/db.js";
import { runWorkspaceCommand } from "../src/workspaces.js";

test("workspace command delegates foreground and streaming contracts to the execution host facade", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-command-host-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "command-host" });
  const executionId = crypto.randomUUID();
  const calls = [];
  const chunks = [];
  const executionHost = {
    async runCommand(options) {
      calls.push(options);
      options.onOutput?.({ stream: "stdout", text: "2 passed\n", elapsedMs: 4 });
      return {
        ok: true,
        stdout: "2 passed\n",
        stderr: "",
        exitCode: 0,
        signal: "",
        executionId: options.executionId
      };
    }
  };

  try {
    const result = await runWorkspaceCommand(workspace.id, { allowedRoots: [tempRoot] }, {
      executionId,
      executionHost,
      command: "npm test",
      kind: "test",
      timeoutMs: 4321,
      onOutput: (chunk) => chunks.push(chunk)
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].executionId, executionId);
    assert.equal(calls[0].cwd, repo);
    assert.equal(calls[0].timeoutMs, 4321);
    assert.equal(result.executionId, executionId);
    assert.equal(result.workspace.id, workspace.id);
    assert.equal(result.command, "npm test");
    assert.deepEqual(
      {
        ok: result.test.ok,
        passed: result.test.passed,
        failed: result.test.failed,
        failures: result.test.failures,
        log: result.test.log
      },
      { ok: true, passed: 2, failed: 0, failures: [], log: "2 passed\n" }
    );
    assert.deepEqual(result.test.suites, []);
    assert.deepEqual(result.test.cases, []);
    assert.equal(chunks[0].command, "npm test");
    assert.equal(chunks[0].cwd, repo);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
