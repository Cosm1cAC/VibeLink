import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __testInternals } from "../src/agents.js";

const rootDir = path.resolve(import.meta.dirname, "..");

test("resolveWorkingDir ignores fallback directories outside allowed roots", () => {
  const result = __testInternals.resolveWorkingDir(
    {},
    {
      defaultCwd: rootDir,
      allowedRoots: [rootDir],
    },
  );

  assert.equal(result.cwd, rootDir);
  assert.equal(result.requestedCwd, rootDir);
  assert.equal(result.usedFallback, false);
  assert.notEqual(path.resolve(os.homedir()), rootDir);
});

test("claude streaming args include verbose for current CLI compatibility", () => {
  const args = __testInternals.claudeArgs({ prompt: "hello" }, {});

  assert.deepEqual(args.slice(0, 4), ["--print", "--output-format", "stream-json", "--verbose"]);
  assert.ok(args.includes("--include-partial-messages"));
});

test("agent launch plan starts Doubao through the standalone bridge CLI when available", () => {
  const plan = __testInternals.agentLaunchPlan(
    { agent: "doubao", prompt: "hello" },
    {
      doubaoCommand: "auto",
      doubaoCdpEndpoint: "http://127.0.0.1:9222",
      doubaoUrl: "https://www.doubao.com/chat/"
    }
  );

  assert.equal(plan.agent, "doubao");
  assert.equal(plan.base.command, process.execPath);
  assert.match(plan.base.args[0].replaceAll("\\", "/"), /packages\/doubao-cli\/src\/bin\/doubao\.mjs$/);
  assert.deepEqual(plan.args.slice(1, 5), ["ask", "--json", "--prompt", "hello"]);
});

test("agent launch plan treats Zhipu as a first-class VibeLink Agent provider", () => {
  const plan = __testInternals.agentLaunchPlan(
    { agent: "zhipu", prompt: "hello", model: "glm-5.2" },
    {}
  );

  assert.equal(plan.agent, "zhipu");
  assert.equal(plan.base.command, process.execPath);
  assert.match(plan.base.args[0].replaceAll("\\", "/"), /src\/zhipuCli\.mjs$/);
  assert.deepEqual(plan.args.slice(1, 6), ["--json", "--prompt", "hello", "--model", "glm-5.2"]);
});
