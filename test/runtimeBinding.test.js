import assert from "node:assert/strict";
import test from "node:test";
import { applyRuntimeBindingOverrides } from "../src/runtimeBinding.js";

test("runtime binding overrides persisted host and port without mutating settings", () => {
  const settings = { host: "0.0.0.0", port: 60395, pairingToken: "configured" };
  const result = applyRuntimeBindingOverrides(settings, {
    VIBELINK_RUNTIME_HOST: "127.0.0.1",
    VIBELINK_RUNTIME_PORT: "60194"
  });

  assert.deepEqual(result, { host: "127.0.0.1", port: 60194, pairingToken: "configured" });
  assert.deepEqual(settings, { host: "0.0.0.0", port: 60395, pairingToken: "configured" });
});

test("runtime binding rejects non-loopback hosts and invalid ports", () => {
  const settings = { host: "0.0.0.0", port: 8787 };
  const externalHost = applyRuntimeBindingOverrides(settings, {
    VIBELINK_RUNTIME_HOST: "192.168.1.10",
    VIBELINK_RUNTIME_PORT: "49152"
  });
  const invalidPort = applyRuntimeBindingOverrides(settings, {
    VIBELINK_RUNTIME_HOST: "127.0.0.1",
    VIBELINK_RUNTIME_PORT: "70000"
  });

  assert.deepEqual(externalHost, settings);
  assert.deepEqual(invalidPort, settings);
});
