import assert from "node:assert/strict";
import test from "node:test";
import { getCommands } from "../src/commandRegistry.js";

test("command registry exposes global navigation and action commands", () => {
  const commands = getCommands();
  for (const id of ["navigate.sessions", "search.global", "session.new", "sessions.refresh", "thread.favorite", "workspace.open", "approvals.review"]) {
    assert.ok(commands.some((command) => command.id === id), id);
  }
  const dangerous = commands.find((command) => command.id === "workspace.command");
  assert.equal(dangerous.requiresApproval, true);
  assert.equal(dangerous.permission, "ask");
});
