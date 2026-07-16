export const AUDIO_PIPELINE_PROTOCOL_VERSION = 1;

export const AUDIO_PIPELINE_METHODS = Object.freeze(["processPcm16"]);
export const AUDIO_PIPELINE_CONTROL_METHODS = Object.freeze(["__health", "stats", "__close"]);

export function serializeAudioPipelineError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
    code: error?.code || ""
  };
}

export function audioPipelineErrorFromPayload(payload = {}) {
  const error = new Error(payload.message || "Audio pipeline sidecar request failed.");
  error.name = payload.name || "Error";
  if (payload.stack) error.stack = payload.stack;
  if (payload.code) error.code = payload.code;
  return error;
}
