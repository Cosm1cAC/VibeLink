import test from "node:test";
import assert from "node:assert/strict";

import {
  RUST_ONLY_READINESS_PATH,
  rustOnlyServerArgs
} from "../tools/rust-only-package-smoke.mjs";

test("rust-only package smoke launches the headless Rust server entry", () => {
  assert.deepEqual(rustOnlyServerArgs(15177, "C:\\temp\\vibelink-data"), [
    "--host",
    "127.0.0.1",
    "--port",
    "15177",
    "rust-only",
    "--data-dir",
    "C:\\temp\\vibelink-data"
  ]);
  assert.equal(RUST_ONLY_READINESS_PATH, "/api/openapi.json");
});
