import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { resolveEventStoreRustCommand } from "../tools/event-store/rustCommand.mjs";

const rootDir = "C:\\repo";
const binary = "vibelink.exe";
const release = path.join(rootDir, "apps", "windows", "target", "release", binary);
const debug = path.join(rootDir, "apps", "windows", "target", "debug", binary);

test("event-store canary default fails fast on a stale release binary", () => {
  assert.throws(
    () => resolveEventStoreRustCommand({
      rootDir,
      platform: "win32",
      exists: (candidate) => candidate === release || candidate === debug,
      isCurrent: (candidate) => candidate !== release,
      performanceGate: true
    }),
    /stale Rust event-store binary.*cargo build --release --manifest-path apps\/windows\/Cargo.toml/s
  );
});

test("event-store performance canaries reject debug binaries unless run as functional-only", () => {
  assert.throws(
    () => resolveEventStoreRustCommand({
      rootDir,
      platform: "win32",
      explicitCommand: debug,
      exists: (candidate) => candidate === debug,
      isCurrent: () => true,
      performanceGate: true
    }),
    /debug Rust event-store binary.*functional-only/s
  );

  assert.deepEqual(resolveEventStoreRustCommand({
    rootDir,
    platform: "win32",
    explicitCommand: debug,
    exists: (candidate) => candidate === debug,
    isCurrent: () => true,
    performanceGate: false
  }), {
    command: debug,
    profile: "debug",
    explicit: true
  });
});

test("event-store CI binds canaries to the release binary built in the same job", () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "event-store-rust-canary.yml"),
    "utf8"
  );
  assert.match(
    workflow,
    /VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND:\s*apps\/windows\/target\/release\/vibelink\.exe/
  );
});
