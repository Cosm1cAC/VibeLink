export function selectBrowserWorkspace(sessions = [], selectedSessionId = "", selectedPageId = "") {
  const session = sessions.find((item) => item.id === selectedSessionId) || sessions[0];
  if (!session) return { sessionId: "", pageId: "" };
  const openPages = (session.pages || []).filter((page) => page.status !== "closed");
  const page = openPages.find((item) => item.id === selectedPageId) || openPages[0];
  return { sessionId: session.id, pageId: page?.id || "" };
}

export function browserScreenshotUrl(screenshot) {
  if (!screenshot?.dataBase64 || !["image/png", "image/jpeg"].includes(screenshot.mimeType)) return "";
  return `data:${screenshot.mimeType};base64,${screenshot.dataBase64}`;
}
