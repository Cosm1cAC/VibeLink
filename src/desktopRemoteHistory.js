function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeMatchText(value) {
  return compactText(value).normalize("NFKC").replace(/[\s"'\`“”‘’。，、,.!?！？:：;；()[\]{}<>《》【】\-_/\\…]+/g, "").toLowerCase();
}

function samePath(left = "", right = "") {
  return compactText(left).toLowerCase() === compactText(right).toLowerCase();
}

function transcriptText(history) {
  return (history?.transcript || []).map((entry) => compactText(entry?.text)).filter(Boolean).join("\n");
}

function visibleSnippets(desktop = {}) {
  return (desktop.visibleTranscript || [])
    .map((entry) => compactText(entry?.text))
    .filter((text) => text.length >= 4 && text.length <= 160);
}

export function scoreDesktopHistoryCandidate(desktop, candidate, history, workspacePath = process.cwd()) {
  if (candidate?.provider !== "codex") return 0;
  let score = 0;
  if (workspacePath && samePath(candidate.projectPath, workspacePath)) score += 24;

  const desktopTitle = normalizeMatchText(desktop?.conversations?.[0]?.title || desktop?.conversations?.[0]?.rawName || "");
  const candidateTitle = normalizeMatchText(candidate?.title || "");
  if (desktopTitle && candidateTitle) {
    if (desktopTitle === candidateTitle) score += 80;
    else if (desktopTitle.length >= 8 && candidateTitle.includes(desktopTitle)) score += 48;
    else if (candidateTitle.length >= 8 && desktopTitle.includes(candidateTitle)) score += 48;
  }

  const blob = transcriptText(history);
  for (const snippet of visibleSnippets(desktop)) {
    if (blob.includes(snippet)) score += 36;
  }

  const ageMs = Date.now() - new Date(candidate?.updatedAt || 0).getTime();
  if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 6 * 60 * 60 * 1000) score += 8;
  return score;
}

export function resolveDesktopHistoryTranscript({ desktop, histories, getHistory, workspacePath = process.cwd(), limit = 80 }) {
  const codexCandidates = (histories || []).filter((item) => item?.provider === "codex");
  const workspaceCandidates = codexCandidates
    .filter((item) => !workspacePath || samePath(item.projectPath, workspacePath))
    .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime());
  const candidates = workspaceCandidates.length ? workspaceCandidates : codexCandidates;
  if (!candidates.length) return null;

  const desktopTitle = normalizeMatchText(desktop?.conversations?.[0]?.title || desktop?.conversations?.[0]?.rawName || "");
  const titleMatch = desktopTitle
    ? candidates.find((candidate) => {
        const title = normalizeMatchText(candidate.title);
        return title === desktopTitle
          || (desktopTitle.length >= 8 && title.includes(desktopTitle))
          || (title.length >= 8 && desktopTitle.includes(title));
      })
    : null;
  const candidate = titleMatch || candidates[0];
  const history = getHistory(candidate.provider, candidate.id);
  if (!history) return null;
  const score = scoreDesktopHistoryCandidate(desktop, candidate, history, workspacePath);
  const snippets = visibleSnippets(desktop);
  const hasVisibleText = (desktop?.visibleTranscript || []).some((entry) => compactText(entry?.text));
  const confident = score >= 60;
  const latestWorkspaceFallback = !hasVisibleText && workspaceCandidates[0]?.id === candidate.id && score >= 24;
  if (!confident && !latestWorkspaceFallback) return null;

  return {
    source: "codex-jsonl",
    sessionId: candidate.id,
    title: candidate.title || "",
    score,
    transcript: (history.transcript || []).slice(-limit).map((entry, index) => ({
      index,
      role: entry.role || "assistant",
      kind: entry.kind || "text",
      text: compactText(entry.text),
      turnId: entry.turnId || "",
      bounds: null,
    })).filter((entry) => entry.text),
  };
}
