/*
 * The canonical roster.
 *
 * This list is now the source of truth for every client count in the
 * workspace, so a mistake here is not a display bug — it silently changes the
 * answer to "how many clients do we have?", which is the exact question that
 * caused the problem this roster exists to solve.
 *
 * Two failures matter and both are pinned:
 *
 *   over-merging   two real clients collapsing into one row, hiding a client
 *   silent drops   a live client falling out of every count with no signal
 *
 *   node --test src/lib/clients/roster.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ROSTER, isKnownNonClient, keyOf, matchRoster, resolve } from "./roster.ts";

test("the roster is the 36 clients the business named", () => {
  assert.equal(ROSTER.length, 36);
});

test("no two clients share a comparison key", () => {
  // An over-merge: two businesses collapsing into one row, so one of them
  // vanishes from every count without anything looking wrong.
  const keys = ROSTER.map((c) => keyOf(c.name));
  assert.equal(new Set(keys).size, keys.length, "two roster entries collide");
});

test("no alias collides with another client's name", () => {
  // The most dangerous mistake available here: an alias that points a tool's
  // rows at the wrong business.
  const names = new Map(ROSTER.map((c) => [keyOf(c.name), c.name]));
  for (const client of ROSTER) {
    for (const alias of client.aliases ?? []) {
      const owner = names.get(keyOf(alias));
      assert.ok(
        owner === undefined || owner === client.name,
        `alias "${alias}" on ${client.name} collides with ${owner}`,
      );
    }
  }
});

test("the spellings the tools actually use all resolve", () => {
  // Every one of these was observed in a live tool, not invented.
  const observed: [string, string][] = [
    ["BHGRE Basecamp", "BHGRE Base Camp"],
    ["C21 Results - Elite Team", "C21 Results Elite Team"],
    ["The Discover Phx Team", "Discover Phx Team"],
    ["Fast Real Estate", "FAST Real Estate"],
    ["JPAR Ironhorse Real Estate", "JPAR Iron Horse Real Estate"],
    ["PRG Real Estate at EXP", "PRG Real Estate at eXp"],
    ["Properties & Estates Florida", "Properties & Estates"],
    ["SERHANT. PA 15M+", "SERHANT. PA"],
    ["M Wagner Team", "Wagner Real Estate Group"],
  ];
  for (const [toolName, canonical] of observed) {
    assert.equal(resolve(toolName)?.name, canonical, `${toolName} did not resolve`);
  }
});

test("case, punctuation and a leading 'the' do not matter", () => {
  assert.equal(resolve("  the keyes company  ")?.name, "The Keyes Company");
  assert.equal(resolve("RE/MAX PACIFIC")?.name, "RE/MAX Pacific");
  assert.equal(resolve("Norvell & Co Real Estate")?.name, "Norvell&Co Real Estate");
});

test("two SERHANT offices stay separate", () => {
  // Same brand, different clients. Merging them would be invisible and wrong.
  assert.notEqual(resolve("SERHANT. NJ")?.name, resolve("SERHANT. PA")?.name);
});

test("the three Douglas Elliman offices stay separate", () => {
  const names = ["Douglas Elliman LA", "Douglas Elliman Las Vegas", "Douglas Elliman NYC"]
    .map((n) => resolve(n)?.name);
  assert.equal(new Set(names).size, 3);
});

test("Demo Portal is protected, not flagged as clutter", () => {
  // It backs a live demo client portal. Listing it as an unrecognised extra
  // would invite someone to delete it and take that portal down.
  assert.equal(isKnownNonClient("Demo Portal"), true);
  const m = matchRoster(["Demo Portal", "54 Realty"]);
  assert.equal(m.unknown.length, 0, "must never appear as a discrepancy");
  assert.equal(m.exempt[0]?.name, "Demo Portal");
  assert.match(m.exempt[0]?.reason ?? "", /keep/);
});

test("an unrecognised name is reported, never dropped", () => {
  // A client nobody told us about must surface, not disappear.
  const m = matchRoster(["54 Realty", "Some Brand New Client"]);
  assert.deepEqual(m.unknown, ["Some Brand New Client"]);
});

test("a roster client no tool has is reported as missing", () => {
  const m = matchRoster(["54 Realty"]);
  assert.equal(m.missing.length, 35);
  assert.equal(m.matched.size, 1);
});

test("two tool spellings of one client count once", () => {
  const m = matchRoster(["BHGRE Base Camp", "BHGRE Basecamp"]);
  assert.equal(m.matched.size, 1);
  assert.deepEqual(m.matched.get("BHGRE Base Camp"), ["BHGRE Base Camp", "BHGRE Basecamp"]);
});
