import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  RUST_ONLY_READINESS_PATH,
  RUST_ONLY_SMOKE_DEVICE_TOKEN,
  prepareRustOnlySmokeData,
  rustOnlyDefaultEntryArgs,
  rustOnlyServerArgs
} from "../tools/rust-only-package-smoke.mjs";

test("rust-only package smoke launches the default user entry", () => {
  assert.deepEqual(rustOnlyDefaultEntryArgs(15177), [
    "--host",
    "127.0.0.1",
    "--port",
    "15177"
  ]);
  assert.equal(RUST_ONLY_READINESS_PATH, "/api/status");
});

test("explicit rust-only server args remain available for direct canaries", () => {
  assert.deepEqual(rustOnlyServerArgs(15177, "C:\\temp\\vibelink-data"), [
    "--host",
    "127.0.0.1",
    "--port",
    "15177",
    "rust-only",
    "--data-dir",
    "C:\\temp\\vibelink-data"
  ]);
});

test("rust-only package smoke prepares authenticated status data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-package-smoke-data-"));
  try {
    prepareRustOnlySmokeData(directory, 15177);
    const settings = JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8"));
    assert.equal(settings.port, 15177);
    assert.deepEqual(settings.hostAllowlist, ["127.0.0.1"]);

    const database = new DatabaseSync(path.join(directory, "mobile-agent.sqlite"), { readOnly: true });
    try {
      const row = database.prepare("SELECT token_hash FROM devices WHERE id = ?").get("package-smoke-device");
      assert.equal(
        row.token_hash,
        crypto.createHash("sha256").update(RUST_ONLY_SMOKE_DEVICE_TOKEN).digest("hex")
      );
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
