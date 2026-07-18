import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForBridge(baseUrl, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Bridge exited with ${child.exitCode}.`);
    try {
      if ((await fetch(baseUrl)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Bridge did not start.");
}

test("artifact HTTP contract is authenticated, bounded, redacted, and read-only", { timeout: 60_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-artifact-http-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pairingToken = "ARTIFACT-HTTP-TEST";
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
    host: "127.0.0.1",
    port,
    pairingToken,
    allowLegacyPairingTokenLogin: true
  }), "utf8");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: rootDir,
    env: { ...process.env, VIBELINK_DATA_DIR: dataDir, MOBILE_AGENT_HOST: "127.0.0.1", MOBILE_AGENT_PORT: String(port), MOBILE_AGENT_TOKEN: pairingToken },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForBridge(baseUrl, child);
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingToken, label: "Artifact test" })
    });
    assert.equal(login.status, 200);
    const token = (await login.json()).token;
    const authorization = { Authorization: `Bearer ${token}` };

    const source = "name,note\nAda,token=private-value\n";
    const upload = await fetch(`${baseUrl}/api/attachments`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "text/csv", "X-File-Name": "report.csv" },
      body: source
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.equal(uploaded.mimeType, "text/csv");
    assert.match(uploaded.artifact.metadataUrl, /^\/api\/artifacts\//);

    assert.equal((await fetch(`${baseUrl}${uploaded.artifact.metadataUrl}`)).status, 401);
    const metadataResponse = await fetch(`${baseUrl}${uploaded.artifact.metadataUrl}`, { headers: authorization });
    assert.equal(metadataResponse.status, 200);
    const metadata = (await metadataResponse.json()).artifact;
    assert.equal(metadata.kind, "table");
    assert.equal(metadata.size, Buffer.byteLength(source));
    assert.equal(metadata.capabilities.mutation, false);

    const missingRange = await fetch(`${baseUrl}${uploaded.artifact.contentUrl}`, { headers: authorization });
    assert.equal(missingRange.status, 416);
    assert.equal(missingRange.headers.get("accept-ranges"), "bytes");

    const range = await fetch(`${baseUrl}${uploaded.artifact.contentUrl}`, { headers: { ...authorization, Range: "bytes=0-3" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 0-3/${Buffer.byteLength(source)}`);
    assert.equal(await range.text(), "name");

    const previewResponse = await fetch(`${baseUrl}${uploaded.artifact.previewUrl}`, { headers: authorization });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).preview;
    assert.equal(preview.readonly, true);
    assert.equal(JSON.stringify(preview).includes("private-value"), false);
    assert.equal(preview.redaction.applied, true);

    const mutation = await fetch(`${baseUrl}${uploaded.artifact.metadataUrl}`, { method: "POST", headers: authorization });
    assert.equal(mutation.status, 404);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
