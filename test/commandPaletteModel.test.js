import assert from "node:assert/strict";
import test from "node:test";

import {
  commandArgumentDraft,
  commandQueryFromText,
  filterCommandCandidates,
  normalizeCommandCandidate,
  paletteCommandDisabledReason,
  resolvePaletteCommandPlan
} from "../apps/web/src/commandPaletteModel.js";

const commands = [
  {
    id: "thread.favorite",
    name: "Toggle favorite",
    description: "Pin or unpin the current session",
    usage: "Toggle favorite <thread-key>",
    toolKind: "thread",
    action: { type: "thread-patch", patch: "favorite" }
  },
  {
    id: "workspace.command",
    name: "Run Workspace command",
    description: "Execute a command in a Workspace after risk checks",
    args: [{ name: "command", type: "string", required: true }],
    usage: "Run Workspace command <command>",
    permission: "ask",
    requiresApproval: true,
    toolKind: "workspace",
    ui: { label: "Workspace shell", detail: "Run a terminal command" },
    action: { type: "workspace-command" }
  }
];

test("normalizes registry commands for display", () => {
  const command = normalizeCommandCandidate(commands[1]);

  assert.equal(command.label, "Workspace shell");
  assert.equal(command.detail, "Run a terminal command");
  assert.equal(command.needsArguments, true);
  assert.equal(command.requiresApproval, true);
});

test("filters commands by id, usage, label, and tool kind", () => {
  assert.deepEqual(filterCommandCandidates(commands, "workspace").map((command) => command.id), ["workspace.command"]);
  assert.deepEqual(filterCommandCandidates(commands, "shell").map((command) => command.id), ["workspace.command"]);
  assert.deepEqual(filterCommandCandidates(commands, "thread").map((command) => command.id), ["thread.favorite"]);
});

test("extracts command query and argument draft from slash text", () => {
  assert.equal(commandQueryFromText("/workspace.command git status --short"), "workspace.command");
  assert.equal(commandArgumentDraft("/workspace.command git status --short"), "git status --short");
  assert.equal(commandQueryFromText("plain text"), "");
});

test("requires a selected session before favorite command can execute", () => {
  assert.equal(paletteCommandDisabledReason(commands[0], {}), "Select a session first");
  assert.equal(paletteCommandDisabledReason(commands[0], { selected: { key: "thread:codex:abc" } }), "");
});

test("plans workspace command argument collection before execution", () => {
  const needsArg = resolvePaletteCommandPlan(commands[1], { workspace: { id: "w1" } }, "/workspace.command");
  assert.equal(needsArg.kind, "needs-argument");
  assert.equal(needsArg.argName, "command");

  const executable = resolvePaletteCommandPlan(commands[1], { workspace: { id: "w1" } }, "/workspace.command git status");
  assert.equal(executable.kind, "execute");
  assert.deepEqual(executable.args, { text: "git status" });
});
