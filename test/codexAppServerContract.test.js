import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_SCHEMA_FILE_BYTES,
  analyzeCodexAppServerSchemas,
  resolveCodexProbeInvocation,
  runCodexAppServerContractProbe
} from "../tools/codex-app-server/contract-probe.mjs";

const requestRefs = {
  "item/commandExecution/requestApproval": "CommandExecutionRequestApprovalParams",
  "item/fileChange/requestApproval": "FileChangeRequestApprovalParams",
  "item/permissions/requestApproval": "PermissionsRequestApprovalParams",
  "item/tool/call": "DynamicToolCallParams"
};

const notificationRefs = {
  "item/commandExecution/outputDelta": "CommandExecutionOutputDeltaNotification",
  "item/completed": "ItemCompletedNotification",
  "turn/completed": "TurnCompletedNotification"
};

function methodSchema(method, ref, { request = false } = {}) {
  return {
    type: "object",
    required: request ? ["id", "method", "params"] : ["method", "params"],
    properties: {
      ...(request ? { id: { $ref: "#/definitions/RequestId" } } : {}),
      method: { type: "string", enum: [method] },
      params: { $ref: `#/definitions/${ref}` }
    }
  };
}

function responseSchema(required) {
  return { type: "object", required };
}

function completeSchemas() {
  return {
    "ServerRequest.json": JSON.stringify({
      title: "ServerRequest",
      oneOf: Object.entries(requestRefs).map(([method, ref]) => methodSchema(method, ref, { request: true }))
    }),
    "ServerNotification.json": JSON.stringify({
      title: "ServerNotification",
      oneOf: Object.entries(notificationRefs).map(([method, ref]) => methodSchema(method, ref))
    }),
    "CommandExecutionRequestApprovalResponse.json": JSON.stringify(responseSchema(["decision"])),
    "FileChangeRequestApprovalResponse.json": JSON.stringify(responseSchema(["decision"])),
    "PermissionsRequestApprovalResponse.json": JSON.stringify(responseSchema(["permissions"])),
    "DynamicToolCallResponse.json": JSON.stringify(responseSchema(["contentItems", "success"]))
  };
}

test("Codex app-server contract gate accepts the reviewed 0.117 schema", () => {
  const report = analyzeCodexAppServerSchemas({
    cliVersion: "codex-cli 0.117.0",
    schemas: completeSchemas()
  });

  assert.equal(report.ok, true);
  assert.equal(report.contractVersion, 1);
  assert.equal(report.cliVersion, "0.117.0");
  assert.match(report.schemaHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.capabilities, {
    approvalContinuation: true,
    dynamicToolCalls: true,
    authoritativeCommandOutput: true,
    turnCompletion: true
  });
  assert.deepEqual(report.errors, []);
});

test("Codex app-server contract gate rejects a missing approval method", () => {
  const schemas = completeSchemas();
  const requests = JSON.parse(schemas["ServerRequest.json"]);
  requests.oneOf = requests.oneOf.filter(
    (item) => item.properties.method.enum[0] !== "item/fileChange/requestApproval"
  );
  schemas["ServerRequest.json"] = JSON.stringify(requests);

  const report = analyzeCodexAppServerSchemas({
    cliVersion: "codex-cli 0.117.0",
    schemas
  });

  assert.equal(report.ok, false);
  assert.equal(report.capabilities.approvalContinuation, false);
  assert.ok(report.errors.some((error) =>
    error.code === "REQUEST_METHOD_MISSING" &&
    error.method === "item/fileChange/requestApproval" &&
    error.expected === "FileChangeRequestApprovalParams"
  ));
});

test("Codex app-server contract gate reports a params schema drift", () => {
  const schemas = completeSchemas();
  const requests = JSON.parse(schemas["ServerRequest.json"]);
  const fileApproval = requests.oneOf.find(
    (item) => item.properties.method.enum[0] === "item/fileChange/requestApproval"
  );
  fileApproval.properties.params.$ref = "#/definitions/ChangedFileApprovalParams";
  schemas["ServerRequest.json"] = JSON.stringify(requests);

  const report = analyzeCodexAppServerSchemas({
    cliVersion: "codex-cli 0.117.0",
    schemas
  });

  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) =>
    error.code === "REQUEST_PARAMS_DRIFT" &&
    error.method === "item/fileChange/requestApproval" &&
    error.expected === "FileChangeRequestApprovalParams" &&
    error.actual === "ChangedFileApprovalParams"
  ));
});

test("Codex app-server contract gate rejects an unreviewed CLI minor", () => {
  const report = analyzeCodexAppServerSchemas({
    cliVersion: "codex-cli 0.118.0",
    schemas: completeSchemas()
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.supportedCliMinors, ["0.117"]);
  assert.ok(report.errors.some((error) =>
    error.code === "CLI_VERSION_UNSUPPORTED" &&
    error.version === "0.118.0" &&
    error.supported.includes("0.117")
  ));
});

test("Codex app-server contract gate rejects an oversized schema file", () => {
  const schemas = completeSchemas();
  schemas["ServerRequest.json"] = " ".repeat(MAX_SCHEMA_FILE_BYTES + 1);

  const report = analyzeCodexAppServerSchemas({
    cliVersion: "codex-cli 0.117.0",
    schemas
  });

  assert.equal(report.ok, false);
  assert.equal(report.schemaHash, "");
  assert.ok(report.errors.some((error) =>
    error.code === "SCHEMA_FILE_TOO_LARGE" &&
    error.file === "ServerRequest.json" &&
    error.maxBytes === MAX_SCHEMA_FILE_BYTES
  ));
});

test("Codex app-server contract gate rejects an oversized generated file before reading it", () => {
  const schemas = completeSchemas();
  delete schemas["ServerRequest.json"];

  const report = analyzeCodexAppServerSchemas({
    cliVersion: "codex-cli 0.117.0",
    schemas,
    schemaFileSizes: { "ServerRequest.json": MAX_SCHEMA_FILE_BYTES + 1 }
  });

  assert.equal(report.ok, false);
  assert.equal(report.schemaHash, "");
  assert.ok(report.errors.some((error) =>
    error.code === "SCHEMA_FILE_TOO_LARGE" && error.file === "ServerRequest.json"
  ));
  assert.ok(!report.errors.some((error) =>
    error.code === "SCHEMA_FILE_MISSING" && error.file === "ServerRequest.json"
  ));
});

test("Codex app-server probe generates, audits, and removes a temporary schema bundle", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-codex-probe-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const calls = [];
  let generatedDir = "";
  const execute = (command, args) => {
    calls.push({ command, args });
    if (args[0] === "--version") return { status: 0, stdout: "codex-cli 0.117.0\n", stderr: "" };
    generatedDir = args.at(-1);
    fs.mkdirSync(generatedDir, { recursive: true });
    for (const [name, content] of Object.entries(completeSchemas())) {
      fs.writeFileSync(path.join(generatedDir, name), content, "utf8");
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const report = runCodexAppServerContractProbe({
    codexCommand: "codex-test",
    execute,
    tempRoot
  });

  assert.equal(report.ok, true);
  assert.equal(report.source.command, "codex-test");
  assert.equal(report.source.schemaGenerator, "app-server generate-json-schema --experimental");
  assert.deepEqual(calls.map((call) => call.args), [
    ["--version"],
    ["app-server", "generate-json-schema", "--experimental", "--out", generatedDir]
  ]);
  assert.equal(fs.existsSync(generatedDir), false);
});

test("Codex app-server probe resolves the Windows npm shim without a shell", () => {
  const appData = "C:\\Users\\test\\AppData\\Roaming";
  const codexJs = path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  const invocation = resolveCodexProbeInvocation({
    codexCommand: "codex",
    platform: "win32",
    env: { APPDATA: appData },
    nodeCommand: "node-test.exe",
    exists: (candidate) => candidate === codexJs
  });

  assert.deepEqual(invocation, {
    command: "node-test.exe",
    prefixArgs: [codexJs],
    displayCommand: "codex"
  });
});
