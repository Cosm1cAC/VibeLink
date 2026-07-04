import webpush from "web-push";
import { listPushSubscriptions, recordAuditLog, revokePushSubscription } from "./db.js";

const DEFAULT_SUBJECT = "mailto:vibelink@localhost";

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
  return {
    webPush: {
      enabled: Boolean(webPush.publicKey),
      publicKey: webPush.publicKey || ""
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

  if (!subscriptions.length || !configureWebPush(settings)) {
    if (settings.notificationEmail) {
      recordAuditLog({
        type: "notification.email_fallback",
        success: true,
        target: settings.notificationEmail,
        meta: notification
      });
    }
    return { ok: false, sent: 0, reason: "No active Web Push subscription." };
  }

  let sent = 0;
  for (const item of subscriptions) {
    try {
      await webpush.sendNotification(item.subscription, JSON.stringify(notification), { TTL: 60 * 60 });
      sent += 1;
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

  recordAuditLog({
    type: "notification.push",
    success: sent > 0,
    target: notification.type,
    meta: { sent, subscriptionCount: subscriptions.length, notification }
  });
  return { ok: sent > 0, sent };
}
