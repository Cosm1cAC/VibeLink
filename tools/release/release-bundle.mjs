#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const requiredRollbackStages = [
  "upgrade-to-rust-only",
  "process-rollback-to-hybrid",
  "re-upgrade-to-rust-only"
];

function fail(message) {
  throw new Error(message);
}

function requireHash(value, label) {
  if (!/^[0-9a-f]{64}$/i.test(value || "")) fail(`${label} must be a SHA-256 hash.`);
}

export function validateReleaseBundleMetadata(input) {
  const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(input?.tag || "")?.[1];
  if (!version) fail("tag must be a semantic version prefixed with v.");
  if (!/^[0-9a-f]{40,64}$/i.test(input.commit || "")) fail("commit must be a full Git commit hash.");
  if (!['preview', 'stable'].includes(input.releaseType)) fail("releaseType must be preview or stable.");
  if (!['passed', 'non-blocking'].includes(input.qg003?.decision)) fail("QG-003 decision must be passed or non-blocking.");
  if (input.qg003.decision === "non-blocking" && (!input.qg003.reason || input.releaseType !== "preview")) {
    fail("A non-blocking QG-003 decision requires a reason and preview releaseType.");
  }

  for (const [name, expectedFlavor] of [["hybrid", "hybrid"], ["rustOnly", "rust-only"]]) {
    const item = input.packages?.[name];
    requireHash(item?.sha256, `${name}.sha256`);
    if (item?.manifest?.version !== version) fail(`${name} package version does not match tag ${input.tag}.`);
    if (item?.manifest?.commit !== input.commit) fail(`${name} package commit does not match release commit.`);
    if (item?.manifest?.runtimeFlavor !== expectedFlavor) fail(`${name} package runtimeFlavor must be ${expectedFlavor}.`);
  }

  requireHash(input.sbom?.sha256, "sbom.sha256");
  if (input.sbom?.format !== "CycloneDX" || input.sbom?.version !== version) {
    fail("CycloneDX SBOM version must match the release tag.");
  }
  requireHash(input.audit?.sha256, "audit.sha256");
  if (Number(input.audit?.vulnerabilities?.total) !== 0
      || Number(input.audit?.vulnerabilities?.high) !== 0
      || Number(input.audit?.vulnerabilities?.critical) !== 0) {
    fail("Dependency audit must report zero vulnerabilities.");
  }

  if (input.rollback?.passed !== true) fail("Upgrade/rollback rehearsal must pass.");
  const stages = new Map((input.rollback.stages || []).map((item) => [item.name, item]));
  for (const name of requiredRollbackStages) {
    if (stages.get(name)?.ready !== true) fail(`Rollback stage ${name} must be ready.`);
  }
  for (const name of ["hybrid", "rustOnly"]) {
    const rollback = input.rollback.archives?.[name];
    const packaged = input.packages[name];
    if (rollback?.commit !== input.commit || rollback?.sha256 !== packaged.sha256) {
      fail(`Rollback ${name} archive does not match the release package.`);
    }
  }

  return {
    version,
    commit: input.commit,
    tag: input.tag,
    releaseType: input.releaseType,
    qg003Decision: input.qg003.decision,
    passed: true
  };
}

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function requiredFile(name) {
  const value = argument(name);
  if (!value) fail(`Missing ${name}.`);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) fail(`${name} file not found: ${resolved}`);
  return resolved;
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function verifyChecksumSidecar(archive, digest) {
  const sidecar = `${archive}.sha256`;
  if (!fs.existsSync(sidecar)) fail(`Checksum sidecar is missing: ${sidecar}`);
  const recorded = fs.readFileSync(sidecar, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
  if (recorded !== digest) fail(`Checksum sidecar does not match ${path.basename(archive)}.`);
}

function packageManifest(archive) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-release-bundle-"));
  try {
    const expanded = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      archive, temp
    ], { encoding: "utf8", windowsHide: true });
    if (expanded.status !== 0) fail(expanded.stderr || expanded.stdout || `Cannot extract ${archive}.`);
    const manifest = path.join(temp, "VibeLink", "release-manifest.json");
    if (!fs.existsSync(manifest)) fail(`Package manifest is missing from ${archive}.`);
    return JSON.parse(fs.readFileSync(manifest, "utf8"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function releaseNotes(manifest) {
  const hybrid = manifest.artifacts.hybrid;
  const rustOnly = manifest.artifacts.rustOnly;
  return `# VibeLink ${manifest.version} Windows Preview\n\n` +
    `Tag: \`${manifest.tag}\`  \nCommit: \`${manifest.commit}\`\n\n` +
    `## Artifacts\n\n` +
    `- \`${hybrid.file}\` SHA-256 \`${hybrid.sha256}\`\n` +
    `- \`${rustOnly.file}\` SHA-256 \`${rustOnly.sha256}\`\n` +
    `- \`${manifest.sbom.file}\` SHA-256 \`${manifest.sbom.sha256}\`\n` +
    `- \`${manifest.dependencyAudit.file}\` SHA-256 \`${manifest.dependencyAudit.sha256}\`\n` +
    `- \`${manifest.rollback.file}\` SHA-256 \`${manifest.rollback.sha256}\`\n\n` +
    `## Verification\n\n` +
    `- Hybrid and Rust-only package manifests match tag \`${manifest.tag}\` and commit \`${manifest.commit}\`.\n` +
    `- Dependency audit reports zero vulnerabilities.\n` +
    `- Upgrade, process rollback, and re-upgrade rehearsal passed.\n` +
    `- QG-003 decision: ${manifest.qualityGates.qg003.decision}. ${manifest.qualityGates.qg003.reason}\n`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const tag = argument("--tag");
  const commit = argument("--commit");
  const releaseType = argument("--release-type", "preview");
  const qg003Decision = argument("--qg003-decision", "non-blocking");
  const qg003Reason = argument("--qg003-reason");
  const hybridPath = requiredFile("--hybrid");
  const rustOnlyPath = requiredFile("--rust-only");
  const sbomPath = requiredFile("--sbom");
  const auditPath = requiredFile("--audit");
  const rollbackPath = requiredFile("--rollback");
  const output = path.resolve(argument("--output", "artifacts/release/release-manifest.json"));
  const notesOutput = path.resolve(argument("--notes-output", "artifacts/release/release-notes.md"));

  const hybridSha = sha256(hybridPath);
  const rustOnlySha = sha256(rustOnlyPath);
  verifyChecksumSidecar(hybridPath, hybridSha);
  verifyChecksumSidecar(rustOnlyPath, rustOnlySha);
  const sbom = JSON.parse(fs.readFileSync(sbomPath, "utf8"));
  const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
  const rollback = JSON.parse(fs.readFileSync(rollbackPath, "utf8"));
  const input = {
    tag,
    commit,
    releaseType,
    qg003: { decision: qg003Decision, reason: qg003Reason },
    packages: {
      hybrid: { sha256: hybridSha, manifest: packageManifest(hybridPath) },
      rustOnly: { sha256: rustOnlySha, manifest: packageManifest(rustOnlyPath) }
    },
    sbom: {
      format: sbom.bomFormat,
      version: sbom.metadata?.component?.version,
      sha256: sha256(sbomPath)
    },
    audit: {
      sha256: sha256(auditPath),
      vulnerabilities: audit.metadata?.vulnerabilities || {}
    },
    rollback
  };
  const verification = validateReleaseBundleMetadata(input);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tag,
    version: verification.version,
    commit,
    releaseType,
    artifacts: {
      hybrid: { file: path.basename(hybridPath), sha256: hybridSha, bytes: fs.statSync(hybridPath).size, embeddedManifest: input.packages.hybrid.manifest },
      rustOnly: { file: path.basename(rustOnlyPath), sha256: rustOnlySha, bytes: fs.statSync(rustOnlyPath).size, embeddedManifest: input.packages.rustOnly.manifest }
    },
    sbom: { file: path.basename(sbomPath), sha256: input.sbom.sha256, format: input.sbom.format },
    dependencyAudit: { file: path.basename(auditPath), sha256: input.audit.sha256, vulnerabilities: input.audit.vulnerabilities },
    rollback: { file: path.basename(rollbackPath), sha256: sha256(rollbackPath), passed: true, stages: rollback.stages },
    qualityGates: { qg003: input.qg003 },
    verification: { passed: true }
  };
  writeJson(output, manifest);
  fs.mkdirSync(path.dirname(notesOutput), { recursive: true });
  fs.writeFileSync(notesOutput, releaseNotes(manifest), "utf8");
  console.log(JSON.stringify({ ok: true, output, notesOutput, ...verification }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
