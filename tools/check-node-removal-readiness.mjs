#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { nodeRuntimeReadiness } from "./rust-migration-policy.mjs";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "docs", "rust-migration-status.json"), "utf8"));
const readiness = nodeRuntimeReadiness(manifest);
const json = process.argv.includes("--json");

if (json) {
  process.stdout.write(`${JSON.stringify(readiness)}\n`);
} else if (readiness.ready) {
  console.log("Node runtime removal gate passed.");
} else {
  console.error("Node runtime removal gate blocked:");
  for (const blocker of readiness.blockers) {
    console.error(`- ${blocker.id}: ${blocker.title} (${blocker.status})`);
  }
}

process.exitCode = readiness.ready ? 0 : 1;
