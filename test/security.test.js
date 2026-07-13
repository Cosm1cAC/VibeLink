import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { pairingTokenLogValue } from "../src/security.js";

test("pairing token is hidden from startup logs after a device is paired", () => {
  const pairingToken = crypto.randomBytes(24).toString("hex");
  const value = pairingTokenLogValue({
    settings: { pairingToken, allowLegacyPairingTokenLogin: false },
    devices: [{ id: "device-1", revokedAt: "", expired: false }]
  });

  assert.equal(value, "[hidden; use device pairing]");
  assert.equal(value.includes(pairingToken), false);
});

test("pairing token remains visible for first-device onboarding", () => {
  const pairingToken = crypto.randomBytes(24).toString("hex");
  const value = pairingTokenLogValue({
    settings: { pairingToken, allowLegacyPairingTokenLogin: false },
    devices: []
  });

  assert.equal(value, pairingToken);
});
