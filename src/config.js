import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const rootDir = path.resolve(__dirname, "..");
export const publicDir = path.join(rootDir, "public");
export const dataDir = path.join(rootDir, ".agent-mobile-terminal");
export const tasksDir = path.join(dataDir, "tasks");
export const attachmentsDir = path.join(dataDir, "attachments");
export const settingsPath = path.join(dataDir, "settings.json");

export const defaultSettings = {
  host: process.env.MOBILE_AGENT_HOST || "0.0.0.0",
  port: Number(process.env.MOBILE_AGENT_PORT || 8787),
  pairingToken: process.env.MOBILE_AGENT_TOKEN || "",
  defaultCwd: process.cwd(),
  claudeCommand: process.env.CLAUDE_COMMAND || "claude",
  codexCommand: process.env.CODEX_COMMAND || "auto",
  codexTemplate: process.env.CODEX_TEMPLATE || "",
  permissionMode: "default",
  allowedRoots: [],
  hostAllowlist: [],
  allowTryCloudflare: false,
  allowLegacyPairingTokenLogin: false,
  notificationEmail: "",
  webPush: {
    publicKey: "",
    privateKey: "",
    subject: ""
  },
  apiKeys: {
    openai: "",
    anthropic: ""
  }
};

export function getHomeDir() {
  return os.homedir();
}

export function getNetworkAddresses(port) {
  const addresses = [];
  const nets = os.networkInterfaces();

  for (const [name, entries] of Object.entries(nets)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      addresses.push({
        name,
        address: entry.address,
        url: `http://${entry.address}:${port}`
      });
    }
  }

  return addresses;
}
