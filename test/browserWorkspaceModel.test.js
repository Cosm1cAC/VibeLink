import assert from "node:assert/strict";
import test from "node:test";

import { browserScreenshotUrl, selectBrowserWorkspace } from "../apps/web/src/browserWorkspaceModel.js";

test("browser workspace preserves valid selection and falls back to the first open page", () => {
  const sessions = [
    { id: "one", pages: [{ id: "closed", status: "closed" }, { id: "open", status: "open" }] },
    { id: "two", pages: [{ id: "other", status: "open" }] }
  ];
  assert.deepEqual(selectBrowserWorkspace(sessions, "two", "other"), { sessionId: "two", pageId: "other" });
  assert.deepEqual(selectBrowserWorkspace(sessions, "missing", "closed"), { sessionId: "one", pageId: "open" });
  assert.deepEqual(selectBrowserWorkspace([], "one", "open"), { sessionId: "", pageId: "" });
});

test("browser screenshot data is rendered only for supported image payloads", () => {
  assert.equal(browserScreenshotUrl({ mimeType: "image/png", dataBase64: "YWJj" }), "data:image/png;base64,YWJj");
  assert.equal(browserScreenshotUrl({ mimeType: "text/html", dataBase64: "YWJj" }), "");
  assert.equal(browserScreenshotUrl({ mimeType: "image/png", dataBase64: "" }), "");
});
