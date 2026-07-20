import React, { useEffect, useState } from "react";
import { Download, Play, RefreshCw, Save, Trash2 } from "lucide-react";

import { automationDraftPayload, capabilityCategories, capabilityOperationMessage } from "./capabilityCenterModel.js";

export function CapabilityCenter({ request, token }) {
  const [category, setCategory] = useState("plugins");
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [plugin, setPlugin] = useState({ id: "", name: "", version: "" });
  const [automation, setAutomation] = useState({ title: "", type: "interval", value: "3600000", prompt: "" });
  const [configDrafts, setConfigDrafts] = useState({});
  const [subagent, setSubagent] = useState({ parentTaskId: "", prompt: "", agent: "codex" });

  async function refresh(nextCategory = category) {
    const result = await request(`/api/capabilities/${nextCategory}`, {}, token);
    setItems(result.items || []);
    setConfigDrafts(Object.fromEntries((result.items || []).map((item) => [item.id, item.preview || ""])));
  }

  async function run(key, operation, successText = "Operation completed.") {
    setBusy(key); setError(""); setNotice(null);
    try { await operation(); setNotice(capabilityOperationMessage(null, successText)); await refresh(); }
    catch (failure) { const result = capabilityOperationMessage(failure); if (result.tone === "error") setError(result.text); else setNotice(result); }
    finally { setBusy(""); }
  }

  useEffect(() => { setItems([]); run("refresh", () => refresh(category)); }, [category, token]);

  async function installPlugin(event) {
    event.preventDefault();
    await run("plugin-install", async () => {
      await request("/api/capabilities/plugins", { method: "POST", body: JSON.stringify({ id: plugin.id.trim(), manifest: { name: plugin.name.trim(), version: plugin.version.trim() } }) }, token);
      setPlugin({ id: "", name: "", version: "" });
    });
  }

  async function createAutomation(event) {
    event.preventDefault();
    await run("automation-create", async () => {
      await request("/api/automations", { method: "POST", body: JSON.stringify(automationDraftPayload(automation)) }, token);
      setAutomation({ title: "", type: "interval", value: "3600000", prompt: "" });
    });
  }

  async function createSubagent(event) {
    event.preventDefault();
    await run("subagent-create", async () => {
      await request("/api/subagents", { method: "POST", body: JSON.stringify({ parentTaskId: subagent.parentTaskId.trim(), prompt: subagent.prompt.trim(), agent: subagent.agent }) }, token);
      setSubagent({ parentTaskId: "", prompt: "", agent: "codex" });
    }, "Subagent started.");
  }

  return (
    <section className="capability-center" aria-label="Capability center">
      <div className="capability-heading"><div><h3>Capability center</h3><p>Managed lifecycle and source-aware Agent configuration.</p></div><button type="button" title="Refresh capabilities" aria-label="Refresh capabilities" onClick={() => run("refresh", refresh)} disabled={Boolean(busy)}><RefreshCw size={16} /></button></div>
      <div className="capability-tabs" role="tablist">{capabilityCategories.map((item) => <button type="button" role="tab" aria-selected={category === item.id} key={item.id} onClick={() => setCategory(item.id)}>{item.label}</button>)}</div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className={`form-notice ${notice.tone}`} role="status">{notice.text}</p> : null}

      {category === "plugins" ? <form className="capability-create" onSubmit={installPlugin}><input aria-label="Plugin id" placeholder="plugin-id" value={plugin.id} onChange={(event) => setPlugin({ ...plugin, id: event.target.value })} /><input aria-label="Plugin name" placeholder="Plugin name" value={plugin.name} onChange={(event) => setPlugin({ ...plugin, name: event.target.value })} /><input aria-label="Plugin version" placeholder="1.0.0" value={plugin.version} onChange={(event) => setPlugin({ ...plugin, version: event.target.value })} /><button className="primary-button" type="submit" disabled={Boolean(busy) || !plugin.id.trim() || !plugin.name.trim()}><Download size={15} /> Install</button></form> : null}
      {category === "automations" ? <form className="capability-create automation-create" onSubmit={createAutomation}><input aria-label="Automation title" placeholder="Automation title" value={automation.title} onChange={(event) => setAutomation({ ...automation, title: event.target.value })} /><select aria-label="Schedule type" value={automation.type} onChange={(event) => setAutomation({ ...automation, type: event.target.value })}><option value="once">Once</option><option value="interval">Interval</option><option value="cron">Cron</option></select><input aria-label="Schedule value" placeholder={automation.type === "cron" ? "0 * * * *" : automation.type === "once" ? "2026-07-20T12:00:00Z" : "3600000"} value={automation.value} onChange={(event) => setAutomation({ ...automation, value: event.target.value })} /><textarea aria-label="Automation prompt" placeholder="Agent prompt" value={automation.prompt} onChange={(event) => setAutomation({ ...automation, prompt: event.target.value })} /><button className="primary-button" type="submit" disabled={Boolean(busy) || !automation.title.trim() || !automation.prompt.trim()}><Play size={15} /> Create</button></form> : null}
      {category === "subagents" ? <form className="capability-create" onSubmit={createSubagent}><input aria-label="Parent task id" placeholder="Parent task id" value={subagent.parentTaskId} onChange={(event) => setSubagent({ ...subagent, parentTaskId: event.target.value })} /><input aria-label="Subagent prompt" placeholder="Subagent prompt" value={subagent.prompt} onChange={(event) => setSubagent({ ...subagent, prompt: event.target.value })} /><select aria-label="Subagent provider" value={subagent.agent} onChange={(event) => setSubagent({ ...subagent, agent: event.target.value })}><option value="codex">Codex</option><option value="claude">Claude</option></select><button className="primary-button" type="submit" disabled={Boolean(busy) || !subagent.parentTaskId.trim() || !subagent.prompt.trim()}><Play size={15} /> Start</button></form> : null}

      <div className="capability-list" role="tabpanel">
        {!items.length && busy ? <p aria-busy="true">Loading...</p> : null}
        {!items.length && !busy ? <p>No {category} found.</p> : null}
        {items.map((item) => <div className="capability-row" key={item.id}>
          <div className="capability-row-head"><span><strong>{item.label || item.title || item.id}</strong><small>{item.version || item.status || item.schedule?.type || item.source || ""}</small></span><div className="capability-actions">
            {category === "plugins" && item.capabilities?.enable ? <button type="button" onClick={() => run(`${item.id}:toggle`, () => request(`/api/capabilities/plugins/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ action: item.enabled ? "disable" : "enable" }) }, token))}>{item.enabled ? "Disable" : "Enable"}</button> : null}
            {category === "plugins" && item.capabilities?.remove ? <button type="button" title="Remove plugin" aria-label={`Remove ${item.label}`} onClick={() => run(`${item.id}:remove`, () => request(`/api/capabilities/plugins/${encodeURIComponent(item.id)}`, { method: "DELETE" }, token))}><Trash2 size={15} /></button> : null}
            {category === "automations" ? <><button type="button" title="Run automation" aria-label={`Run ${item.title}`} onClick={() => run(`${item.id}:run`, () => request(`/api/automations/${encodeURIComponent(item.id)}/run`, { method: "POST", body: "{}" }, token))}><Play size={15} /></button><button type="button" onClick={() => run(`${item.id}:toggle`, () => request(`/api/automations/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !item.enabled }) }, token))}>{item.enabled ? "Disable" : "Enable"}</button><button type="button" title="Delete automation" aria-label={`Delete ${item.title}`} onClick={() => run(`${item.id}:delete`, () => request(`/api/automations/${encodeURIComponent(item.id)}`, { method: "DELETE" }, token))}><Trash2 size={15} /></button></> : null}
            {category === "hooks" && item.capabilities?.enable ? <button type="button" onClick={() => run(`${item.id}:toggle`, () => request(`/api/capabilities/hooks/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ action: item.enabled ? "disable" : "enable" }) }, token), `Hook ${item.enabled ? "disabled" : "enabled"}.`)}>{item.enabled ? "Disable" : "Enable"}</button> : null}
            {category === "subagents" && item.capabilities?.stop ? <button type="button" onClick={() => run(`${item.id}:stop`, () => request(`/api/tasks/${encodeURIComponent(item.id)}/stop`, { method: "POST", body: "{}" }, token), "Subagent stopped.")}>Stop</button> : null}
          </div></div>
          {category === "config" ? <><textarea value={configDrafts[item.id] || ""} readOnly={!item.capabilities?.edit} onChange={(event) => setConfigDrafts({ ...configDrafts, [item.id]: event.target.value })} aria-label={`${item.label} content`} />{item.capabilities?.edit ? <button className="secondary-button" type="button" onClick={() => run(`${item.id}:save`, () => request(`/api/capabilities/config/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ expectedDigest: item.digest, text: configDrafts[item.id] }) }, token))}><Save size={15} /> Save</button> : null}</> : null}
          {category === "hooks" ? <p>{item.count} registered hook(s) · {item.enabled ? "enabled" : "disabled"}</p> : null}
          {category === "subagents" ? <p>Parent {item.parentTaskId} · {item.agent || "agent"}</p> : null}
          {category === "automations" ? <p>{item.schedule?.value} · next {item.nextRunAt || "disabled"} · last {item.lastStatus || "never"}</p> : null}
        </div>)}
      </div>
    </section>
  );
}
