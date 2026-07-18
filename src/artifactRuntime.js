import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

export const ARTIFACT_RANGE_LIMIT = 1024 * 1024;

const DEFAULT_LIMITS = Object.freeze({
  archiveEntries: 2048,
  archiveEntryBytes: 4 * 1024 * 1024,
  sourceBytes: 8 * 1024 * 1024,
  textChars: 256 * 1024,
  rows: 200,
  columns: 100,
  sheets: 24,
  cells: 200,
  outputsPerCell: 20,
  paragraphs: 1000,
  slides: 200,
  pages: 200
});

const MIME_BY_EXTENSION = new Map([
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".ipynb", "application/x-ipynb+json"],
  [".json", "application/json"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]
]);

const KIND_BY_MIME = new Map([
  ["application/pdf", "pdf"],
  ["application/msword", "document"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
  ["application/vnd.ms-excel", "workbook"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "workbook"],
  ["application/vnd.ms-powerpoint", "presentation"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "presentation"],
  ["text/csv", "table"],
  ["text/tab-separated-values", "table"],
  ["application/x-ipynb+json", "notebook"],
  ["application/json", "text"],
  ["text/plain", "text"],
  ["text/markdown", "text"]
]);

function artifactError(message, status = 400, code = "ARTIFACT_INVALID") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function limitsFor(options = {}) {
  return {
    ...DEFAULT_LIMITS,
    rows: Math.max(1, Math.min(DEFAULT_LIMITS.rows, Number(options.maxRows) || DEFAULT_LIMITS.rows)),
    columns: Math.max(1, Math.min(DEFAULT_LIMITS.columns, Number(options.maxColumns) || DEFAULT_LIMITS.columns)),
    textChars: Math.max(1024, Math.min(DEFAULT_LIMITS.textChars, Number(options.maxTextChars) || DEFAULT_LIMITS.textChars))
  };
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw artifactError("Artifact ended unexpectedly.", 422, "ARTIFACT_CORRUPT");
  return buffer;
}

async function readBoundedFile(filePath, maxBytes) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw artifactError("Artifact not found.", 404, "ARTIFACT_NOT_FOUND");
  if (stat.size > maxBytes) throw artifactError("Artifact source exceeds the preview limit.", 413, "ARTIFACT_TOO_LARGE");
  return fs.promises.readFile(filePath);
}

function safeArchiveName(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw artifactError("Artifact archive contains an unsafe path.", 422, "ARTIFACT_CORRUPT");
  }
  return normalized;
}

async function readZipDirectory(filePath, limits = DEFAULT_LIMITS) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const tailLength = Math.min(stat.size, 65_557);
    const tail = await readAt(handle, stat.size - tailLength, tailLength);
    let endOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        endOffset = index;
        break;
      }
    }
    if (endOffset < 0) throw artifactError("Artifact ZIP directory is missing.", 422, "ARTIFACT_CORRUPT");
    const entryCount = tail.readUInt16LE(endOffset + 10);
    const directorySize = tail.readUInt32LE(endOffset + 12);
    const directoryOffset = tail.readUInt32LE(endOffset + 16);
    if (entryCount > limits.archiveEntries || directorySize > limits.archiveEntryBytes) {
      throw artifactError("Artifact archive exceeds preview limits.", 413, "ARTIFACT_TOO_LARGE");
    }
    if (directoryOffset + directorySize > stat.size) throw artifactError("Artifact ZIP directory is invalid.", 422, "ARTIFACT_CORRUPT");
    const directory = await readAt(handle, directoryOffset, directorySize);
    const entries = new Map();
    let offset = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) {
        throw artifactError("Artifact ZIP entry is invalid.", 422, "ARTIFACT_CORRUPT");
      }
      const flags = directory.readUInt16LE(offset + 8);
      const method = directory.readUInt16LE(offset + 10);
      const compressedSize = directory.readUInt32LE(offset + 20);
      const uncompressedSize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const localOffset = directory.readUInt32LE(offset + 42);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > directory.length) throw artifactError("Artifact ZIP entry is truncated.", 422, "ARTIFACT_CORRUPT");
      const name = safeArchiveName(directory.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
      if ((flags & 1) !== 0) throw artifactError("Encrypted artifacts cannot be previewed.", 422, "ARTIFACT_ENCRYPTED");
      entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
      offset = end;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function readZipEntry(filePath, entry, limits = DEFAULT_LIMITS) {
  if (!entry) return null;
  if (entry.compressedSize > limits.archiveEntryBytes || entry.uncompressedSize > limits.archiveEntryBytes) {
    throw artifactError("Artifact archive entry exceeds preview limits.", 413, "ARTIFACT_TOO_LARGE");
  }
  const handle = await fs.promises.open(filePath, "r");
  try {
    const header = await readAt(handle, entry.localOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) throw artifactError("Artifact ZIP local entry is invalid.", 422, "ARTIFACT_CORRUPT");
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const compressed = await readAt(handle, entry.localOffset + 30 + nameLength + extraLength, entry.compressedSize);
    let output;
    if (entry.method === 0) output = compressed;
    else if (entry.method === 8) output = inflateRawSync(compressed, { maxOutputLength: limits.archiveEntryBytes });
    else throw artifactError(`Unsupported ZIP compression method ${entry.method}.`, 422, "ARTIFACT_UNSUPPORTED");
    if (output.length > limits.archiveEntryBytes) throw artifactError("Artifact archive entry exceeds preview limits.", 413, "ARTIFACT_TOO_LARGE");
    return output;
  } catch (error) {
    if (error.code === "ERR_BUFFER_TOO_LARGE" || error.code === "ERR_OUT_OF_RANGE") {
      throw artifactError("Artifact archive entry exceeds preview limits.", 413, "ARTIFACT_TOO_LARGE");
    }
    throw error;
  } finally {
    await handle.close();
  }
}

function zipMime(entries) {
  const names = [...entries.keys()];
  if (names.includes("word/document.xml")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (names.includes("xl/workbook.xml")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (names.includes("ppt/presentation.xml") || names.some((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  return "application/zip";
}

async function detectMime(filePath, name, limits) {
  const handle = await fs.promises.open(filePath, "r");
  let sample;
  try {
    const stat = await handle.stat();
    sample = await readAt(handle, 0, Math.min(stat.size, 8192));
  } finally {
    await handle.close();
  }
  if (sample.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (sample.length >= 8 && sample.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return MIME_BY_EXTENSION.get(path.extname(name).toLowerCase()) || "application/x-ole-storage";
  }
  if (sample.length >= 4 && sample.readUInt32LE(0) === 0x04034b50) return zipMime(await readZipDirectory(filePath, limits));
  const extensionMime = MIME_BY_EXTENSION.get(path.extname(name).toLowerCase());
  const text = sample.toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (text.startsWith("{") && /"nbformat"\s*:/.test(text) && /"cells"\s*:/.test(text)) return "application/x-ipynb+json";
  if (sample.includes(0)) return extensionMime || "application/octet-stream";
  return extensionMime || "text/plain";
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function artifactMetadata(filePath, options = {}) {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw artifactError("Artifact not found.", 404, "ARTIFACT_NOT_FOUND");
  const name = path.basename(String(options.name || filePath));
  const limits = limitsFor(options);
  const mimeType = await detectMime(filePath, name, limits);
  const kind = KIND_BY_MIME.get(mimeType) || "binary";
  return {
    version: 1,
    id: String(options.id || ""),
    name,
    mimeType,
    kind,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    digest: `sha256:${await sha256(filePath)}`,
    capabilities: {
      rangeRead: true,
      preview: kind !== "binary",
      mutation: false
    }
  };
}

export function parseArtifactRange(header, size, maxBytes = ARTIFACT_RANGE_LIMIT) {
  const value = String(header || "").trim();
  if (!/^bytes=/i.test(value) || value.includes(",")) {
    throw artifactError("Artifact content requires a single byte range.", 416, "ARTIFACT_RANGE_INVALID");
  }
  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) {
    throw artifactError("Artifact byte range is invalid.", 416, "ARTIFACT_RANGE_INVALID");
  }
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw artifactError("Artifact byte range is invalid.", 416, "ARTIFACT_RANGE_INVALID");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : Math.min(size - 1, start + maxBytes - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw artifactError("Artifact byte range is unsatisfiable.", 416, "ARTIFACT_RANGE_INVALID");
  }
  end = Math.min(end, size - 1);
  const length = end - start + 1;
  if (length > maxBytes) throw artifactError(`Artifact byte range exceeds ${maxBytes} bytes.`, 416, "ARTIFACT_RANGE_TOO_LARGE");
  return { start, end, length };
}

export async function readArtifactRange(filePath, rangeHeader, maxBytes = ARTIFACT_RANGE_LIMIT) {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw artifactError("Artifact not found.", 404, "ARTIFACT_NOT_FOUND");
  const range = parseArtifactRange(rangeHeader, stat.size, maxBytes);
  const handle = await fs.promises.open(filePath, "r");
  try {
    return { ...range, size: stat.size, data: await readAt(handle, range.start, range.length) };
  } finally {
    await handle.close();
  }
}

export function redactArtifactText(value) {
  let text = String(value ?? "");
  let count = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      count += 1;
      return typeof replacement === "function" ? replacement(...args) : replacement;
    });
  };
  replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]");
  replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, (_match, prefix) => `${prefix}[REDACTED]`);
  replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|pwd|secret|token)\s*[:=]\s*)[^\s,;]+/gi, (_match, prefix) => `${prefix}[REDACTED]`);
  replace(/\b(?:sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
  return { text, count };
}

function redactionState() {
  return { count: 0 };
}

function redact(value, state) {
  const result = redactArtifactText(value);
  state.count += result.count;
  return result.text;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlAttribute(source, name) {
  return decodeXml(source.match(new RegExp(`\\b${name.replace(":", "\\:")}=["']([^"']*)["']`, "i"))?.[1] || "");
}

function xmlTexts(source, tag = "t") {
  const values = [];
  const pattern = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tag}>`, "gi");
  for (const match of source.matchAll(pattern)) values.push(decodeXml(match[1].replace(/<[^>]+>/g, "")));
  return values;
}

function parseDelimited(text, delimiter, limits, state) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let sourceRows = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index] ?? "\n";
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && !field) quoted = true;
    else if (char === delimiter) {
      if (row.length < limits.columns) row.push(redact(field, state));
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      if (row.length < limits.columns) row.push(redact(field, state));
      field = "";
      if (row.some((value) => value !== "")) {
        sourceRows += 1;
        if (rows.length < limits.rows + 1) rows.push(row);
      }
      row = [];
    } else field += char;
  }
  const columns = rows.shift() || [];
  const dataRows = rows.slice(0, limits.rows);
  return { columns, rows: dataRows, sourceRows: Math.max(0, sourceRows - 1), truncated: sourceRows - 1 > dataRows.length };
}

function safeNotebookMetadata(metadata = {}) {
  return {
    kernelspec: metadata.kernelspec ? {
      name: String(metadata.kernelspec.name || ""),
      displayName: String(metadata.kernelspec.display_name || "")
    } : undefined,
    language: metadata.language_info ? {
      name: String(metadata.language_info.name || ""),
      version: String(metadata.language_info.version || "")
    } : undefined
  };
}

function notebookPreview(buffer, limits, state) {
  let notebook;
  try {
    notebook = JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw artifactError("Notebook JSON is invalid.", 422, "ARTIFACT_CORRUPT");
  }
  if (!Array.isArray(notebook.cells)) throw artifactError("Notebook cells are missing.", 422, "ARTIFACT_CORRUPT");
  const cells = notebook.cells.slice(0, limits.cells).map((cell, index) => ({
    index,
    type: ["markdown", "code", "raw"].includes(cell.cell_type) ? cell.cell_type : "raw",
    executionCount: Number.isInteger(cell.execution_count) ? cell.execution_count : null,
    source: redact((Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "")).slice(0, limits.textChars), state),
    outputs: Array.isArray(cell.outputs) ? cell.outputs.slice(0, limits.outputsPerCell).map((output) => ({
      type: String(output.output_type || "unknown"),
      name: String(output.name || ""),
      text: redact((Array.isArray(output.text) ? output.text.join("") : String(output.text || output.data?.["text/plain"] || "")).slice(0, limits.textChars), state)
    })) : []
  }));
  return {
    document: { type: "notebook", nbformat: Number(notebook.nbformat || 0), metadata: safeNotebookMetadata(notebook.metadata), cells },
    truncated: { cells: notebook.cells.length > cells.length }
  };
}

async function docxPreview(filePath, entries, limits, state) {
  const xml = (await readZipEntry(filePath, entries.get("word/document.xml"), limits))?.toString("utf8") || "";
  const paragraphs = [];
  for (const match of xml.matchAll(/<(?:w:)?p\b[^>]*>([\s\S]*?)<\/(?:w:)?p>/gi)) {
    if (paragraphs.length >= limits.paragraphs) break;
    const value = xmlTexts(match[1]).join("");
    if (value) paragraphs.push(redact(value, state));
  }
  const sourceCount = [...xml.matchAll(/<(?:w:)?p\b/gi)].length;
  return { document: { type: "document", paragraphs }, truncated: { paragraphs: sourceCount > paragraphs.length } };
}

function columnIndex(reference) {
  const letters = String(reference || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "";
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, value - 1);
}

async function xlsxPreview(filePath, entries, limits, state) {
  const workbook = (await readZipEntry(filePath, entries.get("xl/workbook.xml"), limits))?.toString("utf8") || "";
  const relationships = (await readZipEntry(filePath, entries.get("xl/_rels/workbook.xml.rels"), limits))?.toString("utf8") || "";
  const relationshipTargets = new Map();
  for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    relationshipTargets.set(xmlAttribute(match[1], "Id"), xmlAttribute(match[1], "Target"));
  }
  const sharedXml = (await readZipEntry(filePath, entries.get("xl/sharedStrings.xml"), limits))?.toString("utf8") || "";
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => xmlTexts(match[1]).join(""));
  const sheetSpecs = [...workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)].slice(0, limits.sheets);
  const sheets = [];
  for (const sheetSpec of sheetSpecs) {
    const relation = xmlAttribute(sheetSpec[1], "r:id");
    const target = relationshipTargets.get(relation) || `worksheets/sheet${sheets.length + 1}.xml`;
    const entryName = target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join("xl", target));
    const xml = (await readZipEntry(filePath, entries.get(entryName), limits))?.toString("utf8") || "";
    const rows = [];
    let sourceRows = 0;
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
      sourceRows += 1;
      if (rows.length >= limits.rows) continue;
      const row = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const index = columnIndex(xmlAttribute(cellMatch[1], "r"));
        if (index >= limits.columns) continue;
        const type = xmlAttribute(cellMatch[1], "t");
        const raw = cellMatch[2].match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? xmlTexts(cellMatch[2]).join("");
        const value = type === "s" ? shared[Number(raw)] || "" : decodeXml(raw);
        while (row.length < index) row.push("");
        row[index] = redact(value, state);
      }
      rows.push(row);
    }
    sheets.push({ name: xmlAttribute(sheetSpec[1], "name") || `Sheet ${sheets.length + 1}`, rows, truncated: sourceRows > rows.length });
  }
  return { document: { type: "workbook", sheets }, truncated: { sheets: [...workbook.matchAll(/<sheet\b/gi)].length > sheets.length, rows: sheets.some((sheet) => sheet.truncated) } };
}

async function pptxPreview(filePath, entries, limits, state) {
  const slideEntries = [...entries.values()]
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((a, b) => Number(a.name.match(/\d+/)?.[0]) - Number(b.name.match(/\d+/)?.[0]));
  const slides = [];
  for (const entry of slideEntries.slice(0, limits.slides)) {
    const xml = (await readZipEntry(filePath, entry, limits)).toString("utf8");
    slides.push({ index: slides.length + 1, paragraphs: xmlTexts(xml).map((value) => redact(value, state)).filter(Boolean) });
  }
  return { document: { type: "presentation", slides }, truncated: { slides: slideEntries.length > slides.length } };
}

function pdfPreview(buffer, limits, state) {
  const source = buffer.toString("latin1");
  const pageCount = Math.min(limits.pages, [...source.matchAll(/\/Type\s*\/Page(?!s)\b/g)].length || 1);
  const fragments = [];
  for (const match of source.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj\b/g)) {
    const value = match[1].replace(/\\([nrtbf()\\])/g, (_, char) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[char] || char));
    if (value.trim()) fragments.push(redact(value, state));
    if (fragments.join("\n").length >= limits.textChars) break;
  }
  return {
    document: { type: "pdf", pageCount, text: fragments.join("\n").slice(0, limits.textChars), extraction: "best-effort" },
    truncated: { pages: [...source.matchAll(/\/Type\s*\/Page(?!s)\b/g)].length > pageCount, text: fragments.join("\n").length > limits.textChars }
  };
}

function previewEnvelope(metadata, result, limits, state) {
  return {
    version: 1,
    readonly: true,
    mimeType: metadata.mimeType,
    kind: metadata.kind,
    document: result.document,
    truncated: result.truncated || {},
    redaction: { applied: state.count > 0, count: state.count },
    limits: { maxBytes: limits.sourceBytes, maxTextChars: limits.textChars, maxRows: limits.rows, maxColumns: limits.columns }
  };
}

export async function artifactPreview(filePath, options = {}) {
  const limits = limitsFor(options);
  const metadata = await artifactMetadata(filePath, options);
  const state = redactionState();
  let result;
  if (metadata.kind === "notebook") {
    result = notebookPreview(await readBoundedFile(filePath, limits.sourceBytes), limits, state);
  } else if (metadata.kind === "table") {
    const buffer = await readBoundedFile(filePath, limits.sourceBytes);
    const parsed = parseDelimited(buffer.toString("utf8").replace(/^\uFEFF/, ""), metadata.mimeType === "text/tab-separated-values" ? "\t" : ",", limits, state);
    result = { document: { type: "table", columns: parsed.columns, rows: parsed.rows }, truncated: { rows: parsed.truncated, columns: parsed.columns.length >= limits.columns } };
  } else if (metadata.mimeType.includes("openxmlformats")) {
    const entries = await readZipDirectory(filePath, limits);
    if (metadata.kind === "document") result = await docxPreview(filePath, entries, limits, state);
    else if (metadata.kind === "workbook") result = await xlsxPreview(filePath, entries, limits, state);
    else result = await pptxPreview(filePath, entries, limits, state);
  } else if (metadata.kind === "pdf") {
    result = pdfPreview(await readBoundedFile(filePath, limits.sourceBytes), limits, state);
  } else if (["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].includes(metadata.mimeType)) {
    result = { document: { type: metadata.kind, unsupported: true, reason: "Legacy binary Office preview is unavailable." }, truncated: {} };
  } else if (metadata.kind === "text") {
    const buffer = await readBoundedFile(filePath, limits.sourceBytes);
    const source = buffer.toString("utf8");
    result = { document: { type: "text", text: redact(source.slice(0, limits.textChars), state) }, truncated: { text: source.length > limits.textChars } };
  } else {
    result = { document: { type: "binary", unsupported: true, reason: "No read-only preview extractor is available." }, truncated: {} };
  }
  return previewEnvelope(metadata, result, limits, state);
}
