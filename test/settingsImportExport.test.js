import assert from "node:assert/strict";
import test from "node:test";

import { defaultSettings } from "../src/config.js";
import {
  prepareSettingsMutation,
  buildSettingsExport,
  importSettingsSnapshot,
  publicSettings,
  sanitizeSettingsPatch
} from "../src/store.js";

test("buildSettingsExport omits local secrets and private push keys", async () => {
  const exported = await buildSettingsExport({
    ...defaultSettings,
    defaultCwd: "C:/work/project",
    notificationEmail: "ops@example.com",
    webPush: {
      publicKey: "public-vapid",
      privateKey: "private-vapid",
      subject: "mailto:test@example.com"
    },
    apiKeys: {
      openai: "sk-secret",
      anthropic: "anthropic-secret",
      zhipu: "zhipu-secret"
    }
  });

  assert.equal(exported.kind, "vibelink.settings.export");
  assert.equal(exported.settings.defaultCwd, "C:/work/project");
  assert.equal(exported.settings.notificationEmail, undefined);
  assert.equal(exported.settings.webPush.privateKey, undefined);
  assert.equal(exported.settings.webPush.publicKey, undefined);
  assert.equal(exported.settings.apiKeys, undefined);
});

test("importSettingsSnapshot sanitizes imported settings and preserves existing secrets", () => {
  const current = {
    ...defaultSettings,
    defaultCwd: "C:/old",
    apiKeys: {
      openai: "existing-openai",
      anthropic: "existing-anthropic"
    },
    webPush: {
      publicKey: "current-public",
      privateKey: "current-private",
      subject: "mailto:old@example.com"
    }
  };
  const snapshot = {
    kind: "vibelink.settings.export",
    settings: {
      defaultCwd: "C:/new",
      hostAllowlist: ["example.com", ""],
      security: {
        sandboxMode: "read-only",
        networkAccess: false
      },
      apiKeys: {
        openai: "should-not-import"
      },
      webPush: {
        publicKey: "foreign-public",
        privateKey: "foreign-private",
        subject: "mailto:new@example.com"
      },
      unsupported: "ignored"
    }
  };

  const imported = importSettingsSnapshot(current, snapshot);

  assert.equal(imported.defaultCwd, "C:/new");
  assert.deepEqual(imported.hostAllowlist, ["example.com"]);
  assert.equal(imported.security.sandboxMode, "read-only");
  assert.equal(imported.security.networkAccess, false);
  assert.equal(imported.apiKeys.openai, "existing-openai");
  assert.equal(imported.webPush.publicKey, "current-public");
  assert.equal(imported.webPush.privateKey, "current-private");
  assert.equal(imported.webPush.subject, "mailto:new@example.com");
  assert.equal(imported.unsupported, undefined);
});

test("sanitizeSettingsPatch accepts importable retention and mcp settings", () => {
  const patch = sanitizeSettingsPatch({
    toolEvents: {
      retentionDays: 45,
      keepLatest: 200,
      autoPrune: false,
      autoPruneIntervalMinutes: 30
    },
    mcp: {
      probeTimeoutMs: 5000
    }
  });

  assert.deepEqual(patch.toolEvents, {
    retentionDays: 45,
    keepLatest: 200,
    autoPrune: false,
    autoPruneIntervalMinutes: 30
  });
  assert.equal(patch.mcp.probeTimeoutMs, 5000);
});

test("settings revisions merge disjoint device patches and reject stale same-field writes", () => {
  const base = {
    ...defaultSettings,
    revision: 0,
    _fieldRevisions: {}
  };

  const deviceA = prepareSettingsMutation(base, { defaultCwd: "C:/device-a" }, { expectedRevision: 0 });
  assert.equal(deviceA.settings.revision, 1);

  assert.throws(
    () => prepareSettingsMutation(deviceA.settings, { defaultCwd: "C:/device-b" }, { expectedRevision: 0 }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "SETTINGS_CONFLICT");
      assert.equal(error.expectedRevision, 0);
      assert.equal(error.actualRevision, 1);
      assert.deepEqual(error.conflictingFields, ["defaultCwd"]);
      return true;
    }
  );

  const deviceB = prepareSettingsMutation(deviceA.settings, { permissionMode: "plan" }, { expectedRevision: 0 });
  assert.equal(deviceB.settings.defaultCwd, "C:/device-a");
  assert.equal(deviceB.settings.permissionMode, "plan");
  assert.equal(deviceB.settings.revision, 2);
});

test("public settings expose the current revision without field revision metadata", async () => {
  const settings = await publicSettings({
    ...defaultSettings,
    revision: 7,
    _fieldRevisions: { defaultCwd: 7 }
  });

  assert.equal(settings.revision, 7);
  assert.equal(settings._fieldRevisions, undefined);
});
