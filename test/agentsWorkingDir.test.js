import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __testInternals, createTask, getTask, stopTask, writeTaskInput } from "../src/agents.js";
import { defaultSettings } from "../src/config.js";

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

test("persistent queue payload excludes runtime objects and environment secrets", () => {
  assert.deepEqual(
    __testInternals.persistentLaunchPayload({
      agent: "codex",
      prompt: "hello",
      env: { OPENAI_API_KEY: "secret" },
      executionHost: { startProvider() {} },
      security: { sandboxMode: "workspace-write" }
    }),
    { agent: "codex", prompt: "hello", security: { sandboxMode: "workspace-write" } }
  );
});

test("restored Rust queue inputs retain only explicitly durable input events", () => {
  assert.deepEqual(
    __testInternals.queuedDurableInputs([
      { type: "stdin", text: "initial prompt", payload: {} },
      { type: "stdin", text: "resume after restart", payload: { queued: true } },
      { type: "system", text: "Input queued for the next resume turn." },
      { type: "stdin", text: "", payload: { queued: true } }
    ]),
    ["resume after restart"]
  );
});

test("agent output normalizer preserves split UTF-8 JSONL", () => {
  const events = [];
  const normalizer = __testInternals.createOutputNormalizer((event) => events.push(event));
  const encoded = Buffer.from(`${JSON.stringify({ type: "thread.started", thread_id: "session-1", text: "你好" })}\n`, "utf8");
  const split = encoded.indexOf(Buffer.from("你", "utf8")) + 2;
  normalizer.write(encoded.subarray(0, split));
  normalizer.write(encoded.subarray(split));
  normalizer.end();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "json");
  assert.equal(events[0].payload.thread_id, "session-1");
  assert.equal(events[0].payload.text, "你好");
});

test("running CLI input queues a resume turn on the execution host under the same task id", async () => {
  const starts = [];
  const pages = new Map();
  let releaseFirst;
  const firstReady = new Promise((resolve) => { releaseFirst = resolve; });
  async function recordStart(params) {
    starts.push(params);
    pages.set(params.executionId, starts.length === 1 ? null : [
      { hostSeq: 1, type: "stream.stdout", payload: { text: `${JSON.stringify({ text: "continued" })}\n` } },
      { hostSeq: 2, type: "execution.exited", payload: { exitCode: 0, signal: "" } }
    ]);
    return { executionId: params.executionId, status: "running", lastAckedHostSeq: 0 };
  }
  const facade = {
    startProvider: recordStart,
    startAppServerProvider: recordStart,
    async providerEvents(id) {
      if (starts[0]?.executionId === id && pages.get(id) === null) {
        await firstReady;
        pages.set(id, [
          {
            hostSeq: 1,
            type: "provider.event",
            payload: {
              type: "provider.thread.started",
              protocol: "codex-app-server",
              threadId: "session-1",
              payload: { thread: { id: "session-1" } }
            }
          },
          { hostSeq: 2, type: "stream.stderr", payload: { text: "warning\n" } },
          { hostSeq: 3, type: "execution.exited", payload: { exitCode: 0, signal: "" } }
        ]);
      }
      const events = pages.get(id) || [];
      pages.set(id, []);
      return { events };
    },
    async acknowledgeProviderEvents() {},
    async getProvider(id) { return { executionId: id, status: "running" }; },
    async signalProvider() { return { accepted: true }; }
  };
  const task = await createTask(
    { agent: "codex", prompt: "first", cwd: rootDir, executionHost: facade },
    {
      ...defaultSettings,
      codexCommand: "codex",
      defaultCwd: rootDir,
      allowedRoots: [rootDir],
      security: { ...defaultSettings.security, requireTrustedWorkspace: false }
    }
  );

  assert.equal(starts[0].executionId, task.id);
  assert.equal(starts[0].threadStartParams.threadSource, "appServer");
  assert.equal(starts[0].threadResumeParams, undefined);
  assert.equal(starts[0].turnStartParams.threadId, undefined);
  assert.deepEqual(writeTaskInput(task.id, "second"), { ok: true, queued: true, queueLength: 1 });
  releaseFirst();
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const poll = () => {
      const current = getTask(task.id);
      if (current?.status === "done") return resolve();
      if (Date.now() > deadline) return reject(new Error("queued resume did not complete"));
      setTimeout(poll, 10);
    };
    poll();
  });

  const completed = getTask(task.id);
  assert.equal(starts.length, 2);
  assert.notEqual(starts[1].executionId, task.id);
  assert.equal(starts[1].threadResumeParams.threadId, "session-1");
  assert.equal(starts[1].turnStartParams.threadId, "session-1");
  assert.equal(starts[1].turnStartParams.input[0].text, "second");
  assert.equal(starts[1].args.includes("resume"), false);
  assert.equal(completed.id, task.id);
  assert.equal(completed.sessionId, "session-1");
  assert.equal(completed.events.some((event) => event.type === "stderr" && event.text === "warning\n"), true);
  assert.equal(completed.events.some((event) => event.text === "Turn completed; starting queued resume."), true);
});

test("stopping an agent task signals its worker and drops queued input", async () => {
  let releaseEvents;
  const eventsReady = new Promise((resolve) => { releaseEvents = resolve; });
  const signals = [];
  const facade = {
    async startProvider(params) { return { executionId: params.executionId, status: "running", lastAckedHostSeq: 0 }; },
    async providerEvents() {
      await eventsReady;
      return { events: [{ hostSeq: 1, type: "execution.exited", payload: { exitCode: 1, signal: "stop" } }] };
    },
    async acknowledgeProviderEvents() {},
    async getProvider(id) { return { executionId: id, status: "running" }; },
    async signalProvider(id, signal, reason) {
      signals.push({ id, signal, reason });
      releaseEvents();
      return { accepted: true };
    }
  };
  const task = await createTask(
    { agent: "zhipu", prompt: "first", cwd: rootDir, executionHost: facade },
    {
      ...defaultSettings,
      defaultCwd: rootDir,
      allowedRoots: [rootDir],
      security: { ...defaultSettings.security, requireTrustedWorkspace: false }
    }
  );
  writeTaskInput(task.id, "do not run");

  assert.equal(await stopTask(task.id), true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].id, task.id);
  assert.equal(signals[0].signal, "stop");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(getTask(task.id).events.some((event) => event.text === "Turn completed; starting queued resume."), false);
});
