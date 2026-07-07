function mcpToolNameFromBody(body = {}) {
  if (body.toolName) return String(body.toolName || "");
  const parts = String(body.fullName || body.name || "").split("__");
  if (parts[0] === "mcp" && parts.length >= 3) return parts.slice(2).join("__");
  return "";
}

export function mcpCallApprovalRisk(body = {}, policy = {}) {
  const toolName = mcpToolNameFromBody(body).toLowerCase();
  const args = body.arguments && typeof body.arguments === "object" ? body.arguments : {};
  const manageAdrUpdate = toolName === "manage_adr" && !["get", "sections"].includes(String(args.mode || "").toLowerCase());
  const mutating = Boolean(
    manageAdrUpdate ||
    /^(delete|remove|write|update|create|index|ingest|prune|reset|install|uninstall)_/.test(toolName) ||
    /_(delete|remove|write|update|create|index|ingest|prune|reset)$/.test(toolName)
  );
  const required = Boolean(policy.requireDangerousCommandApproval !== false && mutating);
  const reason = `MCP tool may modify local state: ${toolName || "unknown"}`;
  return {
    risky: mutating,
    required,
    reasons: required ? [reason] : [],
    matches: required
      ? [{ code: "mcp_mutating_tool", severity: "medium", reason, toolName, policy: "requireDangerousCommandApproval=true" }]
      : []
  };
}
