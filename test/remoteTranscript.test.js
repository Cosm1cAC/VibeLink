import assert from "node:assert/strict";
import test from "node:test";
import { remoteToolSummary, remoteTranscriptItems } from "../apps/web/src/remoteTranscript.js";

test("Codex Remote transcript keeps tool calls as lightweight rows", () => {
  const items = remoteTranscriptItems([
    {
      role: "assistant",
      text: "代码已经修好了。",
      toolCalls: [
        {
          id: "tool-1",
          name: "mcp__codebase_memory_mcp.search_graph",
          label: "mcp__codebase_memory_mcp.search_graph",
          kind: "plugin",
          status: "done"
        }
      ]
    }
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].type, "message");
  assert.equal(items[1].type, "tool");
  assert.equal(items[1].statusText, "已运行");
  assert.equal(items[1].label, "mcp__codebase_memory_mcp.search_graph");
  assert.equal("kindLabel" in items[1], false);
});

test("Codex Remote transcript summarizes command counts without cards", () => {
  const items = remoteTranscriptItems([
    {
      role: "assistant",
      text: "",
      commandCount: 11
    }
  ]);

  assert.deepEqual(items, [
    {
      type: "tool",
      source: "command-count",
      key: "0-assistant:command-count",
      statusText: "已运行",
      label: "11 条命令",
      detail: ""
    }
  ]);
});

test("Codex Remote transcript prefers shell command text for tool labels", () => {
  const summary = remoteToolSummary({
    status: "running",
    name: "Shell command",
    input: { command: "npm run build" }
  });

  assert.equal(summary.statusText, "正在运行");
  assert.equal(summary.label, "npm run build");
});
