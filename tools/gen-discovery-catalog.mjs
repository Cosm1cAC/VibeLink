#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { getCommands } from "../src/commandRegistry.js";
import { listToolRegistry } from "../src/toolRegistry.js";

const output = path.resolve("apps/windows/resources/discovery-catalog.json");
const commands = getCommands().filter((command) => !command.id.startsWith("skill:"));
const catalog = { tools: listToolRegistry(), commands };

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Wrote ${catalog.tools.length} tools and ${catalog.commands.length} commands to ${output}`);
