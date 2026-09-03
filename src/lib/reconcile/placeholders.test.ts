/*
 * Placeholder filtering.
 *
 * Two tools carry bucket rows that are not customers — Analytics an
 * "Unassigned" row for campaigns matching no client, Master Inbox an "Unknown"
 * one for unattributable replies. Comparing them yields a difference that is
 * real, permanent and useless, and a list with permanent noise at the top is a
 * list people stop reading.
 *
 * The danger runs the other way too: a filter this blunt could swallow an
 * actual client. "Demo Portal" and "Unknown Realty Group" are real rows in
 * Master Inbox today, and both must survive.
 *
 *   node --test src/lib/reconcile/placeholders.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * Mirrors the predicate in rosters.ts, which cannot be imported here — it is
 * `server-only` and pulls in the whole HTTP stack. The regex is the unit under
 * test and is duplicated deliberately; if it changes there and not here, these
 * tests keep passing while production changes behaviour, so the comment in
 * rosters.ts points back at this file.
 */
const PLACEHOLDER = /^(unassigned|unknown|none|n\/?a|test|demo)$/i;
const isPlaceholder = (name: string) => PLACEHOLDER.test(name.trim());

test("drops the bucket rows the tools actually use", () => {
  for (const name of ["Unassigned", "unassigned", "UNKNOWN", "Unknown", "None", "N/A", "na"]) {
    assert.equal(isPlaceholder(name), true, `${name} should be filtered`);
  }
});

test("tolerates surrounding whitespace", () => {
  assert.equal(isPlaceholder("  Unassigned  "), true);
});

test("KEEPS real clients whose names merely contain a placeholder word", () => {
  // The failure that would matter: silently eating a paying customer.
  const real = [
    "Demo Portal",            // a genuine Master Inbox row today
    "New client portal",      // likewise
    "Unknown Realty Group",
    "Test Valley Homes",
    "NA Realty Partners",
    "None Such Properties",
  ];
  for (const name of real) {
    assert.equal(isPlaceholder(name), false, `${name} must survive the filter`);
  }
});

test("only an exact, whole-string match is filtered", () => {
  assert.equal(isPlaceholder("Unassigned Leads"), false);
  assert.equal(isPlaceholder("The Unknown"), false);
  assert.equal(isPlaceholder("Demo"), true, "but a bare 'Demo' is a bucket");
});

test("an empty or whitespace name is not treated as a placeholder", () => {
  // Blank names are dropped earlier, by the `str()` guard. If one reached
  // here it would be a parsing bug, and quietly filtering it would hide that.
  assert.equal(isPlaceholder(""), false);
  assert.equal(isPlaceholder("   "), false);
});
