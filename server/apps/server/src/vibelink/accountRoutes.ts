// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import type { VibeLinkAccountStore, VlPublicUser, VlReplicationSnapshot } from "./accounts.ts";
import { isLoopbackAddress, type VibeLinkAuth } from "./auth.ts";
import type { VibeLinkClusterManager } from "./cluster.ts";
import {
  handleOpenAiGatewayRequest,
  inspectMagpieBridge,
  invalidateMagpieModelCache,
  listMergedAvailableModels,
  type VlMagpieRuntimeAdapter,
} from "./gateway.ts";

export interface VlAuthContext {
  readonly kind: "owner_token" | "loopback_admin" | "user_session";
  readonly user: VlPublicUser;
  readonly isAdmin: boolean;
  readonly sessionToken?: string;
}

export interface AccountHttpResponseSpec {
  readonly status: number;
  readonly json?: unknown;
  readonly rawText?: {
    readonly body: string;
    readonly contentType: string;
  };
}

const RATE_BUCKETS = new Map<string, number[]>();
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAIL_MAX = 10;
const LOGIN_IP_MAX = 30;
const REGISTER_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_IP_MAX = 10;
const REDEEM_WINDOW_MS = 10 * 60 * 1000;
const REDEEM_USER_MAX = 15;

export function resetAuthRateLimits(): void {
  RATE_BUCKETS.clear();
}

function pruneBucket(key: string, windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  const list = (RATE_BUCKETS.get(key) ?? []).filter((ts) => ts > cutoff);
  if (list.length === 0) {
    RATE_BUCKETS.delete(key);
  } else {
    RATE_BUCKETS.set(key, list);
  }
  return list;
}

function isRateLimited(key: string, windowMs: number, maxHits: number, now = Date.now()): boolean {
  return pruneBucket(key, windowMs, now).length >= maxHits;
}

function recordRateHit(key: string, windowMs: number, now = Date.now()): number {
  const list = pruneBucket(key, windowMs, now);
  list.push(now);
  RATE_BUCKETS.set(key, list);
  return list.length;
}

function clearRateBucket(key: string): void {
  RATE_BUCKETS.delete(key);
}

function rateLimitClientIp(remoteAddress?: string | null): string {
  const clean = (remoteAddress ?? "").trim().toLowerCase();
  return clean || "unknown";
}

function getHeader(
  headers: Record<string, string | ReadonlyArray<string> | undefined>,
  name: string,
): string | null {
  const val = headers[name.toLowerCase()];
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0];
  return null;
}

function parseJsonBodySafe(
  raw: string,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly message: string } {
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, message: "Request JSON body must be an object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Invalid JSON body" };
  }
}

export function resolveAuthContext(
  auth: VibeLinkAuth,
  accounts: VibeLinkAccountStore,
  input: {
    readonly headers: Record<string, string | ReadonlyArray<string> | undefined>;
    readonly queryToken?: string | null;
    readonly remoteAddress?: string | null;
  },
): VlAuthContext | null {
  const authorizationHeader = getHeader(input.headers, "authorization");
  const tokenHeader = getHeader(input.headers, "x-vibelink-token");
  const hostHeader = getHeader(input.headers, "host");
  const provided = auth.extractToken({
    authorizationHeader,
    tokenHeader,
    ...(input.queryToken !== undefined ? { queryToken: input.queryToken } : {}),
  });

  if (provided !== null) {
    if (provided.startsWith("vls_")) {
      const resolved = accounts.resolveSessionToken(provided);
      if (!resolved) return null;
      return {
        kind: "user_session",
        user: resolved.user,
        isAdmin: resolved.user.role === "admin",
        sessionToken: provided,
      };
    }
    if (auth.isOwnerToken(provided)) {
      return {
        kind: "owner_token",
        user: accounts.getAdminUser(),
        isAdmin: true,
      };
    }
    return null;
  }

  if (process.env.VIBELINK_REQUIRE_LOOPBACK_AUTH === "1") {
    return null;
  }

  if (isLoopbackAddress(input.remoteAddress, hostHeader, input.headers)) {
    return {
      kind: "loopback_admin",
      user: accounts.getAdminUser(),
      isAdmin: true,
    };
  }

  return null;
}

export async function dispatchAccountAndClusterHttp(
  deps: {
    readonly auth: VibeLinkAuth;
    readonly accounts: VibeLinkAccountStore;
    readonly cluster: VibeLinkClusterManager;
    readonly magpie?: VlMagpieRuntimeAdapter;
  },
  input: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string | ReadonlyArray<string> | undefined>;
    readonly remoteAddress?: string | null;
    readonly bodyText?: string;
  },
): Promise<AccountHttpResponseSpec | null> {
  const parsedUrl = new URL(input.url, "http://127.0.0.1");
  const pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";
  const method = input.method.toUpperCase();

  // OpenAI & Anthropic compatible gateway routes (/v1/* or /api/vl/v1/*)
  if (pathname === "/v1" || pathname.startsWith("/v1/") || pathname.startsWith("/api/vl/v1/")) {
    const subPath = pathname.startsWith("/api/vl/v1/")
      ? pathname.slice("/api/vl/v1".length) || "/"
      : pathname.slice("/v1".length) || "/";
    return handleOpenAiGatewayRequest(
      deps.accounts,
      {
        method,
        subPath,
        headers: input.headers,
        ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
      },
      deps.magpie,
    );
  }

  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== "api" || segments[1] !== "vl") {
    return null;
  }

  const resource = segments[2];
  const isAccountScopedResource =
    resource === "auth" ||
    resource === "welfare" ||
    resource === "admin" ||
    resource === "cluster";
  if (!isAccountScopedResource) {
    return null;
  }

  let body: Record<string, unknown> = {};
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const parsedBody = parseJsonBodySafe(input.bodyText ?? "");
    if (!parsedBody.ok) {
      return { status: 400, json: { error: "invalid_json", message: parsedBody.message } };
    }
    body = parsedBody.value;
  }

  // Cluster internal endpoints authenticated via X-VibeLink-Cluster-Secret (or loopback)
  if (resource === "cluster" && segments[3] !== "nodes") {
    const clusterSecret = getHeader(input.headers, "x-vibelink-cluster-secret");
    const authCtx = resolveAuthContext(deps.auth, deps.accounts, {
      headers: input.headers,
      queryToken: parsedUrl.searchParams.get("token"),
      ...(input.remoteAddress !== undefined ? { remoteAddress: input.remoteAddress } : {}),
    });
    const secretOk = deps.cluster.verifyClusterSecret(clusterSecret) || Boolean(authCtx?.isAdmin);
    if (!secretOk) {
      return { status: 401, json: { error: "unauthorized", message: "Cluster secret or admin auth required" } };
    }

    if (method === "GET" && segments[3] === "status" && segments.length === 4) {
      return {
        status: 200,
        json: deps.cluster.getStatusPayload(getHeader(input.headers, "host")),
      };
    }

    if (method === "GET" && segments[3] === "snapshot" && segments.length === 4) {
      return {
        status: 200,
        json: { ok: true, snapshot: deps.accounts.exportReplicationSnapshot() },
      };
    }

    if (method === "POST" && segments[3] === "replicate" && segments.length === 4) {
      const snapshot = body.snapshot as VlReplicationSnapshot | undefined;
      if (!snapshot || typeof snapshot !== "object" || !snapshot.tables) {
        return { status: 400, json: { error: "invalid_snapshot" } };
      }
      const res = deps.accounts.applyReplicationSnapshot(snapshot, {
        force: Boolean(body.force),
      });
      return { status: 200, json: { ok: true, ...res } };
    }

    if (method === "POST" && segments[3] === "replicate-request" && segments.length === 4) {
      const standbySnapshot = body.standbySnapshot as VlReplicationSnapshot | undefined;
      let mergedRows = 0;
      if (standbySnapshot && standbySnapshot.tables) {
        const merged = deps.accounts.mergeStandbyFailoverSnapshot(standbySnapshot);
        mergedRows = merged.mergedRows;
      }
      return {
        status: 200,
        json: {
          ok: true,
          mergedRows,
          snapshot: deps.accounts.exportReplicationSnapshot(),
        },
      };
    }
  }

  // Public Auth Endpoints
  if (resource === "auth") {
    if (method === "GET" && segments[3] === "config" && segments.length === 4) {
      return {
        status: 200,
        json: {
          ok: true,
          registrationMode: "invite_only",
          cluster: deps.cluster.getPublicSummary(),
          nodes: deps.cluster.getClusterEndpoints(getHeader(input.headers, "host")),
        },
      };
    }

    if (method === "POST" && segments[3] === "login" && segments.length === 4) {
      const clientIp = rateLimitClientIp(input.remoteAddress);
      const rawUser = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const ipBucket = `login_ip:${clientIp}`;
      const failBucket = `login_fail:${clientIp}:${rawUser || "_"}`;
      if (
        recordRateHit(ipBucket, LOGIN_FAIL_WINDOW_MS) > LOGIN_IP_MAX ||
        isRateLimited(failBucket, LOGIN_FAIL_WINDOW_MS, LOGIN_FAIL_MAX)
      ) {
        return {
          status: 429,
          json: { error: "too_many_requests", message: "尝试过于频繁，请 15 分钟后再试" },
        };
      }
      try {
        const result = deps.accounts.login(
          typeof body.username === "string" ? body.username : "",
          typeof body.password === "string" ? body.password : "",
          typeof body.deviceLabel === "string" ? body.deviceLabel : "",
        );
        clearRateBucket(failBucket);
        return { status: 200, json: { ok: true, ...result } };
      } catch (err) {
        recordRateHit(failBucket, LOGIN_FAIL_WINDOW_MS);
        return {
          status: 401,
          json: { error: "login_failed", message: err instanceof Error ? err.message : String(err) },
        };
      }
    }

    if (method === "POST" && segments[3] === "register" && segments.length === 4) {
      const clientIp = rateLimitClientIp(input.remoteAddress);
      if (recordRateHit(`register_ip:${clientIp}`, REGISTER_WINDOW_MS) > REGISTER_IP_MAX) {
        return {
          status: 429,
          json: { error: "too_many_requests", message: "注册请求过于频繁，请稍后再试" },
        };
      }
      if (deps.cluster.getRole() === "standby") {
        const proxied = await deps.cluster.proxyWriteToPrimaryIfOnline({
          method,
          pathAndQuery: `${parsedUrl.pathname}${parsedUrl.search}`,
          headers: input.headers,
          ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
        });
        if (proxied.proxied) {
          return { status: proxied.status, json: proxied.json };
        }
      }
      try {
        const result = deps.accounts.registerWithInvite({
          username: typeof body.username === "string" ? body.username : "",
          password: typeof body.password === "string" ? body.password : "",
          ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
          inviteCode: typeof body.inviteCode === "string" ? body.inviteCode : "",
          ...(typeof body.deviceLabel === "string" ? { deviceLabel: body.deviceLabel } : {}),
        });
        return { status: 201, json: { ok: true, ...result } };
      } catch (err) {
        return {
          status: 400,
          json: { error: "register_failed", message: err instanceof Error ? err.message : String(err) },
        };
      }
    }
  }

  // Remaining account/welfare/cluster-nodes/admin endpoints require auth
  const authCtx = resolveAuthContext(deps.auth, deps.accounts, {
    headers: input.headers,
    queryToken: parsedUrl.searchParams.get("token"),
    ...(input.remoteAddress !== undefined ? { remoteAddress: input.remoteAddress } : {}),
  });
  if (!authCtx) {
    return { status: 401, json: { error: "unauthorized", message: "Valid VibeLink session or token required." } };
  }

  if (resource === "auth") {
    if (method === "GET" && segments[3] === "me" && segments.length === 4) {
      return {
        status: 200,
        json: {
          ok: true,
          authMode: authCtx.kind,
          user: authCtx.user,
          cluster: deps.cluster.getPublicSummary(),
          nodes: deps.cluster.getClusterEndpoints(getHeader(input.headers, "host")),
        },
      };
    }

    if (method === "POST" && segments[3] === "logout" && segments.length === 4) {
      if (authCtx.sessionToken) {
        deps.accounts.logoutSession(authCtx.sessionToken);
      }
      return { status: 200, json: { ok: true } };
    }

    if (method === "POST" && segments[3] === "password" && segments.length === 4) {
      if (deps.cluster.getRole() === "standby") {
        const proxied = await deps.cluster.proxyWriteToPrimaryIfOnline({
          method,
          pathAndQuery: `${parsedUrl.pathname}${parsedUrl.search}`,
          headers: input.headers,
          ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
        });
        if (proxied.proxied) return { status: proxied.status, json: proxied.json };
      }
      try {
        const skipOld = authCtx.kind === "owner_token" || authCtx.kind === "loopback_admin";
        deps.accounts.changePassword(
          authCtx.user.id,
          typeof body.oldPassword === "string" ? body.oldPassword : "",
          typeof body.newPassword === "string" ? body.newPassword : "",
          skipOld,
          authCtx.sessionToken,
        );
        return { status: 200, json: { ok: true } };
      } catch (err) {
        return {
          status: 400,
          json: { error: "password_change_failed", message: err instanceof Error ? err.message : String(err) },
        };
      }
    }
  }

  if (resource === "cluster" && method === "GET" && segments[3] === "nodes" && segments.length === 4) {
    return {
      status: 200,
      json: {
        ok: true,
        cluster: deps.cluster.getPublicSummary(),
        endpoints: deps.cluster.getClusterEndpoints(getHeader(input.headers, "host")),
      },
    };
  }

  // Proxy mutations from Standby -> Primary when Primary is reachable
  if (
    deps.cluster.getRole() === "standby" &&
    method !== "GET" &&
    !(resource === "admin" && segments[3] === "cluster")
  ) {
    const proxied = await deps.cluster.proxyWriteToPrimaryIfOnline({
      method,
      pathAndQuery: `${parsedUrl.pathname}${parsedUrl.search}`,
      headers: input.headers,
      ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
    });
    if (proxied.proxied) {
      return { status: proxied.status, json: proxied.json };
    }
  }

  // User Welfare & Personal API Keys
  if (resource === "welfare") {
    if (method === "GET" && segments[3] === "mine" && segments.length === 4) {
      const data = deps.accounts.listWelfareForUser(authCtx.user.id);
      const merged = await listMergedAvailableModels(deps.accounts, deps.magpie, undefined, data.user);
      return {
        status: 200,
        json: {
          ok: true,
          ...data,
          availableModels: merged.map((m) => m.id),
        },
      };
    }

    if (method === "POST" && segments[3] === "redeem" && segments.length === 4) {
      if (recordRateHit(`redeem_user:${authCtx.user.id}`, REDEEM_WINDOW_MS) > REDEEM_USER_MAX) {
        return {
          status: 429,
          json: { error: "too_many_requests", message: "兑换尝试过于频繁，请 10 分钟后再试" },
        };
      }
      try {
        const res = deps.accounts.redeemCodeOrClaim(authCtx.user.id, {
          ...(typeof body.code === "string" ? { code: body.code } : {}),
          ...(typeof body.grantId === "string" ? { grantId: body.grantId } : {}),
        });
        return { status: 200, json: { ok: true, ...res } };
      } catch (err) {
        return {
          status: 400,
          json: { error: "redeem_failed", message: err instanceof Error ? err.message : String(err) },
        };
      }
    }

    if (method === "GET" && segments[3] === "keys" && segments.length === 4) {
      return {
        status: 200,
        json: { ok: true, keys: deps.accounts.listUserApiKeys(authCtx.user.id) },
      };
    }

    if (method === "POST" && segments[3] === "keys" && segments.length === 4) {
      try {
        const allowedModels = Array.isArray(body.allowedModels)
          ? body.allowedModels.filter((x): x is string => typeof x === "string")
          : [];
        const key = deps.accounts.createUserApiKey(authCtx.user.id, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          allowedModels,
          ...(typeof body.quotaLimit === "number" ? { quotaLimit: body.quotaLimit } : {}),
        });
        return { status: 201, json: { ok: true, key } };
      } catch (err) {
        return {
          status: 400,
          json: { error: "create_key_failed", message: err instanceof Error ? err.message : String(err) },
        };
      }
    }

    if (method === "DELETE" && segments[3] === "keys" && segments[4] && segments.length === 5) {
      try {
        const revoked = deps.accounts.revokeUserApiKey(authCtx.user.id, segments[4], authCtx.isAdmin);
        return revoked
          ? { status: 200, json: { ok: true, keyId: segments[4] } }
          : { status: 404, json: { error: "not_found" } };
      } catch (err) {
        return {
          status: 403,
          json: { error: "forbidden", message: err instanceof Error ? err.message : String(err) },
        };
      }
    }
  }

  // Admin Console Endpoints
  if (resource === "admin") {
    if (!authCtx.isAdmin) {
      return { status: 403, json: { error: "forbidden", message: "仅管理员账号可执行此操作" } };
    }

    const section = segments[3];

    if (section === "users") {
      if (method === "GET" && segments.length === 4) {
        return { status: 200, json: { ok: true, users: deps.accounts.listUsers() } };
      }

      if (method === "POST" && segments.length === 4) {
        try {
          const user = deps.accounts.createUserByAdmin({
            username: typeof body.username === "string" ? body.username : "",
            password: typeof body.password === "string" ? body.password : "",
            ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
            ...(body.role === "admin" || body.role === "user" ? { role: body.role } : {}),
            ...(typeof body.tokenBalance === "number" ? { tokenBalance: body.tokenBalance } : {}),
            ...(typeof body.dailyLimit === "number" ? { dailyLimit: body.dailyLimit } : {}),
            ...(typeof body.deepseekDailyQuota === "number"
              ? { deepseekDailyQuota: body.deepseekDailyQuota }
              : {}),
            ...(typeof body.gptBalance === "number" ? { gptBalance: body.gptBalance } : {}),
            ...(typeof body.note === "string" ? { note: body.note } : {}),
          });
          return { status: 201, json: { ok: true, user } };
        } catch (err) {
          return {
            status: 400,
            json: { error: "create_user_failed", message: err instanceof Error ? err.message : String(err) },
          };
        }
      }

      const targetId = segments[4];
      if (targetId && method === "PATCH" && segments.length === 5) {
        try {
          const user = deps.accounts.updateUserByAdmin(targetId, {
            ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
            ...(body.role === "admin" || body.role === "user" ? { role: body.role } : {}),
            ...(body.status === "active" || body.status === "disabled" ? { status: body.status } : {}),
            ...(typeof body.dailyLimit === "number" ? { dailyLimit: body.dailyLimit } : {}),
            ...(typeof body.deepseekDailyQuota === "number"
              ? { deepseekDailyQuota: body.deepseekDailyQuota }
              : {}),
            ...(typeof body.note === "string" ? { note: body.note } : {}),
            ...(typeof body.resetPassword === "string" ? { resetPassword: body.resetPassword } : {}),
            ...(typeof body.tokenBalanceDelta === "number" ? { tokenBalanceDelta: body.tokenBalanceDelta } : {}),
            ...(typeof body.gptBalanceDelta === "number" ? { gptBalanceDelta: body.gptBalanceDelta } : {}),
            ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
          });
          return { status: 200, json: { ok: true, user } };
        } catch (err) {
          return {
            status: 400,
            json: { error: "update_user_failed", message: err instanceof Error ? err.message : String(err) },
          };
        }
      }

      if (targetId && method === "DELETE" && segments.length === 5) {
        try {
          const deleted = deps.accounts.deleteUserByAdmin(targetId);
          return deleted
            ? { status: 200, json: { ok: true, deletedId: targetId } }
            : { status: 404, json: { error: "not_found" } };
        } catch (err) {
          return {
            status: 400,
            json: { error: "delete_user_failed", message: err instanceof Error ? err.message : String(err) },
          };
        }
      }

      if (targetId && method === "POST" && segments[5] === "grant" && segments.length === 6) {
        try {
          const res = deps.accounts.grantToUserByAdmin(authCtx.user.id, targetId, {
            ...(body.kind === "token_credit" ||
            body.kind === "custom_secret" ||
            body.kind === "notice_gift"
              ? { kind: body.kind }
              : {}),
            ...(body.quotaPool === "gpt" || body.quotaPool === "deepseek"
              ? { quotaPool: body.quotaPool }
              : {}),
            title: typeof body.title === "string" ? body.title : "",
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(typeof body.tokenAmount === "number" ? { tokenAmount: body.tokenAmount } : {}),
            ...(typeof body.payload === "object" && body.payload !== null
              ? { payload: body.payload as Record<string, unknown> }
              : {}),
          });
          return { status: 201, json: { ok: true, ...res } };
        } catch (err) {
          return {
            status: 400,
            json: { error: "grant_failed", message: err instanceof Error ? err.message : String(err) },
          };
        }
      }
    }

    if (section === "invites") {
      if (method === "GET" && segments.length === 4) {
        return { status: 200, json: { ok: true, invites: deps.accounts.listInvites() } };
      }

      if (method === "POST" && segments.length === 4) {
        try {
          const invite = deps.accounts.createInvite(authCtx.user.id, {
            ...(typeof body.code === "string" ? { code: body.code } : {}),
            ...(typeof body.grantTokens === "number" ? { grantTokens: body.grantTokens } : {}),
            ...(typeof body.maxUses === "number" ? { maxUses: body.maxUses } : {}),
            ...(typeof body.expiresInDays === "number" ? { expiresInDays: body.expiresInDays } : {}),
            ...(typeof body.note === "string" ? { note: body.note } : {}),
          });
          return { status: 201, json: { ok: true, invite } };
        } catch (err) {
          return {
            status: 400,
            json: { error: "create_invite_failed", message: err instanceof Error ? err.message : String(err) },
          };
        }
      }

      if (method === "DELETE" && segments[4] && segments.length === 5) {
        const hard = parsedUrl.searchParams.get("hard") === "1";
        const ok = hard
          ? deps.accounts.deleteInvite(segments[4])
          : deps.accounts.revokeInvite(segments[4]);
        return ok
          ? { status: 200, json: { ok: true, code: segments[4] } }
          : { status: 404, json: { error: "not_found" } };
      }
    }

    if (section === "welfare") {
      if (method === "GET" && segments.length === 4) {
        return { status: 200, json: { ok: true, grants: deps.accounts.listAllWelfareGrants() } };
      }

      if (method === "POST" && segments.length === 4) {
        try {
          const grant = deps.accounts.createWelfareGrant(authCtx.user.id, {
            ...(body.kind === "token_credit" ||
            body.kind === "redeem_code" ||
            body.kind === "custom_secret" ||
            body.kind === "notice_gift"
              ? { kind: body.kind }
              : {}),
            ...(body.quotaPool === "gpt" || body.quotaPool === "deepseek"
              ? { quotaPool: body.quotaPool }
              : {}),
            title: typeof body.title === "string" ? body.title : "",
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(typeof body.targetUserId === "string" ? { targetUserId: body.targetUserId } : {}),
            ...(typeof body.code === "string" ? { code: body.code } : {}),
            ...(typeof body.tokenAmount === "number" ? { tokenAmount: body.tokenAmount } : {}),
            ...(typeof body.payload === "object" && body.payload !== null
              ? { payload: body.payload as Record<string, unknown> }
              : {}),
            ...(typeof body.maxClaims === "number" ? { maxClaims: body.maxClaims } : {}),
            ...(typeof body.expiresInDays === "number" ? { expiresInDays: body.expiresInDays } : {}),
          });
          return { status: 201, json: { ok: true, grant } };
        } catch (err) {
          return {
            status: 400,
            json: { error: "create_welfare_failed", message: err instanceof Error ? err.message : String(err) },
          };
        }
      }

      if (method === "DELETE" && segments[4] && segments.length === 5) {
        const hard = parsedUrl.searchParams.get("hard") === "1";
        const ok = hard
          ? deps.accounts.deleteWelfareGrant(segments[4])
          : deps.accounts.revokeWelfareGrant(segments[4]);
        return ok
          ? { status: 200, json: { ok: true, grantId: segments[4] } }
          : { status: 404, json: { error: "not_found" } };
      }
    }

    if (section === "upstreams") {
      if (method === "GET" && segments.length === 4) {
        const forceRefresh = parsedUrl.searchParams.get("refresh") === "1";
        const bridge = await inspectMagpieBridge(deps.accounts, deps.magpie, { forceRefresh });
        return {
          status: 200,
          json: {
            ok: true,
            upstreams: deps.accounts.listUpstreams(),
            magpieBridge: {
              config: bridge.config,
              status: bridge.status,
            },
          },
        };
      }

      if (method === "POST" && segments[4] === "magpie" && segments.length === 5) {
        try {
          const allowedModels = Array.isArray(body.allowedModels)
            ? body.allowedModels.filter((x): x is string => typeof x === "string")
            : typeof body.allowedModels === "string"
              ? body.allowedModels
                  .split(/[,\s]+/)
                  .map((x) => x.trim())
                  .filter(Boolean)
              : undefined;
          deps.accounts.setMagpieBridgeConfig({
            ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
            ...(allowedModels !== undefined ? { allowedModels } : {}),
            ...(typeof body.rateMultiplier === "number" ? { rateMultiplier: body.rateMultiplier } : {}),
            ...(typeof body.urlOverride === "string" ? { urlOverride: body.urlOverride } : {}),
          });
          invalidateMagpieModelCache();
          const bridge = await inspectMagpieBridge(deps.accounts, deps.magpie, { forceRefresh: true });
          return {
            status: 200,
            json: {
              ok: true,
              magpieBridge: {
                config: bridge.config,
                status: bridge.status,
              },
            },
          };
        } catch (err) {
          return {
            status: 400,
            json: {
              error: "magpie_bridge_config_failed",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      }

      if (method === "POST" && segments.length === 4) {
        try {
          const models = Array.isArray(body.models)
            ? body.models.filter((x): x is string => typeof x === "string")
            : typeof body.models === "string"
              ? body.models
                  .split(/[,\s]+/)
                  .map((x) => x.trim())
                  .filter(Boolean)
              : [];
          const upstream = deps.accounts.upsertUpstream({
            ...(typeof body.id === "string" ? { id: body.id } : {}),
            name: typeof body.name === "string" ? body.name : "上游模型池",
            baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
            ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
            models,
            ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
            ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
            ...(typeof body.rateMultiplier === "number" ? { rateMultiplier: body.rateMultiplier } : {}),
          });
          return { status: 200, json: { ok: true, upstream } };
        } catch (err) {
          return {
            status: 400,
            json: { error: "upsert_upstream_failed", message: err instanceof Error ? err.message : String(err) },
          };
        }
      }

      if (method === "DELETE" && segments[4] && segments.length === 5) {
        const ok = deps.accounts.deleteUpstream(segments[4]);
        return ok
          ? { status: 200, json: { ok: true, upstreamId: segments[4] } }
          : { status: 404, json: { error: "not_found" } };
      }
    }

    if (section === "cluster") {
      if (method === "GET" && segments[4] === "status" && segments.length === 5) {
        return {
          status: 200,
          json: deps.cluster.getStatusPayload(getHeader(input.headers, "host")),
        };
      }

      if (method === "POST" && segments[4] === "config" && segments.length === 5) {
        const updated = deps.cluster.updateConfig({
          ...(body.role === "primary" || body.role === "standby" ? { role: body.role } : {}),
          ...(typeof body.nodeId === "string" ? { nodeId: body.nodeId } : {}),
          ...(typeof body.nodeLabel === "string" ? { nodeLabel: body.nodeLabel } : {}),
          ...(typeof body.peerUrl === "string" ? { peerUrl: body.peerUrl } : {}),
          ...(typeof body.primaryTailscaleUrl === "string"
            ? { primaryTailscaleUrl: body.primaryTailscaleUrl }
            : {}),
          ...(typeof body.primaryPublicUrl === "string"
            ? { primaryPublicUrl: body.primaryPublicUrl }
            : {}),
          ...(typeof body.standbyTailscaleUrl === "string"
            ? { standbyTailscaleUrl: body.standbyTailscaleUrl }
            : {}),
          ...(typeof body.standbyPublicUrl === "string"
            ? { standbyPublicUrl: body.standbyPublicUrl }
            : {}),
          ...(typeof body.syncIntervalMs === "number" ? { syncIntervalMs: body.syncIntervalMs } : {}),
        });
        return {
          status: 200,
          json: {
            ok: true,
            status: deps.cluster.getStatusPayload(getHeader(input.headers, "host")),
            config: {
              role: updated.role,
              nodeId: updated.nodeId,
              nodeLabel: updated.nodeLabel,
              peerUrl: updated.peerUrl,
              primaryTailscaleUrl: updated.primaryTailscaleUrl,
              primaryPublicUrl: updated.primaryPublicUrl,
              standbyTailscaleUrl: updated.standbyTailscaleUrl,
              standbyPublicUrl: updated.standbyPublicUrl,
              syncIntervalMs: updated.syncIntervalMs,
            },
          },
        };
      }

      if (method === "POST" && segments[4] === "sync" && segments.length === 5) {
        const result = await deps.cluster.syncWithPeerNow({ force: Boolean(body.force) });
        return {
          status: result.ok ? 200 : 502,
          json: {
            ...result,
            status: deps.cluster.getStatusPayload(getHeader(input.headers, "host")),
          },
        };
      }
    }
  }

  return { status: 404, json: { error: "not_found", path: pathname } };
}
