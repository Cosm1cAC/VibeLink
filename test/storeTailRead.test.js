import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __testInternals, readJsonLines } from "../src/store.js";

test("small history summaries start with a 64 KiB tail chunk", () => {
  assert.equal(__testInternals.tailReadChunkSize(80), 64 * 1024);
  assert.equal(__testInternals.tailReadChunkSize(3000), 512 * 1024);
});

test("small tail chunks still recover JSON lines larger than one chunk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-tail-read-"));
  const filePath = path.join(root, "history.jsonl");
  const longText = "x".repeat(96 * 1024);
  const entries = [
    { id: "long", text: longText },
    ...Array.from({ length: 79 }, (_, index) => ({ id: `item-${index}` })),
  ];
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

  try {
    const items = readJsonLines(filePath, 80);
    assert.equal(items.length, 80);
    assert.equal(items[0].text, longText);
    assert.equal(items.at(-1).id, "item-78");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
