import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const VIRTUAL_IFACE_RE =
  /vEthernet|WSL|Hyper-V|Docker|Default Switch|Loopback|VMware|VirtualBox/i;

function unquoteYaml(raw) {
  const s = String(raw || "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Pure parser for host wproxy/config.ps1 and wproxy/config.yaml.
 * Secrets stay in memory only and must never be emitted by status/health endpoints.
 */
export function parseWproxyConfigFiles(configPs1Text = "", configYamlText = "") {
  const ps1 = String(configPs1Text || "");
  const yaml = String(configYamlText || "");

  let mixedPort = 7897;
  let apiPort = 9097;
  let apiSecret = "";
  let taskName = "WProxy";

  const psMixedMatch = /^\s*\$MixedPort\s*=\s*(\d+)/m.exec(ps1);
  if (psMixedMatch) mixedPort = Number(psMixedMatch[1]);

  const psApiPortMatch = /^\s*\$ApiPort\s*=\s*(\d+)/m.exec(ps1);
  if (psApiPortMatch) apiPort = Number(psApiPortMatch[1]);

  const psSecretMatch = /^\s*\$ApiSecret\s*=\s*['"]([^'"]*)['"]/m.exec(ps1);
  if (psSecretMatch) apiSecret = psSecretMatch[1];

  const psTaskMatch = /^\s*\$TaskName\s*=\s*['"]([^'"]+)['"]/m.exec(ps1);
  if (psTaskMatch) taskName = psTaskMatch[1];

  if (!psMixedMatch) {
    const yamlMixedMatch = /^mixed-port:\s*(\d+)/m.exec(yaml);
    if (yamlMixedMatch) mixedPort = Number(yamlMixedMatch[1]);
  }

  let apiHost = "127.0.0.1";
  const yamlCtrlMatch = /^external-controller:\s*([^\r\n#]+)/m.exec(yaml);
  if (yamlCtrlMatch) {
    const ctrl = unquoteYaml(yamlCtrlMatch[1]);
    const idx = ctrl.lastIndexOf(":");
    if (idx >= 0) {
      const hostPart = ctrl.slice(0, idx).trim();
      const portPart = Number(ctrl.slice(idx + 1).trim());
      if (hostPart && hostPart !== "0.0.0.0" && hostPart !== "::") {
        apiHost = hostPart;
      }
      if (!psApiPortMatch && Number.isFinite(portPart) && portPart > 0) {
        apiPort = portPart;
      }
    }
  }

  if (!apiSecret) {
    const yamlSecretMatch = /^secret:\s*([^\r\n#]+)/m.exec(yaml);
    if (yamlSecretMatch) {
      apiSecret = unquoteYaml(yamlSecretMatch[1]);
    }
  }

  const listeners = [];
  const yamlLines = yaml.split(/\r?\n/);
  let inListeners = false;
  let currentListener = null;
  let inUsers = false;

  for (const rawLine of yamlLines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!inListeners) {
      if (/^listeners:\s*(?:#.*)?$/.test(line)) {
        inListeners = true;
      }
      continue;
    }

    if (/^[a-zA-Z0-9_-]+:/.test(line)) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^\s{2}-\s+/.test(line)) {
      if (currentListener) listeners.push(currentListener);
      currentListener = {
        name: "",
        type: "mixed",
        port: 0,
        listen: "",
        username: "",
        password: "",
      };
      inUsers = false;
      const kv = /^\s{2}-\s+([a-zA-Z0-9_-]+):\s*(.+)$/.exec(line);
      if (kv) {
        const k = kv[1];
        const v = unquoteYaml(kv[2]);
        if (k === "port") currentListener.port = Number(v) || 0;
        else if (k in currentListener) currentListener[k] = v;
      }
      continue;
    }

    if (!currentListener) continue;

    if (/^\s+users:\s*$/.test(line)) {
      inUsers = true;
      continue;
    }

    if (inUsers) {
      const userStart = /^\s+-\s+username:\s*(.+)$/.exec(line);
      if (userStart && !currentListener.username) {
        currentListener.username = unquoteYaml(userStart[1]);
        continue;
      }
      const userKv = /^\s+(username|password):\s*(.+)$/.exec(line);
      if (userKv) {
        if (userKv[1] === "username" && !currentListener.username) {
          currentListener.username = unquoteYaml(userKv[2]);
        } else if (userKv[1] === "password" && !currentListener.password) {
          currentListener.password = unquoteYaml(userKv[2]);
        }
        continue;
      }
      if (/^\s{4}[a-zA-Z0-9_-]+:/.test(line)) {
        inUsers = false;
      }
    }

    const propMatch = /^\s+([a-zA-Z0-9_-]+):\s*(.+)$/.exec(line);
    if (propMatch && !inUsers) {
      const k = propMatch[1];
      const v = unquoteYaml(propMatch[2]);
      if (k === "port") currentListener.port = Number(v) || 0;
      else if (k in currentListener) currentListener[k] = v;
    }
  }
  if (currentListener) listeners.push(currentListener);

  const shareListener =
    listeners.find(
      (l) => l.name === "lan-share" || l.listen === "0.0.0.0" || l.listen === "::",
    ) ?? null;

  return {
    mixedPort,
    apiPort,
    apiBase: `http://${apiHost}:${apiPort}`,
    apiSecret,
    taskName,
    lanShare: shareListener && shareListener.port > 0
      ? {
          enabled: true,
          name: shareListener.name || "lan-share",
          type: shareListener.type || "mixed",
          port: shareListener.port,
          username: shareListener.username || "",
          hasPassword: Boolean(shareListener.password),
          password: shareListener.password || "",
        }
      : null,
  };
}

function isTailscaleIp(ip, ifaceName) {
  if (/tailscale/i.test(String(ifaceName || ""))) return true;
  const parts = String(ip || "").split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/**
 * Discovers non-loopback shareable IPv4 addresses dynamically from os.networkInterfaces().
 */
export function collectShareableHosts(networkInterfaces) {
  const results = [];
  const seen = new Set();

  for (const [iface, addrs] of Object.entries(networkInterfaces || {})) {
    if (!Array.isArray(addrs)) continue;
    if (VIRTUAL_IFACE_RE.test(iface)) continue;

    for (const addr of addrs) {
      if (!addr) continue;
      const isV4 = addr.family === "IPv4" || addr.family === 4;
      if (!isV4 || addr.internal) continue;
      const ip = String(addr.address || "").trim();
      if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
      if (seen.has(ip)) continue;
      seen.add(ip);

      results.push({
        kind: isTailscaleIp(ip, iface) ? "tailscale" : "lan",
        iface,
        ip,
      });
    }
  }

  results.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "lan" ? -1 : 1;
    return a.iface.localeCompare(b.iface);
  });

  return results;
}

function resolveDefaultWproxyDir(pluginDir) {
  const roots = [pluginDir, process.cwd()].filter(Boolean);
  for (const startDir of roots) {
    let cur = path.resolve(startDir);
    for (let i = 0; i < 7; i += 1) {
      const candidate = path.join(cur, "wproxy");
      if (fs.existsSync(path.join(candidate, "config.yaml"))) {
        return candidate;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return "";
}

function readTextIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function resolvePwshExecutable() {
  if (process.platform !== "win32") return "pwsh";
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    "pwsh.exe",
  ];
  for (const c of candidates) {
    if (c.includes("\\") && fs.existsSync(c)) return c;
  }
  return "pwsh.exe";
}

function resolveCurlExecutable() {
  if (process.platform === "win32") {
    const sysCurl = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "curl.exe",
    );
    if (fs.existsSync(sysCurl)) return sysCurl;
    return "curl.exe";
  }
  return "curl";
}

async function readWindowsSysProxy() {
  if (process.platform !== "win32") {
    return { enable: false, server: "" };
  }
  try {
    const { stdout: enOut } = await execFileAsync(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
    );
    const enable = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enOut);
    const { stdout: srvOut } = await execFileAsync(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
    );
    const match = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(srvOut);
    return { enable, server: match?.[1]?.trim() || "" };
  } catch {
    return { enable: false, server: "" };
  }
}

async function checkHysteriaProcess() {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await execFileAsync(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq hysteria.exe", "/NH"],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
    );
    return /hysteria\.exe/i.test(String(stdout || ""));
  } catch {
    return false;
  }
}

export function createPlugin(context = {}) {
  const pluginDir = context.pluginDir || import.meta.dirname || "";

  const loadRuntimeConfig = () => {
    const wproxyDir =
      process.env.VIBELINK_WPROXY_DIR ||
      process.env.WPROXY_DIR ||
      resolveDefaultWproxyDir(pluginDir);

    const ps1Text = wproxyDir ? readTextIfExists(path.join(wproxyDir, "config.ps1")) : "";
    const yamlText = wproxyDir ? readTextIfExists(path.join(wproxyDir, "config.yaml")) : "";
    const parsed = parseWproxyConfigFiles(ps1Text, yamlText);

    const apiBase = (process.env.VIBELINK_WPROXY_API_BASE || parsed.apiBase).replace(/\/+$/, "");
    const apiSecret =
      process.env.VIBELINK_WPROXY_API_SECRET !== undefined
        ? process.env.VIBELINK_WPROXY_API_SECRET
        : parsed.apiSecret;

    return {
      ...parsed,
      wproxyDir,
      apiBase,
      apiSecret,
    };
  };

  const mihomoRequest = async (cfg, method, apiPath, body, timeoutMs = 4000) => {
    const headers = {};
    if (cfg.apiSecret) {
      headers.Authorization = `Bearer ${cfg.apiSecret}`;
    }
    let bodyStr;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(body);
    }
    const res = await fetch(`${cfg.apiBase}${apiPath}`, {
      method,
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      const msg = parsed?.message || text || `HTTP ${res.status}`;
      throw new Error(`Mihomo API (${apiPath}) 失败: ${msg}`);
    }
    return parsed ?? {};
  };

  const health = async () => {
    const cfg = loadRuntimeConfig();
    if (!cfg.wproxyDir && !process.env.VIBELINK_WPROXY_API_BASE) {
      return {
        ok: false,
        status: "not_installed",
        version: "",
        gatewayUrl: `http://127.0.0.1:${cfg.mixedPort}`,
        message: "未检测到宿主机 wproxy 目录",
      };
    }

    try {
      const [ver, conf, proxyGroup] = await Promise.all([
        mihomoRequest(cfg, "GET", "/version", undefined, 2500),
        mihomoRequest(cfg, "GET", "/configs", undefined, 2500),
        mihomoRequest(cfg, "GET", "/proxies/PROXY", undefined, 2500).catch(() => null),
      ]);
      const version = String(ver?.version || "");
      const activeNode = String(proxyGroup?.now || "-");
      const routeMode = String(conf?.mode || "rule");
      return {
        ok: true,
        status: "running",
        version,
        gatewayUrl: `http://127.0.0.1:${cfg.mixedPort}`,
        configDir: cfg.wproxyDir || undefined,
        message: `Mihomo ${version} · 节点 ${activeNode} (${routeMode})`.trim(),
        details: {
          activeNode,
          routeMode,
          mixedPort: cfg.mixedPort,
          apiPort: cfg.apiPort,
          lanSharePort: cfg.lanShare?.port ?? null,
        },
      };
    } catch {
      return {
        ok: false,
        status: "installed_idle",
        version: "",
        gatewayUrl: `http://127.0.0.1:${cfg.mixedPort}`,
        configDir: cfg.wproxyDir || undefined,
        message: "WProxy 已安装但内核 API 未响应",
      };
    }
  };

  const buildStatus = async () => {
    const cfg = loadRuntimeConfig();
    const [ver, conf, proxiesResp, connResp, sysProxy, hysteriaRunning] = await Promise.all([
      mihomoRequest(cfg, "GET", "/version", undefined, 3000),
      mihomoRequest(cfg, "GET", "/configs", undefined, 3000),
      mihomoRequest(cfg, "GET", "/proxies", undefined, 3000),
      mihomoRequest(cfg, "GET", "/connections", undefined, 3000).catch(() => ({
        connections: [],
        uploadTotal: 0,
        downloadTotal: 0,
      })),
      readWindowsSysProxy(),
      checkHysteriaProcess(),
    ]);

    const proxiesMap = proxiesResp?.proxies && typeof proxiesResp.proxies === "object"
      ? proxiesResp.proxies
      : {};
    const groupInfo = proxiesMap.PROXY ?? null;
    const allNames = Array.isArray(groupInfo?.all) ? groupInfo.all : [];
    const nodes = allNames.map((nodeName) => {
      const item = proxiesMap[nodeName] || {};
      const history = Array.isArray(item.history) ? item.history : [];
      const last = history.length > 0 ? history[history.length - 1] : null;
      const delayVal = typeof last?.delay === "number" && last.delay > 0 ? last.delay : null;
      return {
        name: String(nodeName),
        type: String(item.type || "Unknown"),
        alive: item.alive !== false,
        delay: delayVal,
      };
    });

    const hosts = collectShareableHosts(os.networkInterfaces());
    const lanSharePort = cfg.lanShare?.port ?? 7898;
    const lanShareEnabled = Boolean(cfg.lanShare?.enabled);

    return {
      ok: true,
      running: true,
      version: String(ver?.version || ""),
      routeMode: String(conf?.mode || "rule"),
      tunEnabled: Boolean(conf?.tun?.enable),
      sysProxy,
      hysteriaRunning,
      activeGroup: "PROXY",
      activeNode: String(groupInfo?.now || ""),
      nodes,
      connections: {
        count: Array.isArray(connResp?.connections) ? connResp.connections.length : 0,
        uploadTotal: Number(connResp?.uploadTotal ?? 0),
        downloadTotal: Number(connResp?.downloadTotal ?? 0),
      },
      localProxy: {
        host: "127.0.0.1",
        port: Number(conf?.["mixed-port"] || cfg.mixedPort),
      },
      lanShare: {
        enabled: lanShareEnabled,
        port: lanSharePort,
        type: cfg.lanShare?.type || "mixed",
        username: cfg.lanShare?.username || "",
        authRequired: Boolean(cfg.lanShare?.hasPassword),
        endpoints: hosts.map((h) => ({
          kind: h.kind,
          iface: h.iface,
          ip: h.ip,
          address: `${h.ip}:${lanSharePort}`,
        })),
      },
      wproxyDir: cfg.wproxyDir,
      updatedAt: Date.now(),
    };
  };

  const invokeAction = async (action, payload = {}) => {
    const cfg = loadRuntimeConfig();

    switch (action) {
      case "status":
        return buildStatus();

      case "selectNode": {
        const group = String(payload.group || "PROXY");
        const node = String(payload.node || "").trim();
        if (!node) {
          throw new Error("Node name is required");
        }
        const groupInfo = await mihomoRequest(
          cfg,
          "GET",
          `/proxies/${encodeURIComponent(group)}`,
        );
        const allowed = Array.isArray(groupInfo?.all) ? groupInfo.all : [];
        if (!allowed.includes(node)) {
          throw new Error(`Invalid node '${node}' for group '${group}'`);
        }
        await mihomoRequest(cfg, "PUT", `/proxies/${encodeURIComponent(group)}`, { name: node });
        try {
          await mihomoRequest(cfg, "DELETE", "/connections");
        } catch {
          // best-effort connection flush
        }
        return {
          ok: true,
          group,
          node,
          status: await buildStatus(),
        };
      }

      case "testDelay": {
        const group = String(payload.group || "PROXY");
        const timeoutMs = Math.max(1000, Math.min(Number(payload.timeoutMs) || 5000, 15000));
        const probeUrl = "https://www.google.com/generate_204";

        let targets = [];
        if (typeof payload.node === "string" && payload.node.trim()) {
          targets = [payload.node.trim()];
        } else {
          const groupInfo = await mihomoRequest(
            cfg,
            "GET",
            `/proxies/${encodeURIComponent(group)}`,
          );
          const all = Array.isArray(groupInfo?.all) ? groupInfo.all : [];
          targets = all.filter((n) => n !== "DIRECT" && n !== "REJECT");
        }

        const delays = {};
        let cursor = 0;
        const worker = async () => {
          while (cursor < targets.length) {
            const name = targets[cursor];
            cursor += 1;
            try {
              const q = `url=${encodeURIComponent(probeUrl)}&timeout=${timeoutMs}`;
              const r = await mihomoRequest(
                cfg,
                "GET",
                `/proxies/${encodeURIComponent(name)}/delay?${q}`,
                undefined,
                timeoutMs + 1500,
              );
              delays[name] = typeof r?.delay === "number" ? r.delay : null;
            } catch {
              delays[name] = null;
            }
          }
        };

        const workerCount = Math.min(4, Math.max(1, targets.length));
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        return {
          ok: true,
          delays,
          probeUrl,
          testedAt: Date.now(),
        };
      }

      case "setRouteMode": {
        const mode = String(payload.mode || "").trim().toLowerCase();
        if (mode !== "rule" && mode !== "global" && mode !== "direct") {
          throw new Error(`Invalid route mode: ${mode}`);
        }
        if (mode === "global") {
          try {
            const globalInfo = await mihomoRequest(cfg, "GET", "/proxies/GLOBAL");
            const all = Array.isArray(globalInfo?.all) ? globalInfo.all : [];
            if (all.includes("PROXY") && globalInfo?.now !== "PROXY") {
              await mihomoRequest(cfg, "PUT", "/proxies/GLOBAL", { name: "PROXY" });
            }
          } catch {
            // ignore if GLOBAL selector is unavailable
          }
        }
        await mihomoRequest(cfg, "PATCH", "/configs", { mode });
        try {
          await mihomoRequest(cfg, "DELETE", "/connections");
        } catch {
          // best-effort connection flush
        }
        return {
          ok: true,
          mode,
          status: await buildStatus(),
        };
      }

      case "setSystemProxy": {
        if (!cfg.wproxyDir || !fs.existsSync(path.join(cfg.wproxyDir, "wproxy.ps1"))) {
          throw new Error("wproxy.ps1 not found");
        }
        const enabled = Boolean(payload.enabled);
        const modeVal = enabled ? "sysproxy" : "off";
        const { stdout, stderr } = await execFileAsync(
          resolvePwshExecutable(),
          [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(cfg.wproxyDir, "wproxy.ps1"),
            "-Action",
            "mode",
            "-Value",
            modeVal,
          ],
          { encoding: "utf8", timeout: 15000, windowsHide: true },
        );
        return {
          ok: true,
          enabled,
          output: `${stdout || ""}\n${stderr || ""}`.trim(),
          status: await buildStatus(),
        };
      }

      case "healHysteria": {
        const scriptPath = cfg.wproxyDir ? path.join(cfg.wproxyDir, "heal-hysteria.ps1") : "";
        if (!scriptPath || !fs.existsSync(scriptPath)) {
          throw new Error("heal-hysteria.ps1 not found");
        }
        const { stdout, stderr } = await execFileAsync(
          resolvePwshExecutable(),
          [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
            "-Reason",
            "vibelink",
            "-Force",
          ],
          { encoding: "utf8", timeout: 15000, windowsHide: true },
        );
        return {
          ok: true,
          output: `${stdout || ""}\n${stderr || ""}`.trim() || "已触发 HY2 自愈重启，看门狗将在数秒内拉起新进程。",
        };
      }

      case "probeEgress": {
        const started = Date.now();
        const { stdout } = await execFileAsync(
          resolveCurlExecutable(),
          [
            "-sS",
            "--max-time",
            "12",
            "-x",
            `http://127.0.0.1:${cfg.mixedPort}`,
            "https://api.ipify.org",
          ],
          { encoding: "utf8", timeout: 14000, windowsHide: true },
        );
        return {
          ok: true,
          ip: String(stdout || "").trim(),
          latencyMs: Date.now() - started,
        };
      }

      case "reloadConfig": {
        if (!cfg.wproxyDir || !fs.existsSync(path.join(cfg.wproxyDir, "config.yaml"))) {
          throw new Error("wproxy/config.yaml not found");
        }
        await mihomoRequest(cfg, "PUT", "/configs?force=true", {
          path: path.join(cfg.wproxyDir, "config.yaml"),
        });
        return {
          ok: true,
          message: "配置已热重载",
        };
      }

      case "getLanShareUri": {
        if (!cfg.lanShare?.enabled || !cfg.lanShare.port) {
          throw new Error("LAN share listener is not enabled in wproxy/config.yaml");
        }
        const scheme = String(payload.scheme || "http").trim().toLowerCase();
        if (scheme !== "http" && scheme !== "socks5") {
          throw new Error(`Invalid proxy scheme: ${scheme}`);
        }
        const hosts = collectShareableHosts(os.networkInterfaces());
        const host = String(payload.host || "").trim();
        if (!hosts.some((h) => h.ip === host)) {
          throw new Error(`Invalid or non-host IP: ${host}`);
        }
        const authPart = cfg.lanShare.username
          ? `${encodeURIComponent(cfg.lanShare.username)}:${encodeURIComponent(cfg.lanShare.password || "")}@`
          : "";
        return {
          ok: true,
          uri: `${scheme}://${authPart}${host}:${cfg.lanShare.port}`,
          host,
          port: cfg.lanShare.port,
          scheme,
          username: cfg.lanShare.username,
          authRequired: Boolean(cfg.lanShare.hasPassword),
        };
      }

      default:
        throw new Error(`Unsupported wproxy action: ${action}`);
    }
  };

  const getWatchPaths = () => {
    const wproxyDir =
      process.env.VIBELINK_WPROXY_DIR ||
      process.env.WPROXY_DIR ||
      resolveDefaultWproxyDir(pluginDir);
    if (!wproxyDir) return [];
    const cfgFile = path.join(wproxyDir, "config.yaml");
    return fs.existsSync(cfgFile) ? [cfgFile] : [];
  };

  return {
    health,
    invokeAction,
    getWatchPaths,
  };
}
