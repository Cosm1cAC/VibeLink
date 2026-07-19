import assert from "node:assert/strict";
import test from "node:test";

import { artifactEndpoint, notebookCellPatches, updateTableCell } from "../apps/web/src/artifactWorkbenchModel.js";

test("artifact workbench resolves authenticated attachment and local artifact identifiers", () => {
  assert.equal(artifactEndpoint({ href: "/api/attachments/report.csv?token=x", raw: "report.csv" }), "/api/artifacts/report.csv");
  assert.equal(artifactEndpoint({ raw: "C:\\tmp\\analysis.ipynb" }), "/api/artifacts/analysis.ipynb");
});

test("artifact workbench creates immutable table and notebook edits", () => {
  const table = { type: "table", columns: ["a"], rows: [["old"]] };
  const changed = updateTableCell(table, 0, 0, "new");
  assert.equal(table.rows[0][0], "old");
  assert.equal(changed.rows[0][0], "new");
  assert.deepEqual(notebookCellPatches([{ index: 2, source: "print(2)" }]), [{ index: 2, source: "print(2)" }]);
});
