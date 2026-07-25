import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDesktopTarget } from "../src/desktopObserver.js";

test("desktop transcript excludes text to the right of the bottom composer action", () => {
  const desktop = normalizeDesktopTarget({
    ok: true,
    target: {
      found: true,
      windowBounds: { x: 0, y: 0, width: 2578, height: 1398 },
      sendBounds: { x: 1695, y: 1316, width: 36, height: 35 },
      visibleTranscript: [
        { role: "assistant", text: "Main Codex response", bounds: { x: 900, y: 700, width: 700, height: 80 } },
        { role: "assistant", text: "E13 排版质量差", bounds: { x: 1945, y: 700, width: 180, height: 30 } },
      ],
    },
  });

  assert.deepEqual(desktop.visibleTranscript.map((item) => item.text), ["Main Codex response"]);
});

test("desktop transcript keeps observations when composer geometry is unavailable", () => {
  const desktop = normalizeDesktopTarget({
    ok: true,
    target: {
      found: true,
      visibleTranscript: [
        { role: "assistant", text: "Visible response", bounds: { x: 100, y: 100, width: 400, height: 40 } },
      ],
    },
  });

  assert.deepEqual(desktop.visibleTranscript.map((item) => item.text), ["Visible response"]);
});
