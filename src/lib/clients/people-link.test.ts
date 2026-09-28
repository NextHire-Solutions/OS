import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePerson, type TeamPerson } from "./people-link";

// The real list on 28 Sep, including its two near-duplicates.
const TEAM: TeamPerson[] = [
  { id: "p1", name: "Ryan Jagdeo", role: "salesperson" },
  { id: "p2", name: "Scott Craigue", role: "salesperson" },
  { id: "p3", name: "Eddy", role: "salesperson" },
  { id: "p4", name: "RYan", role: "salesperson" },
  { id: "p5", name: "vicky", role: "salesperson" },
];

test("blank clears", () => {
  assert.deepEqual(resolvePerson("", TEAM, "salesperson"), { kind: "clear" });
  assert.deepEqual(resolvePerson("   ", TEAM, "salesperson"), { kind: "clear" });
  assert.deepEqual(resolvePerson(null, TEAM, "account_manager"), { kind: "clear" });
});

test("a name matches whatever its case and spacing", () => {
  // …and hands back the team list's own spelling, which the master then stores.
  assert.deepEqual(resolvePerson("ryan  jagdeo", TEAM, "salesperson"), { kind: "found", id: "p1", name: "Ryan Jagdeo" });
  assert.deepEqual(resolvePerson(" Vicky ", TEAM, "salesperson"), { kind: "found", id: "p5", name: "vicky" });
});

test("whole names only — 'Ryan' is RYan, never Ryan Jagdeo", () => {
  assert.deepEqual(resolvePerson("Ryan", TEAM, "salesperson"), { kind: "found", id: "p4", name: "RYan" });
});

test("an unknown name is created in the requested role, tidied", () => {
  assert.deepEqual(resolvePerson("  Priya   Shah ", TEAM, "account_manager"), { kind: "create", name: "Priya Shah", role: "account_manager" });
});

test("someone in the requested role wins over a namesake in the other", () => {
  const t = [...TEAM, { id: "a1", name: "Eddy", role: "account_manager" }];
  assert.deepEqual(resolvePerson("eddy", t, "account_manager"), { kind: "found", id: "a1", name: "Eddy" });
  assert.deepEqual(resolvePerson("eddy", t, "salesperson"), { kind: "found", id: "p3", name: "Eddy" });
});

test("a person listed only in the other role is still that person, not a new one", () => {
  assert.deepEqual(resolvePerson("Scott Craigue", TEAM, "account_manager"), { kind: "found", id: "p2", name: "Scott Craigue" });
});

test("two people with the same name in the role is refused, not guessed", () => {
  const t = [...TEAM, { id: "p9", name: "Eddy", role: "salesperson" }];
  const r = resolvePerson("Eddy", t, "salesperson");
  assert.equal(r.kind, "ambiguous");
});
