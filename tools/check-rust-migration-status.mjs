#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "docs", "rust-migration-status.json");
const statusDocPath = path.join(root, "docs", "rust-migration-status.md");
const skippedDirs = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
  ".agent-mobile-terminal",
  ".tmp"
]);
const searchableExtensions = new Set([
  ".js",
  ".mjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".rs",
  ".md",
  ".json",
  ".toml"
]);

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON ${filePath}: ${error.message}`);
  }
}

function existsRelative(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function isPlannedReference(value = "") {
  return /^planned\b/i.test(String(value).trim());
}

function walkFiles(dir, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skippedDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, output);
      continue;
    }
    if (searchableExtensions.has(path.extname(entry.name))) output.push(fullPath);
  }
  return output;
}

let sourceTextCache = null;
function sourceText() {
  if (sourceTextCache) return sourceTextCache;
  sourceTextCache = walkFiles(root)
    .map((filePath) => {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
  return sourceTextCache;
}

function statusRank(statuses, status) {
  const index = statuses.indexOf(status);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

const errors = [];
const warnings = [];
const manifest = readJson(manifestPath);
const statusDoc = fs.existsSync(statusDocPath) ? fs.readFileSync(statusDocPath, "utf8") : "";
const statuses = Array.isArray(manifest.statusOrder) ? manifest.statusOrder : [];
const slices = Array.isArray(manifest.slices) ? manifest.slices : [];
const requiredIds = new Set([
  "workspace-tree",
  "mcp-session-sidecar",
  "event-store-sidecar",
  "audio-pipeline",
  "compression-adapter"
]);

if (!statuses.length) fail("Manifest must define a non-empty statusOrder array.");
if (!slices.length) fail("Manifest must define a non-empty slices array.");

const seenIds = new Set();
for (const slice of slices) {
  if (!slice || typeof slice !== "object") {
    fail("Every manifest slice must be an object.");
    continue;
  }
  const label = slice.id || slice.title || "(unknown slice)";
  if (!slice.id) fail(`${label}: missing id.`);
  if (seenIds.has(slice.id)) fail(`${label}: duplicate id.`);
  seenIds.add(slice.id);
  if (!slice.title) fail(`${label}: missing title.`);
  if (!statuses.includes(slice.status)) fail(`${label}: unknown status '${slice.status}'.`);
  if (!slice.priority) fail(`${label}: missing priority.`);
  if (!slice.rollout) fail(`${label}: missing rollout.`);
  if (!slice.nodeEntry) fail(`${label}: missing nodeEntry.`);
  if (!slice.rustEntry) fail(`${label}: missing rustEntry.`);
  if (!slice.sidecarCommand) fail(`${label}: missing sidecarCommand.`);
  if (!slice.nodeFallback) fail(`${label}: missing nodeFallback.`);
  if (!slice.currentState) fail(`${label}: missing currentState.`);
  if (!slice.nextAction) fail(`${label}: missing nextAction.`);
  if (!slice.promotionGate) fail(`${label}: missing promotionGate.`);

  const docs = Array.isArray(slice.docs) ? slice.docs : [];
  if (!docs.length) fail(`${label}: docs must list at least one document.`);
  for (const doc of docs) {
    if (!existsRelative(doc)) fail(`${label}: listed doc does not exist: ${doc}`);
  }

  const tests = Array.isArray(slice.tests) ? slice.tests : [];
  if (!tests.length) fail(`${label}: tests must list at least one current or planned test.`);
  if (slice.status !== "planned") {
    for (const testPath of tests) {
      if (isPlannedReference(testPath)) fail(`${label}: non-planned slice cannot list planned-only test '${testPath}'.`);
      else if (!existsRelative(testPath)) fail(`${label}: listed test does not exist: ${testPath}`);
    }
  }

  const optInOrHigher = statusRank(statuses, slice.status) >= statusRank(statuses, "opt-in");
  if (optInOrHigher && isPlannedReference(slice.rustEntry)) {
    fail(`${label}: opt-in or higher slice cannot have planned rustEntry '${slice.rustEntry}'.`);
  }
  if (optInOrHigher && (!slice.nodeFallback || isPlannedReference(slice.nodeFallback))) {
    fail(`${label}: opt-in or higher slices must describe an implemented Node fallback.`);
  }

  const featureFlags = Array.isArray(slice.featureFlags) ? slice.featureFlags : [];
  if (!featureFlags.length) fail(`${label}: featureFlags must list at least one flag or planned flag.`);
  for (const flag of featureFlags) {
    const name = typeof flag === "string" ? flag : flag?.name;
    const requiredInCode = typeof flag === "object" ? flag.requiredInCode === true : true;
    if (!name) {
      fail(`${label}: feature flag entry missing name.`);
      continue;
    }
    if (requiredInCode && !sourceText().includes(name)) {
      fail(`${label}: required feature flag '${name}' was not found in source/docs.`);
    }
  }

  if (statusDoc) {
    if (!statusDoc.includes(slice.title)) fail(`${label}: status doc does not mention title '${slice.title}'.`);
    if (!statusDoc.includes(`\`${slice.status}\``)) warn(`${label}: status doc does not visibly include status '${slice.status}'.`);
  }
}

for (const id of requiredIds) {
  if (!seenIds.has(id)) fail(`Manifest missing required Rust migration slice: ${id}`);
}

if (!statusDoc) {
  fail("docs/rust-migration-status.md is missing or empty.");
} else {
  for (const id of requiredIds) {
    const slice = slices.find((item) => item.id === id);
    if (slice && !statusDoc.includes(slice.title)) fail(`Status doc missing required slice title: ${slice.title}`);
  }
}

const eventStore = slices.find((slice) => slice.id === "event-store-sidecar");
if (eventStore) {
  const rank = statusRank(statuses, eventStore.status);
  const optInRank = statusRank(statuses, "opt-in");
  if (rank >= optInRank) {
    if (isPlannedReference(eventStore.rustEntry) || isPlannedReference(eventStore.sidecarCommand)) {
      fail("event-store-sidecar cannot be opt-in or higher while rustEntry/sidecarCommand are still planned.");
    }
    if (!sourceText().includes("event-store-sidecar")) {
      fail("event-store-sidecar cannot be opt-in or higher until a real Rust command is present in source.");
    }
  }
}

const todos = slices.map((slice) => `- [ ] ${slice.title} (${slice.status}): ${slice.nextAction}`);
console.log("Rust migration status TODO summary:");
console.log(todos.join("\n"));

if (warnings.length) {
  console.warn("\nWarnings:");
  for (const message of warnings) console.warn(`- ${message}`);
}

if (errors.length) {
  console.error("\nRust migration status check failed:");
  for (const message of errors) console.error(`- ${message}`);
  process.exit(1);
}

console.log("\nRust migration status check passed.");
