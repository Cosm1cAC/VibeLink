import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { getCommands } from "../src/commandRegistry.js";
import { listToolRegistry } from "../src/toolRegistry.js";

const catalogPath = new URL("../apps/windows/resources/discovery-catalog.json", import.meta.url);

test("Rust discovery catalog matches every built-in tool and command", () => {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const commands = getCommands().filter((command) => !command.id.startsWith("skill:"));

  assert.deepEqual(catalog.tools, listToolRegistry());
  assert.deepEqual(catalog.commands, commands);
  assert.equal(catalog.commands.some((command) => command.source || command.body), false);
});
