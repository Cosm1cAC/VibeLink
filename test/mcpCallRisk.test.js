import assert from "node:assert/strict";
import test from "node:test";

import { mcpCallApprovalRisk } from "../src/mcpCallRisk.js";

test("mcpCallApprovalRisk allows read-only codebase-memory tools", () => {
  const risk = mcpCallApprovalRisk(
    { fullName: "mcp__codebase-memory-mcp__search_graph", arguments: { query: "server" } },
    { requireDangerousCommandApproval: true }
  );

  assert.equal(risk.required, false);
  assert.equal(risk.risky, false);
});

test("mcpCallApprovalRisk requires approval for mutating MCP tools", () => {
  const risk = mcpCallApprovalRisk(
    { serverId: "codebase-memory-mcp", toolName: "index_repository", arguments: { repo_path: "C:/repo" } },
    { requireDangerousCommandApproval: true }
  );

  assert.equal(risk.required, true);
  assert.equal(risk.matches[0].code, "mcp_mutating_tool");
});

test("mcpCallApprovalRisk honors disabled dangerous-command approvals", () => {
  const risk = mcpCallApprovalRisk(
    { serverId: "codebase-memory-mcp", toolName: "delete_project", arguments: { project: "demo" } },
    { requireDangerousCommandApproval: false }
  );

  assert.equal(risk.risky, true);
  assert.equal(risk.required, false);
});
