import assert from "node:assert/strict";
import { test } from "node:test";

import { isManagedBy, matchTeamMember, type TeamMember } from "./team-match.ts";

const m = (name: string, email: string): TeamMember => ({ name, email, active: true, admin: false });
const team = [m("Ryan Jagdeo", "ryan@x.com"), m("Scott Craigue", "scott@x.com"), m("Sam", "sam1@x.com"), m("Sam", "sam2@x.com")];

test("a name matches its team member regardless of case and spacing", () => {
  const r = matchTeamMember("  ryan   JAGDEO ", team);
  assert.equal(r.kind, "found");
  assert.equal(r.kind === "found" && r.member.email, "ryan@x.com");
});

test("an address matches too; an unknown name is refused; a shared name is refused, not guessed", () => {
  assert.equal(matchTeamMember("SCOTT@x.com", team).kind, "found");
  assert.equal(matchTeamMember("Somebody Else", team).kind, "none");
  assert.equal(matchTeamMember("", team).kind, "none");
  assert.deepEqual(matchTeamMember("sam", team), { kind: "ambiguous", name: "Sam" });
});

test("a client belongs to the member whose name (or address) is on the record", () => {
  assert.equal(isManagedBy("Ryan Jagdeo", team[0]), true);
  assert.equal(isManagedBy("ryan jagdeo", team[0]), true);
  assert.equal(isManagedBy("ryan@x.com", team[0]), true);
  assert.equal(isManagedBy("Scott Craigue", team[0]), false);
  assert.equal(isManagedBy(null, team[0]), false);
});
