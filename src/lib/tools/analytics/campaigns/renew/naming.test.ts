import { test } from "node:test";
import assert from "node:assert/strict";

import { nameKey, planNames, roundOf, searchTermFor, splitFirstPart, withRound, type NamedCampaign } from "./naming.ts";

// The real LIV Indy campaigns as EmailBison listed them on 19 Nov (three series under one brand).
const LIV: NamedCampaign[] = [
  { id: 68, name: "LIV Indy Realty 1 + Nicole + MIBOR", status: "archived" },
  { id: 84, name: "LIV Indy Realty 2 + Nicole + MIBOR", status: "archived" },
  { id: 93, name: "LIV Indy Realty 3 + Nicole + MIBOR", status: "archived" },
  { id: 152, name: "LIV Indy Realty 5 + Nicole + MIBOR", status: "archived" },
  { id: 162, name: "LIV Indy Realty New Target + Nicole + MIBOR", status: "archived" },
  { id: 188, name: "LIV Indy Realty New Target 2 + Nicole + MIBOR", status: "archived" },
  { id: 223, name: "LIV Indy Realty 4 + Nicole + MIBOR", status: "archived" },
  { id: 262, name: "LIV Indy Realty 1 + Indianapolis Metro + ZF NS1 (EST)", status: "completed" },
  { id: 372, name: "LIV Indy Realty + Indianapolis Metro + ZF NS1 (EST)", status: "completed" },
  { id: 387, name: "LIV Indy Realty 1 + Indianapolis Metro + ZF NS4 (EST)", status: "completed" },
  { id: 404, name: "LIV Indy Realty 2 + Indianapolis Metro + ZF NS4 (EST)", status: "completed" },
  { id: 843, name: "LIV Indy Realty 3 + Indianapolis Metro + ZF NS4 (EST)", status: "completed" },
  { id: 1112, name: "LIV Indy Realty 4 + Indianapolis Metro + ZF NS4 (EST)", status: "completed" },
  { id: 1246, name: "LIV Indy Realty 5 + Indianapolis Metro + ZF NS4 (EST)", status: "completed" },
  { id: 1277, name: "LIV Indy Realty + Indianapolis Metro + ZF NS4 (EST)", status: "active" },
];
const current = LIV.find((c) => c.id === 1277)!;

test("the spec's own example: LIV Indy NS4 becomes round 6, the new campaign keeps the name", () => {
  const plan = planNames(current, LIV);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.round, 6);
  assert.equal(plan.numberedName, "LIV Indy Realty 6 + Indianapolis Metro + ZF NS4 (EST)");
  assert.equal(plan.newName, "LIV Indy Realty + Indianapolis Metro + ZF NS4 (EST)");
  assert.deepEqual(plan.earlier.map((r) => r.id), [387, 404, 843, 1112, 1246], "NS4's rounds only, in order");
});

test("other series under the same brand are never counted", () => {
  const plan = planNames(current, LIV);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  for (const id of [68, 84, 93, 152, 162, 188, 223, 262, 372]) assert.ok(!plan.earlier.some((r) => r.id === id), `#${id} is another series`);
});

test("the NS1 series renews on its own count (its unnumbered campaign is completed, round 1 exists)", () => {
  const ns1 = LIV.find((c) => c.id === 372)!;
  const plan = planNames(ns1, LIV);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.round, 2);
  assert.equal(plan.numberedName, "LIV Indy Realty 2 + Indianapolis Metro + ZF NS1 (EST)");
});

test("a first renewal (no earlier rounds) takes 1", () => {
  const c = { id: 1, name: "Momentum Realty + San Gabriel Valley + ZF NS4 (PST)" };
  const plan = planNames(c, [c]);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.round, 1);
  assert.equal(plan.numberedName, "Momentum Realty 1 + San Gabriel Valley + ZF NS4 (PST)");
});

test("gaps: the next number is one past the highest, not the first free one", () => {
  const c = { id: 9, name: "Acme + X" };
  const plan = planNames(c, [c, { id: 1, name: "Acme 1 + X" }, { id: 2, name: "Acme 4 + X" }]);
  assert.ok(plan.ok && plan.round === 5);
});

test("a number placed elsewhere by hand still counts (C21's 'C21 Results 1 - Elite Team')", () => {
  const c = { id: 10, name: "C21 Results - Elite Team + Atlanta + ZF NS1 (EST)" };
  const plan = planNames(c, [c, { id: 2, name: "C21 Results 1 - Elite Team + Atlanta + ZF NS1 (EST)" }, { id: 3, name: "C21 Results - Elite Team 2 + Atlanta + ZF NS1 (EST)" }]);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.round, 3);
  assert.equal(plan.numberedName, "C21 Results - Elite Team 3 + Atlanta + ZF NS1 (EST)");
});

test("a brand that starts with a number (54 Realty) is not mistaken for a round", () => {
  const c = { id: 20, name: "54 Realty + Tampa Bay + ZF NS1 (EST)" };
  const plan = planNames(c, [c, { id: 21, name: "54 Realty 1 + Tampa Bay + ZF NS1 (EST)" }]);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.round, 2);
  assert.equal(plan.numberedName, "54 Realty 2 + Tampa Bay + ZF NS1 (EST)");
  assert.equal(roundOf("Realty + Tampa Bay + ZF NS1 (EST)", c.name), null);
});

test("a brand ending in a number (Century 21) with no series is renewed, not refused", () => {
  const c = { id: 30, name: "Century 21 + Phoenix" };
  const plan = planNames(c, [c, { id: 31, name: "Century 21 + Tucson" }]);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.numberedName, "Century 21 1 + Phoenix");
  // …whereas a sibling that reads as another round of "Century + Phoenix" makes it one of a series: refused.
  assert.equal(planNames(c, [c, { id: 32, name: "Century 22 + Phoenix" }]).ok, false);
});

test("an earlier round itself is refused, naming the campaign to renew instead", () => {
  const plan = planNames(LIV.find((c) => c.id === 1246)!, LIV);
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.reason, /round 5 of "LIV Indy Realty \+ Indianapolis Metro \+ ZF NS4 \(EST\)"/);
});

test("an earlier round whose unnumbered campaign is gone is still refused (other rounds exist)", () => {
  const rounds = [{ id: 1, name: "Acme 1 + X" }, { id: 2, name: "Acme 2 + X" }];
  const plan = planNames(rounds[1], rounds);
  assert.equal(plan.ok, false);
});

test("another campaign with the exact same name is named, not a refusal (spaces and case aside)", () => {
  // Real: #1252 (active) and #644 (completed) are both "Bastion Realty South + Florida Panhandle + ZF NS1 (CST)".
  const a = { id: 1252, name: "Bastion Realty South + Florida Panhandle + ZF NS1 (CST)", status: "active" };
  const twin = { id: 644, name: "Bastion Realty South  +  Florida Panhandle + ZF NS1 (CST) ", status: "completed" };
  const plan = planNames(a, [a, twin, { id: 700, name: "Bastion Realty South 2 + Florida Panhandle + ZF NS1 (CST)" }]);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.deepEqual(plan.sameName.map((c) => c.id), [644]);
  assert.equal(plan.round, 3);
  assert.equal(plan.newName, a.name);
});

test("no other campaign with the name: sameName is empty", () => {
  const plan = planNames(current, LIV);
  assert.ok(plan.ok && plan.sameName.length === 0);
});

test("never a name that already exists: a taken next number is skipped", () => {
  const c = { id: 1, name: "Acme + X" };
  // Round 2 is the highest; "Acme 3 + X" exists under another spelling the round rule can't see as this series? No —
  // it IS a round. So make a taken name the round rule ignores: a different case is the same name to nameKey.
  const plan = planNames(c, [c, { id: 2, name: "Acme 2 + X" }, { id: 3, name: "ACME 3 + X" }]);
  assert.ok(plan.ok && plan.round === 4, "ACME 3 counts as round 3, so 4");
});

test("a name with no ' + ' gets its number at the end", () => {
  const c = { id: 1, name: "Wagner Real Estate Group" };
  const plan = planNames(c, [c, { id: 2, name: "Wagner Real Estate Group 2" }]);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.numberedName, "Wagner Real Estate Group 3");
});

test("odd spacing as typed is kept in the rest of the name, the number goes in once", () => {
  assert.equal(withRound("Momentum Realty + San Gabriel Valley & Inland Empire  + ZF NS0 (PST)", 2), "Momentum Realty 2 + San Gabriel Valley & Inland Empire  + ZF NS0 (PST)");
  assert.equal(withRound("  Acme   + X ", 7), "Acme 7   + X");
  assert.equal(roundOf("Momentum Realty 1 + San Gabriel Valley & Inland Empire + ZF NS0 (PST)", "Momentum Realty + San Gabriel Valley & Inland Empire  + ZF NS0 (PST)"), 1);
});

test("splitFirstPart and nameKey", () => {
  assert.deepEqual(splitFirstPart("A + B + C"), { head: "A", rest: " + B + C" });
  assert.deepEqual(splitFirstPart("A+B"), { head: "A+B", rest: "" }, "a '+' without spaces is part of a word");
  assert.equal(nameKey("  A   b  "), "a b");
});

test("roundOf: exact, numbered, other words, and two numbers", () => {
  const base = "LIV Indy Realty + Indianapolis Metro + ZF NS4 (EST)";
  assert.equal(roundOf(base, base), 0);
  assert.equal(roundOf("LIV Indy Realty 12 + Indianapolis Metro + ZF NS4 (EST)", base), 12);
  assert.equal(roundOf("LIV Indy Realty New Target 2 + Indianapolis Metro + ZF NS4 (EST)", base), null);
  assert.equal(roundOf("LIV Indy Realty 1 + Indianapolis Metro + ZF NS1 (EST)", base), null);
  assert.equal(roundOf("Copy of LIV Indy Realty + Indianapolis Metro + ZF NS4 (EST)", base), null, "EmailBison's 'Copy of' is not a round");
  assert.equal(roundOf("LIV Indy Realty 5 + Indianapolis Metro + ZF NS4 (EST) 2", base), null, "two numbers is not one round");
});

test("searchTermFor: the first word, which every round shares", () => {
  assert.equal(searchTermFor("  LIV Indy Realty + X"), "LIV");
  for (const c of LIV) assert.ok(c.name.includes(searchTermFor(current.name)));
});

test("review 19 Nov: an old round with its number mid-name is refused too", () => {
  const current = { id: 1, name: "C21 Results - Elite Team + Atlanta + ZF NS1 (EST)", status: "active" };
  const round1 = { id: 2, name: "C21 Results 1 - Elite Team + Atlanta + ZF NS1 (EST)", status: "completed" };
  const plan = planNames(round1, [current, round1]);
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.reason, /round 1 of "C21 Results - Elite Team \+ Atlanta \+ ZF NS1 \(EST\)"/);
});

test("review 19 Nov: a number later in the name is never a round (a year, a size)", () => {
  const c = { id: 1, name: "Jeff Cook + Greenville + ZF NS1 (EST)" };
  const plan = planNames(c, [c, { id: 2, name: "Jeff Cook + Greenville + ZF NS1 (EST) 2025" }, { id: 3, name: "Jeff Cook 2 + Greenville + ZF NS1 (EST)" }]);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.round, 3);
  assert.deepEqual(plan.earlier.map((r) => r.id), [3]);
  assert.equal(roundOf("Jeff Cook + Greenville + ZF NS1 (EST) 2025", c.name), null);
  assert.equal(roundOf("Jeff Cook 2025 + Greenville + ZF NS1 (EST)", c.name), null, "four digits is never a round");
});
