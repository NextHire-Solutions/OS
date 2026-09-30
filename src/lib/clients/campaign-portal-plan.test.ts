import { test } from "node:test";
import assert from "node:assert/strict";
import { autoPortal, majority, marketWords } from "./campaign-portal-plan.ts";

const PE = ["Properties & Estates", "Properties & Estates Florida", "Properties & Estates Boston"];
const BOSTON = { id: "b", name: "Properties & Estates Boston" };
const FLORIDA = { id: "f", name: "Properties & Estates Florida" };

test("a portal's market words are what its name adds to the client's", () => {
  assert.deepEqual(marketWords("Properties & Estates Boston", ["Properties & Estates"]), ["boston"]);
  assert.deepEqual(marketWords("SERHANT. PA 15M+", ["SERHANT. PA"]), ["15m"]);
  assert.deepEqual(marketWords("SERHANT. PA", ["SERHANT. PA"]), []);
});

test("P&E's real campaigns go where their names say", () => {
  const cases: [string, string][] = [
    ["Properties & Estates Rutenberg 1 + South Florida + ZF NS1 (EST)", "f"],
    ["Properties & Estates Rutenberg + South Florida + ZF NS1 SEPT-2026 (EST)", "f"],
    ["Properties & Estates 3 + Nicole + Florida", "f"],
    ["Properties & Estates REMAX + Boston + ZF NS1 (EST)", "b"],
    ["Properties & Estates 1 + Nicole + Boston", "b"],
  ];
  for (const [name, want] of cases) {
    assert.equal(autoPortal(name, [BOSTON, FLORIDA], PE.slice(0, 1), "b").portalId, want, name);
  }
});

test("no market word, or both, falls back to the main portal", () => {
  assert.equal(autoPortal("Properties & Estates - RI", [BOSTON, FLORIDA], PE.slice(0, 1), "b").portalId, "b");
  assert.equal(autoPortal("Properties & Estates - Boston + West Palm + Florida", [BOSTON, FLORIDA], PE.slice(0, 1), "b").portalId, "b");
  assert.equal(autoPortal(null, [BOSTON, FLORIDA], PE.slice(0, 1), "f").portalId, "f");
});

test("a portal named exactly like the client never wins on words; its sibling does", () => {
  const base = { id: "pa", name: "SERHANT. PA" }, big = { id: "pa15", name: "SERHANT. PA 15M+" };
  assert.equal(autoPortal("SERHANT. PA 15M+ Philadelphia", [base, big], ["SERHANT. PA"], "pa").portalId, "pa15");
  assert.equal(autoPortal("SERHANT. PA Philadelphia", [base, big], ["SERHANT. PA"], "pa").portalId, "pa");
});

test("the reason is readable", () => {
  assert.match(autoPortal("Properties & Estates 1 + Nicole + Boston", [BOSTON, FLORIDA], ["Properties & Estates"], "f").reason, /boston/);
});

test("no market word: a campaign keeps the portal its replies already go to", () => {
  const base = { id: "pa", name: "SERHANT. PA" }, big = { id: "pa15", name: "SERHANT. PA 15M+" };
  // The real case: "BRIGHT 10M+" feeds the 15M+ portal today — keep it there.
  assert.equal(autoPortal("SERHANT. PA + Nicole + BRIGHT 10M+", [base, big], ["SERHANT. PA"], "pa", { replies: "pa15", guess: "pa15" }).portalId, "pa15");
  // A new campaign with no replies follows today's guess, if it is one of this client's portals…
  assert.equal(autoPortal("SERHANT. PA + BRIGHT 10M+ #2", [base, big], ["SERHANT. PA"], "pa", { replies: null, guess: "pa15" }).portalId, "pa15");
  // …and a guess naming some other client's portal is ignored.
  assert.equal(autoPortal("SERHANT. PA + BRIGHT", [base, big], ["SERHANT. PA"], "pa", { guess: "someone-else" }).portalId, "pa");
});

test("a market word beats where replies went — that is the bug being fixed", () => {
  assert.equal(autoPortal("Properties & Estates Rutenberg 1 + South Florida", [BOSTON, FLORIDA], ["Properties & Estates"], "b", { replies: "b", guess: "b" }).portalId, "f");
});

test("majority picks the most common portal, and null for none", () => {
  assert.equal(majority(["b", "f", "b", null]), "b");
  assert.equal(majority([]), null);
  assert.equal(majority([null]), null);
});
