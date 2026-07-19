function baseName(value) {
  return String(value || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
}

export function artifactEndpoint(artifact = {}) {
  let id = "";
  try {
    const url = new URL(artifact.href || "", "http://localhost");
    const match = url.pathname.match(/^\/api\/(?:attachments|artifacts)\/([^/]+)/);
    if (match) id = decodeURIComponent(match[1]);
  } catch {}
  id ||= baseName(String(artifact.raw || "").split(/[?#]/)[0]);
  return id ? `/api/artifacts/${encodeURIComponent(id)}` : "";
}

export function updateTableCell(document, rowIndex, columnIndex, value) {
  return {
    ...document,
    rows: document.rows.map((row, index) => index === rowIndex
      ? row.map((cell, cellIndex) => cellIndex === columnIndex ? value : cell)
      : row)
  };
}

export function notebookCellPatches(cells = []) {
  return cells.map((cell) => ({ index: cell.index, source: String(cell.source || "") }));
}
