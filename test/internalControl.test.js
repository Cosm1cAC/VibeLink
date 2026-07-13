import assert from "node:assert/strict";
import test from "node:test";
import { internalControlAuthorized, originalHostRequest } from "../src/internalControl.js";

test("internal control requires loopback and an exact non-empty process token", () => {
  const configuredToken = "a".repeat(64);
  const request = (remoteAddress, providedToken) => ({
    socket: { remoteAddress },
    headers: { "x-vibelink-internal-token": providedToken }
  });

  assert.equal(internalControlAuthorized(request("127.0.0.1", configuredToken), configuredToken), true);
  assert.equal(internalControlAuthorized(request("::1", configuredToken), configuredToken), true);
  assert.equal(internalControlAuthorized(request("::ffff:127.0.0.1", configuredToken), configuredToken), true);
  assert.equal(internalControlAuthorized(request("192.168.1.10", configuredToken), configuredToken), false);
  assert.equal(internalControlAuthorized(request("127.0.0.1", "b".repeat(64)), configuredToken), false);
  assert.equal(internalControlAuthorized(request("127.0.0.1", "short"), configuredToken), false);
  assert.equal(internalControlAuthorized(request("127.0.0.1", configuredToken), ""), false);
});

test("internal snapshot request restores only the authenticated original host", () => {
  const request = {
    headers: { host: "127.0.0.1:49152", "x-vibelink-original-host": "bridge.vibelink.cloud" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  const restored = originalHostRequest(request);

  assert.equal(restored.headers.host, "bridge.vibelink.cloud");
  assert.equal(request.headers.host, "127.0.0.1:49152");
  assert.equal(restored.socket, request.socket);
});
