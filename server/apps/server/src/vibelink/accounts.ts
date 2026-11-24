// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";

import type { VibeLinkDatabase } from "./db.ts";

export type VlUserRole = "admin" | "user";
export type VlUserStatus = "active" | "disabled";
export type VlWelfareKind = "token_credit" | "redeem_code" | "custom_secret" | "notice_gift";
export type VlWelfareStatus = "active" | "claimed" | "revoked";
export type VlQuotaPool = "deepseek" | "gpt";

export const GIFT_DEEPSEEK_MODEL = "auto/deepseek-v4.1-flash";
export const GIFT_GPT_MODEL = "auto/gpt-6.1-sol";
export const DEFAULT_DEEPSEEK_DAILY_QUOTA = 10_000_000;
export const ALLOWED_MAGPIE_GIFT_MODELS: ReadonlyArray<string> = [
  GIFT_DEEPSEEK_MODEL,
  GIFT_GPT_MODEL,
];

export function getLocalDateKey(ts = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isProhibitedShareModel(model: string): boolean {
  const clean = model.trim().replace(/^magpie\//i, "");
  if (!clean) return false;
  return /(?:claude|anthropic|gemini|google|antigravity)/i.test(clean);
}

export function classifyGiftModelPool(model: string): "deepseek" | "gpt" | "other" {
  const clean = model.trim().replace(/^magpie\//i, "").toLowerCase();
  if (clean === GIFT_DEEPSEEK_MODEL) return "deepseek";
  if (clean === GIFT_GPT_MODEL) return "gpt";
  return "other";
}

export function sanitizeMagpieGiftAllowedModels(models: ReadonlyArray<string> | undefined): string[] {
  if (!Array.isArray(models)) return [...ALLOWED_MAGPIE_GIFT_MODELS];
  const out: string[] = [];
  for (const item of models) {
    const clean = String(item ?? "").trim().replace(/^magpie\//i, "");
    if (ALLOWED_MAGPIE_GIFT_MODELS.includes(clean) && !out.includes(clean)) {
      out.push(clean);
    }
  }
  return out.length > 0 ? out : [...ALLOWED_MAGPIE_GIFT_MODELS];
}

export interface VlPublicUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: VlUserRole;
  readonly status: VlUserStatus;
  readonly imAccountId: string | null;
  readonly tokenBalance: number;
  readonly tokenUsed: number;
  readonly tokenGrantedTotal: number;
  readonly dailyLimit: number;
  readonly deepseekDailyQuota: number;
  readonly deepseekDailyUsed: number;
  readonly deepseekDailyRemaining: number;
  readonly deepseekDailyDate: string;
  readonly deepseekTotalAvailable: number;
  readonly gptBalance: number;
  readonly gptUsed: number;
  readonly gptGrantedTotal: number;
  readonly note: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastLoginAt: number | null;
}

export interface VlUserSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly deviceLabel: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

export interface VlInviteCode {
  readonly code: string;
  readonly createdBy: string;
  readonly note: string;
  readonly grantTokens: number;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: number | null;
  readonly disabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VlWelfareGrant {
  readonly id: string;
  readonly kind: VlWelfareKind;
  readonly quotaPool: VlQuotaPool;
  readonly title: string;
  readonly description: string;
  readonly targetUserId: string | null;
  readonly code: string | null;
  readonly tokenAmount: number;
  readonly payload: Record<string, unknown>;
  readonly maxClaims: number;
  readonly claimedCount: number;
  readonly expiresAt: number | null;
  readonly status: VlWelfareStatus;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly alreadyClaimed?: boolean;
}

export interface VlWelfareClaim {
  readonly id: string;
  readonly grantId: string;
  readonly userId: string;
  readonly tokenAmount: number;
  readonly claimedAt: number;
}

export interface VlTokenLedgerEntry {
  readonly id: string;
  readonly userId: string;
  readonly delta: number;
  readonly balanceAfter: number;
  readonly reason: string;
  readonly quotaPool: "deepseek_daily" | "deepseek_bonus" | "gpt" | "deepseek";
  readonly refId: string | null;
  readonly model: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly meta: Record<string, unknown>;
  readonly createdAt: number;
}

export interface VlUserApiKeyView {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly key?: string;
  readonly allowedModels: ReadonlyArray<string>;
  readonly quotaLimit: number;
  readonly tokensUsed: number;
  readonly revoked: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsedAt: number | null;
}

export interface VlGatewayUpstreamView {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKeyMasked: string;
  readonly models: ReadonlyArray<string>;
  readonly priority: number;
  readonly enabled: boolean;
  readonly rateMultiplier: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VlGatewayUpstreamSecret {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<string>;
  readonly priority: number;
  readonly rateMultiplier: number;
}

export interface VlMagpieBridgeConfig {
  readonly enabled: boolean;
  readonly allowedModels: string[];
  readonly rateMultiplier: number;
  readonly urlOverride: string;
}

export interface VlReplicationSnapshot {
  readonly version: 1;
  readonly syncRevision: number;
  readonly standbyDirty: boolean;
  readonly exportedAt: number;
  readonly magpieBridgeConfig?: VlMagpieBridgeConfig;
  readonly tables: {
    readonly vl_users: Array<Record<string, unknown>>;
    readonly vl_user_sessions: Array<Record<string, unknown>>;
    readonly vl_invite_codes: Array<Record<string, unknown>>;
    readonly vl_welfare_grants: Array<Record<string, unknown>>;
    readonly vl_welfare_claims: Array<Record<string, unknown>>;
    readonly vl_token_ledger: Array<Record<string, unknown>>;
    readonly vl_user_api_keys: Array<Record<string, unknown>>;
    readonly vl_gateway_upstreams: Array<Record<string, unknown>>;
  };
}

const DEFAULT_MAGPIE_BRIDGE_CONFIG: VlMagpieBridgeConfig = {
  enabled: true,
  allowedModels: [GIFT_DEEPSEEK_MODEL, GIFT_GPT_MODEL],
  rateMultiplier: 1,
  urlOverride: "",
};

export function matchesModelPattern(pattern: string, model: string): boolean {
  const cleanPattern = pattern.trim();
  const cleanModel = model.trim();
  if (!cleanPattern || !cleanModel) return false;
  if (cleanPattern === "*") return true;
  if (cleanPattern.endsWith("*")) {
    return cleanModel.startsWith(cleanPattern.slice(0, -1));
  }
  return cleanPattern === cleanModel;
}

export function isModelAllowedByList(
  allowed: ReadonlyArray<string> | undefined,
  model: string,
): boolean {
  if (!allowed || allowed.length === 0) return true;
  const clean = model.trim();
  if (!clean) return false;
  const stripped = clean.startsWith("magpie/") ? clean.slice("magpie/".length) : clean;
  for (const pat of allowed) {
    if (matchesModelPattern(pat, clean) || matchesModelPattern(pat, stripped)) {
      return true;
    }
  }
  return false;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INITIAL_ADMIN_TOKENS = 999_999_999;

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((x) => String(x ?? "").trim()).filter((x) => x.length > 0)
      : [];
  } catch {
    return [];
  }
}

function hashSha256Hex(raw: string): string {
  return NodeCrypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

const SCRYPT_PARAMS = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;
const GCM2_AAD = Buffer.from("vibelink:gcm2", "utf8");
const GCM2_INFO = Buffer.from("vibelink-aes-gcm-v2", "utf8");

function hashPasswordScrypt(password: string): string {
  const salt = NodeCrypto.randomBytes(16).toString("hex");
  const derived = NodeCrypto.scryptSync(password, salt, 64, SCRYPT_PARAMS).toString("hex");
  return `scrypt2$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt}$${derived}`;
}

function verifyPasswordScrypt(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts[0] === "scrypt2" && parts.length === 6) {
    const N = Number.parseInt(parts[1] ?? "", 10);
    const r = Number.parseInt(parts[2] ?? "", 10);
    const p = Number.parseInt(parts[3] ?? "", 10);
    const salt = parts[4] ?? "";
    const hashHex = parts[5] ?? "";
    if (
      !Number.isSafeInteger(N) ||
      N < 1024 ||
      N > 1048576 ||
      !Number.isSafeInteger(r) ||
      r < 1 ||
      r > 64 ||
      !Number.isSafeInteger(p) ||
      p < 1 ||
      p > 16 ||
      !salt ||
      !hashHex
    ) {
      return false;
    }
    try {
      const expected = Buffer.from(hashHex, "hex");
      const actual = NodeCrypto.scryptSync(password, salt, expected.length, {
        N,
        r,
        p,
        maxmem: 128 * 1024 * 1024,
      });
      if (actual.length !== expected.length) return false;
      return NodeCrypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = parts[1] ?? "";
  const hashHex = parts[2] ?? "";
  if (!salt || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = NodeCrypto.scryptSync(password, salt, expected.length);
    if (actual.length !== expected.length) return false;
    return NodeCrypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function maskSecret(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 10) return `${trimmed.slice(0, 3)}***`;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function deriveLegacyAesKey(secret: string): Buffer {
  return NodeCrypto.createHash("sha256").update(`vibelink-aes:${secret}`, "utf8").digest();
}

function deriveHkdfAesKey(secret: string, salt: Buffer): Buffer {
  return Buffer.from(NodeCrypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), salt, GCM2_INFO, 32));
}

function encryptWithSecret(plaintext: string, secret: string): string {
  const salt = NodeCrypto.randomBytes(16);
  const key = deriveHkdfAesKey(secret, salt);
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(GCM2_AAD);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm2$${salt.toString("hex")}$${iv.toString("hex")}$${tag.toString("hex")}$${enc.toString("hex")}`;
}

function decryptWithSecret(ciphertext: string, secret: string): string {
  const parts = ciphertext.split("$");
  if (parts[0] === "gcm2" && parts.length === 5) {
    const salt = Buffer.from(parts[1] ?? "", "hex");
    const iv = Buffer.from(parts[2] ?? "", "hex");
    const tag = Buffer.from(parts[3] ?? "", "hex");
    const enc = Buffer.from(parts[4] ?? "", "hex");
    const key = deriveHkdfAesKey(secret, salt);
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(GCM2_AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  }
  if (parts.length !== 4 || parts[0] !== "gcm") {
    throw new Error("Invalid encrypted secret format");
  }
  const iv = Buffer.from(parts[1] ?? "", "hex");
  const tag = Buffer.from(parts[2] ?? "", "hex");
  const enc = Buffer.from(parts[3] ?? "", "hex");
  const key = deriveLegacyAesKey(secret);
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function generateRandomPassword(length = 16): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = NodeCrypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return out;
}

function generateShortCode(prefix: string, bytesLen = 4): string {
  return `${prefix}-${NodeCrypto.randomBytes(bytesLen).toString("hex").toUpperCase()}`;
}

function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/.test(username);
}

export class VibeLinkAccountStore {
  readonly db: NodeSqlite.DatabaseSync;
  readonly homeDir: string;
  private mutationListener: (() => void) | null = null;
  private standbyLocalMode = false;
  private fallbackSecret: string;
  private nowFn: () => number = () => Date.now();

  constructor(vlDb: VibeLinkDatabase, homeDir: string) {
    this.db = vlDb.db;
    this.homeDir = homeDir;
    this.fallbackSecret = this.resolveInitialSecret(homeDir);
    this.migrate();
    this.ensureDefaultAdmin();
  }

  setNowProvider(fn: (() => number) | null): void {
    this.nowFn = fn ?? (() => Date.now());
  }

  private now(): number {
    return this.nowFn();
  }

  setMutationListener(listener: (() => void) | null): void {
    this.mutationListener = listener;
  }

  setStandbyMode(isStandby: boolean): void {
    this.standbyLocalMode = isStandby;
  }

  setEncryptionSecret(secret: string): void {
    if (secret.trim()) {
      this.fallbackSecret = secret.trim();
    }
  }

  private resolveInitialSecret(homeDir: string): string {
    const clusterCfg = NodePath.join(homeDir, "cluster-config.json");
    try {
      if (NodeFS.existsSync(clusterCfg)) {
        const parsed = JSON.parse(NodeFS.readFileSync(clusterCfg, "utf8")) as {
          clusterSecret?: unknown;
        };
        if (typeof parsed.clusterSecret === "string" && parsed.clusterSecret.trim().length >= 16) {
          return parsed.clusterSecret.trim();
        }
      }
    } catch {
      // ignore
    }
    const tokenPath = NodePath.join(homeDir, "auth-token.txt");
    try {
      if (NodeFS.existsSync(tokenPath)) {
        const token = NodeFS.readFileSync(tokenPath, "utf8").trim();
        if (token.length >= 16) return token;
      }
    } catch {
      // ignore
    }
    const envSecret = process.env.VIBELINK_CLUSTER_SECRET?.trim();
    if (envSecret && envSecret.length >= 16) return envSecret;
    const masterKeyPath = NodePath.join(homeDir, ".master-key");
    try {
      if (NodeFS.existsSync(masterKeyPath)) {
        const existingMaster = NodeFS.readFileSync(masterKeyPath, "utf8").trim();
        if (existingMaster.length >= 32) return existingMaster;
      }
    } catch {
      // ignore
    }
    const generatedMaster = NodeCrypto.randomBytes(32).toString("hex");
    try {
      NodeFS.mkdirSync(homeDir, { recursive: true });
      NodeFS.writeFileSync(masterKeyPath, `${generatedMaster}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // ignore fs write errors in restricted envs
    }
    return generatedMaster;
  }

  private cleanupAdminBootstrapFile(): void {
    const bootstrapFile = NodePath.join(this.homeDir, "admin-bootstrap.txt");
    try {
      if (NodeFS.existsSync(bootstrapFile)) {
        NodeFS.rmSync(bootstrapFile, { force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vl_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        password_hash TEXT NOT NULL,
        im_account_id TEXT,
        token_balance INTEGER NOT NULL DEFAULT 0,
        token_used INTEGER NOT NULL DEFAULT 0,
        token_granted_total INTEGER NOT NULL DEFAULT 0,
        daily_limit INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS vl_user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES vl_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        device_label TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vl_user_sessions_user ON vl_user_sessions (user_id);

      CREATE TABLE IF NOT EXISTS vl_invite_codes (
        code TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        grant_tokens INTEGER NOT NULL DEFAULT 0,
        max_uses INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vl_welfare_grants (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('token_credit', 'redeem_code', 'custom_secret', 'notice_gift')),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        target_user_id TEXT REFERENCES vl_users(id) ON DELETE CASCADE,
        code TEXT UNIQUE,
        token_amount INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        max_claims INTEGER NOT NULL DEFAULT 1,
        claimed_count INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'claimed', 'revoked')),
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vl_welfare_claims (
        id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL REFERENCES vl_welfare_grants(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES vl_users(id) ON DELETE CASCADE,
        token_amount INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER NOT NULL,
        UNIQUE (grant_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS vl_token_ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES vl_users(id) ON DELETE CASCADE,
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ref_id TEXT,
        model TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        meta_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vl_token_ledger_user ON vl_token_ledger (user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS vl_user_api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES vl_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_ciphertext TEXT NOT NULL,
        allowed_models_json TEXT NOT NULL DEFAULT '[]',
        quota_limit INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS vl_gateway_upstreams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key_enc TEXT NOT NULL,
        models_json TEXT NOT NULL DEFAULT '[]',
        priority INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 1,
        rate_multiplier REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vl_cluster_meta (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.ensureColumn("vl_users", "deepseek_daily_quota", "INTEGER NOT NULL DEFAULT 10000000");
    this.ensureColumn("vl_users", "deepseek_daily_used", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("vl_users", "deepseek_daily_date", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("vl_users", "gpt_balance", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("vl_users", "gpt_used", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("vl_users", "gpt_granted_total", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("vl_welfare_grants", "quota_pool", "TEXT NOT NULL DEFAULT 'deepseek'");
    this.ensureColumn("vl_token_ledger", "quota_pool", "TEXT NOT NULL DEFAULT 'deepseek'");

    // Clamp legacy wildcard / unsafe Magpie config if present in DB
    const storedCfg = this.getClusterMeta<Partial<VlMagpieBridgeConfig> | null>(
      "magpie_bridge_config",
      null,
    );
    if (storedCfg && Array.isArray(storedCfg.allowedModels)) {
      const sanitized = sanitizeMagpieGiftAllowedModels(storedCfg.allowedModels);
      const changed =
        sanitized.length !== storedCfg.allowedModels.length ||
        sanitized.some((m, idx) => storedCfg.allowedModels?.[idx] !== m);
      if (changed) {
        this.setClusterMeta(
          "magpie_bridge_config",
          {
            enabled: storedCfg.enabled !== false,
            allowedModels: sanitized,
            rateMultiplier:
              typeof storedCfg.rateMultiplier === "number" && storedCfg.rateMultiplier >= 0.01
                ? storedCfg.rateMultiplier
                : 1,
            urlOverride: typeof storedCfg.urlOverride === "string" ? storedCfg.urlOverride : "",
          },
          Date.now(),
        );
      }
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private ensureDefaultAdmin(): void {
    const existing = this.db
      .prepare("SELECT * FROM vl_users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (existing) {
      if (
        Number(existing.gpt_granted_total ?? 0) === 0 &&
        Number(existing.gpt_balance ?? 0) === 0 &&
        String(existing.id) === "usr_admin"
      ) {
        this.db
          .prepare(
            "UPDATE vl_users SET gpt_balance = ?, gpt_granted_total = ? WHERE id = 'usr_admin'",
          )
          .run(INITIAL_ADMIN_TOKENS, INITIAL_ADMIN_TOKENS);
      }
      return;
    }

    const now = this.now();
    const today = getLocalDateKey(now);
    const adminUsername = (process.env.VIBELINK_ADMIN_USERNAME || "admin").trim() || "admin";
    const envPassword = process.env.VIBELINK_ADMIN_PASSWORD?.trim();
    const initialPassword = envPassword || generateRandomPassword(16);
    const passwordHash = hashPasswordScrypt(initialPassword);

    this.db
      .prepare(
        `INSERT INTO vl_users (
          id, username, display_name, role, status, password_hash, im_account_id,
          token_balance, token_used, token_granted_total, daily_limit,
          deepseek_daily_quota, deepseek_daily_used, deepseek_daily_date,
          gpt_balance, gpt_used, gpt_granted_total, note,
          created_at, updated_at, last_login_at
        ) VALUES (?, ?, ?, 'admin', 'active', ?, 'me', ?, 0, ?, 0, ?, 0, ?, ?, 0, ?, '系统默认超级管理员账号', ?, ?, NULL)`,
      )
      .run(
        "usr_admin",
        adminUsername,
        "管理员 (我)",
        passwordHash,
        INITIAL_ADMIN_TOKENS,
        INITIAL_ADMIN_TOKENS,
        DEFAULT_DEEPSEEK_DAILY_QUOTA,
        today,
        INITIAL_ADMIN_TOKENS,
        INITIAL_ADMIN_TOKENS,
        now,
        now,
      );

    this.db
      .prepare(
        `INSERT INTO vl_token_ledger (
          id, user_id, delta, balance_after, reason, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
        ) VALUES (?, 'usr_admin', ?, ?, 'admin_init', NULL, NULL, 0, 0, '{}', ?)`,
      )
      .run(`ldg_${NodeCrypto.randomUUID().slice(0, 12)}`, INITIAL_ADMIN_TOKENS, INITIAL_ADMIN_TOKENS, now);

    this.setClusterMeta("sync_revision", 1, now);
    this.setClusterMeta("standby_dirty", false, now);

    if (!envPassword) {
      const bootstrapFile = NodePath.join(this.homeDir, "admin-bootstrap.txt");
      try {
        NodeFS.mkdirSync(this.homeDir, { recursive: true });
        if (!NodeFS.existsSync(bootstrapFile)) {
          NodeFS.writeFileSync(
            bootstrapFile,
            `VibeLink 初始管理员账号（请首次登录后修改密码，切勿提交到 Git）\nusername=${adminUsername}\npassword=${initialPassword}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        }
      } catch {
        // ignore write errors
      }
    }
  }

  private getClusterMeta<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value_json FROM vl_cluster_meta WHERE key = ?")
      .get(key) as { value_json?: string } | undefined;
    if (!row?.value_json) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  private setClusterMeta(key: string, value: unknown, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO vl_cluster_meta (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), now);
  }

  getSyncRevision(): number {
    return Number(this.getClusterMeta<number>("sync_revision", 1)) || 1;
  }

  isStandbyDirty(): boolean {
    return Boolean(this.getClusterMeta<boolean>("standby_dirty", false));
  }

  clearStandbyDirty(): void {
    this.setClusterMeta("standby_dirty", false, Date.now());
  }

  private recordMutation(notify = true): number {
    const now = Date.now();
    const next = this.getSyncRevision() + 1;
    this.setClusterMeta("sync_revision", next, now);
    if (this.standbyLocalMode) {
      this.setClusterMeta("standby_dirty", true, now);
    }
    if (notify) {
      this.mutationListener?.();
    }
    return next;
  }

  private mapUser(row: Record<string, unknown>): VlPublicUser {
    const today = getLocalDateKey(this.now());
    const dailyQuota = Math.max(
      0,
      Number(row.deepseek_daily_quota ?? DEFAULT_DEEPSEEK_DAILY_QUOTA),
    );
    const storedDate = String(row.deepseek_daily_date ?? "");
    const rawDailyUsed = Math.max(0, Number(row.deepseek_daily_used ?? 0));
    const effectiveDailyUsed = storedDate === today ? Math.min(dailyQuota, rawDailyUsed) : 0;
    const dailyRemaining = Math.max(0, dailyQuota - effectiveDailyUsed);
    const bonusBalance = Math.max(0, Number(row.token_balance ?? 0));
    const gptBalance = Math.max(0, Number(row.gpt_balance ?? 0));

    return {
      id: String(row.id),
      username: String(row.username),
      displayName: String(row.display_name),
      role: (String(row.role) === "admin" ? "admin" : "user") as VlUserRole,
      status: (String(row.status) === "disabled" ? "disabled" : "active") as VlUserStatus,
      imAccountId: row.im_account_id ? String(row.im_account_id) : null,
      tokenBalance: bonusBalance,
      tokenUsed: Number(row.token_used ?? 0),
      tokenGrantedTotal: Number(row.token_granted_total ?? 0),
      dailyLimit: Number(row.daily_limit ?? 0),
      deepseekDailyQuota: dailyQuota,
      deepseekDailyUsed: effectiveDailyUsed,
      deepseekDailyRemaining: dailyRemaining,
      deepseekDailyDate: today,
      deepseekTotalAvailable: dailyRemaining + bonusBalance,
      gptBalance,
      gptUsed: Math.max(0, Number(row.gpt_used ?? 0)),
      gptGrantedTotal: Math.max(0, Number(row.gpt_granted_total ?? 0)),
      note: String(row.note ?? ""),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      lastLoginAt: row.last_login_at !== null && row.last_login_at !== undefined ? Number(row.last_login_at) : null,
    };
  }

  private mapInvite(row: Record<string, unknown>): VlInviteCode {
    return {
      code: String(row.code),
      createdBy: String(row.created_by),
      note: String(row.note ?? ""),
      grantTokens: Number(row.grant_tokens ?? 0),
      maxUses: Number(row.max_uses ?? 1),
      usedCount: Number(row.used_count ?? 0),
      expiresAt: row.expires_at !== null && row.expires_at !== undefined ? Number(row.expires_at) : null,
      disabled: Boolean(row.disabled),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  private mapWelfareGrant(row: Record<string, unknown>, claimedSet?: Set<string>): VlWelfareGrant {
    const id = String(row.id);
    const pool = String(row.quota_pool ?? "deepseek") === "gpt" ? "gpt" : "deepseek";
    return {
      id,
      kind: String(row.kind) as VlWelfareKind,
      quotaPool: pool,
      title: String(row.title),
      description: String(row.description ?? ""),
      targetUserId: row.target_user_id ? String(row.target_user_id) : null,
      code: row.code ? String(row.code) : null,
      tokenAmount: Number(row.token_amount ?? 0),
      payload: parseJsonObject(row.payload_json),
      maxClaims: Number(row.max_claims ?? 1),
      claimedCount: Number(row.claimed_count ?? 0),
      expiresAt: row.expires_at !== null && row.expires_at !== undefined ? Number(row.expires_at) : null,
      status: String(row.status) as VlWelfareStatus,
      createdBy: String(row.created_by),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      ...(claimedSet ? { alreadyClaimed: claimedSet.has(id) } : {}),
    };
  }

  private mapLedger(row: Record<string, unknown>): VlTokenLedgerEntry {
    const rawPool = String(row.quota_pool ?? "deepseek");
    const quotaPool =
      rawPool === "gpt" ||
      rawPool === "deepseek_daily" ||
      rawPool === "deepseek_bonus" ||
      rawPool === "deepseek"
        ? rawPool
        : "deepseek";
    return {
      id: String(row.id),
      userId: String(row.user_id),
      delta: Number(row.delta ?? 0),
      balanceAfter: Number(row.balance_after ?? 0),
      reason: String(row.reason ?? ""),
      quotaPool,
      refId: row.ref_id ? String(row.ref_id) : null,
      model: row.model ? String(row.model) : null,
      promptTokens: Number(row.prompt_tokens ?? 0),
      completionTokens: Number(row.completion_tokens ?? 0),
      meta: parseJsonObject(row.meta_json),
      createdAt: Number(row.created_at ?? 0),
    };
  }

  private mapApiKey(row: Record<string, unknown>, secret: string): VlUserApiKeyView {
    let rawKey: string | undefined;
    try {
      rawKey = decryptWithSecret(String(row.key_ciphertext), secret);
    } catch {
      rawKey = undefined;
    }
    return {
      id: String(row.id),
      userId: String(row.user_id),
      name: String(row.name),
      keyPrefix: String(row.key_prefix),
      ...(rawKey ? { key: rawKey } : {}),
      allowedModels: parseStringArray(row.allowed_models_json),
      quotaLimit: Number(row.quota_limit ?? 0),
      tokensUsed: Number(row.tokens_used ?? 0),
      revoked: Boolean(row.revoked),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      lastUsedAt: row.last_used_at !== null && row.last_used_at !== undefined ? Number(row.last_used_at) : null,
    };
  }

  private mapUpstream(row: Record<string, unknown>, secret: string): VlGatewayUpstreamView {
    let masked = "***";
    try {
      masked = maskSecret(decryptWithSecret(String(row.api_key_enc), secret));
    } catch {
      masked = "***";
    }
    return {
      id: String(row.id),
      name: String(row.name),
      baseUrl: String(row.base_url),
      apiKeyMasked: masked,
      models: parseStringArray(row.models_json),
      priority: Number(row.priority ?? 100),
      enabled: Boolean(row.enabled),
      rateMultiplier: Number(row.rate_multiplier ?? 1),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  getAdminUser(): VlPublicUser {
    this.ensureDefaultAdmin();
    const row = this.db
      .prepare("SELECT * FROM vl_users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1")
      .get() as Record<string, unknown>;
    return this.mapUser(row);
  }

  getUserById(userId: string): VlPublicUser | null {
    const row = this.db.prepare("SELECT * FROM vl_users WHERE id = ?").get(userId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapUser(row) : null;
  }

  getUserByUsername(username: string): VlPublicUser | null {
    const row = this.db
      .prepare("SELECT * FROM vl_users WHERE username = ? COLLATE NOCASE")
      .get(username.trim()) as Record<string, unknown> | undefined;
    return row ? this.mapUser(row) : null;
  }

  private createSession(userId: string, deviceLabel = "", notify = true): {
    sessionToken: string;
    session: VlUserSessionRecord;
  } {
    const now = Date.now();
    const sessionToken = `vls_${NodeCrypto.randomBytes(24).toString("hex")}`;
    const tokenHash = hashSha256Hex(sessionToken);
    const id = `ses_${NodeCrypto.randomUUID().slice(0, 12)}`;
    const expiresAt = now + SESSION_TTL_MS;
    const cleanDevice = deviceLabel.trim().slice(0, 80);

    this.db
      .prepare(
        `INSERT INTO vl_user_sessions (id, user_id, token_hash, device_label, expires_at, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, tokenHash, cleanDevice, expiresAt, now, now);

    this.db.prepare("UPDATE vl_users SET last_login_at = ? WHERE id = ?").run(now, userId);
    this.recordMutation(notify);

    return {
      sessionToken,
      session: {
        id,
        userId,
        deviceLabel: cleanDevice,
        expiresAt,
        createdAt: now,
        lastUsedAt: now,
      },
    };
  }

  login(
    username: string,
    password: string,
    deviceLabel = "",
  ): { user: VlPublicUser; sessionToken: string; expiresAt: number } {
    const cleanUser = username.trim();
    if (!cleanUser || !password) {
      throw new Error("请输入用户名和密码");
    }
    const row = this.db
      .prepare("SELECT * FROM vl_users WHERE username = ? COLLATE NOCASE")
      .get(cleanUser) as Record<string, unknown> | undefined;
    if (!row || !verifyPasswordScrypt(password, String(row.password_hash ?? ""))) {
      throw new Error("用户名或密码错误");
    }
    if (String(row.status) !== "active") {
      throw new Error("该账号已被管理员禁用");
    }
    if (String(row.password_hash ?? "").startsWith("scrypt$")) {
      this.db
        .prepare("UPDATE vl_users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(hashPasswordScrypt(password), this.now(), String(row.id));
    }
    const { sessionToken, session } = this.createSession(String(row.id), deviceLabel, true);
    const updated = this.getUserById(String(row.id))!;
    return { user: updated, sessionToken, expiresAt: session.expiresAt };
  }

  registerWithInvite(input: {
    readonly username: string;
    readonly password: string;
    readonly displayName?: string;
    readonly inviteCode: string;
    readonly deviceLabel?: string;
  }): { user: VlPublicUser; sessionToken: string; expiresAt: number; welcomeTokens: number } {
    const username = input.username.trim();
    const password = input.password;
    const displayName = (input.displayName ?? "").trim() || username;
    const inviteCode = input.inviteCode.trim().toUpperCase();

    if (!isValidUsername(username)) {
      throw new Error("用户名需为 2-32 位字母/数字/._-，且以字母或数字开头");
    }
    if (password.length < 6) {
      throw new Error("密码至少需要 6 个字符");
    }
    if (!inviteCode) {
      throw new Error("请输入邀请码");
    }

    const now = this.now();
    const today = getLocalDateKey(now);
    const userId = `usr_${NodeCrypto.randomUUID().slice(0, 12)}`;
    const passwordHash = hashPasswordScrypt(password);
    let welcomeTokens = 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingUser = this.db
        .prepare("SELECT id FROM vl_users WHERE username = ? COLLATE NOCASE")
        .get(username) as { id?: string } | undefined;
      if (existingUser) {
        throw new Error("用户名已存在");
      }

      const inv = this.db
        .prepare("SELECT * FROM vl_invite_codes WHERE code = ?")
        .get(inviteCode) as Record<string, unknown> | undefined;
      if (!inv) {
        throw new Error("邀请码不存在");
      }
      if (Boolean(inv.disabled)) {
        throw new Error("邀请码已被作废");
      }
      if (inv.expires_at !== null && inv.expires_at !== undefined && Number(inv.expires_at) < now) {
        throw new Error("邀请码已过期");
      }
      if (Number(inv.used_count ?? 0) >= Number(inv.max_uses ?? 1)) {
        throw new Error("邀请码使用次数已用尽");
      }

      welcomeTokens = Math.max(0, Math.floor(Number(inv.grant_tokens ?? 0)));

      this.db
        .prepare(
          `INSERT INTO vl_users (
            id, username, display_name, role, status, password_hash, im_account_id,
            token_balance, token_used, token_granted_total, daily_limit,
            deepseek_daily_quota, deepseek_daily_used, deepseek_daily_date,
            gpt_balance, gpt_used, gpt_granted_total, note,
            created_at, updated_at, last_login_at
          ) VALUES (?, ?, ?, 'user', 'active', ?, NULL, ?, 0, ?, 0, ?, 0, ?, 0, 0, 0, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          username,
          displayName,
          passwordHash,
          welcomeTokens,
          welcomeTokens,
          DEFAULT_DEEPSEEK_DAILY_QUOTA,
          today,
          `邀请码 ${inviteCode} 注册`,
          now,
          now,
          now,
        );

      this.db
        .prepare("UPDATE vl_invite_codes SET used_count = used_count + 1, updated_at = ? WHERE code = ?")
        .run(now, inviteCode);

      if (welcomeTokens > 0) {
        this.db
          .prepare(
            `INSERT INTO vl_token_ledger (
              id, user_id, delta, balance_after, reason, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
            ) VALUES (?, ?, ?, ?, 'invite_welcome', ?, NULL, 0, 0, '{}', ?)`,
          )
          .run(`ldg_${NodeCrypto.randomUUID().slice(0, 12)}`, userId, welcomeTokens, welcomeTokens, inviteCode, now);
      }

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    const { sessionToken, session } = this.createSession(userId, input.deviceLabel ?? "", true);
    return {
      user: this.getUserById(userId)!,
      sessionToken,
      expiresAt: session.expiresAt,
      welcomeTokens,
    };
  }

  resolveSessionToken(rawToken: string): { user: VlPublicUser; session: VlUserSessionRecord } | null {
    const clean = rawToken.trim();
    if (!clean.startsWith("vls_")) return null;
    const tokenHash = hashSha256Hex(clean);
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT s.id AS s_id, s.user_id AS s_user_id, s.device_label AS s_device_label,
                s.expires_at AS s_expires_at, s.created_at AS s_created_at, s.last_used_at AS s_last_used_at,
                u.*
         FROM vl_user_sessions s
         JOIN vl_users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (Number(row.s_expires_at ?? 0) < now) {
      this.db.prepare("DELETE FROM vl_user_sessions WHERE id = ?").run(String(row.s_id));
      return null;
    }
    if (String(row.status) !== "active") {
      return null;
    }
    this.db.prepare("UPDATE vl_user_sessions SET last_used_at = ? WHERE id = ?").run(now, String(row.s_id));
    return {
      user: this.mapUser(row),
      session: {
        id: String(row.s_id),
        userId: String(row.s_user_id),
        deviceLabel: String(row.s_device_label ?? ""),
        expiresAt: Number(row.s_expires_at),
        createdAt: Number(row.s_created_at),
        lastUsedAt: now,
      },
    };
  }

  logoutSession(rawToken: string): boolean {
    const clean = rawToken.trim();
    if (!clean.startsWith("vls_")) return false;
    const res = this.db.prepare("DELETE FROM vl_user_sessions WHERE token_hash = ?").run(hashSha256Hex(clean));
    if (res.changes > 0) {
      this.recordMutation(true);
      return true;
    }
    return false;
  }

  changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    skipOldCheckForOwnerAdmin = false,
    keepSessionToken?: string,
  ): void {
    if (newPassword.length < 6) {
      throw new Error("新密码至少需要 6 个字符");
    }
    const row = this.db.prepare("SELECT * FROM vl_users WHERE id = ?").get(userId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error("账号不存在");
    if (!skipOldCheckForOwnerAdmin && !verifyPasswordScrypt(oldPassword, String(row.password_hash ?? ""))) {
      throw new Error("原密码不正确");
    }
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE vl_users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(hashPasswordScrypt(newPassword), now, userId);
      const cleanKeep = keepSessionToken?.trim();
      if (cleanKeep) {
        this.db
          .prepare("DELETE FROM vl_user_sessions WHERE user_id = ? AND token_hash != ?")
          .run(userId, hashSha256Hex(cleanKeep));
      } else {
        this.db.prepare("DELETE FROM vl_user_sessions WHERE user_id = ?").run(userId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }
    if (userId === "usr_admin") {
      this.cleanupAdminBootstrapFile();
    }
    this.recordMutation(true);
  }

  listUsers(): VlPublicUser[] {
    const rows = this.db
      .prepare("SELECT * FROM vl_users ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapUser(r));
  }

  createUserByAdmin(input: {
    readonly username: string;
    readonly password: string;
    readonly displayName?: string;
    readonly role?: VlUserRole;
    readonly tokenBalance?: number;
    readonly dailyLimit?: number;
    readonly deepseekDailyQuota?: number;
    readonly gptBalance?: number;
    readonly note?: string;
  }): VlPublicUser {
    const username = input.username.trim();
    if (!isValidUsername(username)) {
      throw new Error("用户名需为 2-32 位字母/数字/._-，且以字母或数字开头");
    }
    if (input.password.length < 6) {
      throw new Error("初始密码至少需要 6 个字符");
    }
    const existing = this.getUserByUsername(username);
    if (existing) {
      throw new Error("用户名已存在");
    }

    const now = this.now();
    const today = getLocalDateKey(now);
    const id = `usr_${NodeCrypto.randomUUID().slice(0, 12)}`;
    const role: VlUserRole = input.role === "admin" ? "admin" : "user";
    const initialTokens = Math.max(0, Math.floor(Number(input.tokenBalance ?? 0)));
    const dailyLimit = Math.max(0, Math.floor(Number(input.dailyLimit ?? 0)));
    const deepseekDailyQuota = Math.max(
      0,
      Math.floor(Number(input.deepseekDailyQuota ?? DEFAULT_DEEPSEEK_DAILY_QUOTA)),
    );
    const gptBalance = Math.max(0, Math.floor(Number(input.gptBalance ?? 0)));
    const displayName = (input.displayName ?? "").trim() || username;
    const note = (input.note ?? "").trim();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO vl_users (
            id, username, display_name, role, status, password_hash, im_account_id,
            token_balance, token_used, token_granted_total, daily_limit,
            deepseek_daily_quota, deepseek_daily_used, deepseek_daily_date,
            gpt_balance, gpt_used, gpt_granted_total, note,
            created_at, updated_at, last_login_at
          ) VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, 0, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          username,
          displayName,
          role,
          hashPasswordScrypt(input.password),
          initialTokens,
          initialTokens,
          dailyLimit,
          deepseekDailyQuota,
          today,
          gptBalance,
          gptBalance,
          note,
          now,
          now,
        );

      if (initialTokens > 0) {
        this.db
          .prepare(
            `INSERT INTO vl_token_ledger (
              id, user_id, delta, balance_after, reason, quota_pool, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
            ) VALUES (?, ?, ?, ?, 'admin_create', 'deepseek_bonus', NULL, NULL, 0, 0, '{}', ?)`,
          )
          .run(`ldg_${NodeCrypto.randomUUID().slice(0, 12)}`, id, initialTokens, initialTokens, now);
      }

      if (gptBalance > 0) {
        this.db
          .prepare(
            `INSERT INTO vl_token_ledger (
              id, user_id, delta, balance_after, reason, quota_pool, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
            ) VALUES (?, ?, ?, ?, 'admin_create_gpt', 'gpt', NULL, NULL, 0, 0, '{}', ?)`,
          )
          .run(`ldg_${NodeCrypto.randomUUID().slice(0, 12)}`, id, gptBalance, gptBalance, now);
      }

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    this.recordMutation(true);
    return this.getUserById(id)!;
  }

  updateUserByAdmin(
    userId: string,
    patch: {
      readonly displayName?: string;
      readonly role?: VlUserRole;
      readonly status?: VlUserStatus;
      readonly dailyLimit?: number;
      readonly deepseekDailyQuota?: number;
      readonly note?: string;
      readonly resetPassword?: string;
      readonly tokenBalanceDelta?: number;
      readonly gptBalanceDelta?: number;
      readonly reason?: string;
    },
  ): VlPublicUser {
    const current = this.db.prepare("SELECT * FROM vl_users WHERE id = ?").get(userId) as
      | Record<string, unknown>
      | undefined;
    if (!current) throw new Error("用户不存在");

    const now = this.now();
    const sets: string[] = [];
    const params: Array<string | number | null> = [];

    if (typeof patch.displayName === "string" && patch.displayName.trim()) {
      sets.push("display_name = ?");
      params.push(patch.displayName.trim());
    }
    if (patch.role === "admin" || patch.role === "user") {
      if (userId === "usr_admin" && patch.role !== "admin") {
        throw new Error("不能取消默认超级管理员权限");
      }
      sets.push("role = ?");
      params.push(patch.role);
    }
    if (patch.status === "active" || patch.status === "disabled") {
      if (userId === "usr_admin" && patch.status === "disabled") {
        throw new Error("不能禁用默认超级管理员");
      }
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (typeof patch.dailyLimit === "number" && Number.isFinite(patch.dailyLimit)) {
      sets.push("daily_limit = ?");
      params.push(Math.max(0, Math.floor(patch.dailyLimit)));
    }
    if (typeof patch.deepseekDailyQuota === "number" && Number.isFinite(patch.deepseekDailyQuota)) {
      sets.push("deepseek_daily_quota = ?");
      params.push(Math.max(0, Math.floor(patch.deepseekDailyQuota)));
    }
    if (typeof patch.note === "string") {
      sets.push("note = ?");
      params.push(patch.note.trim());
    }
    if (typeof patch.resetPassword === "string" && patch.resetPassword.length > 0) {
      if (patch.resetPassword.length < 6) {
        throw new Error("重置密码至少需要 6 个字符");
      }
      sets.push("password_hash = ?");
      params.push(hashPasswordScrypt(patch.resetPassword));
    }

    const delta =
      typeof patch.tokenBalanceDelta === "number" && Number.isFinite(patch.tokenBalanceDelta)
        ? Math.trunc(patch.tokenBalanceDelta)
        : 0;
    const gptDelta =
      typeof patch.gptBalanceDelta === "number" && Number.isFinite(patch.gptBalanceDelta)
        ? Math.trunc(patch.gptBalanceDelta)
        : 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      let nextBalance = Number(current.token_balance ?? 0);
      if (delta !== 0) {
        nextBalance = Math.max(0, nextBalance + delta);
        sets.push("token_balance = ?");
        params.push(nextBalance);
        if (delta > 0) {
          sets.push("token_granted_total = token_granted_total + ?");
          params.push(delta);
        }
      }

      let nextGptBalance = Number(current.gpt_balance ?? 0);
      if (gptDelta !== 0) {
        nextGptBalance = Math.max(0, nextGptBalance + gptDelta);
        sets.push("gpt_balance = ?");
        params.push(nextGptBalance);
        if (gptDelta > 0) {
          sets.push("gpt_granted_total = gpt_granted_total + ?");
          params.push(gptDelta);
        }
      }

      if (sets.length > 0) {
        sets.push("updated_at = ?");
        params.push(now, userId);
        this.db.prepare(`UPDATE vl_users SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      }

      if (delta !== 0) {
        this.db
          .prepare(
            `INSERT INTO vl_token_ledger (
              id, user_id, delta, balance_after, reason, quota_pool, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
            ) VALUES (?, ?, ?, ?, ?, 'deepseek_bonus', NULL, NULL, 0, 0, '{}', ?)`,
          )
          .run(
            `ldg_${NodeCrypto.randomUUID().slice(0, 12)}`,
            userId,
            delta,
            nextBalance,
            patch.reason?.trim() || "admin_adjust",
            now,
          );
      }

      if (gptDelta !== 0) {
        this.db
          .prepare(
            `INSERT INTO vl_token_ledger (
              id, user_id, delta, balance_after, reason, quota_pool, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
            ) VALUES (?, ?, ?, ?, ?, 'gpt', NULL, NULL, 0, 0, '{}', ?)`,
          )
          .run(
            `ldg_${NodeCrypto.randomUUID().slice(0, 12)}`,
            userId,
            gptDelta,
            nextGptBalance,
            patch.reason?.trim() || "admin_adjust_gpt",
            now,
          );
      }

      if (patch.status === "disabled" || (typeof patch.resetPassword === "string" && patch.resetPassword.length > 0)) {
        this.db.prepare("DELETE FROM vl_user_sessions WHERE user_id = ?").run(userId);
      }

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }
    if (userId === "usr_admin" && typeof patch.resetPassword === "string" && patch.resetPassword.length > 0) {
      this.cleanupAdminBootstrapFile();
    }

    this.recordMutation(true);
    return this.getUserById(userId)!;
  }

  deleteUserByAdmin(userId: string): boolean {
    if (userId === "usr_admin") {
      throw new Error("不能删除默认超级管理员");
    }
    const res = this.db.prepare("DELETE FROM vl_users WHERE id = ?").run(userId);
    if (res.changes > 0) {
      this.recordMutation(true);
      return true;
    }
    return false;
  }

  listInvites(): VlInviteCode[] {
    const rows = this.db
      .prepare("SELECT * FROM vl_invite_codes ORDER BY created_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapInvite(r));
  }

  createInvite(
    adminId: string,
    input: {
      readonly code?: string;
      readonly grantTokens?: number;
      readonly maxUses?: number;
      readonly expiresInDays?: number | null;
      readonly note?: string;
    },
  ): VlInviteCode {
    const now = Date.now();
    const code = (input.code ?? "").trim().toUpperCase() || generateShortCode("VL", 4);
    const grantTokens = Math.max(0, Math.floor(Number(input.grantTokens ?? 0)));
    const maxUses = Math.max(1, Math.floor(Number(input.maxUses ?? 1)));
    const expiresAt =
      typeof input.expiresInDays === "number" && input.expiresInDays > 0
        ? now + Math.floor(input.expiresInDays * 24 * 60 * 60 * 1000)
        : null;
    const note = (input.note ?? "").trim();

    this.db
      .prepare(
        `INSERT INTO vl_invite_codes (
          code, created_by, note, grant_tokens, max_uses, used_count, expires_at, disabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
      )
      .run(code, adminId, note, grantTokens, maxUses, expiresAt, now, now);

    this.recordMutation(true);
    const row = this.db.prepare("SELECT * FROM vl_invite_codes WHERE code = ?").get(code) as Record<
      string,
      unknown
    >;
    return this.mapInvite(row);
  }

  revokeInvite(code: string): boolean {
    const clean = code.trim().toUpperCase();
    const res = this.db
      .prepare("UPDATE vl_invite_codes SET disabled = 1, updated_at = ? WHERE code = ?")
      .run(Date.now(), clean);
    if (res.changes > 0) {
      this.recordMutation(true);
      return true;
    }
    return false;
  }

  deleteInvite(code: string): boolean {
    const clean = code.trim().toUpperCase();
    const res = this.db.prepare("DELETE FROM vl_invite_codes WHERE code = ?").run(clean);
    if (res.changes > 0) {
      this.recordMutation(true);
      return true;
    }
    return false;
  }

  grantToUserByAdmin(
    adminId: string,
    userId: string,
    input: {
      readonly kind?: VlWelfareKind;
      readonly quotaPool?: VlQuotaPool;
      readonly title: string;
      readonly description?: string;
      readonly tokenAmount?: number;
      readonly payload?: Record<string, unknown>;
    },
  ): { grant: VlWelfareGrant; user: VlPublicUser } {
    const target = this.getUserById(userId);
    if (!target) throw new Error("目标用户不存在");

    const kind: VlWelfareKind =
      input.kind === "custom_secret" || input.kind === "notice_gift" ? input.kind : "token_credit";
    const quotaPool: VlQuotaPool = input.quotaPool === "gpt" ? "gpt" : "deepseek";
    const tokenAmount = Math.max(0, Math.floor(Number(input.tokenAmount ?? 0)));
    const title =
      input.title.trim() ||
      (tokenAmount > 0
        ? `管理员赠送 ${tokenAmount} ${quotaPool === "gpt" ? "GPT" : "DeepSeek"} Tokens`
        : "管理员福利下发");
    const description = (input.description ?? "").trim();
    const payload = input.payload ?? {};
    const now = this.now();
    const grantId = `welf_${NodeCrypto.randomUUID().slice(0, 12)}`;
    const claimId = `wclm_${NodeCrypto.randomUUID().slice(0, 12)}`;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO vl_welfare_grants (
            id, kind, quota_pool, title, description, target_user_id, code, token_amount, payload_json,
            max_claims, claimed_count, expires_at, status, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, 1, NULL, 'claimed', ?, ?, ?)`,
        )
        .run(
          grantId,
          kind,
          quotaPool,
          title,
          description,
          userId,
          tokenAmount,
          JSON.stringify(payload),
          adminId,
          now,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO vl_welfare_claims (id, grant_id, user_id, token_amount, claimed_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(claimId, grantId, userId, tokenAmount, now);

      if (tokenAmount > 0) {
        if (quotaPool === "gpt") {
          const uRow = this.db.prepare("SELECT gpt_balance FROM vl_users WHERE id = ?").get(userId) as {
            gpt_balance: number;
          };
          const nextGpt = Number(uRow.gpt_balance ?? 0) + tokenAmount;
          this.db
            .prepare(
              "UPDATE vl_users SET gpt_balance = ?, gpt_granted_total = gpt_granted_total + ?, updated_at = ? WHERE id = ?",
            )
            .run(nextGpt, tokenAmount, now, userId);

          this.db
            .prepare(
              `INSERT INTO vl_token_ledger (
                id, user_id, delta, balance_after, reason, quota_pool, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
              ) VALUES (?, ?, ?, ?, 'admin_grant_gpt', 'gpt', ?, NULL, 0, 0, ?, ?)`,
            )
            .run(
              `ldg_${NodeCrypto.randomUUID().slice(0, 12)}`,
              userId,
              tokenAmount,
              nextGpt,
              grantId,
              JSON.stringify({ title, kind, quotaPool }),
              now,
            );
        } else {
          const uRow = this.db.prepare("SELECT token_balance FROM vl_users WHERE id = ?").get(userId) as {
            token_balance: number;
          };
          const nextBalance = Number(uRow.token_balance ?? 0) + tokenAmount;
          this.db
            .prepare(
              "UPDATE vl_users SET token_balance = ?, token_granted_total = token_granted_total + ?, updated_at = ? WHERE id = ?",
            )
            .run(nextBalance, tokenAmount, now, userId);

          this.db
            .prepare(
              `INSERT INTO vl_token_ledger (
                id, user_id, delta, balance_after, reason, quota_pool, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
              ) VALUES (?, ?, ?, ?, 'admin_grant', 'deepseek_bonus', ?, NULL, 0, 0, ?, ?)`,
            )
            .run(
              `ldg_${NodeCrypto.randomUUID().slice(0, 12)}`,
              userId,
              tokenAmount,
              nextBalance,
              grantId,
              JSON.stringify({ title, kind, quotaPool }),
              now,
            );
        }
      }

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    this.recordMutation(true);
    const grantRow = this.db.prepare("SELECT * FROM vl_welfare_grants WHERE id = ?").get(grantId) as Record<
      string,
      unknown
    >;
    return {
      grant: this.mapWelfareGrant(grantRow, new Set([grantId])),
      user: this.getUserById(userId)!,
    };
  }

  createWelfareGrant(
    adminId: string,
    input: {
      readonly kind?: VlWelfareKind;
      readonly quotaPool?: VlQuotaPool;
      readonly title: string;
      readonly description?: string;
      readonly targetUserId?: string | null;
      readonly code?: string | null;
      readonly tokenAmount?: number;
      readonly payload?: Record<string, unknown>;
      readonly maxClaims?: number;
      readonly expiresInDays?: number | null;
    },
  ): VlWelfareGrant {
    const now = this.now();
    const id = `welf_${NodeCrypto.randomUUID().slice(0, 12)}`;
    const kind: VlWelfareKind = input.kind ?? "redeem_code";
    const quotaPool: VlQuotaPool = input.quotaPool === "gpt" ? "gpt" : "deepseek";
    const title = input.title.trim() || "福利兑换包";
    const description = (input.description ?? "").trim();
    const targetUserId = input.targetUserId?.trim() || null;
    if (targetUserId && !this.getUserById(targetUserId)) {
      throw new Error("指定目标用户不存在");
    }
    const cleanCode =
      kind === "redeem_code"
        ? (input.code ?? "").trim().toUpperCase() || generateShortCode("GIFT", 5)
        : (input.code ?? "").trim().toUpperCase() || null;
    const tokenAmount = Math.max(0, Math.floor(Number(input.tokenAmount ?? 0)));
    const maxClaims = Math.max(1, Math.floor(Number(input.maxClaims ?? 1)));
    const expiresAt =
      typeof input.expiresInDays === "number" && input.expiresInDays > 0
        ? now + Math.floor(input.expiresInDays * 24 * 60 * 60 * 1000)
        : null;

    this.db
      .prepare(
        `INSERT INTO vl_welfare_grants (
          id, kind, quota_pool, title, description, target_user_id, code, token_amount, payload_json,
          max_claims, claimed_count, expires_at, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        kind,
        quotaPool,
        title,
        description,
        targetUserId,
        cleanCode,
        tokenAmount,
        JSON.stringify(input.payload ?? {}),
        maxClaims,
        expiresAt,
        adminId,
        now,
        now,
      );

    this.recordMutation(true);
    const row = this.db.prepare("SELECT * FROM vl_welfare_grants WHERE id = ?").get(id) as Record<
      string,
      unknown
    >;
    return this.mapWelfareGrant(row);
  }

  listAllWelfareGrants(): VlWelfareGrant[] {
    const rows = this.db
      .prepare("SELECT * FROM vl_welfare_grants ORDER BY created_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapWelfareGrant(r));
  }

  revokeWelfareGrant(grantId: string): boolean {
    const res = this.db
      .prepare("UPDATE vl_welfare_grants SET status = 'revoked', updated_at = ? WHERE id = ?")
      .run(Date.now(), grantId);
    if (res.changes > 0) {
      this.recordMutation(true);
      return true;
    }
    return false;
  }

  deleteWelfareGrant(grantId: string): boolean {
    const res = this.db.prepare("DELETE FROM vl_welfare_grants WHERE id = ?").run(grantId);
    if (res.changes > 0) {
      this.recordMutation(true);
      return true;
    }
    return false;
  }

  listWelfareForUser(userId: string): {
    user: VlPublicUser;
    grants: VlWelfareGrant[];
    claims: VlWelfareClaim[];
    ledger: VlTokenLedgerEntry[];
  } {
    const user = this.getUserById(userId);
    if (!user) throw new Error("用户不存在");

    const claimRows = this.db
      .prepare("SELECT * FROM vl_welfare_claims WHERE user_id = ? ORDER BY claimed_at DESC")
      .all(userId) as Array<Record<string, unknown>>;
    const claims: VlWelfareClaim[] = claimRows.map((c) => ({
      id: String(c.id),
      grantId: String(c.grant_id),
      userId: String(c.user_id),
      tokenAmount: Number(c.token_amount ?? 0),
      claimedAt: Number(c.claimed_at ?? 0),
    }));
    const claimedSet = new Set(claims.map((c) => c.grantId));

    const grantRows = this.db
      .prepare(
        `SELECT DISTINCT g.*
         FROM vl_welfare_grants g
         LEFT JOIN vl_welfare_claims c ON c.grant_id = g.id AND c.user_id = ?
         WHERE g.target_user_id = ? OR c.user_id = ? OR (g.target_user_id IS NULL AND g.code IS NULL AND g.status = 'active')
         ORDER BY g.created_at DESC`,
      )
      .all(userId, userId, userId) as Array<Record<string, unknown>>;

    const ledgerRows = this.db
      .prepare("SELECT * FROM vl_token_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 80")
      .all(userId) as Array<Record<string, unknown>>;

    return {
      user,
      grants: grantRows.map((g) => this.mapWelfareGrant(g, claimedSet)),
      claims,
      ledger: ledgerRows.map((l) => this.mapLedger(l)),
    };
  }

  redeemCodeOrClaim(
    userId: string,
    input: { readonly code?: string; readonly grantId?: string },
  ): { grant: VlWelfareGrant; user: VlPublicUser; creditedTokens: number } {
    const cleanCode = (input.code ?? "").trim().toUpperCase();
    const cleanGrantId = (input.grantId ?? "").trim();
    if (!cleanCode && !cleanGrantId) {
      throw new Error("请提供兑换码或福利 ID");
    }

    const now = Date.now();
    let grantedGrantId = "";
    let creditedTokens = 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const userRow = this.db.prepare("SELECT * FROM vl_users WHERE id = ?").get(userId) as
        | Record<string, unknown>
        | undefined;
      if (!userRow) throw new Error("用户不存在");
      if (String(userRow.status) !== "active") throw new Error("账号已被禁用");

      const grantRow = (
        cleanCode
          ? this.db.prepare("SELECT * FROM vl_welfare_grants WHERE code = ?").get(cleanCode)
          : this.db.prepare("SELECT * FROM vl_welfare_grants WHERE id = ?").get(cleanGrantId)
      ) as Record<string, unknown> | undefined;

      if (!grantRow) throw new Error("兑换码或福利不存在");
      grantedGrantId = String(grantRow.id);

      if (String(grantRow.status) === "revoked") {
        throw new Error("该福利已被作废");
      }
      if (grantRow.target_user_id && String(grantRow.target_user_id) !== userId) {
        throw new Error("该福利仅限指定账号领取");
      }
      if (
        grantRow.expires_at !== null &&
        grantRow.expires_at !== undefined &&
        Number(grantRow.expires_at) < now
      ) {
        throw new Error("该福利已过期");
      }

      const existingClaim = this.db
        .prepare("SELECT id FROM vl_welfare_claims WHERE grant_id = ? AND user_id = ?")
        .get(grantedGrantId, userId) as { id?: string } | undefined;
      if (existingClaim) {
        throw new Error("你已经领取过该福利，不可重复领取");
      }

      const claimedCount = Number(grantRow.claimed_count ?? 0);
      const maxClaims = Number(grantRow.max_claims ?? 1);
      if (claimedCount >= maxClaims || String(grantRow.status) === "claimed") {
        throw new Error("该福利名额已领完");
      }

      creditedTokens = Math.max(0, Math.floor(Number(grantRow.token_amount ?? 0)));
      const nextClaimedCount = claimedCount + 1;
      const nextStatus: VlWelfareStatus = nextClaimedCount >= maxClaims ? "claimed" : "active";

      this.db
        .prepare(
          "UPDATE vl_welfare_grants SET claimed_count = ?, status = ?, updated_at = ? WHERE id = ?",
        )
        .run(nextClaimedCount, nextStatus, now, grantedGrantId);

      this.db
        .prepare(
          "INSERT INTO vl_welfare_claims (id, grant_id, user_id, token_amount, claimed_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(`wclm_${NodeCrypto.randomUUID().slice(0, 12)}`, grantedGrantId, userId, creditedTokens, now);

      if (creditedTokens > 0) {
        const grantPool: VlQuotaPool =
          String(grantRow.quota_pool ?? "deepseek") === "gpt" ? "gpt" : "deepseek";
        if (grantPool === "gpt") {
          const nextGpt = Number(userRow.gpt_balance ?? 0) + creditedTokens;
          this.db
            .prepare(
              "UPDATE vl_users SET gpt_balance = ?, gpt_granted_total = gpt_granted_total + ?, updated_at = ? WHERE id = ?",
            )
            .run(nextGpt, creditedTokens, now, userId);

          this.db
            .prepare(
              `INSERT INTO vl_token_ledger (
                id, user_id, delta, balance_after, reason, quota_pool, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
              ) VALUES (?, ?, ?, ?, 'welfare_redeem_gpt', 'gpt', ?, NULL, 0, 0, ?, ?)`,
            )
            .run(
              `ldg_${NodeCrypto.randomUUID().slice(0, 12)}`,
              userId,
              creditedTokens,
              nextGpt,
              grantedGrantId,
              JSON.stringify({ title: String(grantRow.title ?? ""), code: cleanCode || null, quotaPool: "gpt" }),
              now,
            );
        } else {
          const nextBalance = Number(userRow.token_balance ?? 0) + creditedTokens;
          this.db
            .prepare(
              "UPDATE vl_users SET token_balance = ?, token_granted_total = token_granted_total + ?, updated_at = ? WHERE id = ?",
            )
            .run(nextBalance, creditedTokens, now, userId);

          this.db
            .prepare(
              `INSERT INTO vl_token_ledger (
                id, user_id, delta, balance_after, reason, quota_pool, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
              ) VALUES (?, ?, ?, ?, 'welfare_redeem', 'deepseek_bonus', ?, NULL, 0, 0, ?, ?)`,
            )
            .run(
              `ldg_${NodeCrypto.randomUUID().slice(0, 12)}`,
              userId,
              creditedTokens,
              nextBalance,
              grantedGrantId,
              JSON.stringify({ title: String(grantRow.title ?? ""), code: cleanCode || null, quotaPool: "deepseek" }),
              now,
            );
        }
      }

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    this.recordMutation(true);
    const updatedGrant = this.db
      .prepare("SELECT * FROM vl_welfare_grants WHERE id = ?")
      .get(grantedGrantId) as Record<string, unknown>;
    return {
      grant: this.mapWelfareGrant(updatedGrant, new Set([grantedGrantId])),
      user: this.getUserById(userId)!,
      creditedTokens,
    };
  }

  listUserApiKeys(userId: string, secret = this.fallbackSecret): VlUserApiKeyView[] {
    const rows = this.db
      .prepare("SELECT * FROM vl_user_api_keys WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapApiKey(r, secret));
  }

  createUserApiKey(
    userId: string,
    input: {
      readonly name?: string;
      readonly allowedModels?: ReadonlyArray<string>;
      readonly quotaLimit?: number;
    },
    secret = this.fallbackSecret,
  ): VlUserApiKeyView {
    const user = this.getUserById(userId);
    if (!user) throw new Error("用户不存在");
    const now = Date.now();
    const id = `key_${NodeCrypto.randomUUID().slice(0, 12)}`;
    const rawKey = `sk-vl-${NodeCrypto.randomBytes(24).toString("hex")}`;
    const keyPrefix = `${rawKey.slice(0, 12)}...${rawKey.slice(-4)}`;
    const keyHash = hashSha256Hex(rawKey);
    const ciphertext = encryptWithSecret(rawKey, secret);
    const allowedModels = (input.allowedModels ?? []).map((m) => m.trim()).filter(Boolean);
    const quotaLimit = Math.max(0, Math.floor(Number(input.quotaLimit ?? 0)));
    const name = (input.name ?? "").trim() || `API Key ${new Date(now).toISOString().slice(0, 10)}`;

    this.db
      .prepare(
        `INSERT INTO vl_user_api_keys (
          id, user_id, name, key_prefix, key_hash, key_ciphertext, allowed_models_json,
          quota_limit, tokens_used, revoked, created_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL)`,
      )
      .run(
        id,
        userId,
        name,
        keyPrefix,
        keyHash,
        ciphertext,
        JSON.stringify(allowedModels),
        quotaLimit,
        now,
        now,
      );

    this.recordMutation(true);
    const row = this.db.prepare("SELECT * FROM vl_user_api_keys WHERE id = ?").get(id) as Record<
      string,
      unknown
    >;
    return this.mapApiKey(row, secret);
  }

  revokeUserApiKey(userId: string, keyId: string, isAdmin = false): boolean {
    const row = this.db.prepare("SELECT * FROM vl_user_api_keys WHERE id = ?").get(keyId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return false;
    if (!isAdmin && String(row.user_id) !== userId) {
      throw new Error("无权吊销他人的 API Key");
    }
    this.db
      .prepare("UPDATE vl_user_api_keys SET revoked = 1, updated_at = ? WHERE id = ?")
      .run(Date.now(), keyId);
    this.recordMutation(true);
    return true;
  }

  resolveGatewayApiKey(rawKey: string): {
    user: VlPublicUser;
    keyId: string;
    allowedModels: string[];
    quotaLimit: number;
    keyTokensUsed: number;
    todayUsed: number;
  } | null {
    const clean = rawKey.trim();
    if (!clean.startsWith("sk-vl-")) return null;
    const keyHash = hashSha256Hex(clean);
    const row = this.db
      .prepare(
        `SELECT k.id AS k_id, k.allowed_models_json AS k_allowed_models, k.quota_limit AS k_quota_limit,
                k.tokens_used AS k_tokens_used, k.revoked AS k_revoked,
                u.*
         FROM vl_user_api_keys k
         JOIN vl_users u ON u.id = k.user_id
         WHERE k.key_hash = ?`,
      )
      .get(keyHash) as Record<string, unknown> | undefined;
    if (!row || Boolean(row.k_revoked)) return null;
    const user = this.mapUser(row);
    if (user.status !== "active") return null;

    const startOfDay = new Date(this.now());
    startOfDay.setHours(0, 0, 0, 0);
    const dayRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(-delta), 0) AS used_today
         FROM vl_token_ledger
         WHERE user_id = ? AND delta < 0 AND created_at >= ?`,
      )
      .get(user.id, startOfDay.getTime()) as { used_today?: number } | undefined;

    return {
      user,
      keyId: String(row.k_id),
      allowedModels: parseStringArray(row.k_allowed_models),
      quotaLimit: Number(row.k_quota_limit ?? 0),
      keyTokensUsed: Number(row.k_tokens_used ?? 0),
      todayUsed: Number(dayRow?.used_today ?? 0),
    };
  }

  recordGatewayUsage(input: {
    readonly userId: string;
    readonly keyId: string;
    readonly model: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly chargedTokens: number;
    readonly upstreamId: string;
    readonly quotaPool?: "deepseek" | "gpt" | "manual";
  }): { balanceAfter: number; ledgerId: string } {
    const now = this.now();
    const today = getLocalDateKey(now);
    const charged = Math.max(0, Math.floor(input.chargedTokens));
    const promptTokens = Math.max(0, Math.floor(input.promptTokens));
    const completionTokens = Math.max(0, Math.floor(input.completionTokens));
    const ledgerId = `ldg_${NodeCrypto.randomUUID().slice(0, 12)}`;
    const pool = input.quotaPool ?? classifyGiftModelPool(input.model);
    let balanceAfter = 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const userRow = this.db
        .prepare(
          "SELECT token_balance, deepseek_daily_quota, deepseek_daily_used, deepseek_daily_date, gpt_balance FROM vl_users WHERE id = ?",
        )
        .get(input.userId) as
        | {
            token_balance?: number;
            deepseek_daily_quota?: number;
            deepseek_daily_used?: number;
            deepseek_daily_date?: string;
            gpt_balance?: number;
          }
        | undefined;
      if (!userRow) throw new Error("User not found for gateway usage");

      let ledgerPool: "deepseek_daily" | "deepseek_bonus" | "gpt" = "deepseek_bonus";
      let ledgerMeta: Record<string, unknown> = { upstreamId: input.upstreamId };

      if (pool === "gpt") {
        const nextGpt = Math.max(0, Number(userRow.gpt_balance ?? 0) - charged);
        balanceAfter = nextGpt;
        ledgerPool = "gpt";
        this.db
          .prepare(
            "UPDATE vl_users SET gpt_balance = ?, gpt_used = gpt_used + ?, token_used = token_used + ?, updated_at = ? WHERE id = ?",
          )
          .run(nextGpt, charged, charged, now, input.userId);
      } else if (pool === "deepseek") {
        const dailyQuota = Math.max(
          0,
          Number(userRow.deepseek_daily_quota ?? DEFAULT_DEEPSEEK_DAILY_QUOTA),
        );
        const storedDate = String(userRow.deepseek_daily_date ?? "");
        const prevDailyUsed =
          storedDate === today ? Math.max(0, Number(userRow.deepseek_daily_used ?? 0)) : 0;
        const dailyAvail = Math.max(0, dailyQuota - prevDailyUsed);
        const fromDaily = Math.min(dailyAvail, charged);
        const fromBonus = charged - fromDaily;
        const nextDailyUsed = prevDailyUsed + fromDaily;
        const nextBonus = Math.max(0, Number(userRow.token_balance ?? 0) - fromBonus);

        balanceAfter = Math.max(0, dailyQuota - nextDailyUsed) + nextBonus;
        ledgerPool = fromBonus > 0 ? "deepseek_bonus" : "deepseek_daily";
        ledgerMeta = {
          upstreamId: input.upstreamId,
          fromDaily,
          fromBonus,
          dailyDate: today,
        };

        this.db
          .prepare(
            `UPDATE vl_users
             SET deepseek_daily_used = ?, deepseek_daily_date = ?, token_balance = ?, token_used = token_used + ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(nextDailyUsed, today, nextBonus, charged, now, input.userId);
      } else {
        balanceAfter = Math.max(0, Number(userRow.token_balance ?? 0) - charged);
        ledgerPool = "deepseek_bonus";
        this.db
          .prepare(
            "UPDATE vl_users SET token_balance = ?, token_used = token_used + ?, updated_at = ? WHERE id = ?",
          )
          .run(balanceAfter, charged, now, input.userId);
      }

      this.db
        .prepare(
          "UPDATE vl_user_api_keys SET tokens_used = tokens_used + ?, last_used_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(charged, now, now, input.keyId);

      this.db
        .prepare(
          `INSERT INTO vl_token_ledger (
            id, user_id, delta, balance_after, reason, quota_pool, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
          ) VALUES (?, ?, ?, ?, 'gateway_usage', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ledgerId,
          input.userId,
          -charged,
          balanceAfter,
          ledgerPool,
          input.keyId,
          input.model,
          promptTokens,
          completionTokens,
          JSON.stringify(ledgerMeta),
          now,
        );

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    this.recordMutation(true);
    return { balanceAfter, ledgerId };
  }

  listUpstreams(secret = this.fallbackSecret): VlGatewayUpstreamView[] {
    const rows = this.db
      .prepare("SELECT * FROM vl_gateway_upstreams ORDER BY priority ASC, created_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapUpstream(r, secret));
  }

  upsertUpstream(
    input: {
      readonly id?: string;
      readonly name: string;
      readonly baseUrl: string;
      readonly apiKey?: string;
      readonly models?: ReadonlyArray<string>;
      readonly priority?: number;
      readonly enabled?: boolean;
      readonly rateMultiplier?: number;
    },
    secret = this.fallbackSecret,
  ): VlGatewayUpstreamView {
    const now = Date.now();
    const id = input.id?.trim() || `ups_${NodeCrypto.randomUUID().slice(0, 12)}`;
    const existing = this.db.prepare("SELECT * FROM vl_gateway_upstreams WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;

    const cleanBaseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(cleanBaseUrl)) {
      throw new Error("上游 Base URL 必须以 http:// 或 https:// 开头");
    }

    let apiKeyEnc = existing ? String(existing.api_key_enc ?? "") : "";
    if (typeof input.apiKey === "string" && input.apiKey.trim()) {
      apiKeyEnc = encryptWithSecret(input.apiKey.trim(), secret);
    }
    if (!apiKeyEnc) {
      throw new Error("首次创建上游必须提供 API Key");
    }

    const models = (input.models ?? []).map((m) => m.trim()).filter(Boolean);
    const priority = Math.floor(Number(input.priority ?? existing?.priority ?? 100));
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : Number(existing?.enabled ?? 1);
    const rateMultiplier = Number.isFinite(Number(input.rateMultiplier))
      ? Math.max(0.01, Number(input.rateMultiplier))
      : Number(existing?.rate_multiplier ?? 1);
    const name = input.name.trim() || "默认上游";

    if (existing) {
      this.db
        .prepare(
          `UPDATE vl_gateway_upstreams
           SET name = ?, base_url = ?, api_key_enc = ?, models_json = ?, priority = ?, enabled = ?, rate_multiplier = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          name,
          cleanBaseUrl,
          apiKeyEnc,
          JSON.stringify(models),
          priority,
          enabled,
          rateMultiplier,
          now,
          id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO vl_gateway_upstreams (
            id, name, base_url, api_key_enc, models_json, priority, enabled, rate_multiplier, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name,
          cleanBaseUrl,
          apiKeyEnc,
          JSON.stringify(models),
          priority,
          enabled,
          rateMultiplier,
          now,
          now,
        );
    }

    this.recordMutation(true);
    const row = this.db.prepare("SELECT * FROM vl_gateway_upstreams WHERE id = ?").get(id) as Record<
      string,
      unknown
    >;
    return this.mapUpstream(row, secret);
  }

  deleteUpstream(id: string): boolean {
    const res = this.db.prepare("DELETE FROM vl_gateway_upstreams WHERE id = ?").run(id.trim());
    if (res.changes > 0) {
      this.recordMutation(true);
      return true;
    }
    return false;
  }

  listAvailableModels(allowedModels?: ReadonlyArray<string>): string[] {
    const rows = this.db
      .prepare("SELECT models_json FROM vl_gateway_upstreams WHERE enabled = 1 ORDER BY priority ASC")
      .all() as Array<{ models_json?: string }>;
    const out = new Set<string>();
    for (const r of rows) {
      for (const m of parseStringArray(r.models_json)) {
        if (m === "*") continue;
        if (isModelAllowedByList(allowedModels, m)) {
          out.add(m);
        }
      }
    }
    return Array.from(out);
  }

  pickUpstreamForModel(model: string, secret = this.fallbackSecret): VlGatewayUpstreamSecret | null {
    const target = model.trim();
    const rows = this.db
      .prepare("SELECT * FROM vl_gateway_upstreams WHERE enabled = 1 ORDER BY priority ASC, created_at ASC")
      .all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const models = parseStringArray(r.models_json);
      if (models.length === 0 || isModelAllowedByList(models, target)) {
        return {
          id: String(r.id),
          name: String(r.name),
          baseUrl: String(r.base_url),
          apiKey: decryptWithSecret(String(r.api_key_enc), secret),
          models,
          priority: Number(r.priority ?? 100),
          rateMultiplier: Number(r.rate_multiplier ?? 1),
        };
      }
    }
    return null;
  }

  getMagpieBridgeConfig(): VlMagpieBridgeConfig {
    const stored = this.getClusterMeta<Partial<VlMagpieBridgeConfig>>("magpie_bridge_config", {});
    const allowedModels = sanitizeMagpieGiftAllowedModels(
      Array.isArray(stored.allowedModels)
        ? stored.allowedModels.map((x) => String(x ?? "").trim()).filter(Boolean)
        : undefined,
    );
    const rate = Number(stored.rateMultiplier);
    const urlOverride =
      typeof stored.urlOverride === "string"
        ? stored.urlOverride.trim().replace(/\/+$/, "")
        : DEFAULT_MAGPIE_BRIDGE_CONFIG.urlOverride;
    return {
      enabled: stored.enabled !== false,
      allowedModels,
      rateMultiplier: Number.isFinite(rate) && rate >= 0.01 ? rate : DEFAULT_MAGPIE_BRIDGE_CONFIG.rateMultiplier,
      urlOverride: /^https?:\/\//i.test(urlOverride) ? urlOverride : "",
    };
  }

  setMagpieBridgeConfig(patch: Partial<VlMagpieBridgeConfig>): VlMagpieBridgeConfig {
    const current = this.getMagpieBridgeConfig();
    let urlOverride = current.urlOverride;
    if (typeof patch.urlOverride === "string") {
      const cleaned = patch.urlOverride.trim().replace(/\/+$/, "");
      if (cleaned && !/^https?:\/\//i.test(cleaned)) {
        throw new Error("Magpie 网关地址覆盖必须为空或以 http:// / https:// 开头");
      }
      urlOverride = cleaned;
    }

    let allowedModels = current.allowedModels;
    if (Array.isArray(patch.allowedModels)) {
      const rawList = patch.allowedModels.map((x) => String(x ?? "").trim()).filter(Boolean);
      for (const rawItem of rawList) {
        const cleanItem = rawItem.replace(/^magpie\//i, "");
        if (
          cleanItem.includes("*") ||
          isProhibitedShareModel(cleanItem) ||
          !ALLOWED_MAGPIE_GIFT_MODELS.includes(cleanItem)
        ) {
          throw new Error(
            "合规拦截：仅允许开放 auto/deepseek-v4.1-flash 与 auto/gpt-6.1-sol，禁止通配符或反代 Claude / Gemini 渠道",
          );
        }
      }
      allowedModels = sanitizeMagpieGiftAllowedModels(rawList);
    }

    let rateMultiplier = current.rateMultiplier;
    if (typeof patch.rateMultiplier === "number" && Number.isFinite(patch.rateMultiplier)) {
      rateMultiplier = Math.max(0.01, patch.rateMultiplier);
    }

    const next: VlMagpieBridgeConfig = {
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
      allowedModels,
      rateMultiplier,
      urlOverride,
    };

    this.setClusterMeta("magpie_bridge_config", next, Date.now());
    this.recordMutation(true);
    return next;
  }

  exportReplicationSnapshot(): VlReplicationSnapshot {
    return {
      version: 1,
      syncRevision: this.getSyncRevision(),
      standbyDirty: this.isStandbyDirty(),
      exportedAt: Date.now(),
      magpieBridgeConfig: this.getMagpieBridgeConfig(),
      tables: {
        vl_users: this.db.prepare("SELECT * FROM vl_users ORDER BY created_at ASC").all() as Array<
          Record<string, unknown>
        >,
        vl_user_sessions: this.db
          .prepare("SELECT * FROM vl_user_sessions ORDER BY created_at ASC")
          .all() as Array<Record<string, unknown>>,
        vl_invite_codes: this.db
          .prepare("SELECT * FROM vl_invite_codes ORDER BY created_at ASC")
          .all() as Array<Record<string, unknown>>,
        vl_welfare_grants: this.db
          .prepare("SELECT * FROM vl_welfare_grants ORDER BY created_at ASC")
          .all() as Array<Record<string, unknown>>,
        vl_welfare_claims: this.db
          .prepare("SELECT * FROM vl_welfare_claims ORDER BY claimed_at ASC")
          .all() as Array<Record<string, unknown>>,
        vl_token_ledger: this.db
          .prepare("SELECT * FROM vl_token_ledger ORDER BY created_at ASC")
          .all() as Array<Record<string, unknown>>,
        vl_user_api_keys: this.db
          .prepare("SELECT * FROM vl_user_api_keys ORDER BY created_at ASC")
          .all() as Array<Record<string, unknown>>,
        vl_gateway_upstreams: this.db
          .prepare("SELECT * FROM vl_gateway_upstreams ORDER BY created_at ASC")
          .all() as Array<Record<string, unknown>>,
      },
    };
  }

  applyReplicationSnapshot(
    snapshot: VlReplicationSnapshot,
    options: { readonly force?: boolean } = {},
  ): { applied: boolean; syncRevision: number } {
    const localRev = this.getSyncRevision();
    if (!options.force && snapshot.syncRevision < localRev) {
      return { applied: false, syncRevision: localRev };
    }

    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        DELETE FROM vl_welfare_claims;
        DELETE FROM vl_token_ledger;
        DELETE FROM vl_user_api_keys;
        DELETE FROM vl_user_sessions;
        DELETE FROM vl_welfare_grants;
        DELETE FROM vl_invite_codes;
        DELETE FROM vl_gateway_upstreams;
        DELETE FROM vl_users;
      `);

      const insUser = this.db.prepare(
        `INSERT INTO vl_users (
          id, username, display_name, role, status, password_hash, im_account_id,
          token_balance, token_used, token_granted_total, daily_limit,
          deepseek_daily_quota, deepseek_daily_used, deepseek_daily_date,
          gpt_balance, gpt_used, gpt_granted_total, note,
          created_at, updated_at, last_login_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of snapshot.tables.vl_users) {
        insUser.run(
          String(r.id),
          String(r.username),
          String(r.display_name),
          String(r.role ?? "user"),
          String(r.status ?? "active"),
          String(r.password_hash),
          r.im_account_id ? String(r.im_account_id) : null,
          Number(r.token_balance ?? 0),
          Number(r.token_used ?? 0),
          Number(r.token_granted_total ?? 0),
          Number(r.daily_limit ?? 0),
          Number(r.deepseek_daily_quota ?? DEFAULT_DEEPSEEK_DAILY_QUOTA),
          Number(r.deepseek_daily_used ?? 0),
          String(r.deepseek_daily_date ?? ""),
          Number(r.gpt_balance ?? 0),
          Number(r.gpt_used ?? 0),
          Number(r.gpt_granted_total ?? 0),
          String(r.note ?? ""),
          Number(r.created_at ?? now),
          Number(r.updated_at ?? now),
          r.last_login_at !== null && r.last_login_at !== undefined ? Number(r.last_login_at) : null,
        );
      }

      const insSession = this.db.prepare(
        `INSERT INTO vl_user_sessions (id, user_id, token_hash, device_label, expires_at, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of snapshot.tables.vl_user_sessions) {
        insSession.run(
          String(r.id),
          String(r.user_id),
          String(r.token_hash),
          String(r.device_label ?? ""),
          Number(r.expires_at ?? now),
          Number(r.created_at ?? now),
          Number(r.last_used_at ?? now),
        );
      }

      const insInvite = this.db.prepare(
        `INSERT INTO vl_invite_codes (
          code, created_by, note, grant_tokens, max_uses, used_count, expires_at, disabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of snapshot.tables.vl_invite_codes) {
        insInvite.run(
          String(r.code),
          String(r.created_by),
          String(r.note ?? ""),
          Number(r.grant_tokens ?? 0),
          Number(r.max_uses ?? 1),
          Number(r.used_count ?? 0),
          r.expires_at !== null && r.expires_at !== undefined ? Number(r.expires_at) : null,
          Number(r.disabled ?? 0),
          Number(r.created_at ?? now),
          Number(r.updated_at ?? now),
        );
      }

      const insGrant = this.db.prepare(
        `INSERT INTO vl_welfare_grants (
          id, kind, quota_pool, title, description, target_user_id, code, token_amount, payload_json,
          max_claims, claimed_count, expires_at, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of snapshot.tables.vl_welfare_grants) {
        insGrant.run(
          String(r.id),
          String(r.kind),
          String(r.quota_pool ?? "deepseek") === "gpt" ? "gpt" : "deepseek",
          String(r.title),
          String(r.description ?? ""),
          r.target_user_id ? String(r.target_user_id) : null,
          r.code ? String(r.code) : null,
          Number(r.token_amount ?? 0),
          String(r.payload_json ?? "{}"),
          Number(r.max_claims ?? 1),
          Number(r.claimed_count ?? 0),
          r.expires_at !== null && r.expires_at !== undefined ? Number(r.expires_at) : null,
          String(r.status ?? "active"),
          String(r.created_by ?? "usr_admin"),
          Number(r.created_at ?? now),
          Number(r.updated_at ?? now),
        );
      }

      const insClaim = this.db.prepare(
        `INSERT INTO vl_welfare_claims (id, grant_id, user_id, token_amount, claimed_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const r of snapshot.tables.vl_welfare_claims) {
        insClaim.run(
          String(r.id),
          String(r.grant_id),
          String(r.user_id),
          Number(r.token_amount ?? 0),
          Number(r.claimed_at ?? now),
        );
      }

      const insLedger = this.db.prepare(
        `INSERT INTO vl_token_ledger (
          id, user_id, delta, balance_after, reason, quota_pool, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of snapshot.tables.vl_token_ledger) {
        insLedger.run(
          String(r.id),
          String(r.user_id),
          Number(r.delta ?? 0),
          Number(r.balance_after ?? 0),
          String(r.reason ?? ""),
          String(r.quota_pool ?? "deepseek"),
          r.ref_id ? String(r.ref_id) : null,
          r.model ? String(r.model) : null,
          Number(r.prompt_tokens ?? 0),
          Number(r.completion_tokens ?? 0),
          String(r.meta_json ?? "{}"),
          Number(r.created_at ?? now),
        );
      }

      const insKey = this.db.prepare(
        `INSERT INTO vl_user_api_keys (
          id, user_id, name, key_prefix, key_hash, key_ciphertext, allowed_models_json,
          quota_limit, tokens_used, revoked, created_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of snapshot.tables.vl_user_api_keys) {
        insKey.run(
          String(r.id),
          String(r.user_id),
          String(r.name),
          String(r.key_prefix),
          String(r.key_hash),
          String(r.key_ciphertext),
          String(r.allowed_models_json ?? "[]"),
          Number(r.quota_limit ?? 0),
          Number(r.tokens_used ?? 0),
          Number(r.revoked ?? 0),
          Number(r.created_at ?? now),
          Number(r.updated_at ?? now),
          r.last_used_at !== null && r.last_used_at !== undefined ? Number(r.last_used_at) : null,
        );
      }

      const insUpstream = this.db.prepare(
        `INSERT INTO vl_gateway_upstreams (
          id, name, base_url, api_key_enc, models_json, priority, enabled, rate_multiplier, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of snapshot.tables.vl_gateway_upstreams) {
        insUpstream.run(
          String(r.id),
          String(r.name),
          String(r.base_url),
          String(r.api_key_enc),
          String(r.models_json ?? "[]"),
          Number(r.priority ?? 100),
          Number(r.enabled ?? 1),
          Number(r.rate_multiplier ?? 1),
          Number(r.created_at ?? now),
          Number(r.updated_at ?? now),
        );
      }

      if (snapshot.magpieBridgeConfig && typeof snapshot.magpieBridgeConfig === "object") {
        this.setClusterMeta(
          "magpie_bridge_config",
          {
            ...snapshot.magpieBridgeConfig,
            allowedModels: sanitizeMagpieGiftAllowedModels(snapshot.magpieBridgeConfig.allowedModels),
          },
          now,
        );
      }
      this.setClusterMeta("sync_revision", snapshot.syncRevision, now);
      this.setClusterMeta("standby_dirty", false, now);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    return { applied: true, syncRevision: snapshot.syncRevision };
  }

  mergeStandbyFailoverSnapshot(standbySnapshot: VlReplicationSnapshot): {
    mergedRows: number;
    syncRevision: number;
  } {
    let mergedRows = 0;
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of standbySnapshot.tables.vl_users) {
        const exists = this.db.prepare("SELECT id FROM vl_users WHERE id = ?").get(String(r.id)) as
          | { id?: string }
          | undefined;
        if (!exists) {
          this.db
            .prepare(
              `INSERT INTO vl_users (
                id, username, display_name, role, status, password_hash, im_account_id,
                token_balance, token_used, token_granted_total, daily_limit,
                deepseek_daily_quota, deepseek_daily_used, deepseek_daily_date,
                gpt_balance, gpt_used, gpt_granted_total, note,
                created_at, updated_at, last_login_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 0, ?, 0, 0, 0, ?, ?, ?, ?)`,
            )
            .run(
              String(r.id),
              String(r.username),
              String(r.display_name),
              String(r.role ?? "user"),
              String(r.status ?? "active"),
              String(r.password_hash),
              r.im_account_id ? String(r.im_account_id) : null,
              Number(r.daily_limit ?? 0),
              Number(r.deepseek_daily_quota ?? DEFAULT_DEEPSEEK_DAILY_QUOTA),
              String(r.deepseek_daily_date ?? ""),
              String(r.note ?? ""),
              Number(r.created_at ?? now),
              Number(r.updated_at ?? now),
              r.last_login_at !== null && r.last_login_at !== undefined ? Number(r.last_login_at) : null,
            );
          mergedRows += 1;
        } else if (
          String(r.deepseek_daily_date ?? "") &&
          Number(r.deepseek_daily_used ?? 0) > 0
        ) {
          const cur = this.db
            .prepare("SELECT deepseek_daily_date, deepseek_daily_used FROM vl_users WHERE id = ?")
            .get(String(r.id)) as { deepseek_daily_date?: string; deepseek_daily_used?: number };
          const standbyDate = String(r.deepseek_daily_date ?? "");
          const curDate = String(cur.deepseek_daily_date ?? "");
          if (standbyDate > curDate) {
            this.db
              .prepare("UPDATE vl_users SET deepseek_daily_date = ?, deepseek_daily_used = ? WHERE id = ?")
              .run(standbyDate, Number(r.deepseek_daily_used ?? 0), String(r.id));
            mergedRows += 1;
          } else if (standbyDate === curDate) {
            const maxUsed = Math.max(Number(cur.deepseek_daily_used ?? 0), Number(r.deepseek_daily_used ?? 0));
            if (maxUsed !== Number(cur.deepseek_daily_used ?? 0)) {
              this.db
                .prepare("UPDATE vl_users SET deepseek_daily_used = ? WHERE id = ?")
                .run(maxUsed, String(r.id));
              mergedRows += 1;
            }
          }
        }
      }

      for (const r of standbySnapshot.tables.vl_user_sessions) {
        const res = this.db
          .prepare(
            `INSERT OR IGNORE INTO vl_user_sessions (
              id, user_id, token_hash, device_label, expires_at, created_at, last_used_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            String(r.id),
            String(r.user_id),
            String(r.token_hash),
            String(r.device_label ?? ""),
            Number(r.expires_at ?? now),
            Number(r.created_at ?? now),
            Number(r.last_used_at ?? now),
          );
        mergedRows += res.changes;
      }

      for (const r of standbySnapshot.tables.vl_invite_codes) {
        const existingInv = this.db
          .prepare("SELECT used_count FROM vl_invite_codes WHERE code = ?")
          .get(String(r.code)) as { used_count?: number } | undefined;
        if (existingInv) {
          const nextCount = Math.max(Number(existingInv.used_count ?? 0), Number(r.used_count ?? 0));
          if (nextCount !== Number(existingInv.used_count ?? 0)) {
            this.db
              .prepare("UPDATE vl_invite_codes SET used_count = ?, updated_at = ? WHERE code = ?")
              .run(nextCount, now, String(r.code));
            mergedRows += 1;
          }
        }
      }

      for (const r of standbySnapshot.tables.vl_welfare_claims) {
        const res = this.db
          .prepare(
            `INSERT OR IGNORE INTO vl_welfare_claims (id, grant_id, user_id, token_amount, claimed_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            String(r.id),
            String(r.grant_id),
            String(r.user_id),
            Number(r.token_amount ?? 0),
            Number(r.claimed_at ?? now),
          );
        if (res.changes > 0) {
          this.db
            .prepare(
              `UPDATE vl_welfare_grants
               SET claimed_count = claimed_count + 1,
                   status = CASE WHEN claimed_count + 1 >= max_claims THEN 'claimed' ELSE status END,
                   updated_at = ?
               WHERE id = ?`,
            )
            .run(now, String(r.grant_id));
          mergedRows += 1;
        }
      }

      for (const r of standbySnapshot.tables.vl_user_api_keys) {
        const existingKey = this.db
          .prepare("SELECT tokens_used, revoked FROM vl_user_api_keys WHERE id = ?")
          .get(String(r.id)) as { tokens_used?: number; revoked?: number } | undefined;
        if (!existingKey) {
          const res = this.db
            .prepare(
              `INSERT OR IGNORE INTO vl_user_api_keys (
                id, user_id, name, key_prefix, key_hash, key_ciphertext, allowed_models_json,
                quota_limit, tokens_used, revoked, created_at, updated_at, last_used_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              String(r.id),
              String(r.user_id),
              String(r.name),
              String(r.key_prefix),
              String(r.key_hash),
              String(r.key_ciphertext),
              String(r.allowed_models_json ?? "[]"),
              Number(r.quota_limit ?? 0),
              Number(r.tokens_used ?? 0),
              Number(r.revoked ?? 0),
              Number(r.created_at ?? now),
              Number(r.updated_at ?? now),
              r.last_used_at !== null && r.last_used_at !== undefined ? Number(r.last_used_at) : null,
            );
          mergedRows += res.changes;
        } else {
          const nextUsed = Math.max(Number(existingKey.tokens_used ?? 0), Number(r.tokens_used ?? 0));
          const nextRevoked = Math.max(Number(existingKey.revoked ?? 0), Number(r.revoked ?? 0));
          if (
            nextUsed !== Number(existingKey.tokens_used ?? 0) ||
            nextRevoked !== Number(existingKey.revoked ?? 0)
          ) {
            this.db
              .prepare(
                "UPDATE vl_user_api_keys SET tokens_used = ?, revoked = ?, last_used_at = COALESCE(?, last_used_at), updated_at = ? WHERE id = ?",
              )
              .run(
                nextUsed,
                nextRevoked,
                r.last_used_at !== null && r.last_used_at !== undefined ? Number(r.last_used_at) : null,
                now,
                String(r.id),
              );
            mergedRows += 1;
          }
        }
      }

      const affectedUserIds = new Set<string>();
      for (const r of standbySnapshot.tables.vl_token_ledger) {
        const lid = String(r.id);
        const res = this.db
          .prepare(
            `INSERT OR IGNORE INTO vl_token_ledger (
              id, user_id, delta, balance_after, reason, quota_pool, ref_id, model, prompt_tokens, completion_tokens, meta_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            lid,
            String(r.user_id),
            Number(r.delta ?? 0),
            Number(r.balance_after ?? 0),
            String(r.reason ?? ""),
            String(r.quota_pool ?? "deepseek"),
            r.ref_id ? String(r.ref_id) : null,
            r.model ? String(r.model) : null,
            Number(r.prompt_tokens ?? 0),
            Number(r.completion_tokens ?? 0),
            String(r.meta_json ?? "{}"),
            Number(r.created_at ?? now),
          );
        if (res.changes > 0) {
          mergedRows += 1;
          affectedUserIds.add(String(r.user_id));
        }
      }

      for (const uid of affectedUserIds) {
        const rows = this.db
          .prepare("SELECT delta, quota_pool, meta_json FROM vl_token_ledger WHERE user_id = ?")
          .all(uid) as Array<{ delta?: number; quota_pool?: string; meta_json?: string }>;
        let dsBonusGranted = 0;
        let dsBonusUsed = 0;
        let gptGranted = 0;
        let gptUsed = 0;
        let totalUsed = 0;
        for (const row of rows) {
          const delta = Number(row.delta ?? 0);
          const pool = String(row.quota_pool ?? "deepseek");
          if (delta < 0) totalUsed += -delta;
          if (pool === "gpt") {
            if (delta > 0) gptGranted += delta;
            else if (delta < 0) gptUsed += -delta;
          } else if (pool === "deepseek_daily") {
            // Deducted from daily allowance, does not reduce bonus token_balance
          } else {
            if (delta > 0) {
              dsBonusGranted += delta;
            } else if (delta < 0) {
              const meta = parseJsonObject(row.meta_json);
              const fromBonus =
                typeof meta.fromBonus === "number" ? Math.max(0, meta.fromBonus) : -delta;
              dsBonusUsed += fromBonus;
            }
          }
        }
        this.db
          .prepare(
            `UPDATE vl_users
             SET token_balance = ?, token_used = ?, token_granted_total = ?,
                 gpt_balance = ?, gpt_used = ?, gpt_granted_total = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            Math.max(0, dsBonusGranted - dsBonusUsed),
            Math.max(0, totalUsed),
            Math.max(0, dsBonusGranted),
            Math.max(0, gptGranted - gptUsed),
            Math.max(0, gptUsed),
            Math.max(0, gptGranted),
            now,
            uid,
          );
      }

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    const syncRevision =
      mergedRows > 0 ? this.recordMutation(false) : this.getSyncRevision();
    return { mergedRows, syncRevision };
  }
}
