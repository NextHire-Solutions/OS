/*
 * Name-matching tests.
 *
 * This is where a discrepancy screen quietly goes wrong. Two mistakes are
 * possible and both are worse than a blank page:
 *
 *   over-matching   two different brokerages merged into one row, so real
 *                   drift is hidden and the screen reports false agreement
 *   under-matching  one client listed as "missing" from a tool it is in,
 *                   producing a list of phantom problems people learn to skip
 *
 * The names below are the real ones from Master Inbox, so the thresholds are
 * tuned against actual data rather than invented examples.
 *
 *   node --test src/lib/reconcile/names.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { diffRosters, normaliseName, similarity, LIKELY_THRESHOLD } from "./names.ts";

const e = (name: string, meta?: Record<string, unknown>) => ({ name, meta });

// --- normalisation -----------------------------------------------------------

test("normalisation folds the cosmetic differences", () => {
  assert.equal(normaliseName("The Keyes Company"), "keyes company");
  assert.equal(normaliseName("  KEYES   COMPANY  "), "keyes company");
  assert.equal(normaliseName("Keyes-Company"), "keyes company");
  assert.equal(normaliseName("Howe & Co"), "howe and co");
  assert.equal(normaliseName("C21 Results - Elite Team"), "c21 results elite team");
});

test("normalisation keeps meaningful words", () => {
  // "Realty" and "Group" distinguish real clients; stripping them would merge
  // firms that are genuinely different.
  assert.equal(normaliseName("Howe Realty Group"), "howe realty group");
  assert.notEqual(normaliseName("Howe Realty Group"), normaliseName("Howe Team"));
});

// --- similarity --------------------------------------------------------------

test("word order does not matter", () => {
  assert.equal(similarity("Douglas Elliman NYC", "NYC Douglas Elliman"), 1);
});

test("company suffixes do not block a match", () => {
  assert.ok(similarity("The Keyes Company", "Keyes Co") >= LIKELY_THRESHOLD,
    "an obvious abbreviation must be caught");
});

test("one shared generic word is NOT a match", () => {
  // The over-matching guard. Half the roster contains "Realty".
  assert.ok(similarity("54 Realty", "Coastal Realty") < LIKELY_THRESHOLD);
  assert.ok(similarity("Maltos Realty Group", "Howe Realty Group") < LIKELY_THRESHOLD);
});

test("unrelated names score near zero", () => {
  assert.ok(similarity("Jeff Cook Real Estate", "LIV Indy Realty") < 0.2);
});

test("an empty name never matches anything", () => {
  assert.equal(similarity("", "Keyes"), 0);
  assert.equal(similarity("The Co", "Keyes"), 0, "a name that is all noise words");
});

// --- the diff ----------------------------------------------------------------

test("identical rosters produce only matches", () => {
  const d = diffRosters(
    [e("54 Realty"), e("The Keyes Company")],
    [e("54 realty"), e("Keyes Company")],
  );
  assert.equal(d.matched.length, 2);
  assert.equal(d.likely.length, 0);
  assert.equal(d.onlyLeft.length, 0);
  assert.equal(d.onlyRight.length, 0);
});

test("a genuinely absent client lands in onlyLeft", () => {
  const d = diffRosters([e("54 Realty"), e("Demo Portal")], [e("54 Realty")]);
  assert.deepEqual(d.onlyLeft.map((x) => x.name), ["Demo Portal"]);
  assert.equal(d.matched.length, 1);
});

test("a spelling difference is 'likely', not 'missing'", () => {
  // The bucket that stops the screen crying wolf.
  const d = diffRosters([e("The Keyes Company")], [e("Keyes Co")]);
  assert.equal(d.onlyLeft.length, 0, "must not be reported as absent");
  assert.equal(d.onlyRight.length, 0);
  assert.equal(d.likely.length, 1);
  assert.ok(d.likely[0].score >= LIKELY_THRESHOLD);
});

test("an exact match is never also offered as a fuzzy candidate", () => {
  const d = diffRosters(
    [e("Howe Realty Group"), e("Howe Team")],
    [e("Howe Realty Group")],
  );
  assert.equal(d.matched.length, 1);
  assert.equal(d.likely.length, 0, "Howe Team must not pair with an already-matched name");
  assert.deepEqual(d.onlyLeft.map((x) => x.name), ["Howe Team"]);
});

test("each name is used at most once, and the best pair wins", () => {
  // Greedy-by-score matters: a weak pair found first must not consume a name
  // that is a far better fit for something later in the list.
  const d = diffRosters(
    [e("Douglas Elliman NYC")],
    [e("Douglas Elliman New York City"), e("Douglas Elliman NYC Team")],
  );
  assert.equal(d.likely.length, 1, "one name cannot match two counterparts");
  assert.equal(d.onlyRight.length, 1);
});

test("metadata survives the comparison", () => {
  // The screen needs the counts, not just the names.
  const d = diffRosters([e("54 Realty", { intros: 12 })], [e("54 Realty", { plan: "production" })]);
  assert.equal(d.matched[0].left.meta?.intros, 12);
  assert.equal(d.matched[0].right.meta?.plan, "production");
});

test("an empty side puts everything in the other bucket", () => {
  const d = diffRosters([e("A"), e("B")], []);
  assert.equal(d.onlyLeft.length, 2);
  assert.equal(d.matched.length, 0);
  assert.equal(d.likely.length, 0);
});

test("the real 57-vs-41 shape behaves sensibly", () => {
  const masterInbox = [
    e("The Keyes Company"), e("Douglas Elliman NYC"), e("LIV Indy Realty"),
    e("C21 Results - Elite Team"), e("Demo Portal"), e("New client portal"), e("EXR"),
  ];
  const clientHealth = [
    e("Keyes Company"), e("Douglas Elliman NYC"), e("LIV Indy Realty"),
    e("C21 Results Elite Team"),
  ];

  const d = diffRosters(masterInbox, clientHealth);

  assert.equal(d.onlyRight.length, 0, "Client Health has nothing Master Inbox lacks");
  assert.deepEqual(
    d.onlyLeft.map((x) => x.name).sort(),
    ["Demo Portal", "EXR", "New client portal"],
    "only the genuine extras — the test entries — are flagged",
  );
  assert.equal(d.matched.length + d.likely.length, 4, "the four real clients all pair up");
});
