export const MCP_SESSION_CONTRACT_METHODS = Object.freeze([
  "probeStdioServer",
  "listTools",
  "callTool",
  "closeIdleSessions",
  "closeAll",
  "stats"
]);

export function serializeMcpSessionError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
    code: error?.code || ""
  };
}

export function mcpSessionErrorFromPayload(payload = {}) {
  const error = new Error(payload.message || "MCP session sidecar request failed.");
  error.name = payload.name || "Error";
  if (payload.stack) error.stack = payload.stack;
  if (payload.code) error.code = payload.code;
  return error;
}
