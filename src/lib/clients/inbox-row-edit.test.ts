import assert from "node:assert/strict";
import { test } from "node:test";

import { planInboxRowEdit, type InboxRowLite, type MasterLite } from "./inbox-row-edit.ts";

const boston: InboxRowLite = { id: "b", name: "Properties & Estates Boston", slug: "properties-and-estates-boston", aliases: ["Properties & Estates", "P&E Boston"] };
const florida: InboxRowLite = { id: "f", name: "Properties & Estates Florida", slug: "properties-and-estates-florida", aliases: [] };
const keyes: InboxRowLite = { id: "k", name: "The Keyes Company", slug: "the-keyes-company", aliases: ["Keyes"] };
const unknown: InboxRowLite = { id: "u", name: "Unknown", slug: "unknown", aliases: [] };
const rows = [boston, florida, keyes, unknown];
const pe: MasterLite = { id: "pe", name: "Properties & Estates", aliases: ["Properties & Estates Florida", "Properties & Estates Boston"] };
const keyesM: MasterLite = { id: "km", name: "The Keyes Company", aliases: ["Keyes", "Keyes Realty"] };
const clients = [pe, keyesM];

test("a rename keeps the old name as a spelling and ties the new one to the client", () => {
  const p = planInboxRowEdit({ row: keyes, client: keyesM, rows, clients, name: "Keyes Company Miami" });
  assert.equal(p.ok, true, p.errors.join("; "));
  assert.equal(p.update.name, "Keyes Company Miami");
  assert.deepEqual(p.update.aliases, ["Keyes", "The Keyes Company"]);
  assert.equal(p.addToClient, "Keyes Company Miami");
  assert.ok(p.notes.some((n) => /link does not change/.test(n)));
});

test("a rename to a name the client already answers to adds nothing to the client", () => {
  const p = planInboxRowEdit({ row: keyes, client: keyesM, rows, clients, name: "Keyes Realty" });
  assert.equal(p.ok, true);
  assert.equal(p.addToClient, null);
});

test("never take another portal's name — the Boston/Florida trap", () => {
  const p = planInboxRowEdit({ row: boston, client: pe, rows, clients, name: "Properties & Estates Florida" });
  assert.equal(p.ok, false);
  assert.match(p.errors[0], /another portal/);
  const q = planInboxRowEdit({ row: boston, client: pe, rows, clients, aliases: [...boston.aliases!, "Properties and Estates Florida"] });
  assert.equal(q.ok, false, "spelled differently, still Florida's name");
});

test("never take another client's name or spelling", () => {
  const p = planInboxRowEdit({ row: boston, client: pe, rows, clients, aliases: [...boston.aliases!, "Keyes Realty"] });
  assert.equal(p.ok, false);
  assert.match(p.errors[0], /another client, The Keyes Company/);
  const r = planInboxRowEdit({ row: boston, client: pe, rows, clients, name: "The Keyes Company" });
  assert.equal(r.ok, false);
});

test("removing and adding spellings, said plainly", () => {
  const p = planInboxRowEdit({ row: boston, client: pe, rows, clients, aliases: ["Properties & Estates", "PE Boston MA"] });
  assert.equal(p.ok, true, p.errors.join("; "));
  assert.deepEqual(p.update.aliases, ["Properties & Estates", "PE Boston MA"]);
  assert.equal(p.update.name, undefined);
  assert.ok(p.notes.some((n) => /Removes the spelling "P&E Boston"/.test(n)));
  assert.ok(p.notes.some((n) => /Adds the spelling "PE Boston MA"/.test(n)));
});

test("a spelling already on the row is left alone even if it would clash today", () => {
  // Boston carries "Properties & Estates" — the CLIENT's own name, so no clash — keep it.
  const p = planInboxRowEdit({ row: boston, client: pe, rows, clients, aliases: ["Properties & Estates", "P&E Boston", "Boston PE"] });
  assert.equal(p.ok, true, p.errors.join("; "));
});

test("duplicates, blanks and the row's own name are dropped; nothing to change is said", () => {
  const p = planInboxRowEdit({ row: keyes, client: keyesM, rows, clients, aliases: ["Keyes", " keyes ", "", "The Keyes Company"] });
  assert.equal(p.ok, false);
  assert.deepEqual(p.errors, ["Nothing to change."]);
});

test("the Unknown row and empty or long names are refused", () => {
  assert.equal(planInboxRowEdit({ row: unknown, client: pe, rows, clients, name: "X" }).ok, false);
  assert.equal(planInboxRowEdit({ row: keyes, client: keyesM, rows, clients, name: "   " }).ok, false);
  assert.equal(planInboxRowEdit({ row: keyes, client: keyesM, rows, clients, name: "x".repeat(81) }).ok, false);
  assert.equal(planInboxRowEdit({ row: keyes, client: keyesM, rows, clients, aliases: Array.from({ length: 21 }, (_, i) => `Keyes ${i}`) }).ok, false);
});

test("a change of capitals only is a rename without new spellings", () => {
  const p = planInboxRowEdit({ row: keyes, client: keyesM, rows, clients, name: "The KEYES Company" });
  assert.equal(p.ok, true);
  assert.equal(p.update.name, "The KEYES Company");
  assert.equal(p.update.aliases, undefined, "the old name is the same spelling");
  assert.equal(p.addToClient, null);
});
