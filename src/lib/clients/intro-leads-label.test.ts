import { test } from "node:test";
import assert from "node:assert/strict";

import { introLeadsLabel } from "./intro-leads-label.ts";

test("the label under each person says which leads they get, as the Introduce button decides it", () => {
  assert.deepEqual(introLeadsLabel({ name: "Lara Chopoorian", role: "Director", email: "lara@elliman.com", territories: ["REBNY", "Manhattan", "Brooklyn"] }), {
    text: "Gets REBNY, Manhattan, Brooklyn leads", tone: "some",
    title: "Leads from campaigns whose name includes REBNY, Manhattan or Brooklyn, and from any campaign that names no territory (those go to everyone).",
  });
  assert.equal(introLeadsLabel({ name: "Elisa", role: "Director", email: "e@x.com", territories: [] })?.text, "Gets every lead");
  assert.equal(introLeadsLabel({ name: "Elisa", role: "Director", email: "e@x.com", territories: null })?.tone, "all");
  assert.equal(introLeadsLabel({ name: "Sam", role: "  ", email: "s@x.com", territories: ["Columbia"] })?.text, "Gets no leads: add a role", "no role: not introduced at all");
  assert.equal(introLeadsLabel({ name: "Sam", role: "Agent", email: "", territories: ["Columbia"] })?.text, "Gets Columbia leads · not copied in: no email");
  assert.equal(introLeadsLabel({ name: "Sam", role: "Agent", email: null })?.text, "Gets every lead · not copied in: no email");
  assert.equal(introLeadsLabel({ name: "", role: "Agent" }), null, "an empty slot shows 'Add a person'");
  assert.equal(introLeadsLabel({ name: "Sam", role: "Agent", email: "s@x.com", territories: [" ", "Myrtle Beach ", ""] })?.text, "Gets Myrtle Beach leads");
});

test("the client record uses it for every person (1-3 and 4+), instead of the old 'Territory:' line", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync("src/components/screens/client-record.tsx", "utf8");
  assert.match(page, /introLeadsLabel\(value\)/);
  assert.doesNotMatch(page, /Territory: none, so every lead/);
});
