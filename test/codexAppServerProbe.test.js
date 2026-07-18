import assert from "node:assert/strict";
import test from "node:test";

import { __testInternals } from "../src/codexAppServerProbe.js";

test("Codex app-server probe preserves quoted Windows path separators", () => {
  assert.deepEqual(
    __testInternals.splitCommandLine('"D:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\codex.js"'),
    ["D:\\Program Files\\nodejs\\node.exe", "C:\\Users\\me\\codex.js"]
  );
});

test("Codex app-server probe auto resolution never returns auto as an executable", () => {
  const invocation = __testInternals.resolveCodexCommand({ codexCommand: "auto" });
  assert.notEqual(invocation.command, "auto");
  assert.ok(invocation.command);
});
