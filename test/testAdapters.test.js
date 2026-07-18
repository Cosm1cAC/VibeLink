import assert from "node:assert/strict";
import test from "node:test";

import { createTestRerunCommand, parseTestOutput, TEST_ADAPTERS, TEST_STATUSES } from "../src/testAdapters.js";

test("parses Jest JSON into the unified suite and case model", () => {
  const report = {
    numPassedTests: 1,
    numFailedTests: 1,
    numPendingTests: 1,
    testResults: [{
      name: "C:\\repo\\src\\sum.test.js",
      status: "failed",
      perfStats: { runtime: 42 },
      assertionResults: [
        { ancestorTitles: ["sum"], title: "adds", fullName: "sum adds", status: "passed", duration: 3, location: { line: 4, column: 3 } },
        { ancestorTitles: ["sum"], title: "subtracts", fullName: "sum subtracts", status: "failed", duration: 5, failureMessages: ["Expected 1, received 2"], location: { line: 8, column: 3 } },
        { ancestorTitles: ["sum"], title: "later", fullName: "sum later", status: "pending", duration: null }
      ]
    }]
  };
  const result = parseTestOutput({ command: "npx jest --json", stdout: JSON.stringify(report), exitCode: 1 });

  assert.equal(result.runner, "jest");
  assert.deepEqual([result.passed, result.failed, result.skipped], [1, 1, 1]);
  assert.deepEqual(result.summary, { pass: 1, fail: 1, skip: 1, durationMs: 42 });
  assert.equal(result.suites[0].type, "suite");
  assert.equal(result.cases[0].type, "case");
  assert.equal(result.suites[0].status, "fail");
  assert.equal(result.suites[0].durationMs, 42);
  assert.deepEqual(result.cases[1].location, { path: "C:\\repo\\src\\sum.test.js", line: 8, column: 3 });
  assert.match(result.cases[1].rerunCommand, /^npx jest --runTestsByPath /);
  assert.equal(result.cases[0].rerunCommand, null);
});

test("parses Vitest JSON and creates only failed-case rerun commands", () => {
  const report = {
    testResults: [{
      name: "src/math.test.ts",
      status: "failed",
      startTime: 100,
      endTime: 112,
      assertionResults: [
        { ancestorTitles: ["math"], title: "multiplies", status: "passed", duration: 2 },
        { ancestorTitles: ["math"], title: "divides", status: "failed", duration: 4, failureMessages: ["division mismatch"] }
      ]
    }]
  };
  const result = parseTestOutput({ command: "pnpm vitest run --reporter=json", stdout: JSON.stringify(report), exitCode: 1 });

  assert.equal(result.runner, "vitest");
  assert.equal(result.suites[0].durationMs, 12);
  assert.equal(result.cases[0].rerunCommand, null);
  assert.match(result.cases[1].rerunCommand, /^npx vitest run /);
  assert.equal(result.failures[0], "division mismatch");
});

test("parses pytest-json-report output with durations, locations, and node-id reruns", () => {
  const report = {
    duration: 0.125,
    summary: { passed: 1, failed: 1, skipped: 1, total: 3 },
    tests: [
      { nodeid: "tests/test_math.py::TestMath::test_add", lineno: 9, outcome: "passed", duration: 0.01 },
      { nodeid: "tests/test_math.py::TestMath::test_divide", lineno: 19, outcome: "failed", duration: 0.02, call: { longrepr: "assert 2 == 3" } },
      { nodeid: "tests/test_math.py::test_future", lineno: 29, outcome: "skipped", duration: 0 }
    ]
  };
  const result = parseTestOutput({ command: "python -m pytest --json-report", stdout: JSON.stringify(report), exitCode: 1 });

  assert.equal(result.runner, "pytest");
  assert.equal(result.durationMs, 125);
  assert.deepEqual(result.cases[1].location, { path: "tests/test_math.py", line: 20 });
  assert.equal(result.cases[1].rerunCommand, createTestRerunCommand("pytest", result.cases[1]));
  assert.match(result.cases[1].rerunCommand, /test_divide/);
});

test("parses common pytest and Vitest console output without a JSON reporter", () => {
  const pytest = parseTestOutput({
    command: "pytest -v",
    stdout: "tests/test_api.py::TestApi::test_ok PASSED [ 50%]\ntests/test_api.py::TestApi::test_bad FAILED [100%]\n1 failed, 1 passed in 0.12s",
    exitCode: 1
  });
  const vitest = parseTestOutput({
    command: "npx vitest run",
    stdout: "\u2713 src/api.test.ts > api > gets data 3ms\n\u00d7 src/api.test.ts > api > rejects bad data 7ms\n Tests  1 failed | 1 passed (2)\n Duration  0.25s",
    exitCode: 1
  });

  assert.deepEqual(pytest.cases.map((item) => item.status), ["pass", "fail"]);
  assert.equal(pytest.durationMs, 120);
  assert.deepEqual(vitest.cases.map((item) => item.status), ["pass", "fail"]);
  assert.equal(vitest.cases[1].location.path, "src/api.test.ts");
  assert.equal(vitest.cases[1].suite, "api");
  assert.equal(vitest.cases[1].durationMs, 7);
  assert.equal(vitest.durationMs, 250);
});

test("keeps the legacy summary fields when a runner cannot expose individual cases", () => {
  const result = parseTestOutput({ command: "npm test", stdout: "2 passed\n", exitCode: 0 });

  assert.equal(result.ok, true);
  assert.equal(result.passed, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.failures, []);
  assert.equal(result.log, "2 passed\n");
  assert.deepEqual(result.suites, []);
  assert.deepEqual(result.cases, []);
  assert.deepEqual([...TEST_STATUSES], ["pass", "fail", "skip"]);
  assert.deepEqual(Object.keys(TEST_ADAPTERS), ["jest", "pytest", "vitest"]);
});
