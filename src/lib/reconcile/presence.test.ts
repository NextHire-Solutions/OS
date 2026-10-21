/*
 * Is a client in a tool (22 Oct)? By a spelling the master knows, or by the
 * linked row — only when that row really exists. Home showed "Douglas Elliman
 * New York" missing from three tools it is in (renamed in the OS; the tools
 * keep "Douglas Elliman NYC", linked).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { presentIn } from "./status-readers.ts";

const read = (names: string[], ids: string[]) => ({ byName: new Map(names.map((n) => [n, null])), byId: new Map(ids.map((i) => [i, i])) });
const client = (keys: string[], links: Record<string, string | null> = {}) => ({ keys, links });

test("present by name, as before", () => {
  assert.equal(presentIn(read(["douglas elliman nyc"], []), client(["douglas elliman nyc"]), "analytics"), true);
});

test("renamed in the OS, linked to a row the tool still has: present", () => {
  const tool = read(["douglas elliman nyc"], ["d2f565d5"]);
  assert.equal(presentIn(tool, client(["douglas elliman new york"], { analytics: "d2f565d5" }), "analytics"), true);
});

test("a stale link — the row is gone — is still absent; so is no link at all; another tool's link doesn't count", () => {
  assert.equal(presentIn(read(["someone else"], ["other-row"]), client(["douglas elliman new york"], { analytics: "deleted-row" }), "analytics"), false);
  assert.equal(presentIn(read(["someone else"], ["x"]), client(["douglas elliman new york"]), "analytics"), false);
  assert.equal(presentIn(read([], ["mi-row"]), client(["douglas elliman new york"], { master_inbox: "mi-row" }), "analytics"), false);
});

test("the coverage check uses it for all four tools; the status check still matches by name; alert counts clients, not pairs", () => {
  const src = fs.readFileSync("src/lib/reconcile/status-readers.ts", "utf8");
  for (const [read, tool] of [["inbox", "master_inbox"], ["health", "client_health"], ["analytics", "analytics"], ["onboarding", "onboarding"]]) {
    assert.match(src, new RegExp(`${tool}: presentIn\\(${read}, client, "${tool}"\\)`), tool);
  }
  assert.match(src, /const found = findIn\(read, client\);/, "status conflicts unchanged");
  assert.match(fs.readFileSync("src/lib/reconcile/run.ts", "utf8"), /aliasDrift: new Set\(\(aliases\?\.findings \?\? \[\]\)\.map\(\(f\) => f\.client\)\)\.size,/);
});
