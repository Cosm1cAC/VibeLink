import assert from "node:assert/strict";
import test from "node:test";

import {
  listPushSubscriptions,
  revokePushSubscription,
  upsertNativePushToken,
  upsertPushSubscription
} from "../src/db.js";

test("native push tokens are stored separately from Web Push subscriptions", () => {
  const web = upsertPushSubscription({
    deviceId: "device-web",
    subscription: {
      endpoint: `https://push.example/${Date.now()}`,
      keys: { p256dh: "key", auth: "auth" }
    }
  });
  const native = upsertNativePushToken({
    deviceId: "device-android",
    provider: "fcm",
    token: `native-token-${Date.now()}`,
    platform: "android",
    appId: "com.vibelink.app",
    installationId: "install-1"
  });

  try {
    const webItems = listPushSubscriptions();
    const nativeItems = listPushSubscriptions({ kind: "native" });

    assert.ok(webItems.some((item) => item.id === web.id));
    assert.ok(webItems.every((item) => item.kind === "web"));
    assert.ok(nativeItems.some((item) => item.id === native.id));
    assert.ok(nativeItems.every((item) => item.kind === "native"));
    assert.equal(native.provider, "fcm");
    assert.equal(native.platform, "android");
    assert.match(native.endpoint, /^native:fcm:/);
  } finally {
    revokePushSubscription(web.id);
    revokePushSubscription(native.id);
  }
});
