import webpush from "web-push";
import crypto from "node:crypto";
import { listPushSubscriptions, recordAuditLog, revokePushSubscription } from "./db.js";
import { readSecret } from "./credentialStore.js";

const DEFAULT_SUBJECT = "mailto:vibelink@localhost";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_TOKEN_URL = "https://oauth2.googleapis.com/token";
let fcmAccessTokenCache = { key: "", token: "", expiresAt: 0 };

export function ensureNotificationSettings(settings = {}) {
  const existing = settings.webPush || {};
  if (existing.publicKey && existing.privateKey) return settings;

  const keys = webpush.generateVAPIDKeys();
  return {
    ...settings,
    webPush: {
      ...existing,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: existing.subject || DEFAULT_SUBJECT
    }
  };
}

export function publicNotificationSettings(settings = {}) {
  const webPush = settings.webPush || {};
  const nativePush = settings.nativePush || {};
  return {
    webPush: {
      enabled: Boolean(webPush.publicKey),
      publicKey: webPush.publicKey || ""
    },
    nativePush: {
      provider: nativePush.provider || "fcm",
      fcmProjectId: nativePush.fcmProjectId || "",
      configured: Boolean(process.env.VIBELINK_FCM_SERVICE_ACCOUNT_JSON)
    },
    emailFallback: {
      configured: Boolean(settings.notificationEmail)
    }
  };
}

function configureWebPush(settings = {}) {
  const webPush = settings.webPush || {};
  if (!webPush.publicKey || !webPush.privateKey) return false;
  webpush.setVapidDetails(webPush.subject || DEFAULT_SUBJECT, webPush.publicKey, webPush.privateKey);
  return true;
}

function base64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function fcmServiceAccount(settings = {}) {
  const raw = (await readSecret("fcmServiceAccount")) || process.env.VIBELINK_FCM_SERVICE_ACCOUNT_JSON || "";
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key) throw new Error("FCM service account requires client_email and private_key.");
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      projectId: settings.nativePush?.fcmProjectId || parsed.project_id || ""
    };
  } catch (error) {
    recordAuditLog({ type: "notification.fcm_config", success: false, reason: error.message });
    return null;
  }
}

async function fcmAccessToken(serviceAccount) {
  const key = crypto.createHash("sha256")
    .update(`${serviceAccount.clientEmail}:${serviceAccount.projectId}:${serviceAccount.privateKey}`)
    .digest("hex");
  if (fcmAccessTokenCache.key === key && fcmAccessTokenCache.token && fcmAccessTokenCache.expiresAt > Date.now() + 60_000) {
    return fcmAccessTokenCache.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: serviceAccount.clientEmail,
    scope: FCM_SCOPE,
    aud: FCM_TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).end().sign(serviceAccount.privateKey);
  const assertion = `${unsigned}.${base64Url(signature)}`;
  const response = await fetch(FCM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || body.error || `FCM OAuth failed with HTTP ${response.status}.`);
  }
  fcmAccessTokenCache = {
    key,
    token: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000
  };
  return body.access_token;
}

function fcmDataPayload(notification = {}) {
  return {
    type: String(notification.type || ""),
    tag: String(notification.tag || ""),
    url: String(notification.url || ""),
    at: String(notification.at || "")
  };
}

async function sendNativePushNotifications(settings = {}, notification = {}) {
  const subscriptions = listPushSubscriptions({ kind: "native" });
  if (!subscriptions.length) return { ok: false, sent: 0, configured: false, reason: "No active native push token." };
  if ((settings.nativePush?.provider || "fcm") !== "fcm") {
    return { ok: false, sent: 0, configured: false, reason: "Native push provider is disabled." };
  }
  const serviceAccount = await fcmServiceAccount(settings);
  if (!serviceAccount?.projectId) return { ok: false, sent: 0, configured: false, reason: "FCM service account is not configured." };

  let accessToken;
  try {
    accessToken = await fcmAccessToken(serviceAccount);
  } catch (error) {
    recordAuditLog({ type: "notification.fcm_auth_failed", success: false, reason: error.message });
    return { ok: false, sent: 0, configured: true, reason: error.message };
  }

  let sent = 0;
  for (const item of subscriptions) {
    const token = item.subscription?.token || "";
    if (!token) continue;
    try {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.projectId)}/messages:send`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: {
            token,
            notification: {
              title: notification.title,
              body: notification.body
            },
            data: fcmDataPayload(notification),
            android: {
              priority: "HIGH",
              notification: {
                tag: notification.tag,
                channel_id: "bridge-push"
              }
            }
          }
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = body.error?.message || `FCM send failed with HTTP ${response.status}.`;
        if (response.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/i.test(reason)) revokePushSubscription(item.id);
        recordAuditLog({
          type: "notification.native_failed",
          success: false,
          target: item.id,
          reason,
          meta: { statusCode: response.status, provider: item.subscription?.provider || "fcm" }
        });
        continue;
      }
      sent += 1;
    } catch (error) {
      recordAuditLog({
        type: "notification.native_failed",
        success: false,
        target: item.id,
        reason: error.message
      });
    }
  }

  return { ok: sent > 0, sent, configured: true, subscriptionCount: subscriptions.length };
}

export async function sendCriticalNotification(settings = {}, payload = {}) {
  const subscriptions = listPushSubscriptions();
  const notification = {
    title: payload.title || "VibeLink",
    body: payload.body || "",
    tag: payload.tag || payload.type || "vibelink",
    type: payload.type || "event",
    url: payload.url || "/",
    at: new Date().toISOString(),
    meta: payload.meta || {}
  };

  let sent = 0;
  let webSent = 0;
  let nativeSent = 0;
  let webConfigured = configureWebPush(settings);

  if (subscriptions.length && webConfigured) {
    for (const item of subscriptions) {
      try {
        await webpush.sendNotification(item.subscription, JSON.stringify(notification), { TTL: 60 * 60 });
        webSent += 1;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) revokePushSubscription(item.id);
        recordAuditLog({
          type: "notification.push_failed",
          success: false,
          target: item.endpoint,
          reason: error.message,
          meta: { statusCode: error.statusCode || 0, notification }
        });
      }
    }
    sent += webSent;
  }

  const native = await sendNativePushNotifications(settings, notification);
  nativeSent = native.sent || 0;
  sent += nativeSent;

  if (!sent) {
    if (settings.notificationEmail) {
      recordAuditLog({
        type: "notification.email_fallback",
        success: true,
        target: settings.notificationEmail,
        meta: notification
      });
    }
    return { ok: false, sent: 0, webSent, nativeSent, reason: native.reason || (webConfigured ? "No active push subscription." : "No active Web Push subscription.") };
  }

  recordAuditLog({
    type: "notification.push",
    success: sent > 0,
    target: notification.type,
    meta: { sent, webSent, nativeSent, subscriptionCount: subscriptions.length, notification }
  });
  return { ok: sent > 0, sent, webSent, nativeSent };
}
