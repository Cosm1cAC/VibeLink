import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateAndroidDeviceEvidence } from "../tools/release/android-device-evidence.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-android-evidence-"));
  fs.writeFileSync(path.join(root, "logcat.txt"), "VibeLink test log\n");
  for (const name of ["browser", "artifact", "approval", "call", "notifications", "rotation", "overview"]) {
    fs.writeFileSync(path.join(root, `${name}.png`), "png");
  }
  const scenarios = {
    browserRemoteControl: { status: "passed", screenshot: "browser.png" },
    artifactWorkbench: { status: "passed", screenshot: "artifact.png" },
    approvalDecision: { status: "passed", screenshot: "approval.png" },
    liveCallAsrMicrophone: { status: "passed", screenshot: "call.png" },
    notificationPermission: { status: "passed", screenshot: "notifications.png" },
    rotation: { status: "passed", screenshot: "rotation.png" }
  };
  return {
    root,
    manifest: {
      schemaVersion: 1,
      capturedAt: "2026-07-21T00:00:00Z",
      commit: "a".repeat(40),
      devices: [
        { formFactor: "phone", model: "Phone", androidVersion: "15", serialHash: "phone-hash", logcat: "logcat.txt", screenshots: ["overview.png"], scenarios },
        { formFactor: "tablet", model: "Tablet", androidVersion: "15", serialHash: "tablet-hash", logcat: "logcat.txt", screenshots: ["overview.png"], scenarios }
      ]
    }
  };
}

test("Android evidence requires phone and tablet scenario archives", () => {
  const { root, manifest } = fixture();
  try {
    assert.deepEqual(validateAndroidDeviceEvidence(manifest, root), {
      devices: 2,
      forms: ["phone", "tablet"],
      scenarios: ["browserRemoteControl", "artifactWorkbench", "approvalDecision", "liveCallAsrMicrophone", "notificationPermission", "rotation"]
    });
    manifest.devices[1].scenarios.rotation.status = "missing";
    assert.throws(() => validateAndroidDeviceEvidence(manifest, root), /rotation is not passed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
