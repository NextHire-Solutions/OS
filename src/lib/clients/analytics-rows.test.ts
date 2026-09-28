import { test } from "node:test";
import assert from "node:assert/strict";

import { insertRow, slugify, updateRow } from "./analytics-rows";

test("slug: the tool's rule", () => {
  assert.equal(slugify("SERHANT. PA 15M+"), "serhant-pa-15m");
  assert.equal(slugify("  Properties & Estates Florida "), "properties-estates-florida");
  assert.equal(slugify("Kelly + Co"), "kelly-co");
});

test("insert: the same row the tool inserts, with its defaults", () => {
  assert.deepEqual(insertRow({ name: "  Acme Realty " }, 2), {
    team_id: 2, name: "Acme Realty", slug: "acme-realty", aliases: [], match_mode: "contains",
  });
  assert.deepEqual(insertRow({ name: "Acme", aliases: ["ACM"], matchMode: "exact" }, 7), {
    team_id: 7, name: "Acme", slug: "acme", aliases: ["ACM"], match_mode: "exact",
  });
});

test("insert: refused exactly where the tool answers 400", () => {
  assert.equal(insertRow({ name: "" }, 2), null);
  assert.equal(insertRow({ name: "x".repeat(201) }, 2), null);
  assert.equal(insertRow({ name: "A", aliases: [""] }, 2), null);
  assert.equal(insertRow({ name: "A", aliases: Array(21).fill("a") }, 2), null);
  assert.equal(insertRow({ name: "A", matchMode: "fuzzy" as never }, 2), null);
});

test("update: only the fields given, plus updated_at", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  assert.deepEqual(updateRow({ status: "paused" }, now), { updated_at: now.toISOString(), status: "paused" });
  assert.deepEqual(updateRow({ aliases: ["X"] }, now), { updated_at: now.toISOString(), aliases: ["X"] });
  assert.deepEqual(updateRow({ name: " New ", matchMode: "prefix", active: false }, now), {
    updated_at: now.toISOString(), name: "New", match_mode: "prefix", active: false,
  });
});

test("update: an empty alias list clears them (it is not 'leave alone')", () => {
  assert.deepEqual(updateRow({ aliases: [] }, new Date(0))?.aliases, []);
});

test("update: refused exactly where the tool answers 400", () => {
  assert.equal(updateRow({ status: "archived" as never }), null);
  assert.equal(updateRow({ name: "" }), null);
  assert.equal(updateRow({ aliases: [""] }), null);
  assert.equal(updateRow({ active: "yes" as never }), null);
});
