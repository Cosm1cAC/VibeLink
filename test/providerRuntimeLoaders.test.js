import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  __testInternals,
  createProviderRuntimeLoaders,
  loadCodexAppServerCatalog
} from "../src/providerRuntimeLoaders.js";

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "" },
    text: async () => JSON.stringify(payload)
  };
}

test("default provider command runner captures stdout, stderr, and exit status", async () => {
  const success = await __testInternals.runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('provider-ok')"],
    timeoutMs: 1000
  });
  const failure = await __testInternals.runCommand({
    command: process.execPath,
    args: ["-e", "process.stderr.write('provider-failed'); process.exit(3)"],
    timeoutMs: 1000
  });

  assert.equal(success.ok, true);
  assert.equal(success.stdout, "provider-ok");
  assert.equal(success.stderr, "");
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 3);
  assert.equal(failure.stderr, "provider-failed");
});

test("runtime loaders use provider-native health and model discovery boundaries", async () => {
  const fetchCalls = [];
  const commandCalls = [];
  const settings = {
    codexCommand: "codex-custom --profile work",
    claudeCommand: "claude-custom",
    doubaoCdpEndpoint: "http://127.0.0.1:9333",
    doubaoUrl: "https://www.doubao.com/chat/",
    apiKeys: { openai: "openai-secret", anthropic: "anthropic-secret", zhipu: "zhipu-secret" }
  };
  const runtime = createProviderRuntimeLoaders({
    getSettings: async () => settings,
    runCommandImpl: async (input) => {
      commandCalls.push(input);
      return { ok: true, stdout: `${input.command} 1.2.3\n`, stderr: "", code: 0, latencyMs: 7 };
    },
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      if (url.includes("anthropic")) {
        return jsonResponse({ data: [{ id: "claude-dynamic", display_name: "Claude Dynamic" }] });
      }
      return jsonResponse({ data: [{ id: "glm-dynamic", name: "GLM Dynamic" }] });
    },
    codexCatalogLoader: async ({ settings: loaderSettings }) => {
      assert.equal(loaderSettings.apiKeys.openai, "openai-secret");
      return { source: "codex-app-server:model/list", models: [{ id: "gpt-dynamic", label: "GPT Dynamic" }] };
    },
    doubaoStatusLoader: async (input) => ({ ok: true, endpoint: input.endpoint, status: { target: { ok: true } } }),
    anthropicModelsUrl: "https://api.anthropic.test/v1/models",
    zhipuModelsUrl: "https://api.bigmodel.test/v4/models"
  });

  const [codexHealth, claudeHealth, codexCatalog, claudeCatalog, doubaoHealth, doubaoCatalog, zhipuHealth, zhipuCatalog] = await Promise.all([
    runtime.healthLoaders.codex(),
    runtime.healthLoaders.claude(),
    runtime.catalogLoaders.codex(),
    runtime.catalogLoaders.claude(),
    runtime.healthLoaders.doubao(),
    runtime.catalogLoaders.doubao(),
    runtime.healthLoaders.zhipu(),
    runtime.catalogLoaders.zhipu()
  ]);

  assert.equal(codexHealth.ok, true);
  assert.equal(claudeHealth.ok, true);
  assert.deepEqual(commandCalls.map((call) => [call.command, call.args]), [
    ["codex-custom", ["--profile", "work", "--version"]],
    ["claude-custom", ["--version"]],
    ["codex-custom", ["--profile", "work", "login", "status"]]
  ]);
  assert.equal(commandCalls[0].env.OPENAI_API_KEY, "openai-secret");
  assert.equal(commandCalls[1].env.ANTHROPIC_API_KEY, "anthropic-secret");
  assert.deepEqual(codexCatalog.models.map((model) => model.id), ["gpt-dynamic"]);
  assert.deepEqual(claudeCatalog.models, [{ id: "claude-dynamic", label: "Claude Dynamic" }]);
  assert.equal(doubaoHealth.ok, true);
  assert.deepEqual(doubaoCatalog.models, [{ id: "doubao-web", label: "Web default" }]);
  assert.equal(zhipuHealth.ok, true);
  assert.deepEqual(zhipuCatalog.models, [{ id: "glm-dynamic", label: "GLM Dynamic" }]);
  assert.equal(fetchCalls.length, 2, "health and catalog should share the in-flight GLM request");
  assert.equal(fetchCalls.find((call) => call.url.includes("anthropic")).options.headers["x-api-key"], "anthropic-secret");
  assert.equal(fetchCalls.find((call) => call.url.includes("bigmodel")).options.headers.Authorization, "Bearer zhipu-secret");
});

test("Codex catalog loader speaks app-server initialize and model/list JSONL", async () => {
  const requests = [];
  let spawnCall = null;
  const spawnImpl = (command, args, options) => {
    spawnCall = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString());
        requests.push(request);
        if (request.id === 1) {
          queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "codex-cli/1.2.3" } })}\n`));
        }
        if (request.id === 2) {
          queueMicrotask(() => child.stdout.write(`${JSON.stringify({
            id: 2,
            result: { data: [{ id: "gpt-live", displayName: "GPT Live" }], nextCursor: null }
          })}\n`));
        }
        callback();
      }
    });
    return child;
  };

  const result = await loadCodexAppServerCatalog({
    settings: { codexCommand: "codex-custom --profile work", apiKeys: { openai: "secret" } },
    spawnImpl,
    timeoutMs: 1000
  });

  assert.equal(spawnCall.command, "codex-custom");
  assert.deepEqual(spawnCall.args, ["--profile", "work", "app-server", "--stdio"]);
  assert.equal(spawnCall.options.env.OPENAI_API_KEY, "secret");
  assert.deepEqual(requests.map((request) => request.method), ["initialize", "initialized", "model/list"]);
  assert.equal(result.source, "codex-app-server:model/list");
  assert.deepEqual(result.models, [{ id: "gpt-live", label: "GPT Live" }]);
});

test("runtime health reports missing GLM credentials without making a request", async () => {
  let fetched = false;
  const runtime = createProviderRuntimeLoaders({
    getSettings: async () => ({ apiKeys: {} }),
    fetchImpl: async () => { fetched = true; return jsonResponse({ data: [] }); }
  });

  const health = await runtime.healthLoaders.zhipu();

  assert.equal(health.ok, false);
  assert.equal(health.status, "missing_credentials");
  assert.match(health.error, /not configured/i);
  assert.equal(fetched, false);
});

test("Doubao health exposes a bounded bridge reason instead of raw CLI JSON", async () => {
  const runtime = createProviderRuntimeLoaders({
    getSettings: async () => ({}),
    doubaoStatusLoader: async () => ({
      ok: false,
      doctor: {
        stderr: `${JSON.stringify({ ok: false, error: { code: "BRIDGE_OFFLINE", message: "Bridge is offline." } })}\n`
      }
    })
  });

  const health = await runtime.healthLoaders.doubao();

  assert.equal(health.ok, false);
  assert.equal(health.error, "Bridge is offline.");
});
