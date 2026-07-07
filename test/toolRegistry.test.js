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
