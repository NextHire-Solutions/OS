import { test } from "node:test";
import assert from "node:assert/strict";

import { labelPolicy } from "./label-policy.ts";

const ok = (r: ReturnType<typeof labelPolicy>) => (r.ok ? r.effects.join(" ") : `REFUSED ${r.reason}`);

test("plain labels: allowed, nothing set off", () => {
  for (const l of ["Keep Warm", "OOO", "Objection", "Wrong Person", "Not Right Now"]) assert.equal(ok(labelPolicy(null, l)), "", l);
});

test("refused: TO Introduction (use the introduce action), FROM Introduction (portal entry), and a no-op", () => {
  assert.match(ok(labelPolicy("OOO", "Introduction")), /REFUSED.*inbox_introduce/);
  assert.match(ok(labelPolicy("Introduction", "Keep Warm")), /REFUSED.*portal entry/);
  assert.match(ok(labelPolicy("Keep Warm", "keep warm")), /REFUSED.*already/);
});

test("Interested / Meetings Booked: allowed, effects said (Slack alert, hand-off, per-lead billing)", () => {
  assert.match(ok(labelPolicy("OOO", "Interested")), /Slack alert.*direct hand-off.*billed/);
  assert.match(ok(labelPolicy("OOO", "Meetings Booked")), /booked call/);
});

test("stop labels: allowed, 'stopped in every campaign' said; Hostile also blacklists", () => {
  for (const l of ["Unsubscribe", "Do Not Contact", "Add to Blocklist"]) assert.match(ok(labelPolicy("OOO", l)), /stopped in every campaign/, l);
  assert.match(ok(labelPolicy("OOO", "Hostile")), /blacklisted.*stopped in every campaign/);
});

test("a lead that was Interested: a correction takes it off a per-lead bill; leaving a correction puts it back", () => {
  assert.match(ok(labelPolicy("Keep Warm", "Not Qualified", true)), /takes it off a per-lead client's bill/);
  assert.match(ok(labelPolicy("Not Interested", "Keep Warm", true)), /puts it back on a per-lead client's bill/);
  assert.match(ok(labelPolicy("Interested", "Keep Warm", true)), /Interested flag is cleared.*NOT undone/);
  assert.equal(ok(labelPolicy("Keep Warm", "Not Qualified", false)), "", "never Interested: no billing effect");
});
