import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = "glm-5.2";

export function zhipuCliPath() {
  return path.join(__dirname, "zhipuCli.mjs");
}

export function zhipuAgentArgs(payload = {}) {
  const args = ["--json", "--prompt", String(payload.prompt || "")];
  if (payload.model) args.push("--model", String(payload.model));
  else args.push("--model", DEFAULT_MODEL);
  if (payload.reasoningEffort) args.push("--effort", String(payload.reasoningEffort));
  if (payload.timeoutMs) args.push("--timeout-ms", String(payload.timeoutMs));
  return args;
}
