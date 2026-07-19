import React, { useEffect, useState } from "react";
import { Download, ExternalLink, File, FileText, Save, X } from "lucide-react";

import { artifactEndpoint, notebookCellPatches, updateTableCell } from "./artifactWorkbenchModel.js";

function StructuredDocument({ document, editable, onChange }) {
  if (!document) return null;
  if (document.type === "table") {
    return (
      <div className="artifact-table-wrap">
        <table className="artifact-table">
          <thead><tr>{document.columns.map((column, index) => <th key={`${column}-${index}`}>{column || `Column ${index + 1}`}</th>)}</tr></thead>
          <tbody>{document.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex}>{editable ? <input aria-label={`Row ${rowIndex + 1}, ${document.columns[columnIndex] || `column ${columnIndex + 1}`}`} value={cell} onChange={(event) => onChange(updateTableCell(document, rowIndex, columnIndex, event.target.value))} /> : cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (document.type === "notebook") {
    return <div className="artifact-notebook">{document.cells.map((cell) => <section className="artifact-cell" key={cell.index}><header><span>{cell.type}</span><small>{cell.executionCount == null ? `#${cell.index + 1}` : `[${cell.executionCount}]`}</small></header>{editable ? <textarea aria-label={`Notebook cell ${cell.index + 1}`} value={cell.source} onChange={(event) => onChange({ ...document, cells: document.cells.map((item) => item.index === cell.index ? { ...item, source: event.target.value } : item) })} /> : <pre>{cell.source}</pre>}{cell.outputs?.map((output, index) => <pre className="artifact-output" key={index}>{output.text}</pre>)}</section>)}</div>;
  }
  if (document.type === "workbook") {
    return <div className="artifact-sheets">{(document.sheets || []).map((sheet, index) => <section key={sheet.name || index}><h4>{sheet.name || `Sheet ${index + 1}`}</h4><div className="artifact-table-wrap"><table className="artifact-table"><tbody>{(sheet.rows || []).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div></section>)}</div>;
  }
  if (document.type === "document") return <div className="artifact-pages">{(document.paragraphs || []).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>;
  if (document.type === "presentation") return <div className="artifact-pages">{(document.slides || []).map((slide, index) => <section key={index}><h4>Slide {index + 1}</h4>{(slide.text || slide.paragraphs || []).map?.((text, itemIndex) => <p key={itemIndex}>{text}</p>) || <p>{String(slide.text || "")}</p>}</section>)}</div>;
  if (document.type === "pdf") return <div className="artifact-pages">{document.pages?.length ? document.pages.map((page, index) => <section key={index}><h4>Page {page.number || index + 1}</h4><pre>{page.text || ""}</pre></section>) : <pre>{document.text || "No extractable PDF text."}</pre>}</div>;
  if (document.type === "text") return <pre className="artifact-text">{document.text}</pre>;
  return <div className="artifact-preview-empty"><File size={34} /><strong>{document.type || "File"} preview</strong><p>{document.reason || "A structured renderer is unavailable."}</p></div>;
}

export function ArtifactWorkbench({ artifact, onClose, request, token }) {
  const [preview, setPreview] = useState(null);
  const [document, setDocument] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const endpoint = artifactEndpoint(artifact);

  useEffect(() => {
    if (!artifact || !endpoint) return;
    let active = true;
    setLoading(true);
    setError("");
    request(`${endpoint}/preview`, {}, token)
      .then((result) => { if (active) { setPreview(result.preview); setDocument(result.preview?.document || null); } })
      .catch((failure) => { if (active) setError(failure.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [artifact, endpoint, request, token]);

  if (!artifact) return null;
  const editable = Boolean(preview?.capabilities?.mutation) && ["table", "notebook"].includes(document?.type);

  async function save() {
    if (!editable) return;
    setSaving(true);
    setError("");
    try {
      const body = document.type === "table"
        ? { expectedDigest: preview.digest, document }
        : { expectedDigest: preview.digest, cellPatches: notebookCellPatches(document.cells) };
      const result = await request(endpoint, { method: "PATCH", body: JSON.stringify(body) }, token);
      setPreview(result.preview);
      setDocument(result.preview.document);
    } catch (failure) {
      setError(failure.status === 409 ? "The artifact changed on another device. Close and reopen it before saving." : failure.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="artifact-preview-backdrop" role="dialog" aria-modal="true" aria-label={`Artifact preview: ${artifact.label}`} onClick={onClose}>
      <section className="artifact-preview artifact-workbench" onClick={(event) => event.stopPropagation()}>
        <div className="artifact-preview-head">
          <FileText size={17} />
          <span><strong>{artifact.label}</strong><small>{preview?.kind || artifact.kind}{editable ? " · editable" : " · read-only"}</small></span>
          {editable ? <button type="button" onClick={save} disabled={saving} title="Save artifact"><Save size={17} /></button> : null}
          <a href={artifact.href} target="_blank" rel="noreferrer" title="Open in new window"><ExternalLink size={17} /></a>
          <a href={artifact.href} download title="Download file"><Download size={17} /></a>
          <button type="button" onClick={onClose} title="Close"><X size={18} /></button>
        </div>
        {error ? <p className="form-error artifact-error" role="alert">{error}</p> : null}
        {loading ? <div className="artifact-preview-empty" aria-busy="true">Loading structured preview...</div> : document ? <StructuredDocument document={document} editable={editable} onChange={setDocument} /> : <div className="artifact-preview-empty"><File size={34} /><strong>{artifact.kind} preview</strong><p>Use download or open in a new window for this file.</p></div>}
      </section>
    </div>
  );
}
