import assert from "node:assert/strict";
import test from "node:test";

import { resolveCompactEventLimit } from "../src/compactService.js";

test("compact service uses a smaller default event window", () => {
  assert.equal(resolveCompactEventLimit(undefined), 1000);
  assert.equal(resolveCompactEventLimit(250), 250);
  assert.equal(resolveCompactEventLimit(9000), 5000);
});
