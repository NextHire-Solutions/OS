/*
 * The Demo Portal's CSV helpers in the browser (22 Oct audit): a skipped row
 * is named by the spreadsheet's own line, and an export cannot run a formula.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCsv } from "@/lib/tools/master-inbox/portals/csv";
import { csvRowLines, csvSafe } from "./demo-save.ts";

test("each data row's line, as a person sees it — blank lines, quoted line breaks, CRLF and comma-only lines", () => {
  const files = [
    "name,email\nA,a@x\nB,b@x\n",
    "name,email\n\nA,a@x\n\n\nB,b@x",
    "name,email\r\nA,a@x\r\n,\r\nB,b@x\r\n",
    'name,notes\nA,"line one\nline two"\nB,ok\n',
    '﻿name,notes\r\n"Q, Inc","said ""hi""\r\nthen left"\r\n\r\nC,x',
    "name\rA\rB",
  ];
  const expected = [[2, 3], [3, 6], [2, 4], [2, 4], [2, 5], [2, 3]];
  files.forEach((f, i) => {
    assert.deepEqual(csvRowLines(f), expected[i], JSON.stringify(f));
    assert.equal(csvRowLines(f).length, parseCsv(f).length, "one line per row parseCsv keeps");
  });
});

test("an export cell a spreadsheet would run is kept as text; phone numbers and numbers are left alone", () => {
  for (const v of ["=HYPERLINK(\"http://evil\",\"x\")", "@SUM(A1)", "+cmd|' /C calc'!A0", "-2+3+cmd", "\tx"]) assert.equal(csvSafe(v), `'${v}`, v);
  for (const v of ["+1 (843) 555-0142", "-5", "+44 20 7946 0958", "Jordan Ellis", "jordan@x.test", ""]) assert.equal(csvSafe(v), v, v);
});
