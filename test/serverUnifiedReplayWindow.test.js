import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");

test("/api/events/unified uses bounded replay window contract", () => {
  const source = fs.readFileSync(path.join(rootDir, "src", "server.js"), "utf8");

  assert.match(source, /replayEventWindowAsync/);
  assert.doesNotMatch(source, /listUnifiedEventsAsync/);
  assert.match(source, /const window = await replayEventWindowAsync\(/);
  assert.match(source, /items:\s*applyFields\(window\.items,\s*url\)/);
  assert.match(source, /nextCursor:\s*window\.nextCursor/);
  assert.match(source, /hasMore:\s*window\.hasMore/);
});
