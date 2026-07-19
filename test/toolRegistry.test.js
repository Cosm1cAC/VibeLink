import assert from "node:assert/strict";
import test from "node:test";

import { listToolRegistry } from "../src/toolRegistry.js";

test("listToolRegistry includes cached MCP tools", () => {
  const items = listToolRegistry({
    mcpTools: [
      {
        full_name: "mcp__codebase-memory-mcp__search_graph",
        tool_name: "search_graph",
        title: "search_graph",
        description: "Search the code knowledge graph.",
        inputSchema: {
          type: "object",
          properties: { project: { type: "string" } },
          required: ["project"]
        }
      }
    ]
  });

  const tool = items.find((item) => item.name === "mcp__codebase-memory-mcp__search_graph");
  assert.equal(tool.kind, "plugin");
  assert.equal(tool.permission, "plugin.mcp");
  assert.equal(tool.label, "search_graph");
  assert.deepEqual(tool.inputSchema.required, ["project"]);
});

test("listToolRegistry exposes Agent Reach tools", () => {
  const items = listToolRegistry();
  const byName = new Map(items.map((item) => [item.name, item]));

  assert.equal(byName.get("agent_reach.status")?.kind, "agent");
  assert.equal(byName.get("agent_reach.skill")?.permission, "agent_reach.manage");
  assert.equal(byName.get("agent_reach.transcribe")?.inputSchema.required.includes("source"), true);
  assert.equal(byName.get("agent_reach.format")?.inputSchema.properties.platform.enum[0], "xhs");
});

test("listToolRegistry exposes Doubao web tools", () => {
  const items = listToolRegistry();
  const byName = new Map(items.map((item) => [item.name, item]));

  assert.equal(byName.get("doubao.status")?.kind, "agent");
  assert.equal(byName.get("doubao.configure")?.permission, "doubao.manage");
  assert.equal(byName.get("doubao.configure")?.inputSchema.properties.noDaemon.type, "boolean");
  assert.equal(byName.get("doubao.ask")?.permission, "doubao.read");
  assert.equal(byName.get("doubao.ask")?.inputSchema.required.includes("prompt"), true);
});

test("listToolRegistry exposes complete Git worktree lifecycle actions", () => {
  const tool = listToolRegistry().find((item) => item.name === "workspace.git_worktree_action");
  assert.deepEqual(tool.inputSchema.properties.action.enum, ["remove", "prune", "lock", "unlock"]);
  assert.deepEqual(tool.inputSchema.required, ["workspaceId", "action"]);
});
