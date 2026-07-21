#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const requiredScenarios = [
  "browserRemoteControl",
  "artifactWorkbench",
  "approvalDecision",
  "liveCallAsrMicrophone",
  "notificationPermission",
  "rotation"
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

function fail(message) {
  throw new Error(message);
}

function loadManifest(file) {
  if (!file) fail("Missing --manifest.");
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) fail(`Evidence manifest not found: ${resolved}`);
  try {
    return { resolved, value: JSON.parse(fs.readFileSync(resolved, "utf8")) };
  } catch (error) {
    fail(`Evidence manifest is not valid JSON: ${error.message}`);
  }
}

function validateDevice(device, manifestDir) {
  if (!device || !["phone", "tablet"].includes(device.formFactor)) {
    fail("Each device must declare formFactor as phone or tablet.");
  }
  if (!device.model || !device.androidVersion || !device.serialHash) {
    fail(`${device.formFactor} evidence must include model, androidVersion, and serialHash.`);
  }
  if (!device.logcat) fail(`${device.model} is missing logcat evidence.`);
  const logcat = path.resolve(manifestDir, device.logcat);
  if (!fs.existsSync(logcat)) fail(`${device.model} logcat file is missing: ${logcat}`);
  if (!Array.isArray(device.screenshots) || device.screenshots.length === 0) {
    fail(`${device.model} is missing screenshots.`);
  }
  for (const screenshot of device.screenshots) {
    const file = path.resolve(manifestDir, screenshot);
    if (!fs.existsSync(file)) fail(`${device.model} screenshot is missing: ${file}`);
  }
  for (const scenario of requiredScenarios) {
    const result = device.scenarios?.[scenario];
    if (result?.status !== "passed") fail(`${device.model} scenario ${scenario} is not passed.`);
    if (!result.screenshot) fail(`${device.model} scenario ${scenario} is missing a screenshot.`);
    if (!fs.existsSync(path.resolve(manifestDir, result.screenshot))) {
      fail(`${device.model} scenario ${scenario} screenshot is missing.`);
    }
  }
}

export function validateAndroidDeviceEvidence(manifest, manifestDir = process.cwd(), { requireBoth = true } = {}) {
  if (manifest?.schemaVersion !== 1) fail("Evidence manifest schemaVersion must be 1.");
  if (!manifest.capturedAt || !manifest.commit) fail("Evidence manifest must include capturedAt and commit.");
  if (!Array.isArray(manifest.devices) || manifest.devices.length === 0) fail("Evidence manifest must include devices.");
  const forms = new Set(manifest.devices.map((device) => device?.formFactor));
  if (requireBoth && (!forms.has("phone") || !forms.has("tablet"))) fail("Physical evidence must include both a phone and a tablet.");
  for (const device of manifest.devices) validateDevice(device, manifestDir);
  return { devices: manifest.devices.length, forms: [...forms].sort(), scenarios: requiredScenarios };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { resolved, value } = loadManifest(argument("--manifest"));
    const summary = validateAndroidDeviceEvidence(value, path.dirname(resolved), { requireBoth: !process.argv.includes("--allow-single-form-factor") });
    console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
