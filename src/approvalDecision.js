function normalizedDecision(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z]/g, "") : "";
}

export function mapApprovalApiDecision(decision, availableDecisions = []) {
  if (decision !== "approve" && decision !== "deny") return decision;
  const available = Array.isArray(availableDecisions) ? availableDecisions : [];
  const names = available.map((item) => normalizedDecision(
    typeof item === "string" ? item : item?.decision || item?.type
  ));
  const preferred = decision === "approve"
    ? ["grant", "accept", "acceptForSession", "approve"]
    : ["decline", "cancel", "deny"];
  const selected = preferred.find((candidate) => names.includes(normalizedDecision(candidate)));
  if (!selected) return { decision: decision === "approve" ? "accept" : "decline" };
  const original = available[names.indexOf(normalizedDecision(selected))];
  const value = typeof original === "string" ? original : original?.decision || original?.type;
  return { decision: value || selected };
}
