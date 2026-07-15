import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(root, "public");

test("public index references only published build assets", () => {
  const index = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const assetPaths = [...index.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
    .map((match) => match[1]);

  assert.ok(assetPaths.length > 0, "public/index.html must reference built assets");

  const missing = assetPaths.filter((assetPath) => {
    const filePath = path.join(publicDir, assetPath.slice(1));
    return !fs.existsSync(filePath) || fs.statSync(filePath).size === 0;
  });

  assert.deepEqual(missing, []);
});
