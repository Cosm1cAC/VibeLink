const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

export function applyRuntimeBindingOverrides(settings = {}, environment = process.env) {
  const host = String(environment.VIBELINK_RUNTIME_HOST || "").trim().toLowerCase();
  const rawPort = String(environment.VIBELINK_RUNTIME_PORT || "").trim();
  const port = Number(rawPort);
  if (!loopbackHosts.has(host) || !rawPort || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ...settings };
  }
  return { ...settings, host, port };
}
