import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

test("android:build uses the checked-in Gradle wrapper", () => {
  const script = packageJson.scripts?.["android:build"] || "";

  assert.match(script, /gradlew\.bat/i);
  assert.doesNotMatch(script, /build-debug\.ps1/i);
  assert.ok(fs.existsSync(path.join(rootDir, "apps", "android", "gradlew.bat")));
});

test("android:adb points at the bundled adb executable", () => {
  const script = packageJson.scripts?.["android:adb"] || "";

  assert.match(script, /adb\.exe/i);
  assert.match(script, /^\.\\/);
  assert.ok(fs.existsSync(path.join(rootDir, ".agent-mobile-terminal", "android-sdk", "platform-tools", "adb.exe")));
});
