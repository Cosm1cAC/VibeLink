import assert from "node:assert/strict";
import test from "node:test";

import { cargoPathOrSkip, probeCargo } from "./rustTestSupport.js";

test("probeCargo accepts working Cargo on Windows without link.exe", () => {
  const calls = [];
  const result = probeCargo({
    platform: "win32",
    homeDir: "C:\\Users\\agent",
    cwd: "C:\\repo",
    fileExists: (candidate) => candidate === "C:\\tools\\cargo.exe",
    run: (command, args) => {
      calls.push({ command, args });
      if (command === "where.exe") {
        assert.deepEqual(args, ["cargo"]);
        return { status: 0, stdout: "C:\\tools\\cargo.exe\r\n", stderr: "" };
      }
      assert.equal(command, "C:\\tools\\cargo.exe");
      assert.deepEqual(args, [
        "metadata",
        "--format-version",
        "1",
        "--no-deps",
        "--manifest-path",
        "apps/windows/Cargo.toml"
      ]);
      return { status: 0, stdout: '{"packages":[]}', stderr: "" };
    }
  });

  assert.deepEqual(result, {
    available: true,
    path: "C:\\tools\\cargo.exe",
    reason: "available",
    commandStatus: 0
  });
  assert.equal(calls.some(({ args }) => args.includes("link.exe")), false);
});

test("cargoPathOrSkip reports a structured reason when Cargo is missing", () => {
  const skips = [];
  const cargo = cargoPathOrSkip({ skip: (message) => skips.push(message) }, {
    env: {},
    probeOptions: {
      platform: "win32",
      homeDir: "C:\\Users\\missing",
      fileExists: () => false,
      run: () => ({ status: 1, stdout: "", stderr: "INFO: no files found" })
    }
  });

  assert.equal(cargo, "");
  assert.equal(skips.length, 1);
  assert.deepEqual(JSON.parse(skips[0].replace("cargo is not available: ", "")), {
    available: false,
    path: "",
    reason: "executable_not_found",
    commandStatus: 1
  });
});

test("cargoPathOrSkip fails closed in CI unless missing Cargo is explicitly allowed", () => {
  let skipped = false;
  assert.throws(
    () => cargoPathOrSkip({ skip: () => { skipped = true; } }, {
      env: { CI: "true" },
      probeOptions: {
        platform: "win32",
        homeDir: "C:\\Users\\missing",
        fileExists: () => false,
        run: () => ({ status: 1, stdout: "", stderr: "" })
      }
    }),
    /Cargo is required in CI.*"reason":"executable_not_found"/
  );
  assert.equal(skipped, false);
});

test("cargoPathOrSkip honors the explicit missing-Cargo CI opt-out", () => {
  const skips = [];
  const cargo = cargoPathOrSkip({ skip: (message) => skips.push(message) }, {
    env: { CI: "true", VIBELINK_ALLOW_MISSING_CARGO: "1" },
    probeOptions: {
      platform: "win32",
      homeDir: "C:\\Users\\missing",
      fileExists: () => false,
      run: () => ({ status: 1, stdout: "", stderr: "" })
    }
  });

  assert.equal(cargo, "");
  assert.match(skips[0], /"reason":"executable_not_found"/);
});
