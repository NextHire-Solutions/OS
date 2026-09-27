import assert from "node:assert/strict";
import { test } from "node:test";

import { planInboxAliases, type InboxRow } from "./inbox-aliases";

/*
 * The test that matters most is the multi-portal one. Everything else here is
 * set arithmetic; that one is the difference between attributing a reply to
 * the right client and silently handing Florida's replies to Boston.
 */

const row = (id: string, name: string, aliases: string[] | null = []): InboxRow =>
  ({ id, name, aliases });

test("a missing spelling is added", () => {
  const p = planInboxAliases(["Momentum Lux Realty"], row("1", "Momentum Realty"), [row("1", "Momentum Realty")]);
  assert.deepEqual(p.added, ["Momentum Lux Realty"]);
  assert.deepEqual(p.next, ["Momentum Lux Realty"]);
  assert.equal(p.noop, false);
});

test("spellings the tool already has are left alone", () => {
  const t = row("1", "Momentum Realty", ["Momentum Lux Realty"]);
  const p = planInboxAliases(["Momentum Lux Realty"], t, [t]);
  assert.deepEqual(p.added, []);
  assert.equal(p.noop, true);
});

test("matching is punctuation- and case-blind, like every matcher here", () => {
  const t = row("1", "Norvell&Co Real Estate", ["Norvell & Co"]);
  const p = planInboxAliases(["norvell and co", "NORVELL & CO."], t, [t]);
  // "norvell and co" normalises differently from "norvell & co" — & is dropped,
  // "and" is not — so it IS new; the punctuated one is not.
  assert.deepEqual(p.added, ["norvell and co"]);
});

test("the client's own name is never added as an alias to itself", () => {
  const t = row("1", "Oz Group");
  const p = planInboxAliases(["Oz Group", "oz  group"], t, [t]);
  assert.deepEqual(p.added, []);
  assert.equal(p.noop, true);
});

test("EXISTING ALIASES ARE KEPT — a union, never a replacement", () => {
  // Master Inbox acquires spellings from its own campaign data. Dropping one
  // would unattribute whatever it was matching.
  const t = row("1", "Client", ["from the tool"]);
  const p = planInboxAliases(["from the master"], t, [t]);
  assert.deepEqual(p.next, ["from the tool", "from the master"]);
});

test("AN ALIAS THAT NAMES ANOTHER MASTER INBOX ROW IS REFUSED", () => {
  // The real case: one client, two portals. "Properties & Estates Florida" is
  // an alias on the master record AND the name of a separate row here.
  // Adopting it would route every Florida reply to Boston.
  const boston = row("b", "Properties & Estates Boston");
  const florida = row("f", "Properties & Estates Florida");
  const p = planInboxAliases(
    ["Properties & Estates Florida", "P&E"],
    boston,
    [boston, florida],
  );
  assert.deepEqual(p.added, ["P&E"], "only the safe spelling is added");
  assert.equal(p.skipped.length, 1);
  assert.equal(p.skipped[0].alias, "Properties & Estates Florida");
  assert.match(p.skipped[0].because, /separate row/);
});

test("the same guard covers SERHANT. PA and its 15M+ portal", () => {
  const base = row("a", "SERHANT. PA");
  const big = row("b", "SERHANT. PA 15M+");
  const p = planInboxAliases(["SERHANT. PA 15M+"], base, [base, big]);
  assert.deepEqual(p.added, []);
  assert.equal(p.noop, true);
  assert.equal(p.skipped.length, 1);
});

test("a skipped alias is reported, never dropped in silence", () => {
  const a = row("a", "A"); const b = row("b", "Beta Group");
  const p = planInboxAliases(["Beta Group"], a, [a, b]);
  assert.equal(p.added.length, 0);
  assert.equal(p.skipped.length, 1, "the caller must be able to say why");
});

test("blank and whitespace aliases are ignored", () => {
  const t = row("1", "Client");
  const p = planInboxAliases(["", "   ", "Real One"], t, [t]);
  assert.deepEqual(p.added, ["Real One"]);
});

test("nothing to add means nothing to write", () => {
  const t = row("1", "Client", ["x"]);
  const p = planInboxAliases([], t, [t]);
  assert.equal(p.noop, true);
  assert.deepEqual(p.next, ["x"]);
});
