import { test } from "node:test";
import assert from "node:assert/strict";
import { indexById, indexByName, pickFor, pickWithSource } from "./tool-index.ts";

const rows = (...names: string[]) => names.map((name) => ({ name, marker: name }));

test("a client the compiled ROSTER has never heard of still matches its tool row", () => {
  // The regression. "OpsLabs" was onboarded through the OS and created
  // correctly in all three tools; the page showed "missing" in all three
  // because it is not in the ROSTER array in the source file.
  const idx = indexByName(rows("OpsLabs"), "name");
  const hit = pickFor({ name: "OpsLabs" }, idx);
  assert.equal(hit?.marker, "OpsLabs");
});

test("aliases still find a differently spelled tool row", () => {
  const idx = indexByName(rows("BHGRE Basecamp"), "name");
  assert.equal(pickFor({ name: "BHGRE Base Camp", aliases: ["BHGRE Basecamp"] }, idx)?.marker,
    "BHGRE Basecamp");
});

test("normalisation still collapses case, punctuation and a leading 'the'", () => {
  const idx = indexByName(rows("the norvell & co real estate"), "name");
  assert.equal(pickFor({ name: "Norvell & Co Real Estate" }, idx)?.marker,
    "the norvell & co real estate");
});

test("a client no tool has returns undefined rather than a wrong row", () => {
  const idx = indexByName(rows("Jeff Cook Real Estate"), "name");
  assert.equal(pickFor({ name: "Howe Realty Group" }, idx), undefined);
});

test("two businesses that merely share a word stay separate", () => {
  const idx = indexByName(rows("Camelot Realty Group"), "name");
  assert.equal(pickFor({ name: "Camelot Realty" }, idx), undefined);
});

test("the first row wins when a tool holds two for one client", () => {
  const idx = indexByName([{ name: "Oz Group", marker: "first" }, { name: "oz group", marker: "second" }], "name");
  assert.equal(pickFor({ name: "Oz Group" }, idx)?.marker, "first");
});

test("rows with a blank or missing name are skipped, not indexed under ''", () => {
  const idx = indexByName([{ name: "   " }, { other: "x" }, { name: "Oz Group" }], "name");
  assert.equal(idx.size, 1);
});

/* ---------------------------------------------------------------------------
 * ID-first resolution.
 *
 * The property that matters is that this is ADDITIVE: every case that
 * resolved by name before must still resolve, and the id must only ever add
 * a way to find a row, never take one away.
 * ------------------------------------------------------------------------ */

test("the stored id wins, even when the name has drifted", () => {
  const rows = [{ id: "AN-1", name: "Douglas Elliman LA" }];
  const byName = indexByName(rows, "name");
  const byId = indexById(rows);
  const client = { name: "Douglas Elliman Los Angeles", aliases: [] } as never;
  const r = pickWithSource(client, byName, byId, "AN-1");
  assert.equal(r.via, "id");
  assert.equal(r.row?.name, "Douglas Elliman LA");
  assert.equal(r.staleLink, false);
});

test("with no stored id it still resolves by name — nothing regresses", () => {
  const rows = [{ id: "AN-1", name: "Oz Group" }];
  const r = pickWithSource(
    { name: "Oz Group", aliases: [] } as never,
    indexByName(rows, "name"),
    indexById(rows),
    null,
  );
  assert.equal(r.via, "name");
  assert.equal(r.row?.id, "AN-1");
});

test("a STALE id falls back to the name and says so", () => {
  const rows = [{ id: "AN-9", name: "Oz Group" }];
  const r = pickWithSource(
    { name: "Oz Group", aliases: [] } as never,
    indexByName(rows, "name"),
    indexById(rows),
    "AN-DELETED",
  );
  assert.equal(r.via, "name", "the fallback must still find it");
  assert.equal(r.staleLink, true, "and the stale link must be visible");
});

test("aliases still resolve when no id is stored", () => {
  const rows = [{ id: "X", name: "The Discover Phx Team" }];
  const r = pickWithSource(
    { name: "Discover Phx Team", aliases: ["The Discover Phx Team"] } as never,
    indexByName(rows, "name"),
    indexById(rows),
    null,
  );
  assert.equal(r.via, "name");
  assert.equal(r.row?.id, "X");
});

test("a tool whose rows carry no id degrades to name matching", () => {
  const rows = [{ client_name: "Oz Group", intros: 4 }];
  const byId = indexById(rows);
  assert.equal(byId.size, 0, "nothing to index");
  const r = pickWithSource(
    { name: "Oz Group", aliases: [] } as never,
    indexByName(rows, "client_name"),
    byId,
    "some-id",
  );
  assert.equal(r.via, "name");
  assert.equal(r.row?.intros, 4);
});

test("neither id nor name finds anything -> none, and no false stale flag", () => {
  const rows = [{ id: "A", name: "Someone Else" }];
  const r = pickWithSource(
    { name: "Missing Co", aliases: [] } as never,
    indexByName(rows, "name"),
    indexById(rows),
    "nope",
  );
  assert.equal(r.via, "none");
  assert.equal(r.row, undefined);
  assert.equal(r.staleLink, false);
});

test("pickFor keeps its old signature and behaviour", () => {
  const rows = [{ id: "A", name: "Oz Group" }];
  assert.equal(pickFor({ name: "Oz Group", aliases: [] } as never, indexByName(rows, "name"))?.id, "A");
});
