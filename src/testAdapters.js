const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const TEST_STATUSES = new Set(["pass", "fail", "skip"]);

function cleanOutput(value = "") {
  return String(value || "").replace(ANSI_ESCAPE, "");
}

function positiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function durationMs(value, unit = "ms") {
  const number = positiveNumber(value);
  if (number === null) return null;
  return unit === "s" ? Math.round(number * 1000 * 1000) / 1000 : Math.round(number * 1000) / 1000;
}

function location(path = "", line = null, column = null) {
  const result = { path: String(path || "") };
  const parsedLine = positiveNumber(line);
  const parsedColumn = positiveNumber(column);
  if (parsedLine !== null) result.line = parsedLine;
  if (parsedColumn !== null) result.column = parsedColumn;
  return result;
}

function normalizeStatus(value = "") {
  const status = String(value || "").toLowerCase();
  if (["pass", "passed", "passing", "success", "xpassed"].includes(status)) return "pass";
  if (["fail", "failed", "failing", "failure", "error", "errors"].includes(status)) return "fail";
  if (["skip", "skipped", "pending", "todo", "disabled", "xfail", "xfailed"].includes(status)) return "skip";
  return "";
}

function shellQuote(value, platform = process.platform) {
  const text = String(value || "");
  if (platform === "win32") return `'${text.replaceAll("'", "''")}'`;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

export function createTestRerunCommand(runner, testCase, platform = process.platform) {
  if (!testCase || testCase.status !== "fail") return null;
  const file = testCase.location?.path || "";
  const fullName = testCase.fullName || testCase.name || "";
  if (!file || !fullName) return null;
  if (runner === "pytest") {
    const nodeId = testCase.id || [file, fullName].filter(Boolean).join("::");
    return `python -m pytest ${shellQuote(nodeId, platform)}`;
  }
  if (runner === "vitest") {
    return `npx vitest run ${shellQuote(file, platform)} --testNamePattern ${shellQuote(fullName, platform)}`;
  }
  if (runner === "jest") {
    return `npx jest --runTestsByPath ${shellQuote(file, platform)} --testNamePattern ${shellQuote(fullName, platform)}`;
  }
  return null;
}

function reportJson(text = "") {
  const trimmed = cleanOutput(text).trim();
  if (!trimmed) return null;
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).filter((line) => line.trim().startsWith("{") && line.trim().endsWith("}"))];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && (Array.isArray(value.testResults) || Array.isArray(value.tests))) return value;
    } catch {}
  }
  return null;
}

function detectRunner(command = "", report = null, text = "") {
  const commandText = String(command || "").toLowerCase();
  if (/\b(?:py\.test|pytest)\b/.test(commandText)) return "pytest";
  if (/\bvitest\b/.test(commandText)) return "vitest";
  if (/\bjest\b/.test(commandText)) return "jest";
  if (Array.isArray(report?.tests) || report?.summary && !report?.testResults) return "pytest";
  const output = cleanOutput(text);
  if (/\bvitest\b/i.test(output)) return "vitest";
  if (/\bpytest\b|\btest session starts\b/i.test(output)) return "pytest";
  if (/\btest suites?:\s+.*(?:passed|failed)/i.test(output)) return "jest";
  return report?.testResults ? "jest" : "unknown";
}

function caseFailure(item = {}) {
  const messages = Array.isArray(item.failureMessages) ? item.failureMessages.filter(Boolean) : [];
  return String(messages.join("\n") || item.failure || item.longrepr || item.call?.longrepr || "");
}

function suiteStatus(cases = [], fallback = "") {
  if (cases.some((item) => item.status === "fail")) return "fail";
  if (cases.some((item) => item.status === "pass")) return "pass";
  if (cases.length && cases.every((item) => item.status === "skip")) return "skip";
  return normalizeStatus(fallback) || "skip";
}

function jestLikeCases(report, runner) {
  const suites = [];
  for (const result of report.testResults || []) {
    const file = String(result.name || result.testFilePath || "");
    const cases = (result.assertionResults || result.tests || []).map((item, index) => {
      const ancestors = Array.isArray(item.ancestorTitles) ? item.ancestorTitles.map(String) : [];
      const name = String(item.title || item.name || item.fullName || `case ${index + 1}`);
      const fullName = String(item.fullName || [...ancestors, name].filter(Boolean).join(" "));
      const status = normalizeStatus(item.status || item.state) || "skip";
      const itemLocation = location(file, item.location?.line, item.location?.column);
      const testCase = {
        type: "case",
        id: `${file}::${fullName}`,
        name,
        fullName,
        suite: ancestors.join(" > "),
        status,
        durationMs: durationMs(item.duration),
        location: itemLocation,
        failure: status === "fail" ? caseFailure(item) : ""
      };
      testCase.rerunCommand = createTestRerunCommand(runner, testCase);
      return testCase;
    });
    const measuredDuration = positiveNumber(result.perfStats?.runtime) ?? (
      positiveNumber(result.endTime) !== null && positiveNumber(result.startTime) !== null
        ? Math.max(0, Number(result.endTime) - Number(result.startTime))
        : null
    );
    suites.push({
      type: "suite",
      name: String(result.displayName?.name || file || "test suite"),
      status: suiteStatus(cases, result.status),
      durationMs: measuredDuration,
      location: location(file),
      cases
    });
  }
  return suites;
}

function pytestCases(report) {
  const grouped = new Map();
  for (const [index, item] of (report.tests || []).entries()) {
    const nodeId = String(item.nodeid || item.id || `case-${index + 1}`);
    const parts = nodeId.split("::");
    const file = parts.shift() || String(item.location?.path || "");
    const name = parts.pop() || nodeId;
    const status = normalizeStatus(item.outcome || item.status) || "skip";
    const testCase = {
      type: "case",
      id: nodeId,
      name,
      fullName: parts.length ? `${parts.join("::")}::${name}` : name,
      suite: parts.join("::"),
      status,
      durationMs: durationMs(item.duration, "s"),
      location: location(file, positiveNumber(item.lineno) === null ? null : Number(item.lineno) + 1),
      failure: status === "fail" ? caseFailure(item) : ""
    };
    testCase.rerunCommand = createTestRerunCommand("pytest", testCase);
    if (!grouped.has(file)) grouped.set(file, []);
    grouped.get(file).push(testCase);
  }
  return [...grouped.entries()].map(([file, cases]) => ({
    type: "suite",
    name: file || "pytest",
    status: suiteStatus(cases),
    durationMs: cases.every((item) => item.durationMs === null) ? null : cases.reduce((total, item) => total + (item.durationMs || 0), 0),
    location: location(file),
    cases
  }));
}

function summaryCount(text, status) {
  const patterns = status === "pass"
    ? [/(\d+)\s+(?:passing|passed|tests?\s+passed)\b/i, /(?:^|[,| ])\s*(\d+)\s+passed\b/im]
    : status === "fail"
      ? [/(\d+)\s+(?:failing|failed|tests?\s+failed|failures?)\b/i, /(?:^|[,| ])\s*(\d+)\s+failed\b/im]
      : [/(\d+)\s+(?:skipped|pending|todo)\b/i];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]) || 0;
  }
  return null;
}

function textDuration(text = "") {
  const match = text.match(/(?:\btime\s*:|\bduration\s+|\bin\s+)(\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  return match ? durationMs(match[1], match[2].toLowerCase()) : null;
}

function parsePytestText(text) {
  const cases = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(.+?\.py(?:::[^\s]+)+)\s+(PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)\b/i);
    if (!match) continue;
    const nodeId = match[1];
    const parts = nodeId.split("::");
    const file = parts.shift() || "";
    const name = parts.pop() || nodeId;
    const status = normalizeStatus(match[2]);
    const testCase = {
      type: "case",
      id: nodeId,
      name,
      fullName: [...parts, name].join("::"),
      suite: parts.join("::"),
      status,
      durationMs: null,
      location: location(file),
      failure: ""
    };
    testCase.rerunCommand = createTestRerunCommand("pytest", testCase);
    cases.push(testCase);
  }
  return groupTextCases(cases);
}

function groupTextCases(cases) {
  const grouped = new Map();
  for (const item of cases) {
    const file = item.location.path || "test suite";
    if (!grouped.has(file)) grouped.set(file, []);
    grouped.get(file).push(item);
  }
  return [...grouped.entries()].map(([file, items]) => ({
    type: "suite",
    name: file,
    status: suiteStatus(items),
    durationMs: items.every((item) => item.durationMs === null) ? null : items.reduce((total, item) => total + (item.durationMs || 0), 0),
    location: location(file),
    cases: items
  }));
}

function parseJestLikeText(text, runner) {
  const cases = [];
  let file = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const suiteMatch = line.match(/^(?:PASS|FAIL)\s+(.+?)(?:\s+\(.*\))?$/);
    if (suiteMatch) {
      file = suiteMatch[1].trim();
      continue;
    }
    const caseMatch = line.match(/^(\u2713|\u2714|\u221A|\u2715|\u00D7|\u25CB|\u2193)\s+(.+?)(?:\s+\(?(\d+(?:\.\d+)?)\s*(ms|s)\)?)?$/);
    if (!caseMatch || /\(\d+\s+tests?\)/i.test(line)) continue;
    const marker = caseMatch[1];
    const status = /[\u2715\u00D7]/.test(marker) ? "fail" : /[\u25CB\u2193]/.test(marker) ? "skip" : "pass";
    const nameParts = caseMatch[2].split(/\s+[>\u203A]\s+/).filter(Boolean);
    if (runner === "vitest" && /\.(?:[cm]?[jt]sx?)$/i.test(nameParts[0] || "")) file = nameParts.shift();
    const fullName = nameParts.join(" ") || caseMatch[2];
    const testCase = {
      type: "case",
      id: `${file}::${fullName}`,
      name: nameParts.at(-1) || fullName,
      fullName,
      suite: nameParts.slice(0, -1).join(" > "),
      status,
      durationMs: durationMs(caseMatch[3], caseMatch[4]?.toLowerCase()),
      location: location(file),
      failure: ""
    };
    testCase.rerunCommand = createTestRerunCommand(runner, testCase);
    cases.push(testCase);
  }
  return groupTextCases(cases);
}

function reportSummary(report, suites, exitCode) {
  const cases = suites.flatMap((suite) => suite.cases);
  const source = report?.summary || report || {};
  const count = (status, keys) => {
    const actual = cases.filter((item) => item.status === status).length;
    if (cases.length) return actual;
    for (const key of keys) {
      const value = positiveNumber(source[key]);
      if (value !== null) return value;
    }
    return 0;
  };
  return {
    passed: count("pass", ["passed", "numPassedTests"]),
    failed: count("fail", ["failed", "numFailedTests"]),
    skipped: count("skip", ["skipped", "numPendingTests", "numTodoTests"]),
    ok: Number(exitCode || 0) === 0
  };
}

export function parseTestOutput({ command = "", stdout = "", stderr = "", exitCode = 0, runner: runnerHint = "" } = {}) {
  const log = [stdout, stderr].filter(Boolean).join("\n");
  const text = cleanOutput(log);
  const report = reportJson(stdout) || reportJson(stderr) || reportJson(log);
  const runner = ["jest", "pytest", "vitest"].includes(runnerHint) ? runnerHint : detectRunner(command, report, text);
  let suites = report
    ? runner === "pytest" ? pytestCases(report) : jestLikeCases(report, runner)
    : runner === "pytest" ? parsePytestText(text) : parseJestLikeText(text, runner);
  suites = suites.filter((suite) => suite.cases.length).map((suite) => ({
    ...suite,
    summary: {
      pass: suite.cases.filter((item) => item.status === "pass").length,
      fail: suite.cases.filter((item) => item.status === "fail").length,
      skip: suite.cases.filter((item) => item.status === "skip").length,
      durationMs: suite.durationMs
    }
  }));
  const cases = suites.flatMap((suite) => suite.cases);
  const reportCounts = reportSummary(report, suites, exitCode);
  const textFailures = text.split(/\r?\n/)
    .filter((line) => /\b(fail|failed|error|exception)\b/i.test(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30);
  const passed = cases.length ? reportCounts.passed : summaryCount(text, "pass") ?? (exitCode === 0 ? 1 : 0);
  const failed = cases.length
    ? reportCounts.failed
    : summaryCount(text, "fail") ?? (exitCode === 0 ? 0 : Math.max(1, textFailures.length));
  const skipped = cases.length ? reportCounts.skipped : summaryCount(text, "skip") ?? 0;
  const failures = cases.filter((item) => item.status === "fail").map((item) => item.failure || item.fullName).filter(Boolean);
  if (!failures.length) {
    failures.push(...textFailures);
  }
  const reportDuration = runner === "pytest" ? durationMs(report?.duration, "s") : durationMs(report?.runTime ?? report?.duration);
  const measuredSuiteDuration = suites.some((suite) => suite.durationMs !== null)
    ? suites.reduce((total, suite) => total + (suite.durationMs || 0), 0)
    : null;
  const totalDurationMs = reportDuration ?? textDuration(text) ?? measuredSuiteDuration;
  return {
    ok: Number(exitCode || 0) === 0,
    passed,
    failed,
    failures: failures.slice(0, 30),
    log,
    runner,
    suites,
    cases,
    skipped,
    durationMs: totalDurationMs,
    summary: { pass: passed, fail: failed, skip: skipped, durationMs: totalDurationMs }
  };
}

export function parseJestOutput(input = {}) {
  return parseTestOutput({ ...input, runner: "jest" });
}

export function parsePytestOutput(input = {}) {
  return parseTestOutput({ ...input, runner: "pytest" });
}

export function parseVitestOutput(input = {}) {
  return parseTestOutput({ ...input, runner: "vitest" });
}

export const TEST_ADAPTERS = Object.freeze({
  jest: parseJestOutput,
  pytest: parsePytestOutput,
  vitest: parseVitestOutput
});

export { TEST_STATUSES };
