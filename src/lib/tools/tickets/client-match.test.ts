import { test } from "node:test";
import assert from "node:assert/strict";

import { backfillQueries, buildClientIndex, isTeamAddress, matchSender, type MatchClient } from "./client-match.ts";

const C = (id: string, name: string, emails: string[], status = "active", internal = false): MatchClient => ({ id, name, status, internal, emails });

const index = buildClientIndex([
  C("homebase", "Homebase", ["john@myrehomebase.com", "ram@myrehomebase.com", "owner@gmail.com"]),
  C("de-lv", "Douglas Elliman Las Vegas", ["lv@elliman.com", "shared@elliman.com"]),
  C("de-la", "Douglas Elliman Los Angeles", ["la@elliman.com", "shared@elliman.com"], "churned"),
  C("kwteam", "Smith Team at KW", ["smith@kw.com"]),
  C("old", "Zed Realty", ["z@zedrealty.com", "shared@elliman.com"], "churned"),
  C("demo", "Demo Portal", ["demo@acme.com"], "active", true),
  C("ours", "Has our address", ["eddy@brokerstaffer.com"]),
]);

test("an address we hold for a client matches, case-insensitively — gmail addresses included", () => {
  assert.deepEqual(matchSender(index, "John@MyreHomebase.com"), { clientId: "homebase", method: "address", alsoOn: [] });
  assert.deepEqual(matchSender(index, "owner@gmail.com"), { clientId: "homebase", method: "address", alsoOn: [] });
  assert.equal(matchSender(index, "smith@kw.com")?.clientId, "kwteam");
});

test("THE RULE (user, 20 Nov): nothing but an exact client address — no company-domain guessing", () => {
  assert.equal(matchSender(index, "newhire@myrehomebase.com"), null, "someone at the client's company we don't hold");
  assert.equal(matchSender(index, "agent@kw.com"), null);
  assert.equal(matchSender(index, "someone@elliman.com"), null);
  assert.equal(matchSender(index, "stranger@gmail.com"), null);
  assert.equal(matchSender(index, "eddy@brokerstaffer.com"), null, "our own address is never a client, even if listed");
  assert.equal(matchSender(index, "demo@acme.com"), null, "internal records are never clients");
  assert.equal(matchSender(index, "not-an-email"), null);
  assert.equal(matchSender(index, null), null);
});

test("an address on several clients goes to the live one first, the rest named", () => {
  assert.deepEqual(matchSender(index, "shared@elliman.com"), { clientId: "de-lv", method: "address", alsoOn: ["de-la", "old"] });
});

test("team addresses: our domains and the named personal ones", () => {
  const team = new Set(["gabo@gmail.com"]);
  assert.equal(isTeamAddress("amy@brokerstaffer.com", team), true);
  assert.equal(isTeamAddress("x@mail.opslabs.ai", team), true);
  assert.equal(isTeamAddress("GABO@gmail.com", team), true);
  assert.equal(isTeamAddress("john@myrehomebase.com", team), false);
});

test("first-fill queries: client addresses in full, chunked; no domains, nothing of ours", () => {
  const q = backfillQueries(index, 30, 4);
  const terms = q.flatMap((s) => /from:\((.*)\)/.exec(s)![1].split(" OR "));
  assert.ok(q.every((s) => /^from:\(.+\) newer_than:30d -in:chats -in:drafts$/.test(s)));
  assert.ok(terms.every((t) => t.includes("@")), "every term is a full address");
  assert.deepEqual(terms.sort(), [...index.byEmail.keys()].sort());
  assert.ok(!terms.some((t) => /brokerstaffer|acme/.test(t)));
});
