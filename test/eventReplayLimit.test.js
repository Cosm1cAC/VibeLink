import assert from "node:assert/strict";
import test from "node:test";

import { getDefaultEventReplayLimit, resolveEventReplayLimit } from "../src/db.js";

test("db exposes event replay window helpers", () => {
  assert.equal(getDefaultEventReplayLimit(), 500);
  assert.equal(resolveEventReplayLimit(undefined), 500);
  assert.equal(resolveEventReplayLimit(42), 42);
  assert.equal(resolveEventReplayLimit(9000), 5000);
  assert.equal(resolveEventReplayLimit(9000, { maxLimit: 2000 }), 2000);
});
