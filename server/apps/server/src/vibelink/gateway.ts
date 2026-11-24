// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  classifyGiftModelPool,
  GIFT_GPT_MODEL,
  isModelAllowedByList,
  isProhibitedShareModel,
  sanitizeMagpieGiftAllowedModels,
  type VibeLinkAccountStore,
  type VlMagpieBridgeConfig,
  type VlPublicUser,
} from "./accounts.ts";

export interface GatewayHttpResult {
  readonly status: number;
  readonly json?: unknown;
  readonly rawText?: {
    readonly body: string;
    readonly contentType: string;
  };
}

export interface VlMagpieRuntimeAdapter {
  readonly getPluginMagpieInfo?: () => {
    readonly pluginEnabled: boolean;
    readonly gatewayUrl?: string;
    readonly version?: string;
    readonly status?: string;
    readonly cachedModels?: ReadonlyArray<{
      readonly id: string;
      readonly ownedBy?: string;
      readonly displayName?: string;
    }>;
  } | null;
}

export interface VlMagpieBridgeStatus {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly source: "builtin_plugin" | "local_gateway" | "url_override" | "disabled";
  readonly pluginEnabled: boolean | null;
  readonly version: string;
  readonly gatewayUrl: string;
  readonly modelsCount: number;
  readonly totalLocalModels?: number;
  readonly sampleModels: string[];
  readonly protocols: string[];
  readonly message: string;
}

export interface VlGatewayModelItem {
  readonly id: string;
  readonly ownedBy: string;
  readonly displayName?: string;
  readonly created?: number;
}

const MAGPIE_PROTOCOLS = [
  "/v1/models",
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/responses",
  "/v1/messages",
];

const MAGPIE_MODEL_CACHE_TTL_MS = 15_000;
const magpieModelCache = new Map<
  string,
  { readonly fetchedAt: number; readonly ok: boolean; readonly models: VlGatewayModelItem[] }
>();

export function invalidateMagpieModelCache(): void {
  magpieModelCache.clear();
}

function normalizeHeaders(
  headers: Record<string, string | ReadonlyArray<string> | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (typeof v === "string") {
      out[lower] = v;
    } else if (Array.isArray(v) && typeof v[0] === "string") {
      out[lower] = v[0];
    }
  }
  return out;
}

function extractGatewayClientKey(headers: Record<string, string>): string | null {
  const auth = headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m?.[1]) return m[1].trim();
  const xKey = headers["x-api-key"] ?? "";
  return xKey.trim() || null;
}

function readLocalMagpieGatewayJsonUrl(): string {
  if (process.env.MAGPIE_ADDR?.trim()) {
    const raw = process.env.MAGPIE_ADDR.trim().replace(/\/+$/, "");
    return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  }
  const configDir =
    process.env.MAGPIE_CONFIG_DIR?.trim() ||
    process.env.MAGPIE_HOME?.trim() ||
    NodePath.join(NodeOS.homedir(), ".config", "magpie");
  const gwPath = NodePath.join(configDir, "gateway.json");
  try {
    if (NodeFS.existsSync(gwPath)) {
      const parsed = JSON.parse(NodeFS.readFileSync(gwPath, "utf8")) as { addr?: string };
      if (typeof parsed?.addr === "string" && parsed.addr.trim()) {
        const addr = parsed.addr.trim().replace(/\/+$/, "");
        return /^https?:\/\//i.test(addr) ? addr : `http://${addr}`;
      }
    }
  } catch {
    // ignore malformed gateway.json
  }
  return "http://127.0.0.1:3425";
}

function resolveLocalMagpieEndpoint(
  config: VlMagpieBridgeConfig,
  adapter?: VlMagpieRuntimeAdapter,
): {
  readonly active: boolean;
  readonly source: "builtin_plugin" | "local_gateway" | "url_override" | "disabled";
  readonly pluginEnabled: boolean | null;
  readonly version: string;
  readonly gatewayUrl: string;
  readonly gatewayKey: string;
  readonly cachedModels: ReadonlyArray<{
    readonly id: string;
    readonly ownedBy?: string;
    readonly displayName?: string;
  }>;
  readonly runningHint: boolean;
  readonly reason?: string;
} {
  const gatewayKey = process.env.MAGPIE_GATEWAY_KEY?.trim() || "";
  const pluginInfo = adapter?.getPluginMagpieInfo?.() ?? null;

  if (!config.enabled) {
    return {
      active: false,
      source: "disabled",
      pluginEnabled: pluginInfo ? pluginInfo.pluginEnabled : null,
      version: pluginInfo?.version ?? "",
      gatewayUrl: config.urlOverride || pluginInfo?.gatewayUrl || readLocalMagpieGatewayJsonUrl(),
      gatewayKey,
      cachedModels: pluginInfo?.cachedModels ?? [],
      runningHint: false,
      reason: "管理员已关闭 Magpie 默认网关桥接",
    };
  }

  if (process.env.VIBELINK_DISABLE_MAGPIE_BRIDGE === "1" && !config.urlOverride) {
    return {
      active: false,
      source: "disabled",
      pluginEnabled: pluginInfo ? pluginInfo.pluginEnabled : null,
      version: pluginInfo?.version ?? "",
      gatewayUrl: "",
      gatewayKey,
      cachedModels: [],
      runningHint: false,
      reason: "Magpie 桥接已被环境变量禁用",
    };
  }

  if (config.urlOverride) {
    return {
      active: true,
      source: "url_override",
      pluginEnabled: pluginInfo ? pluginInfo.pluginEnabled : null,
      version: pluginInfo?.version ?? "",
      gatewayUrl: config.urlOverride,
      gatewayKey,
      cachedModels: [],
      runningHint: false,
    };
  }

  if (pluginInfo) {
    const gatewayUrl = (pluginInfo.gatewayUrl || readLocalMagpieGatewayJsonUrl()).replace(/\/+$/, "");
    if (!pluginInfo.pluginEnabled) {
      return {
        active: false,
        source: "disabled",
        pluginEnabled: false,
        version: pluginInfo.version ?? "",
        gatewayUrl,
        gatewayKey,
        cachedModels: [],
        runningHint: false,
        reason: "内置 Magpie 插件已停用",
      };
    }
    return {
      active: true,
      source: "builtin_plugin",
      pluginEnabled: true,
      version: pluginInfo.version ?? "",
      gatewayUrl,
      gatewayKey,
      cachedModels: pluginInfo.cachedModels ?? [],
      runningHint: pluginInfo.status === "running",
    };
  }

  return {
    active: true,
    source: "local_gateway",
    pluginEnabled: null,
    version: "",
    gatewayUrl: readLocalMagpieGatewayJsonUrl().replace(/\/+$/, ""),
    gatewayKey,
    cachedModels: [],
    runningHint: false,
  };
}

async function fetchMagpieModelsCached(
  gatewayUrl: string,
  gatewayKey: string,
  options: {
    readonly forceRefresh?: boolean;
    readonly fallbackRunning?: boolean;
    readonly fallbackModels?: ReadonlyArray<{
      readonly id: string;
      readonly ownedBy?: string;
      readonly displayName?: string;
    }>;
  } = {},
): Promise<{ readonly ok: boolean; readonly models: VlGatewayModelItem[] }> {
  const cleanUrl = gatewayUrl.replace(/\/+$/, "");
  if (!cleanUrl) return { ok: false, models: [] };

  const now = Date.now();
  const cached = magpieModelCache.get(cleanUrl);
  if (!options.forceRefresh && cached && now - cached.fetchedAt < MAGPIE_MODEL_CACHE_TTL_MS) {
    return { ok: cached.ok, models: cached.models };
  }

  try {
    const headers: Record<string, string> = {};
    if (gatewayKey) {
      headers.Authorization = `Bearer ${gatewayKey}`;
    }
    const resp = await fetch(`${cleanUrl}/v1/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(2500),
    });
    if (resp.ok) {
      const payload = (await resp.json()) as {
        data?: Array<{ id?: string; owned_by?: string; display_name?: string; created?: number }>;
      };
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const models: VlGatewayModelItem[] = [];
      for (const item of rows) {
        const id = typeof item?.id === "string" ? item.id.trim() : "";
        if (!id) continue;
        const ownedBy =
          typeof item.owned_by === "string" && item.owned_by.trim()
            ? item.owned_by.trim()
            : id.includes("/")
              ? id.split("/")[0] || "magpie"
              : "magpie";
        models.push({
          id,
          ownedBy,
          ...(typeof item.display_name === "string" && item.display_name.trim()
            ? { displayName: item.display_name.trim() }
            : {}),
          ...(typeof item.created === "number" ? { created: item.created } : {}),
        });
      }
      magpieModelCache.set(cleanUrl, { fetchedAt: now, ok: true, models });
      return { ok: true, models };
    }
  } catch {
    // fallback handled below
  }

  if (options.fallbackRunning && options.fallbackModels && options.fallbackModels.length > 0) {
    const models: VlGatewayModelItem[] = options.fallbackModels
      .map((m) => ({
        id: m.id,
        ownedBy: m.ownedBy || (m.id.includes("/") ? m.id.split("/")[0] || "magpie" : "magpie"),
        ...(m.displayName ? { displayName: m.displayName } : {}),
      }))
      .filter((m) => Boolean(m.id));
    return { ok: true, models };
  }

  magpieModelCache.set(cleanUrl, { fetchedAt: now, ok: false, models: [] });
  return { ok: false, models: [] };
}

export async function inspectMagpieBridge(
  accounts: VibeLinkAccountStore,
  adapter?: VlMagpieRuntimeAdapter,
  options: { readonly forceRefresh?: boolean } = {},
): Promise<{
  readonly config: VlMagpieBridgeConfig;
  readonly status: VlMagpieBridgeStatus;
  readonly models: VlGatewayModelItem[];
}> {
  const config = accounts.getMagpieBridgeConfig();
  const endpoint = resolveLocalMagpieEndpoint(config, adapter);

  if (!endpoint.active) {
    return {
      config,
      models: [],
      status: {
        enabled: config.enabled,
        running: false,
        source: endpoint.source,
        pluginEnabled: endpoint.pluginEnabled,
        version: endpoint.version,
        gatewayUrl: endpoint.gatewayUrl,
        modelsCount: 0,
        sampleModels: [],
        protocols: [...MAGPIE_PROTOCOLS],
        message: endpoint.reason || "Magpie 网关桥接未启用",
      },
    };
  }

  const fetched = await fetchMagpieModelsCached(endpoint.gatewayUrl, endpoint.gatewayKey, {
    ...(options.forceRefresh !== undefined ? { forceRefresh: options.forceRefresh } : {}),
    fallbackRunning: endpoint.runningHint,
    fallbackModels: endpoint.cachedModels,
  });

  const allowedSet = new Set(sanitizeMagpieGiftAllowedModels(config.allowedModels));
  const exposedModels = fetched.models.filter(
    (m) => !isProhibitedShareModel(m.id) && allowedSet.has(m.id),
  );

  const running = fetched.ok;
  const sourceLabel =
    endpoint.source === "url_override"
      ? "手动覆盖地址"
      : endpoint.source === "builtin_plugin"
        ? "内置 Magpie 插件"
        : "本机 Magpie 网关";
  const versionTag = endpoint.version ? ` v${endpoint.version}` : "";
  const message = running
    ? `${sourceLabel}${versionTag} 在线 (${endpoint.gatewayUrl}) · 合规锁定 ${exposedModels.length} 个赠送渠道 (${exposedModels.map((m) => m.id).join(", ") || "无"})，本地 ${fetched.models.length} 个中已拦截 Claude/Gemini`
    : `${sourceLabel} 未连通 (${endpoint.gatewayUrl})`;

  return {
    config,
    models: exposedModels,
    status: {
      enabled: config.enabled,
      running,
      source: endpoint.source,
      pluginEnabled: endpoint.pluginEnabled,
      version: endpoint.version,
      gatewayUrl: endpoint.gatewayUrl,
      modelsCount: exposedModels.length,
      totalLocalModels: fetched.models.length,
      sampleModels: exposedModels.map((m) => m.id),
      protocols: [...MAGPIE_PROTOCOLS],
      message,
    },
  };
}

function sortGatewayModels(models: VlGatewayModelItem[]): VlGatewayModelItem[] {
  return [...models].sort((a, b) => {
    const aGroup = a.id.startsWith("auto/") || a.id.startsWith("group/");
    const bGroup = b.id.startsWith("auto/") || b.id.startsWith("group/");
    if (aGroup !== bGroup) return aGroup ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export async function listMergedAvailableModels(
  accounts: VibeLinkAccountStore,
  adapter?: VlMagpieRuntimeAdapter,
  keyAllowedModels?: ReadonlyArray<string>,
  user?: VlPublicUser,
): Promise<VlGatewayModelItem[]> {
  const byId = new Map<string, VlGatewayModelItem>();

  for (const id of accounts.listAvailableModels(keyAllowedModels)) {
    if (isProhibitedShareModel(id)) continue;
    if (user && classifyGiftModelPool(id) === "gpt" && user.gptBalance <= 0) continue;
    byId.set(id, { id, ownedBy: "vibelink-gateway" });
  }

  const config = accounts.getMagpieBridgeConfig();
  const approvedMagpieModels = new Set(sanitizeMagpieGiftAllowedModels(config.allowedModels));
  const endpoint = resolveLocalMagpieEndpoint(config, adapter);
  if (endpoint.active) {
    const fetched = await fetchMagpieModelsCached(endpoint.gatewayUrl, endpoint.gatewayKey, {
      fallbackRunning: endpoint.runningHint,
      fallbackModels: endpoint.cachedModels,
    });
    if (fetched.ok) {
      for (const m of fetched.models) {
        if (isProhibitedShareModel(m.id)) continue;
        if (!approvedMagpieModels.has(m.id)) continue;
        if (!isModelAllowedByList(keyAllowedModels, m.id)) continue;
        if (user && m.id === GIFT_GPT_MODEL && user.gptBalance <= 0) continue;
        if (!byId.has(m.id)) {
          byId.set(m.id, m);
        } else {
          const existing = byId.get(m.id)!;
          if (existing.ownedBy === "vibelink-gateway" && m.ownedBy) {
            byId.set(m.id, m);
          }
        }
      }
    }
  }

  return sortGatewayModels(Array.from(byId.values()));
}

function gatewayError(
  status: number,
  cleanSubPath: string,
  message: string,
  type: string,
  code?: string,
): GatewayHttpResult {
  if (cleanSubPath === "/messages") {
    return {
      status,
      json: {
        type: "error",
        error: {
          type,
          message,
        },
      },
    };
  }
  return {
    status,
    json: {
      error: {
        message,
        type,
        ...(code ? { code } : {}),
      },
    },
  };
}

function estimateTokensFromText(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function extractTextFromJsonResponse(parsedJson: Record<string, unknown>, cleanSubPath: string): string {
  if (cleanSubPath === "/responses") {
    if (typeof parsedJson.output_text === "string" && parsedJson.output_text.trim()) {
      return parsedJson.output_text;
    }
    if (Array.isArray(parsedJson.output)) {
      const chunks: string[] = [];
      for (const item of parsedJson.output) {
        if (!item || typeof item !== "object") continue;
        const content = (item as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
              chunks.push((part as { text: string }).text);
            }
          }
        }
      }
      return chunks.join("");
    }
    return "";
  }

  if (cleanSubPath === "/messages") {
    if (Array.isArray(parsedJson.content)) {
      const chunks: string[] = [];
      for (const part of parsedJson.content) {
        if (!part || typeof part !== "object") continue;
        const text = (part as { text?: unknown }).text;
        const thinking = (part as { thinking?: unknown }).thinking;
        if (typeof text === "string") chunks.push(text);
        if (typeof thinking === "string") chunks.push(thinking);
      }
      return chunks.join("");
    }
    return "";
  }

  const choices = Array.isArray(parsedJson.choices) ? parsedJson.choices : [];
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | undefined;
  if (typeof first?.message?.content === "string") return first.message.content;
  if (typeof first?.text === "string") return first.text;
  return "";
}

function extractUsageFromJsonResponse(
  parsedJson: Record<string, unknown>,
  cleanSubPath: string,
  promptFallback: number,
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const usage =
    typeof parsedJson.usage === "object" && parsedJson.usage !== null
      ? (parsedJson.usage as Record<string, unknown>)
      : null;

  if (cleanSubPath === "/messages") {
    const input = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
    const cacheCreate =
      typeof usage?.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
    const cacheRead =
      typeof usage?.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
    const output = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
    const combinedInput = input + cacheCreate + cacheRead;
    const promptTokens = combinedInput > 0 ? combinedInput : promptFallback;
    const completionTokens =
      output > 0
        ? output
        : estimateTokensFromText(extractTextFromJsonResponse(parsedJson, cleanSubPath));
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  if (cleanSubPath === "/responses") {
    const input = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
    const output = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
    const total = typeof usage?.total_tokens === "number" ? usage.total_tokens : 0;
    const promptTokens = input > 0 ? input : promptFallback;
    const completionTokens =
      output > 0
        ? output
        : estimateTokensFromText(extractTextFromJsonResponse(parsedJson, cleanSubPath));
    return {
      promptTokens,
      completionTokens,
      totalTokens: total > 0 ? total : promptTokens + completionTokens,
    };
  }

  const promptTokens =
    typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : promptFallback;
  const completionTokens =
    typeof usage?.completion_tokens === "number"
      ? usage.completion_tokens
      : estimateTokensFromText(extractTextFromJsonResponse(parsedJson, cleanSubPath));
  const totalTokens =
    typeof usage?.total_tokens === "number"
      ? usage.total_tokens
      : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function parseSseUsageAndText(sseText: string): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contentChars: number;
} {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let contentChars = 0;

  for (const line of sseText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as {
        type?: string;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        message?: {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
        response?: {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
          };
        };
        delta?: string | { content?: string; reasoning_content?: string; text?: string; thinking?: string };
        choices?: Array<{
          delta?: { content?: string; reasoning_content?: string };
          text?: string;
        }>;
      };

      // OpenAI chat/completions & completions & top-level usage
      if (obj.usage) {
        if (typeof obj.usage.prompt_tokens === "number") {
          promptTokens = obj.usage.prompt_tokens;
        }
        if (typeof obj.usage.completion_tokens === "number") {
          completionTokens = obj.usage.completion_tokens;
        }
        if (typeof obj.usage.total_tokens === "number") {
          totalTokens = obj.usage.total_tokens;
        }
        if (typeof obj.usage.input_tokens === "number") {
          const cached =
            (obj.usage.cache_creation_input_tokens ?? 0) +
            (obj.usage.cache_read_input_tokens ?? 0);
          promptTokens = Math.max(promptTokens, obj.usage.input_tokens + cached);
        }
        if (typeof obj.usage.output_tokens === "number") {
          completionTokens = Math.max(completionTokens, obj.usage.output_tokens);
        }
      }

      // OpenAI Responses API SSE (response.completed)
      if (obj.response?.usage) {
        if (typeof obj.response.usage.input_tokens === "number") {
          promptTokens = Math.max(promptTokens, obj.response.usage.input_tokens);
        }
        if (typeof obj.response.usage.output_tokens === "number") {
          completionTokens = Math.max(completionTokens, obj.response.usage.output_tokens);
        }
        if (typeof obj.response.usage.total_tokens === "number") {
          totalTokens = Math.max(totalTokens, obj.response.usage.total_tokens);
        }
      }

      // Anthropic Messages API SSE (message_start)
      if (obj.message?.usage) {
        const mu = obj.message.usage;
        const msgInput =
          (mu.input_tokens ?? 0) +
          (mu.cache_creation_input_tokens ?? 0) +
          (mu.cache_read_input_tokens ?? 0);
        if (msgInput > 0) promptTokens = Math.max(promptTokens, msgInput);
        if (typeof mu.output_tokens === "number" && mu.output_tokens > 0) {
          completionTokens = Math.max(completionTokens, mu.output_tokens);
        }
      }

      // Content text counters for fallback estimation
      const choiceDelta = obj.choices?.[0]?.delta;
      if (typeof choiceDelta?.content === "string") contentChars += choiceDelta.content.length;
      if (typeof choiceDelta?.reasoning_content === "string") {
        contentChars += choiceDelta.reasoning_content.length;
      }
      if (typeof obj.choices?.[0]?.text === "string") {
        contentChars += obj.choices[0].text.length;
      }
      if (typeof obj.delta === "string") {
        contentChars += obj.delta.length;
      } else if (obj.delta && typeof obj.delta === "object") {
        if (typeof obj.delta.text === "string") contentChars += obj.delta.text.length;
        if (typeof obj.delta.thinking === "string") contentChars += obj.delta.thinking.length;
        if (typeof obj.delta.content === "string") contentChars += obj.delta.content.length;
      }
    } catch {
      // ignore malformed SSE chunk
    }
  }

  return { promptTokens, completionTokens, totalTokens, contentChars };
}

export async function handleOpenAiGatewayRequest(
  accounts: VibeLinkAccountStore,
  input: {
    readonly method: string;
    readonly subPath: string;
    readonly headers: Record<string, string | ReadonlyArray<string> | undefined>;
    readonly bodyText?: string;
  },
  adapter?: VlMagpieRuntimeAdapter,
): Promise<GatewayHttpResult> {
  const headers = normalizeHeaders(input.headers);
  const cleanSubPath = input.subPath.replace(/\/+$/, "") || "/";
  const method = input.method.toUpperCase();

  const rawKey = extractGatewayClientKey(headers);
  if (!rawKey) {
    return gatewayError(
      401,
      cleanSubPath,
      "Missing VibeLink API Key (Authorization: Bearer sk-vl-... or x-api-key)",
      "invalid_request_error",
      "missing_api_key",
    );
  }

  const resolved = accounts.resolveGatewayApiKey(rawKey);
  if (!resolved) {
    return gatewayError(
      401,
      cleanSubPath,
      "Invalid or revoked VibeLink API Key",
      "invalid_request_error",
      "invalid_api_key",
    );
  }

  if (method === "GET" && cleanSubPath === "/models") {
    const models = await listMergedAvailableModels(
      accounts,
      adapter,
      resolved.allowedModels,
      resolved.user,
    );
    return {
      status: 200,
      json: {
        object: "list",
        data: models.map((m) => ({
          id: m.id,
          object: "model",
          created: m.created ?? Math.floor(Date.now() / 1000),
          owned_by: m.ownedBy || "vibelink-gateway",
          ...(m.displayName ? { display_name: m.displayName } : {}),
        })),
      },
    };
  }

  const isSupportedPostPath =
    cleanSubPath === "/chat/completions" ||
    cleanSubPath === "/completions" ||
    cleanSubPath === "/responses" ||
    cleanSubPath === "/messages";

  if (method !== "POST" || !isSupportedPostPath) {
    return gatewayError(
      404,
      cleanSubPath,
      `Unsupported gateway endpoint: ${method} /v1${cleanSubPath}`,
      "invalid_request_error",
    );
  }

  let bodyObj: Record<string, unknown>;
  try {
    bodyObj = JSON.parse(input.bodyText || "{}") as Record<string, unknown>;
  } catch {
    return gatewayError(400, cleanSubPath, "Invalid JSON body", "invalid_request_error");
  }

  const rawModel = typeof bodyObj.model === "string" ? bodyObj.model.trim() : "";
  if (!rawModel) {
    return gatewayError(400, cleanSubPath, "Field 'model' is required", "invalid_request_error");
  }

  // Strict Compliance Hard-Block: NEVER proxy Claude / Anthropic / Gemini / Google / Antigravity
  if (isProhibitedShareModel(rawModel)) {
    return gatewayError(
      403,
      cleanSubPath,
      "合规策略禁止通过服务端 Magpie 网关反代 Claude 或 Gemini 渠道；免费额度仅限 auto/deepseek-v4.1-flash（每日 10M），自有 Claude/Gemini Key 请在客户端本地直连",
      "permission_error",
      "model_prohibited_by_policy",
    );
  }

  if (!isModelAllowedByList(resolved.allowedModels, rawModel)) {
    return gatewayError(
      403,
      cleanSubPath,
      `Model '${rawModel}' is not allowed for this API Key`,
      "permission_error",
    );
  }

  // Priority 1: Manual override upstreams configured by Admin
  const manualUpstream = accounts.pickUpstreamForModel(rawModel);

  let targetBaseUrl = "";
  let targetUpstreamId = "";
  let targetRateMultiplier = 1;
  let targetKind: "manual" | "magpie" = "manual";
  let upstreamApiKey = "";
  let cleanForwardModel = rawModel;

  if (manualUpstream) {
    targetKind = "manual";
    targetBaseUrl = manualUpstream.baseUrl;
    targetUpstreamId = manualUpstream.id;
    targetRateMultiplier = manualUpstream.rateMultiplier;
    upstreamApiKey = manualUpstream.apiKey;
  } else {
    // Priority 2: Built-in Magpie gateway reuse (STRICTLY locked to approved gift models)
    const bridgeCfg = accounts.getMagpieBridgeConfig();
    const approvedMagpieModels = new Set(sanitizeMagpieGiftAllowedModels(bridgeCfg.allowedModels));
    const magpieEndpoint = resolveLocalMagpieEndpoint(bridgeCfg, adapter);
    const cleanCandidate = rawModel.replace(/^magpie\//i, "");
    if (
      magpieEndpoint.active &&
      magpieEndpoint.gatewayUrl &&
      approvedMagpieModels.has(cleanCandidate)
    ) {
      targetKind = "magpie";
      targetBaseUrl = magpieEndpoint.gatewayUrl;
      targetUpstreamId = "builtin:magpie";
      targetRateMultiplier = bridgeCfg.rateMultiplier;
      upstreamApiKey = magpieEndpoint.gatewayKey;
      cleanForwardModel = cleanCandidate;
    }
  }

  if (!targetBaseUrl) {
    return gatewayError(
      404,
      cleanSubPath,
      `No enabled upstream or built-in Magpie gift route available for model '${rawModel}'`,
      "invalid_request_error",
      "model_not_found",
    );
  }

  // Pool-specific quota enforcement
  const modelPool = classifyGiftModelPool(cleanForwardModel);
  const effectiveQuotaPool: "deepseek" | "gpt" | "manual" =
    modelPool === "gpt" ? "gpt" : modelPool === "deepseek" ? "deepseek" : "manual";

  if (effectiveQuotaPool === "gpt") {
    if (resolved.user.gptBalance <= 0) {
      return gatewayError(
        402,
        cleanSubPath,
        "GPT-6.1 Sol 默认不赠送，当前 GPT 额度为 0；请联系管理员为您单独下发 GPT 额度",
        "insufficient_quota",
        "insufficient_gpt_quota",
      );
    }
  } else if (effectiveQuotaPool === "deepseek") {
    if (resolved.user.deepseekTotalAvailable <= 0) {
      return gatewayError(
        402,
        cleanSubPath,
        "今日 DeepSeek V4.1 免费 10M 额度及额外赠送余额已用完，次日 00:00 自动刷新 10M（不累计）",
        "insufficient_quota",
        "insufficient_quota",
      );
    }
  } else if (resolved.user.tokenBalance <= 0) {
    return gatewayError(
      402,
      cleanSubPath,
      "Insufficient VibeLink token balance. Please redeem a welfare code or contact admin.",
      "insufficient_quota",
      "insufficient_quota",
    );
  }

  if (resolved.quotaLimit > 0 && resolved.keyTokensUsed >= resolved.quotaLimit) {
    return gatewayError(
      402,
      cleanSubPath,
      "This API Key has reached its quota limit.",
      "insufficient_quota",
      "key_quota_exceeded",
    );
  }
  if (resolved.user.dailyLimit > 0 && resolved.todayUsed >= resolved.user.dailyLimit) {
    return gatewayError(
      429,
      cleanSubPath,
      "Daily token usage limit reached.",
      "rate_limit_error",
      "daily_limit_exceeded",
    );
  }

  const isStream = Boolean(bodyObj.stream);
  const forwardPayload: Record<string, unknown> = {
    ...bodyObj,
    model: cleanForwardModel,
  };
  if (isStream && cleanSubPath === "/chat/completions") {
    const streamOpts =
      typeof bodyObj.stream_options === "object" && bodyObj.stream_options !== null
        ? (bodyObj.stream_options as Record<string, unknown>)
        : {};
    if (streamOpts.include_usage === undefined) {
      forwardPayload.stream_options = { ...streamOpts, include_usage: true };
    }
  }

  const cleanBase = targetBaseUrl.replace(/\/+$/, "");
  const upstreamBase = cleanBase.endsWith("/v1") ? cleanBase : `${cleanBase}/v1`;
  const upstreamUrl = `${upstreamBase}${cleanSubPath}`;

  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (upstreamApiKey) {
    upstreamHeaders.Authorization = `Bearer ${upstreamApiKey}`;
    if (cleanSubPath === "/messages") {
      upstreamHeaders["x-api-key"] = upstreamApiKey;
    }
  }
  if (cleanSubPath === "/messages") {
    upstreamHeaders["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
    if (headers["anthropic-beta"]) {
      upstreamHeaders["anthropic-beta"] = headers["anthropic-beta"];
    }
  }

  try {
    const upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(forwardPayload),
      signal: AbortSignal.timeout(120_000),
    });

    const respText = await upstreamResp.text();
    if (!upstreamResp.ok) {
      try {
        return { status: upstreamResp.status, json: JSON.parse(respText) };
      } catch {
        return gatewayError(
          upstreamResp.status,
          cleanSubPath,
          respText || `${targetKind === "magpie" ? "Magpie" : "Upstream"} HTTP ${upstreamResp.status}`,
          "upstream_error",
        );
      }
    }

    const promptFallback = estimateTokensFromText(input.bodyText || "");

    if (isStream) {
      const parsedSse = parseSseUsageAndText(respText);
      const pTokens = parsedSse.promptTokens > 0 ? parsedSse.promptTokens : promptFallback;
      const cTokens =
        parsedSse.completionTokens > 0
          ? parsedSse.completionTokens
          : Math.max(1, Math.ceil(parsedSse.contentChars / 4));
      const rawTotal =
        parsedSse.totalTokens > 0 ? parsedSse.totalTokens : pTokens + cTokens;
      const charged = Math.max(1, Math.ceil(rawTotal * targetRateMultiplier));

      accounts.recordGatewayUsage({
        userId: resolved.user.id,
        keyId: resolved.keyId,
        model: cleanForwardModel,
        promptTokens: pTokens,
        completionTokens: cTokens,
        chargedTokens: charged,
        upstreamId: targetUpstreamId,
        quotaPool: effectiveQuotaPool,
      });

      return {
        status: 200,
        rawText: {
          body: respText,
          contentType: "text/event-stream; charset=utf-8",
        },
      };
    }

    let parsedJson: Record<string, unknown>;
    try {
      parsedJson = JSON.parse(respText) as Record<string, unknown>;
    } catch {
      return gatewayError(
        502,
        cleanSubPath,
        "Upstream gateway returned invalid JSON",
        "upstream_error",
      );
    }

    const usage = extractUsageFromJsonResponse(parsedJson, cleanSubPath, promptFallback);
    const charged = Math.max(1, Math.ceil(usage.totalTokens * targetRateMultiplier));

    accounts.recordGatewayUsage({
      userId: resolved.user.id,
      keyId: resolved.keyId,
      model: cleanForwardModel,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      chargedTokens: charged,
      upstreamId: targetUpstreamId,
      quotaPool: effectiveQuotaPool,
    });

    return { status: 200, json: parsedJson };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedMsg = rawMsg
      .replace(/Bearer\s+\S+/gi, "Bearer ***")
      .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-***");
    return gatewayError(
      502,
      cleanSubPath,
      `${targetKind === "magpie" ? "Magpie gateway" : "Upstream gateway"} request failed: ${sanitizedMsg}`,
      "upstream_error",
    );
  }
}
