import assert from "node:assert/strict";
import { test } from "node:test";

import { normaliseName, nameStem } from "./identity.ts";

/*
 * The matching rules, pinned.
 *
 * These two functions decide whether two rows in different databases are the
 * same company. Getting that wrong does not throw — it reports one client's
 * numbers under another client's name, which is the worst failure this feature
 * has available. So the real pairs from the live estate are the test cases.
 */

test("normalising absorbs the punctuation and spacing that differ between products", () => {
  // Measured pair: Agent Search writes "Norvell & Co", Master Inbox has
  // "Norvell&Co Real Estate". The ampersand must become a SPACE, not vanish,
  // or the two normalise to "norvell co" and "norvellco" and never meet.
  assert.equal(normaliseName("Norvell & Co"), "norvell co");
  assert.equal(normaliseName("Norvell&Co"), "norvell co");
  assert.equal(normaliseName("  JPAR   Iron Horse  "), "jpar iron horse");
  assert.equal(normaliseName("54 Realty"), "54 realty");
  assert.equal(normaliseName(null), "");
});

test("the stem drops the company words one product writes and another omits", () => {
  // "Howe Realty" (Agent Search) vs "Howe Realty Group" (Master Inbox).
  assert.equal(nameStem("Howe Realty"), "howe");
  assert.equal(nameStem("Howe Realty Group"), "howe");
  // "Camelot Realty" vs "Camelot Realty Group".
  assert.equal(nameStem("Camelot Realty"), "camelot");
  assert.equal(nameStem("Camelot Realty Group"), "camelot");
  // Spacing difference survives stemming too.
  assert.equal(nameStem("JPAR Ironhorse Real Estate"), "jpar ironhorse");
  assert.equal(nameStem("JPAR Iron Horse Real Estate"), "jpar iron horse");
});

/*
 * The pair this whole design exists to keep apart.
 *
 * "Rise Realty Of Florida LLC" is a real Agent Search client; "Rise Loan
 * Officers" is a real Master Inbox client. They are different companies that
 * share a first word, and any similarity score loose enough to join "Howe
 * Realty" to "Howe Realty Group" would join these too.
 */
test("different companies that share a word do NOT share a stem", () => {
  assert.notEqual(nameStem("Rise Realty Of Florida LLC"), nameStem("Rise Loan Officers"));
  assert.notEqual(nameStem("Momentum Lux Realty"), nameStem("Momentum Realty"));
  assert.notEqual(nameStem("The Discover Flag Team"), nameStem("The Keyes Company"));
});

test("a stem never collapses to nothing for a real client name", () => {
  // A name made ENTIRELY of stop words would stem to "", and an empty stem
  // matching another empty stem would join two unrelated clients. The resolver
  // guards on `stem &&`, and this pins the shape that guard exists for.
  assert.equal(nameStem("The Real Estate Group"), "");
  assert.notEqual(nameStem("54 Realty"), "");
  assert.notEqual(nameStem("Brandolino Group"), "");
});
