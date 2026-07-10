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

test("agent launch plan starts Doubao through a repo-managed CLI", () => {
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
  assert.match(plan.base.args[0].replaceAll("\\", "/"), /(?:packages\/doubao-cli\/src\/bin\/doubao|tools\/doubao-cli)\.mjs$/);
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

test("codex launch plan passes approval policy before the exec subcommand", () => {
  const plan = __testInternals.agentLaunchPlan(
    { agent: "codex", prompt: "hello", model: "gpt-5.5" },
    {
      codexCommand: "codex",
      defaultCwd: rootDir,
      security: {
        approvalPolicy: "on-request",
        networkAccess: true,
        sandboxMode: "workspace-write",
      },
    },
  );

  const execIndex = plan.args.indexOf("exec");
  const approvalIndex = plan.args.indexOf("--ask-for-approval");
  const sandboxIndex = plan.args.indexOf("--sandbox");

  assert.ok(approvalIndex > -1);
  assert.ok(approvalIndex < execIndex);
  assert.ok(sandboxIndex < execIndex);
  assert.deepEqual(plan.args.slice(execIndex, execIndex + 2), ["exec", "--json"]);
  assert.equal(plan.args.at(-1), "hello");
});

test("codex resume launch plan keeps global options before exec resume", () => {
  const plan = __testInternals.agentLaunchPlan(
    {
      agent: "codex",
      mode: "resume",
      sessionId: "00000000-0000-4000-8000-000000000000",
      prompt: "continue",
    },
    {
      codexCommand: "codex",
      defaultCwd: rootDir,
      security: {
        approvalPolicy: "strict",
        networkAccess: false,
        sandboxMode: "workspace-write",
      },
    },
  );

  const execIndex = plan.args.indexOf("exec");
  assert.deepEqual(plan.args.slice(execIndex, execIndex + 4), ["exec", "resume", "--json", "--skip-git-repo-check"]);
  assert.ok(plan.args.indexOf("--ask-for-approval") < execIndex);
  assert.ok(plan.args.indexOf("--sandbox") < execIndex);
  assert.equal(plan.args[plan.args.indexOf("--ask-for-approval") + 1], "untrusted");
  assert.equal(plan.args.at(-1), "continue");
});
