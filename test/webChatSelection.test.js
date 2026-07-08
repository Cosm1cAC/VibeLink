import assert from "node:assert/strict";
import test from "node:test";

import { selectionStartState } from "../apps/web/src/chatSelection.js";

test("New chat clears desktop conversation mode", () => {
  const state = selectionStartState(null);

  assert.equal(state.selected, null);
  assert.deepEqual(state.messages, []);
  assert.equal(state.running, false);
  assert.equal(state.controlMode, "agent");
});
