#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CODEX_APP_SERVER_CONTRACT_VERSION = 2;
export const SUPPORTED_CODEX_CLI_MINORS = Object.freeze(["0.117", "0.144"]);
export const MAX_SCHEMA_FILE_BYTES = 4 * 1024 * 1024;

const supportedCliMinorSet = new Set(SUPPORTED_CODEX_CLI_MINORS);
const REQUIRED_REQUESTS = {
  "item/commandExecution/requestApproval": "CommandExecutionRequestApprovalParams",
  "item/fileChange/requestApproval": "FileChangeRequestApprovalParams",
  "item/permissions/requestApproval": "PermissionsRequestApprovalParams",
  "item/tool/call": "DynamicToolCallParams"
};
const REQUIRED_NOTIFICATIONS = {
  "thread/started": "ThreadStartedNotification",
  "turn/started": "TurnStartedNotification",
  "item/started": "ItemStartedNotification",
  "item/commandExecution/outputDelta": "CommandExecutionOutputDeltaNotification",
  "item/agentMessage/delta": "AgentMessageDeltaNotification",
  "item/mcpToolCall/progress": "McpToolCallProgressNotification",
  "item/completed": "ItemCompletedNotification",
  "turn/completed": "TurnCompletedNotification"
};
const REQUIRED_TOOL_ITEM_TYPES = Object.freeze(["commandExecution", "mcpToolCall", "dynamicToolCall"]);
const REQUIRED_RESPONSES = {
  "CommandExecutionRequestApprovalResponse.json": ["decision"],
  "FileChangeRequestApprovalResponse.json": ["decision"],
  "PermissionsRequestApprovalResponse.json": ["permissions"],
  "DynamicToolCallResponse.json": ["contentItems", "success"]
};
const REQUIRED_SCHEMA_FILES = [
  "ServerRequest.json",
  "ServerNotification.json",
  ...Object.keys(REQUIRED_RESPONSES)
];

function parseCliVersion(value) {
  const match = String(value || "").match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?\b/);
  if (!match) return null;
  return {
    value: `${match[1]}.${match[2]}.${match[3]}`,
    minor: `${match[1]}.${match[2]}`
  };
}

function parseSchema(name, value, errors, knownSize) {
  if (Number.isFinite(knownSize) && knownSize > MAX_SCHEMA_FILE_BYTES) {
    errors.push({ code: "SCHEMA_FILE_TOO_LARGE", file: name, maxBytes: MAX_SCHEMA_FILE_BYTES });
    return null;
  }
  if (value === undefined) {
    errors.push({ code: "SCHEMA_FILE_MISSING", file: name });
    return null;
  }
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_FILE_BYTES) {
      errors.push({ code: "SCHEMA_FILE_TOO_LARGE", file: name, maxBytes: MAX_SCHEMA_FILE_BYTES });
      return null;
    }
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    errors.push({ code: "SCHEMA_INVALID_JSON", file: name, message: error.message });
    return null;
  }
}

function schemaHash(schemas) {
  const hash = crypto.createHash("sha256");
  for (const name of REQUIRED_SCHEMA_FILES) {
    if (schemas[name] === undefined) continue;
    const value = typeof schemas[name] === "string" ? schemas[name] : JSON.stringify(schemas[name]);
    hash.update(name);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function methodRefs(schema) {
  const methods = new Map();
  for (const variant of schema?.oneOf || []) {
    const method = variant?.properties?.method?.enum?.[0];
    const ref = variant?.properties?.params?.$ref?.split("/").at(-1);
    if (method) methods.set(method, ref || "");
  }
  return methods;
}

function checkMethodRef(actual, method, expected, kind, errors) {
  if (!actual.has(method)) {
    errors.push({ code: `${kind}_METHOD_MISSING`, method, expected });
    return false;
  }
  if (actual.get(method) !== expected) {
    errors.push({ code: `${kind}_PARAMS_DRIFT`, method, expected, actual: actual.get(method) });
    return false;
  }
  return true;
}

function hasRequiredFields(schema, file, fields, errors) {
  const required = new Set(schema?.required || []);
  const missing = fields.filter((field) => !required.has(field));
  if (!missing.length) return true;
  errors.push({ code: "RESPONSE_FIELDS_MISSING", file, fields: missing });
  return false;
}

function hasRequiredToolItemTypes(schema, errors) {
  const actual = new Set(
    (schema?.definitions?.ThreadItem?.oneOf || [])
      .map((variant) => variant?.properties?.type?.enum?.[0])
      .filter(Boolean)
  );
  const missing = REQUIRED_TOOL_ITEM_TYPES.filter((type) => !actual.has(type));
  if (!missing.length) return true;
  errors.push({ code: "TOOL_ITEM_TYPES_MISSING", types: missing });
  return false;
}

export function analyzeCodexAppServerSchemas({ cliVersion = "", schemas = {}, schemaFileSizes = {} } = {}) {
  const errors = [];
  const parsedVersion = parseCliVersion(cliVersion);
  const versionSupported = Boolean(parsedVersion && supportedCliMinorSet.has(parsedVersion.minor));
  if (!parsedVersion) errors.push({ code: "CLI_VERSION_INVALID", value: String(cliVersion || "") });
  else if (!versionSupported) errors.push({
    code: "CLI_VERSION_UNSUPPORTED",
    version: parsedVersion.value,
    supported: [...SUPPORTED_CODEX_CLI_MINORS]
  });

  const requests = parseSchema(
    "ServerRequest.json",
    schemas["ServerRequest.json"],
    errors,
    schemaFileSizes["ServerRequest.json"]
  );
  const notifications = parseSchema(
    "ServerNotification.json",
    schemas["ServerNotification.json"],
    errors,
    schemaFileSizes["ServerNotification.json"]
  );
  const requestMethods = methodRefs(requests);
  const notificationMethods = methodRefs(notifications);

  const responseChecks = {};
  for (const [file, fields] of Object.entries(REQUIRED_RESPONSES)) {
    responseChecks[file] = hasRequiredFields(
      parseSchema(file, schemas[file], errors, schemaFileSizes[file]),
      file,
      fields,
      errors
    );
  }

  const checkRequest = (method) => checkMethodRef(requestMethods, method, REQUIRED_REQUESTS[method], "REQUEST", errors);
  const checkNotification = (method) => checkMethodRef(
    notificationMethods,
    method,
    REQUIRED_NOTIFICATIONS[method],
    "NOTIFICATION",
    errors
  );
  const commandApproval = checkRequest("item/commandExecution/requestApproval");
  const fileApproval = checkRequest("item/fileChange/requestApproval");
  const permissionApproval = checkRequest("item/permissions/requestApproval");
  const dynamicToolRequest = checkRequest("item/tool/call");
  const threadStarted = checkNotification("thread/started");
  const turnStarted = checkNotification("turn/started");
  const itemStarted = checkNotification("item/started");
  const commandOutput = checkNotification("item/commandExecution/outputDelta");
  const agentOutput = checkNotification("item/agentMessage/delta");
  const toolProgress = checkNotification("item/mcpToolCall/progress");
  const itemCompletion = checkNotification("item/completed");
  const turnCompletion = checkNotification("turn/completed");
  const toolItemTypes = hasRequiredToolItemTypes(notifications, errors);

  const capabilities = {
    threadLifecycle: threadStarted,
    turnLifecycle: turnStarted && turnCompletion,
    itemLifecycle: itemStarted && itemCompletion,
    toolLifecycle: itemStarted && itemCompletion && toolItemTypes,
    agentOutput,
    approvalContinuation: commandApproval && fileApproval && permissionApproval &&
      responseChecks["CommandExecutionRequestApprovalResponse.json"] &&
      responseChecks["FileChangeRequestApprovalResponse.json"] &&
      responseChecks["PermissionsRequestApprovalResponse.json"],
    dynamicToolCalls: dynamicToolRequest && responseChecks["DynamicToolCallResponse.json"],
    authoritativeCommandOutput: commandOutput && itemCompletion,
    toolProgress,
    turnCompletion
  };

  return {
    ok: versionSupported && Object.values(capabilities).every(Boolean) && errors.length === 0,
    contractVersion: CODEX_APP_SERVER_CONTRACT_VERSION,
    cliVersion: parsedVersion?.value || "",
    supportedCliMinors: [...SUPPORTED_CODEX_CLI_MINORS],
    schemaHash: errors.some((error) => error.code === "SCHEMA_FILE_TOO_LARGE") ? "" : schemaHash(schemas),
    capabilities,
    errors
  };
}

function probeFailure(code, message, source) {
  return {
    ok: false,
    contractVersion: CODEX_APP_SERVER_CONTRACT_VERSION,
    cliVersion: "",
    supportedCliMinors: [...SUPPORTED_CODEX_CLI_MINORS],
    schemaHash: schemaHash({}),
    capabilities: {
      threadLifecycle: false,
      turnLifecycle: false,
      itemLifecycle: false,
      toolLifecycle: false,
      agentOutput: false,
      approvalContinuation: false,
      dynamicToolCalls: false,
      authoritativeCommandOutput: false,
      toolProgress: false,
      turnCompletion: false
    },
    errors: [{ code, message }],
    source
  };
}

export function resolveCodexProbeInvocation({
  codexCommand = "codex",
  platform = process.platform,
  env = process.env,
  nodeCommand = process.execPath,
  exists = fs.existsSync
} = {}) {
  const configured = String(codexCommand || "codex").trim() || "codex";
  const base = path.basename(configured).toLowerCase();
  if (platform === "win32" && ["auto", "codex", "codex.cmd", "codex.ps1"].includes(base)) {
    const shimDirs = [];
    if (path.isAbsolute(configured)) shimDirs.push(path.dirname(configured));
    if (env.APPDATA) shimDirs.push(path.join(env.APPDATA, "npm"));
    for (const shimDir of [...new Set(shimDirs)]) {
      const codexJs = path.join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (exists(codexJs)) {
        return { command: nodeCommand, prefixArgs: [codexJs], displayCommand: configured };
      }
    }
  }
  return {
    command: configured === "auto" ? "codex" : configured,
    prefixArgs: [],
    displayCommand: configured
  };
}

export function runCodexAppServerContractProbe({
  codexCommand = process.env.CODEX_COMMAND || "codex",
  execute = spawnSync,
  tempRoot = os.tmpdir(),
  resolveInvocation = resolveCodexProbeInvocation
} = {}) {
  const invocation = resolveInvocation({ codexCommand });
  const source = {
    command: invocation.displayCommand,
    launcher: invocation.command,
    schemaGenerator: "app-server generate-json-schema --experimental"
  };
  const commandOptions = { encoding: "utf8", windowsHide: true };
  const versionRun = execute(invocation.command, [...invocation.prefixArgs, "--version"], commandOptions);
  if (versionRun?.status !== 0) {
    return probeFailure(
      "CODEX_VERSION_FAILED",
      String(versionRun?.error?.message || versionRun?.stderr || "Cannot read Codex CLI version."),
      source
    );
  }

  const outputDir = fs.mkdtempSync(path.join(tempRoot, "vibelink-codex-app-server-"));
  try {
    const generateRun = execute(
      invocation.command,
      [...invocation.prefixArgs, "app-server", "generate-json-schema", "--experimental", "--out", outputDir],
      commandOptions
    );
    if (generateRun?.status !== 0) {
      return probeFailure("SCHEMA_GENERATION_FAILED", String(generateRun?.stderr || "Codex schema generation failed."), source);
    }

    const schemas = {};
    const schemaFileSizes = {};
    for (const name of REQUIRED_SCHEMA_FILES) {
      const filePath = path.join(outputDir, name);
      if (!fs.existsSync(filePath)) continue;
      schemaFileSizes[name] = fs.statSync(filePath).size;
      if (schemaFileSizes[name] <= MAX_SCHEMA_FILE_BYTES) {
        schemas[name] = fs.readFileSync(filePath, "utf8");
      }
    }
    return {
      ...analyzeCodexAppServerSchemas({ cliVersion: versionRun.stdout, schemas, schemaFileSizes }),
      source
    };
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runCodexAppServerContractProbe();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}
