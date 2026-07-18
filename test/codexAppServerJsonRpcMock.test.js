import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCodexAppServerMessage } from "../src/codexAppServerEvents.js";

const receivedAt = "2026-07-18T10:00:00.000Z";

class JsonRpcMock {
  constructor() {
    this.events = [];
    this.responses = [];
  }

  serverMessage(message) {
    this.events.push(...normalizeCodexAppServerMessage(JSON.stringify(message), { receivedAt }));
  }

  clientResponse(id, result) {
    const message = { id, result };
    this.responses.push(message);
    this.events.push(...normalizeCodexAppServerMessage(message, { receivedAt }));
  }
}

test("JSON-RPC mock normalizes thread, turn, item, tool, output, and completion events", () => {
  const rpc = new JsonRpcMock();
  rpc.serverMessage({ method: "thread/started", params: { thread: { id: "thread-1", createdAt: 1_752_836_400 } } });
  rpc.serverMessage({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", startedAt: 1_752_836_401 } }
  });
  rpc.serverMessage({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1_752_836_402_000,
      item: { type: "commandExecution", id: "item-1", command: "npm test", status: "inProgress" }
    }
  });
  rpc.serverMessage({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "ok\n" }
  });
  rpc.serverMessage({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1_752_836_403_000,
      item: { type: "commandExecution", id: "item-1", command: "npm test", status: "completed", exitCode: 0 }
    }
  });
  rpc.serverMessage({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", completedAt: 1_752_836_404 } }
  });

  assert.deepEqual(rpc.events.map((event) => event.type), [
    "provider.thread.started",
    "provider.turn.started",
    "provider.item.started",
    "provider.tool.started",
    "provider.output.delta",
    "provider.item.completed",
    "provider.tool.completed",
    "provider.turn.completed"
  ]);
  assert.equal(rpc.events[3].payload.name, "npm test");
  assert.equal(rpc.events[4].payload.channel, "tool");
  assert.equal(rpc.events[4].payload.delta, "ok\n");
  assert.equal(rpc.events[6].payload.item.exitCode, 0);
});

test("JSON-RPC mock preserves approval request identity without dispatching it", () => {
  const rpc = new JsonRpcMock();
  rpc.serverMessage({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 1_752_836_402_000,
      reason: "network access",
      command: "npm install",
      availableDecisions: ["accept", "decline"]
    }
  });

  assert.equal(rpc.events.length, 1);
  assert.equal(rpc.events[0].type, "provider.approval.required");
  assert.equal(rpc.events[0].payload.requestId, 42);
  assert.equal(rpc.events[0].payload.requestIdType, "number");
  assert.equal(rpc.events[0].payload.connectionScoped, true);
  assert.deepEqual(rpc.events[0].payload.availableDecisions, ["accept", "decline"]);
  assert.deepEqual(rpc.responses, []);

  rpc.clientResponse(42, { decision: "accept" });
  assert.equal(rpc.events.length, 1);
  assert.deepEqual(rpc.responses, [{ id: 42, result: { decision: "accept" } }]);
});

test("JSON-RPC mock normalizes dynamic and MCP tool identities and progress", () => {
  const rpc = new JsonRpcMock();
  rpc.serverMessage({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1,
      item: { type: "dynamicToolCall", id: "dynamic-1", namespace: "workspace", tool: "search", status: "inProgress" }
    }
  });
  rpc.serverMessage({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 2,
      item: { type: "mcpToolCall", id: "mcp-1", server: "docs", tool: "fetch", status: "inProgress" }
    }
  });
  rpc.serverMessage({
    method: "item/mcpToolCall/progress",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "mcp-1", message: "loading" }
  });

  const tools = rpc.events.filter((event) => event.type === "provider.tool.started");
  assert.deepEqual(tools.map((event) => [event.payload.kind, event.payload.namespace, event.payload.name]), [
    ["dynamicToolCall", "workspace", "search"],
    ["mcpToolCall", "docs", "fetch"]
  ]);
  assert.equal(rpc.events.at(-1).payload.progress, true);
  assert.equal(rpc.events.at(-1).payload.delta, "loading");
});

test("JSON-RPC mock normalizes assistant output and all reviewed approval kinds", () => {
  const rpc = new JsonRpcMock();
  rpc.serverMessage({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "hello" }
  });
  rpc.serverMessage({
    id: "file-approval",
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "patch-1", startedAtMs: 3, grantRoot: "D:\\repo" }
  });
  rpc.serverMessage({
    id: "permissions-approval",
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      startedAtMs: 4,
      permissions: { network: { enabled: true } }
    }
  });

  assert.equal(rpc.events[0].payload.channel, "assistant");
  assert.equal(rpc.events[0].payload.delta, "hello");
  assert.deepEqual(rpc.events.slice(1).map((event) => event.payload.kind), ["fileChange", "permissions"]);
  assert.deepEqual(rpc.events[2].payload.requestedPermissions, { network: { enabled: true } });
  assert.ok(rpc.events.slice(1).every((event) => event.payload.connectionScoped));
});

test("normalizer ignores unrelated JSON-RPC messages and rejects malformed supported messages", () => {
  assert.deepEqual(normalizeCodexAppServerMessage({ id: 1, result: {} }, { receivedAt }), []);
  assert.deepEqual(normalizeCodexAppServerMessage({ method: "account/updated", params: {} }, { receivedAt }), []);
  assert.throws(
    () => normalizeCodexAppServerMessage({ method: "turn/started", params: { threadId: "thread-1", turn: {} } }),
    (error) => error.code === "CODEX_APP_SERVER_MESSAGE_INVALID" && error.field === "params.turn.id"
  );
});
