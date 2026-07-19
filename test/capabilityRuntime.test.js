import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCapabilityRuntime } from "../src/capabilityRuntime.js";

test("capability runtime manages marked plugins and keeps external plugins read-only", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-capability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".codex", "plugins", "external", ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "plugins", "external", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "external" }));
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "AGENTS.md"), "# Rules\n");
  const runtime = createCapabilityRuntime({ rootDir: project, homeDir: home, getTasks: () => [] });

  await runtime.installPlugin({ id: "managed", manifest: { name: "Managed", version: "1.0.0" }, files: { "README.md": "hello" } });
  const plugins = await runtime.list("plugins");
  assert.equal(plugins.find((item) => item.id === "external").capabilities.remove, false);
  assert.equal(plugins.find((item) => item.id === "managed").capabilities.remove, true);
  await runtime.setPluginEnabled("managed", false);
  assert.equal((await runtime.list("plugins")).find((item) => item.id === "managed").enabled, false);
  await runtime.removePlugin("managed");
  assert.equal((await runtime.list("plugins")).some((item) => item.id === "managed"), false);
});

test("capability runtime redacts config and revision-guards AGENTS edits", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-resources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: ["notify"] }, api_key: "secret-value" }));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Old\n");
  const runtime = createCapabilityRuntime({ rootDir: root, homeDir: home, getTasks: () => [{ id: "child", parentTaskId: "parent", status: "running" }] });
  const configs = await runtime.list("config");
  assert.equal(JSON.stringify(configs).includes("secret-value"), false);
  assert.equal((await runtime.list("hooks")).length, 1);
  await runtime.setHookEnabled("claude:Stop", false);
  assert.equal((await runtime.list("hooks"))[0].enabled, false);
  await runtime.setHookEnabled("claude:Stop", true);
  assert.equal((await runtime.list("hooks"))[0].enabled, true);
  assert.equal((await runtime.list("subagents"))[0].parentTaskId, "parent");
  const agents = configs.find((item) => item.id === "project-agents");
  await runtime.updateTextResource("project-agents", { expectedDigest: agents.digest, text: "# New\n" });
  await assert.rejects(runtime.updateTextResource("project-agents", { expectedDigest: agents.digest, text: "stale" }), (error) => error.code === "CAPABILITY_CONFLICT");
});
