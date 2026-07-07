import assert from "node:assert/strict";
import test from "node:test";

import { getCachedMcpTools, storeMcpTools } from "../src/db.js";

test("storeMcpTools persists discovered MCP tools", () => {
  const fullName = `mcp__test-server__tool_${Date.now()}`;
  const count = storeMcpTools("test-server", [
    {
      name: "tool",
      fullName,
      title: "Tool",
      description: "A cached test MCP tool.",
      inputSchema: { type: "object", properties: { q: { type: "string" } } }
    }
  ]);

  assert.equal(count, 1);
  const row = getCachedMcpTools().find((item) => item.full_name === fullName);
  assert.equal(row.server_name, "test-server");
  assert.deepEqual(row.inputSchema.properties.q, { type: "string" });
});
