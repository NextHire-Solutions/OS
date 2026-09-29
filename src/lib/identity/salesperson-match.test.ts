import assert from "node:assert/strict";
import { test } from "node:test";

import { isSoldBy, matchSalesperson, salespersonProblems, type Salesperson } from "./salesperson-match.ts";
import { isManagedBy, joinManagers, splitManagers } from "./team-match.ts";

const sp = (name: string, active = true): Salesperson => ({ id: name, name, email: null, active, rates: { monthOne: 0.7, residual: 0.15 } });

test("a salesperson is matched by exact name, ignoring case and spacing — never by a first name", () => {
  const people = [sp("Ryan Jagdeo"), sp("Scott Craigue"), sp("Eddy")];
  assert.equal(matchSalesperson("  ryan   jagdeo ", people).kind, "found");
  assert.equal(matchSalesperson("Ryan", people).kind, "none", "a first name is not enough — two Ryans would be a guess");
  assert.equal(matchSalesperson("", people).kind, "none");
  assert.equal(matchSalesperson("eddy", [sp("Eddy"), sp("EDDY")]).kind, "ambiguous");
  assert.ok(isSoldBy("RYAN JAGDEO", sp("Ryan Jagdeo")));
  assert.ok(!isSoldBy(null, sp("Eddy")));
});

test("salesperson names: required, no commas, a sane email", () => {
  assert.deepEqual(salespersonProblems({ name: "Amy Lee", email: "amy@x.com" }), []);
  assert.equal(salespersonProblems({ name: "  " }).length, 1);
  assert.equal(salespersonProblems({ name: "Lee, Amy" }).length, 1);
  assert.equal(salespersonProblems({ email: "not-an-email" }).length, 1);
  assert.deepEqual(salespersonProblems({ email: "" }), [], "blank email clears it");
});

test("several account managers live in one value, in order, and each is recognised", () => {
  assert.deepEqual(splitManagers("Amy, Eddy"), ["Amy", "Eddy"]);
  assert.deepEqual(splitManagers(" amy ,, Amy , eddy "), ["amy", "eddy"], "blanks and repeats dropped");
  assert.deepEqual(splitManagers(null), []);
  assert.equal(joinManagers(["Amy", "Eddy"]), "Amy, Eddy");
  assert.equal(joinManagers([]), null);
  const eddy = { name: "Eddy", email: "eddy@x.com" };
  assert.ok(isManagedBy("Amy, Eddy", eddy));
  assert.ok(isManagedBy("Eddy", eddy));
  assert.ok(!isManagedBy("Amy", eddy));
  assert.ok(!isManagedBy("Eddyson", eddy), "no partial matches");
});
