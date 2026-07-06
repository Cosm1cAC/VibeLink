#!/usr/bin/env node
/**
 * Download a whisper.cpp model.
 *
 * Usage:
 *   node tools/whisper-cpp/download-model.mjs [model-name]
 *
 * Examples:
 *   node tools/whisper-cpp/download-model.mjs base      # ~150MB, recommended for CPU
 *   node tools/whisper-cpp/download-model.mjs small     # ~500MB, more accurate
 *   node tools/whisper-cpp/download-model.mjs tiny      # ~75MB, fastest
 *
 * If no model name provided, downloads `base` by default.
 * The model file is stored in tools/whisper-cpp/models/ and named ggml-{model}.bin.
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { get } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, "models");
const BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const MODELS = ["tiny", "base", "small", "medium", "large-v3"];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const req = get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    });
    req.on("error", (err) => {
      file.close();
      reject(err);
    });
  });
}

async function main() {
  const model = (process.argv[2] || "base").toLowerCase();
  if (!MODELS.includes(model)) {
    console.error(`Available models: ${MODELS.join(", ")}`);
    process.exit(1);
  }

  const filename = `ggml-${model}.bin`;
  const dest = path.join(MODELS_DIR, filename);

  if (existsSync(dest)) {
    const sizeMB = (existsSync(dest) ? 0 : 0); // re-read below
    console.log(`Model already exists: ${dest}`);
    const stat = await import("node:fs/promises").then((m) => m.stat(dest));
    console.log(`  Size: ${(stat.size / 1024 / 1024).toFixed(0)} MB`);
    return;
  }

  mkdirSync(MODELS_DIR, { recursive: true });

  const sizes = { tiny: 75, base: 150, small: 500, medium: 1500, "large-v3": 3000 };
  const sizeMB = sizes[model] || 150;

  console.log(`Downloading ${model} model (~${sizeMB} MB)...`);
  console.log(`URL: ${BASE_URL}/${filename}`);
  console.log(`Dest: ${dest}`);
  console.log(`This may take a few minutes depending on your connection.\n`);

  const start = Date.now();
  try {
    await download(`${BASE_URL}/${filename}`, dest);
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    const stat = await import("node:fs/promises").then((m) => m.stat(dest));
    console.log(`\nDone! Downloaded ${(stat.size / 1024 / 1024).toFixed(0)} MB in ${elapsed}s`);
    console.log(`Model: ${dest}`);
  } catch (err) {
    console.error(`Download failed: ${err.message}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(3);
});
