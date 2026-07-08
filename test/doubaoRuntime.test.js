import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  doubaoAgentArgs,
  doubaoBridgeCliPath,
  doubaoCommandForAction,
  doubaoCliPath
} from "../src/doubaoRuntime.js";
import { TaskInputSchema } from "../src/validation.js";

test("doubaoCommandForAction builds safe Doubao CLI commands", () => {
  const cliPath = doubaoBridgeCliPath();

  assert.equal(path.basename(cliPath), "doubao.mjs");
  assert.deepEqual(doubaoCommandForAction("doctor"), [cliPath, "doctor", "--json"]);
  assert.deepEqual(
    doubaoCommandForAction("configure", { noDaemon: true, noOpen: true, port: 45771 }),
    [cliPath, "configure", "--json", "--no-daemon", "--no-open", "--port", "45771"]
  );
  assert.deepEqual(
    doubaoCommandForAction("ask", {
      prompt: "你好",
      endpoint: "http://127.0.0.1:9333",
      url: "https://www.doubao.com/chat/"
    }),
    [
      cliPath,
      "ask",
      "--json",
      "--prompt",
      "你好",
      "--endpoint",
      "http://127.0.0.1:9333",
      "--url",
      "https://www.doubao.com/chat/"
    ]
  );
});

test("doubaoAgentArgs maps a VibeLink task prompt to the web CLI", () => {
  assert.deepEqual(
    doubaoAgentArgs(
      { prompt: "写一个摘要" },
      {
        doubaoCdpEndpoint: "http://127.0.0.1:9222",
        doubaoUrl: "https://www.doubao.com/chat/"
      }
    ),
    [
      "ask",
      "--json",
      "--prompt",
      "写一个摘要",
      "--endpoint",
      "http://127.0.0.1:9222",
      "--url",
      "https://www.doubao.com/chat/"
    ]
  );
});

test("TaskInputSchema accepts VibeLink Agent providers", () => {
  for (const agent of ["codex", "claude", "doubao", "zhipu"]) {
    const parsed = TaskInputSchema.safeParse({ agent, prompt: "你好" });
    assert.equal(parsed.success, true, `${agent} should be accepted`);
  }
});
