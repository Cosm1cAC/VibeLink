import React, { useEffect, useMemo, useState } from "react";
import { Camera, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";

import { browserScreenshotUrl, selectBrowserWorkspace } from "./browserWorkspaceModel.js";

export function BrowserWorkspace({ request, token }) {
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState("");
  const [pageId, setPageId] = useState("");
  const [address, setAddress] = useState("");
  const [screenshot, setScreenshot] = useState(null);
  const [trace, setTrace] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const session = sessions.find((item) => item.id === sessionId) || null;
  const page = session?.pages?.find((item) => item.id === pageId) || null;
  const screenshotUrl = useMemo(() => browserScreenshotUrl(screenshot), [screenshot]);

  async function refreshSessions(preferred = {}) {
    const result = await request("/api/browser-sessions", {}, token);
    const items = result.items || [];
    const selected = selectBrowserWorkspace(
      items,
      preferred.sessionId ?? sessionId,
      preferred.pageId ?? pageId
    );
    setSessions(items);
    setSessionId(selected.sessionId);
    setPageId(selected.pageId);
    const selectedSession = items.find((item) => item.id === selected.sessionId);
    const selectedPage = selectedSession?.pages?.find((item) => item.id === selected.pageId);
    if (selectedPage?.url && selectedPage.url !== "about:blank") setAddress(selectedPage.url);
    return selected;
  }

  async function refreshTrace(targetSessionId = sessionId) {
    if (!targetSessionId) { setTrace([]); return; }
    const result = await request(`/api/browser-sessions/${encodeURIComponent(targetSessionId)}/trace?limit=80`, {}, token);
    setTrace(result.items || []);
  }

  async function run(key, operation) {
    setBusy(key);
    setError("");
    try { await operation(); } catch (err) { setError(err.message); } finally { setBusy(""); }
  }

  useEffect(() => {
    run("refresh", async () => {
      const selected = await refreshSessions({ sessionId: "", pageId: "" });
      await refreshTrace(selected.sessionId);
    });
  }, [token]);

  async function createSession() {
    await run("create", async () => {
      const result = await request("/api/browser-sessions", { method: "POST", body: JSON.stringify({ timeoutMs: 20000, maxTraceEvents: 1000 }) }, token);
      const createdPageId = result.session?.pages?.[0]?.id || "";
      await refreshSessions({ sessionId: result.session.id, pageId: createdPageId });
      setScreenshot(null);
      await refreshTrace(result.session.id);
    });
  }

  async function navigate(event) {
    event.preventDefault();
    if (!sessionId || !pageId || !address.trim()) return;
    await run("navigate", async () => {
      await request(`/api/browser-sessions/${encodeURIComponent(sessionId)}/navigate`, {
        method: "POST",
        body: JSON.stringify({ pageId, url: address.trim(), waitUntil: "domcontentloaded", timeoutMs: 20000 })
      }, token);
      await refreshSessions();
      await captureScreenshot();
      await refreshTrace();
    });
  }

  async function captureScreenshot() {
    if (!sessionId || !pageId) return;
    const result = await request(`/api/browser-sessions/${encodeURIComponent(sessionId)}/screenshot`, {
      method: "POST",
      body: JSON.stringify({ pageId, fullPage: false })
    }, token);
    setScreenshot(result.screenshot || null);
  }

  async function createPage() {
    await run("page", async () => {
      const result = await request(`/api/browser-sessions/${encodeURIComponent(sessionId)}/pages`, { method: "POST", body: "{}" }, token);
      await refreshSessions({ pageId: result.page.id });
      setScreenshot(null);
    });
  }

  async function closeSession() {
    await run("close", async () => {
      await request(`/api/browser-sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }, token);
      setScreenshot(null);
      setTrace([]);
      await refreshSessions({ sessionId: "", pageId: "" });
    });
  }

  function switchSession(nextSessionId) {
    const selected = selectBrowserWorkspace(sessions, nextSessionId, "");
    setSessionId(selected.sessionId);
    setPageId(selected.pageId);
    setScreenshot(null);
    void refreshTrace(selected.sessionId).catch((err) => setError(err.message));
  }

  return (
    <section className="browser-workspace" aria-label="Managed browser workspace">
      <div className="browser-workspace-heading">
        <div>
          <h3>Managed browser</h3>
          <p>Bridge-owned Chromium sessions with redacted navigation, console, and network traces.</p>
        </div>
        <div className="browser-icon-actions">
          <button type="button" title="Refresh sessions" aria-label="Refresh browser sessions" onClick={() => run("refresh", async () => { await refreshSessions(); await refreshTrace(); })} disabled={Boolean(busy)}><RefreshCw size={16} /></button>
          <button type="button" title="New session" aria-label="Create browser session" onClick={createSession} disabled={Boolean(busy)}><Plus size={16} /></button>
          <button type="button" title="Close session" aria-label="Close browser session" onClick={closeSession} disabled={Boolean(busy) || !sessionId}><Trash2 size={16} /></button>
        </div>
      </div>

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!sessions.length ? (
        <div className="browser-empty" role="status">
          <strong>No managed browser session</strong>
          <span>Create one to navigate and inspect a remote page.</span>
          <button className="primary-button" type="button" onClick={createSession} disabled={Boolean(busy)}>Create session</button>
        </div>
      ) : (
        <>
          <div className="browser-session-controls">
            <label><span>Session</span><select value={sessionId} onChange={(event) => switchSession(event.target.value)}>{sessions.map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 8)} · {item.pages?.filter((entry) => entry.status !== "closed").length || 0} page(s)</option>)}</select></label>
            <label><span>Page</span><select value={pageId} onChange={(event) => { setPageId(event.target.value); setScreenshot(null); }}>{(session?.pages || []).filter((item) => item.status !== "closed").map((item) => <option key={item.id} value={item.id}>{item.title || item.url || item.id.slice(0, 8)}</option>)}</select></label>
            <button type="button" title="New page" aria-label="Create browser page" onClick={createPage} disabled={Boolean(busy) || !sessionId}><Plus size={16} /></button>
          </div>
          <form className="browser-address" onSubmit={navigate}>
            <input aria-label="Browser address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="https://example.com" />
            <button className="primary-button" type="submit" disabled={Boolean(busy) || !pageId || !address.trim()}><ExternalLink size={16} /> Open</button>
            <button type="button" title="Capture screenshot" aria-label="Capture browser screenshot" onClick={() => run("screenshot", captureScreenshot)} disabled={Boolean(busy) || !pageId}><Camera size={16} /></button>
          </form>
          <div className="browser-stage" aria-busy={busy === "navigate" || busy === "screenshot"}>
            {screenshotUrl ? <img src={screenshotUrl} alt={`Screenshot of ${page?.title || page?.url || "managed browser page"}`} /> : <span>{busy ? "Working..." : "Navigate or capture a screenshot to inspect the page."}</span>}
          </div>
          <div className="browser-trace">
            <div className="browser-trace-heading"><strong>Trace</strong><span>{trace.length} event(s)</span></div>
            {trace.length ? trace.slice().reverse().map((event) => <div className="browser-trace-row" key={event.seq}><span>{event.type}</span><small>{event.data?.url || event.data?.text || event.at}</small></div>) : <p>No trace events yet.</p>}
          </div>
        </>
      )}
    </section>
  );
}
