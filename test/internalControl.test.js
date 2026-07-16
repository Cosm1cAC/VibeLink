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

test("internal control request restores bounded original audit headers", () => {
  const request = {
    headers: {
      host: "127.0.0.1:49152",
      "user-agent": "internal-client",
      "x-forwarded-for": "127.0.0.1",
      "x-vibelink-original-host": "bridge.vibelink.cloud",
      "x-vibelink-original-user-agent": "VibeLink Android",
      "x-vibelink-original-forwarded-for": "203.0.113.7"
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
  const restored = originalHostRequest(request);

  assert.equal(restored.headers.host, "bridge.vibelink.cloud");
  assert.equal(restored.headers["user-agent"], "VibeLink Android");
  assert.equal(restored.headers["x-forwarded-for"], "203.0.113.7");
  assert.equal(request.headers.host, "127.0.0.1:49152");
  assert.equal(request.headers["user-agent"], "internal-client");
  assert.equal(restored.socket, request.socket);
});

test("internal control request ignores oversized restored headers", () => {
  const request = {
    headers: {
      host: "127.0.0.1:49152",
      "x-vibelink-original-host": "x".repeat(256),
      "x-vibelink-original-user-agent": "u".repeat(513),
      "x-vibelink-original-forwarded-for": "f".repeat(1025)
    }
  };
  const restored = originalHostRequest(request);

  assert.equal(restored.headers.host, "127.0.0.1:49152");
  assert.equal(restored.headers["user-agent"], undefined);
  assert.equal(restored.headers["x-forwarded-for"], undefined);
});
