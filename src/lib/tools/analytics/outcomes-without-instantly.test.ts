import assert from "node:assert/strict";
import test from "node:test";

import { coverageWithoutInstantly, facetsWithoutInstantly, outcomeListPlatforms } from "./outcomes-without-instantly.ts";

/* Attribution with Instantly switched off (19 Nov 2026): its outcomes leave every figure; Direct stays. */

test("coverage: Instantly's outcomes leave the total, Another platform and the how-decided line; the rest is untouched", () => {
  const out = coverageWithoutInstantly({
    total: 120, attributed: 60, otherPlatform: 24, unattributed: 30, pending: 6,
    byMethod: { provided: 50, matched: 10, other_platform: 24, unresolved: 30, pending: 6 },
    byPlatform: { emailbison: 70, instantly: 24, direct: 26 },
  });
  assert.deepEqual(out, {
    total: 96, attributed: 60, otherPlatform: 0, unattributed: 30, pending: 6,
    byMethod: { provided: 50, matched: 10, unresolved: 30, pending: 6 },
    byPlatform: { emailbison: 70, direct: 26 },
  });
  // The parts still add up: the sources sum to the total.
  assert.equal(Object.values(out.byPlatform).reduce((a, b) => a + b, 0), out.total);
});

test("coverage with no Instantly outcomes in range is unchanged", () => {
  const c = { total: 5, attributed: 2, otherPlatform: 0, unattributed: 3, pending: 0, byMethod: { provided: 2, unresolved: 3 }, byPlatform: { emailbison: 5 } };
  assert.deepEqual(coverageWithoutInstantly(c), c);
});

test("dropdowns: no Instantly source; each type less its Instantly outcomes; a type left empty is gone", () => {
  const facets = [
    { kind: "type", value: "interview", n: 10 },
    { kind: "type", value: "hired", n: 4 },
    { kind: "type", value: "no_show", n: 2 },
    { kind: "platform", value: "emailbison", n: 9 },
    { kind: "platform", value: "instantly", n: 5 },
    { kind: "platform", value: "direct", n: 2 },
  ];
  assert.deepEqual(facetsWithoutInstantly(facets, new Map([["interview", 3], ["no_show", 2]])), [
    { kind: "type", value: "interview", n: 7 },
    { kind: "type", value: "hired", n: 4 },
    { kind: "platform", value: "emailbison", n: 9 },
    { kind: "platform", value: "direct", n: 2 },
  ]);
});

test("the list's sources: its own EmailBison or Direct choice, else both; never Instantly", () => {
  assert.deepEqual(outcomeListPlatforms([]), ["emailbison", "direct"]);
  assert.deepEqual(outcomeListPlatforms(["instantly"]), ["emailbison", "direct"]);
  assert.deepEqual(outcomeListPlatforms(["direct"]), ["direct"]);
  assert.deepEqual(outcomeListPlatforms(["emailbison"]), ["emailbison"]);
});
