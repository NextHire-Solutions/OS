import { test } from "node:test";
import assert from "node:assert/strict";
import { indexByName, pickFor } from "./tool-index.ts";

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
