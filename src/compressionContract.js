export const COMPRESSION_SIDECAR_PROTOCOL_VERSION = 1;

export const COMPRESSION_CONTRACT_METHODS = Object.freeze([
  "trimUtf8",
  "sampleLogLines"
]);

export const COMPRESSION_SIDECAR_CONTROL_METHODS = Object.freeze([
  "__health",
  "stats",
  "__close"
]);

export function serializeCompressionError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
    code: error?.code || ""
  };
}

export function compressionErrorFromPayload(payload = {}) {
  const error = new Error(payload.message || "Compression sidecar request failed.");
  error.name = payload.name || "Error";
  if (payload.stack) error.stack = payload.stack;
  if (payload.code) error.code = payload.code;
  return error;
}
