import crypto from "node:crypto";

const FIELD_LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function fieldMatches(source, value, [min, max], sunday = false) {
  const normalized = sunday && value === 0 ? [0, 7] : [value];
  return String(source).split(",").some((part) => {
    const [base, stepText] = part.split("/");
    const step = stepText == null ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return false;
    let start = min;
    let end = max;
    if (base !== "*") {
      const range = base.split("-").map(Number);
      start = range[0];
      end = range.length === 2 ? range[1] : range[0];
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return false;
    return normalized.some((candidate) => candidate >= start && candidate <= end && (candidate - start) % step === 0);
  });
}

function cronMatches(expression, date) {
  const fields = String(expression || "").trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expression must contain five fields.");
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  return fields.every((field, index) => fieldMatches(field, values[index], FIELD_LIMITS[index], index === 4));
}

export function nextAutomationRun(schedule, from = new Date()) {
  const type = String(schedule?.type || "");
  if (type === "once") {
    const target = new Date(schedule.value);
    if (!Number.isFinite(target.getTime()) || target <= from) return null;
    return target;
  }
  if (type === "interval") {
    const intervalMs = Number(schedule.value);
    if (!Number.isInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 365 * 24 * 60 * 60 * 1000) throw new Error("Automation interval must be between one minute and one year.");
    return new Date(from.getTime() + intervalMs);
  }
  if (type === "cron") {
    cronMatches(schedule.value, from);
    const candidate = new Date(from);
    candidate.setUTCSeconds(0, 0);
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    for (let minute = 0; minute < 366 * 24 * 60; minute += 1) {
      if (cronMatches(schedule.value, candidate)) return candidate;
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    }
    throw new Error("Cron expression has no run time within one year.");
  }
  throw new Error("Automation schedule type must be once, interval, or cron.");
}

function fromJson(value, fallback = {}) {
  try { return JSON.parse(value || "null") ?? fallback; } catch { return fallback; }
}

function publicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    enabled: Boolean(row.enabled),
    schedule: { type: row.schedule_type, value: row.schedule_value },
    payload: fromJson(row.payload_json),
    nextRunAt: row.next_run_at || "",
    lastRunAt: row.last_run_at || "",
    lastStatus: row.last_status || "never",
    lastError: row.last_error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createAutomationRuntime({
  database,
  executeAutomation = async () => {},
  now = () => new Date(),
  setTimer = setInterval,
  clearTimer = clearInterval
}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      last_status TEXT NOT NULL DEFAULT 'never',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(enabled, next_run_at);
  `);
  const running = new Set();
  let timer = null;

  const list = () => database.prepare("SELECT * FROM automations ORDER BY updated_at DESC").all().map(publicRow);
  const get = (id) => publicRow(database.prepare("SELECT * FROM automations WHERE id = ?").get(String(id)));

  function create(input = {}) {
    const title = String(input.title || "").trim();
    if (!title || title.length > 200) throw new Error("Automation title is required.");
    const schedule = { type: String(input.schedule?.type || ""), value: String(input.schedule?.value || "") };
    const current = now();
    const next = nextAutomationRun(schedule, current);
    const id = String(input.id || crypto.randomUUID());
    const timestamp = current.toISOString();
    database.prepare("INSERT INTO automations (id,title,enabled,schedule_type,schedule_value,payload_json,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, title, input.enabled && next ? 1 : 0, schedule.type, schedule.value, JSON.stringify(input.payload || {}), next?.toISOString() || null, timestamp, timestamp);
    return get(id);
  }

  function update(id, patch = {}) {
    const current = get(id);
    if (!current) return null;
    const schedule = patch.schedule ? { type: String(patch.schedule.type || ""), value: String(patch.schedule.value || "") } : current.schedule;
    const timestamp = now().toISOString();
    const next = nextAutomationRun(schedule, now());
    const enabled = patch.enabled == null ? current.enabled : Boolean(patch.enabled);
    database.prepare("UPDATE automations SET title=?,enabled=?,schedule_type=?,schedule_value=?,payload_json=?,next_run_at=?,updated_at=? WHERE id=?")
      .run(String(patch.title ?? current.title).trim(), enabled && next ? 1 : 0, schedule.type, schedule.value, JSON.stringify(patch.payload ?? current.payload), next?.toISOString() || null, timestamp, String(id));
    return get(id);
  }

  function remove(id) {
    if (running.has(String(id))) throw new Error("Running automation cannot be removed.");
    return database.prepare("DELETE FROM automations WHERE id = ?").run(String(id)).changes > 0;
  }

  async function run(id) {
    const key = String(id);
    if (running.has(key)) return { started: false, reason: "already_running", automation: get(key) };
    const item = get(key);
    if (!item) return { started: false, reason: "not_found", automation: null };
    running.add(key);
    const startedAt = now();
    database.prepare("UPDATE automations SET last_run_at=?,last_status='running',last_error='',updated_at=? WHERE id=?").run(startedAt.toISOString(), startedAt.toISOString(), key);
    try {
      await executeAutomation(item);
      const next = nextAutomationRun(item.schedule, now());
      database.prepare("UPDATE automations SET enabled=?,next_run_at=?,last_status='succeeded',updated_at=? WHERE id=?")
        .run(item.schedule.type === "once" ? 0 : (item.enabled ? 1 : 0), next?.toISOString() || null, now().toISOString(), key);
      return { started: true, automation: get(key) };
    } catch (error) {
      const next = nextAutomationRun(item.schedule, now());
      database.prepare("UPDATE automations SET enabled=?,next_run_at=?,last_status='failed',last_error=?,updated_at=? WHERE id=?")
        .run(item.schedule.type === "once" ? 0 : (item.enabled ? 1 : 0), next?.toISOString() || null, String(error.message || error).slice(0, 1000), now().toISOString(), key);
      return { started: true, automation: get(key), error: String(error.message || error) };
    } finally {
      running.delete(key);
    }
  }

  async function tick() {
    const due = database.prepare("SELECT id FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 20").all(now().toISOString());
    await Promise.all(due.map((row) => run(row.id)));
    return { due: due.length };
  }

  return {
    list, get, create, update, remove, run, tick,
    start() { if (!timer) { timer = setTimer(() => void tick(), 30_000); timer?.unref?.(); } },
    stop() { if (timer) clearTimer(timer); timer = null; },
    status() { return { running: [...running], count: list().length }; }
  };
}
