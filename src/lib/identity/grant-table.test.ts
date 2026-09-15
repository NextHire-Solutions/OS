import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceStoredTools, indexGrantRows } from "./grant-table.ts";

test("only real tool ids survive a table read", () => {
  assert.deepEqual(coerceStoredTools(["inbox", "bogus", "ANALYTICS", " search "]), ["inbox", "analytics", "search"]);
});

test("a non-array tools value grants nothing rather than throwing", () => {
  assert.deepEqual(coerceStoredTools(null), []);
  assert.deepEqual(coerceStoredTools("inbox"), []);
});

test("rows are keyed by lowercased email; an empty list is kept as an explicit lockout", () => {
  const m = indexGrantRows([{ email: "Sam@X.com", tools: ["inbox"] }, { email: "nic@x.com", tools: [] }, { email: "", tools: ["inbox"] }]);
  assert.deepEqual(m.get("sam@x.com"), ["inbox"]);
  assert.deepEqual(m.get("nic@x.com"), []);
  assert.equal(m.size, 2);
});
