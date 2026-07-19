import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactMetadata,
  artifactPreview,
  mutateArtifact,
  parseArtifactRange,
  redactArtifactText
} from "../src/artifactRuntime.js";

function temporaryFile(t, name, content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-artifact-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const fileName = Buffer.from(name);
    const data = Buffer.from(value);
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    local.push(header, fileName, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(fileName.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, fileName);
    offset += header.length + fileName.length + data.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

test("artifact metadata detects content instead of trusting the extension", async (t) => {
  const filePath = temporaryFile(t, "renamed.txt", Buffer.from("%PDF-1.7\n1 0 obj<</Type /Page>>endobj"));
  const metadata = await artifactMetadata(filePath, { id: "artifact-1", name: "renamed.txt" });

  assert.equal(metadata.mimeType, "application/pdf");
  assert.equal(metadata.kind, "pdf");
  assert.equal(metadata.size, Buffer.byteLength("%PDF-1.7\n1 0 obj<</Type /Page>>endobj"));
  assert.match(metadata.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(metadata.capabilities, { rangeRead: true, preview: true, mutation: false });
});

test("artifact ranges are bounded and reject multipart or unsatisfiable requests", () => {
  assert.deepEqual(parseArtifactRange("bytes=5-9", 20), { start: 5, end: 9, length: 5 });
  assert.deepEqual(parseArtifactRange("bytes=-4", 20), { start: 16, end: 19, length: 4 });
  assert.throws(() => parseArtifactRange("bytes=0-1,4-5", 20), /single byte range/i);
  assert.throws(() => parseArtifactRange("bytes=20-30", 20), (error) => error.status === 416);
  assert.throws(() => parseArtifactRange("bytes=0-1048576", 2_000_000), (error) => error.status === 416);
});

test("notebook preview preserves cell structure and redacts secrets", async (t) => {
  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "python3" }, token: "metadata-secret" },
    cells: [
      { cell_type: "markdown", source: ["# Report\n", "password=hunter2"] },
      { cell_type: "code", execution_count: 1, source: ["print('ok')"], outputs: [{ output_type: "stream", name: "stdout", text: ["Authorization: Bearer abc.def.ghi\n"] }] }
    ]
  };
  const filePath = temporaryFile(t, "report.ipynb", JSON.stringify(notebook));
  const preview = await artifactPreview(filePath, { name: "report.ipynb" });

  assert.equal(preview.kind, "notebook");
  assert.equal(preview.document.cells.length, 2);
  assert.equal(preview.document.cells[0].source.includes("hunter2"), false);
  assert.equal(preview.document.cells[1].outputs[0].text.includes("abc.def.ghi"), false);
  assert.equal(preview.redaction.applied, true);
  assert.equal(Object.hasOwn(preview.document.metadata, "token"), false);
});

test("CSV preview returns bounded table structure", async (t) => {
  const filePath = temporaryFile(t, "people.csv", "name,note\nAda,\"line one, line two\"\nBob,password=secret\n");
  const preview = await artifactPreview(filePath, { name: "people.csv", maxRows: 2 });

  assert.equal(preview.kind, "table");
  assert.deepEqual(preview.document.columns, ["name", "note"]);
  assert.deepEqual(preview.document.rows[0], ["Ada", "line one, line two"]);
  assert.equal(preview.document.rows[1][1].includes("secret"), false);
  assert.equal(preview.truncated.rows, false);
});

test("artifact mutation updates tables and notebook sources with digest conflicts", async (t) => {
  const csvPath = temporaryFile(t, "editable.csv", "name,count\nalpha,1\n");
  const csvMetadata = await artifactMetadata(csvPath, { name: "editable.csv" });
  const csvResult = await mutateArtifact(csvPath, {
    expectedDigest: csvMetadata.digest,
    document: { type: "table", columns: ["name", "count"], rows: [["a,b", "2"]] }
  }, { name: "editable.csv" });
  assert.equal(csvResult.metadata.capabilities.mutation, true);
  assert.equal(await fs.promises.readFile(csvPath, "utf8"), "name,count\n\"a,b\",2\n");
  await assert.rejects(
    mutateArtifact(csvPath, { expectedDigest: csvMetadata.digest, document: { type: "table", columns: [], rows: [] } }, { name: "editable.csv" }),
    (error) => error.status === 409 && error.code === "ARTIFACT_CONFLICT"
  );

  const notebookPath = temporaryFile(t, "editable.ipynb", JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "python3" } },
    cells: [{ cell_type: "code", source: ["print('old')\n"], execution_count: 7, outputs: [{ output_type: "stream", text: ["old\n"] }], metadata: { tag: "keep" } }]
  }));
  const notebookMetadata = await artifactMetadata(notebookPath, { name: "editable.ipynb" });
  await mutateArtifact(notebookPath, {
    expectedDigest: notebookMetadata.digest,
    cellPatches: [{ index: 0, source: "print('new')\n" }]
  }, { name: "editable.ipynb" });
  const saved = JSON.parse(await fs.promises.readFile(notebookPath, "utf8"));
  assert.deepEqual(saved.cells[0].source, ["print('new')\n"]);
  assert.equal(saved.cells[0].outputs[0].text[0], "old\n");
  assert.equal(saved.cells[0].metadata.tag, "keep");
});

test("OOXML preview dispatches DOCX paragraphs and XLSX sheet cells", async (t) => {
  const docxPath = temporaryFile(t, "report.docx", storedZip({
    "[Content_Types].xml": "<Types><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
    "word/document.xml": "<w:document xmlns:w=\"w\"><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> world</w:t></w:r></w:p><w:p><w:r><w:t>api_key=top-secret</w:t></w:r></w:p></w:body></w:document>"
  }));
  const docx = await artifactPreview(docxPath, { name: "report.docx" });
  assert.equal(docx.kind, "document");
  assert.equal(docx.document.paragraphs[0], "Hello world");
  assert.equal(docx.document.paragraphs[1].includes("top-secret"), false);

  const xlsxPath = temporaryFile(t, "book.xlsx", storedZip({
    "[Content_Types].xml": "<Types><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/></Types>",
    "xl/workbook.xml": "<workbook xmlns:r=\"relationships\"><sheets><sheet name=\"People\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>",
    "xl/_rels/workbook.xml.rels": "<Relationships><Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/></Relationships>",
    "xl/sharedStrings.xml": "<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>",
    "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c></row><row r=\"2\"><c r=\"A2\" t=\"s\"><v>1</v></c></row></sheetData></worksheet>"
  }));
  const xlsx = await artifactPreview(xlsxPath, { name: "book.xlsx" });
  assert.equal(xlsx.kind, "workbook");
  assert.equal(xlsx.document.sheets[0].name, "People");
  assert.deepEqual(xlsx.document.sheets[0].rows, [["Name"], ["Ada"]]);
});

test("PDF and PPTX previews expose bounded page and slide text", async (t) => {
  const pdfPath = temporaryFile(t, "report.pdf", "%PDF-1.7\n1 0 obj<</Type /Page>>stream\nBT (Hello PDF) Tj (password=secret) Tj ET\nendstream\nendobj");
  const pdf = await artifactPreview(pdfPath, { name: "report.pdf" });
  assert.equal(pdf.document.pageCount, 1);
  assert.match(pdf.document.text, /Hello PDF/);
  assert.equal(pdf.document.text.includes("password=secret"), false);

  const pptxPath = temporaryFile(t, "slides.pptx", storedZip({
    "[Content_Types].xml": "<Types><Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/></Types>",
    "ppt/presentation.xml": "<p:presentation xmlns:p=\"p\"/>",
    "ppt/slides/slide1.xml": "<p:sld xmlns:p=\"p\" xmlns:a=\"a\"><a:p><a:r><a:t>Quarterly report</a:t></a:r></a:p></p:sld>"
  }));
  const pptx = await artifactPreview(pptxPath, { name: "slides.pptx" });
  assert.equal(pptx.kind, "presentation");
  assert.deepEqual(pptx.document.slides[0].paragraphs, ["Quarterly report"]);
});

test("redaction handles credential-shaped paragraph text without exposing values", () => {
  const result = redactArtifactText("token: ghp_1234567890abcdef\nemail=user@example.com\nnormal value");
  assert.equal(result.text.includes("ghp_1234567890abcdef"), false);
  assert.match(result.text, /token: \[REDACTED\]/);
  assert.match(result.text, /user@example\.com/);
  assert.equal(result.count, 1);
});
