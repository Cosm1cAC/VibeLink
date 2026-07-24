import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { __testInternals } from "../src/desktopRemote.js";

const rootDir = path.resolve(import.meta.dirname, "..");

test("Desktop Remote accepts the current OpenAI Codex Store package identity", () => {
  const result = __testInternals.evaluateDesktopPreflight(
    {
      found: true,
      processPath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.715.4045.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
      windowTitle: "ChatGPT",
      composerReady: true,
      inputName: "Ask Codex",
      sendName: "Send",
      sendEnabled: false,
      conversations: [{ index: 0, title: "Current task", projectTitle: "VibeLink" }]
    },
    { target: { desktopIndex: 0, desktopTitle: "Current task", desktopProjectTitle: "VibeLink" } }
  );

  assert.equal(result.ok, true);
});

test("Desktop Remote does not treat an unrelated ChatGPT executable as Codex Desktop", () => {
  assert.equal(
    __testInternals.isCodexDesktopIdentity({
      processPath: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
      windowTitle: "ChatGPT"
    }),
    false
  );
});

test("Desktop Remote waits while Codex is running instead of reporting a draft hazard", () => {
  const result = __testInternals.evaluateDesktopPreflight(
    {
      found: true,
      processPath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.715.4045.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
      windowTitle: "ChatGPT",
      composerReady: false,
      reason: "Codex Desktop composer shows a Stop button, so the current window is running a turn.",
      inputName: "synthetic-bottom-composer",
      sendName: "停止",
      sendEnabled: true,
      conversations: [{ index: 0, title: "Current task", projectTitle: "VibeLink" }]
    },
    { target: { desktopIndex: 0, desktopTitle: "Current task", desktopProjectTitle: "VibeLink" } }
  );

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.deepEqual(result.failures.map((failure) => failure.code), ["composer_unready"]);
});

test("the Windows desktop probe enumerates the current ChatGPT-hosted Codex window", () => {
  const source = fs.readFileSync(path.join(rootDir, "src", "codexDesktopControl.ps1"), "utf8");

  assert.match(source, /Get-Process -Name Codex, ChatGPT/);
  assert.match(source, /OpenAI\.Codex_/);
  assert.match(source, /\$window\.Current\.Name -notin @\("Codex", "ChatGPT"\)/);
});
