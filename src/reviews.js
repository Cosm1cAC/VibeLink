import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

const reviewPath = path.join(dataDir, "reviews.json");

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function save(items) {
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  return items;
}

export function listReviews() { return load().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }

export function getReview(id) { return load().find((item) => item.id === id) || null; }

export function createReview(input = {}) {
  const now = new Date().toISOString();
  const review = {
    id: crypto.randomUUID(), workspaceId: String(input.workspaceId || ""), branch: String(input.branch || ""),
    title: String(input.title || "PR Review").trim().slice(0, 200), status: "open", files: Array.isArray(input.files) ? input.files : [], comments: [],
    createdAt: now, updatedAt: now
  };
  save([...load(), review]);
  return review;
}

export function updateReview(id, patch = {}) {
  const items = load();
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const current = items[index];
  items[index] = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
  save(items);
  return items[index];
}

export function addReviewComment(id, input = {}) {
  const review = getReview(id);
  if (!review) return null;
  const comment = {
    id: crypto.randomUUID(), file: String(input.file || ""), line: Number(input.line || 0) || 0,
    body: String(input.body || "").trim().slice(0, 4000), severity: ["critical", "high", "medium", "low", "info"].includes(input.severity) ? input.severity : "info",
    status: "open", createdAt: new Date().toISOString()
  };
  return updateReview(id, { comments: [...review.comments, comment] });
}

