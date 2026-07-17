import assert from "node:assert/strict";
import test from "node:test";
import { getCommands } from "../src/commandRegistry.js";

test("command registry exposes global navigation and action commands", () => {
  const commands = getCommands();
  for (const id of [
    "navigate.sessions",
    "search.global",
    "session.new",
    "sessions.refresh",
    "thread.favorite",
    "workspace.open",
    "live-call.open",
    "review.open",
    "settings.open",
    "approvals.review"
  ]) {
    assert.ok(commands.some((command) => command.id === id), id);
  }
  const favorite = commands.find((command) => command.id === "thread.favorite");
  assert.equal(favorite.action.type, "thread-patch");
  assert.equal(favorite.action.patch, "favorite");

  const dangerous = commands.find((command) => command.id === "workspace.command");
  assert.equal(dangerous.requiresApproval, true);
  assert.equal(dangerous.permission, "ask");
  assert.equal(dangerous.action.type, "workspace-command");
});

test("command registry filter matches id, usage, label, and tool kind", () => {
  assert.ok(getCommands("workspace.command").some((command) => command.id === "workspace.command"));
  assert.ok(getCommands("Toggle favorite").some((command) => command.id === "thread.favorite"));
  assert.ok(getCommands("thread").some((command) => command.id === "thread.favorite"));
  assert.ok(getCommands("Run Workspace command").some((command) => command.id === "workspace.command"));
});
