import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const rootDir = path.resolve(import.meta.dirname, "..");
const contentScriptPath = path.join(rootDir, "packages", "doubao-cli", "apps", "extension", "src", "content", "doubao-content.js");

function fakeElement(text, score = 100) {
  return {
    className: "assistant message markdown",
    innerText: text,
    textContent: text,
    getBoundingClientRect() {
      return {
        top: score,
        height: 20,
        width: 200
      };
    }
  };
}

function loadContentScript(elements) {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const context = {
    chrome: {
      runtime: {
        onMessage: {
          addListener() {}
        }
      }
    },
    document: {
      title: "Doubao",
      body: { innerText: "" },
      querySelectorAll() {
        return elements;
      }
    },
    getComputedStyle() {
      return {
        display: "block",
        visibility: "visible"
      };
    },
    location: {
      href: "https://www.doubao.com/chat/"
    },
    setTimeout,
    clearTimeout,
    window: {}
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: contentScriptPath });
  return context;
}

test("Doubao content script ignores answers that existed before sending a prompt", () => {
  const context = loadContentScript([fakeElement("old assistant answer")]);

  assert.equal(
    context.__DOUBAO_BRIDGE_CONTENT_INTERNALS__.answerSnapshot("fresh prompt", new Set(["old assistant answer"])),
    ""
  );
});

test("Doubao content script waits for the newest non-ignored answer", async () => {
  const context = loadContentScript([
    fakeElement("new assistant answer", 100),
    fakeElement("old assistant answer", 200)
  ]);

  assert.equal(
    await context.__DOUBAO_BRIDGE_CONTENT_INTERNALS__.waitForAnswer("fresh prompt", 5000, new Set(["old assistant answer"])),
    "new assistant answer"
  );
});
