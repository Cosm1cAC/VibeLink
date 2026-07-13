export function parseSupervisorPid(value, currentPid = process.pid) {
  const pid = Number(String(value || "").trim());
  if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) return 0;
  return pid;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function startSupervisorMonitor({
  supervisorPid = parseSupervisorPid(process.env.VIBELINK_SUPERVISOR_PID),
  intervalMs = 1000,
  isAlive = processIsAlive,
  onExit
} = {}) {
  if (!supervisorPid || typeof onExit !== "function") return null;
  let stopping = false;
  const timer = setInterval(() => {
    if (stopping || isAlive(supervisorPid)) return;
    stopping = true;
    clearInterval(timer);
    Promise.resolve()
      .then(() => onExit("SUPERVISOR_EXIT"))
      .catch(() => {});
  }, Math.max(1, Number(intervalMs) || 1000));
  timer.unref?.();
  return timer;
}
