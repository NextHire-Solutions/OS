/*
 * Home's six figures and its chart (13 Oct). The arithmetic is pure; this pins
 * it with the numbers that were on the live Home page that day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { change, chartPoints, homeMetrics, ratio, sumWindow, threadsByDay } from "./overview-model.ts";

const byKey = (m: ReturnType<typeof homeMetrics>) => Object.fromEntries(m.map((x) => [x.key, x]));

test("the six tiles, in order — and Median Reply is not one of them", () => {
  const m = homeMetrics({ sent: 64227, replies: 332, prospects: 21409 }, { sent: 71600, replies: 519, prospects: 24000 }, 41, 60);
  assert.deepEqual(m.map((x) => x.key), ["sent", "replies", "reply-rate", "reply-rate-contact", "interested", "interested-rate"]);
  assert.equal(m.some((x) => /median/i.test(x.key + x.label)), false);
});

test("both reply rates: per email sent, and per person emailed", () => {
  const m = byKey(homeMetrics({ sent: 64227, replies: 332, prospects: 21409 }, null, 41, null));
  assert.equal(m["reply-rate"].value, 332 / 64227);
  assert.equal(m["reply-rate-contact"].value, 332 / 21409);
  // The per-contact rate is the larger whenever a sequence sends more than one email each.
  assert.ok(m["reply-rate-contact"].value! > m["reply-rate"].value!);
  assert.match(m["reply-rate"].label, /per email/);
  assert.match(m["reply-rate-contact"].label, /per contact/);
});

test("Interested is a count from Master Inbox; its rate is a share of the replies received", () => {
  const m = byKey(homeMetrics({ sent: 64227, replies: 332, prospects: 21409 }, null, 41, null));
  assert.equal(m.interested.value, 41);
  assert.equal(m["interested-rate"].value, 41 / 332);
  assert.match(m.interested.hint ?? "", /Master Inbox/);
});

test("deltas compare like with like: each rate against the SAME rate a week before", () => {
  const now = { sent: 1000, replies: 50, prospects: 400 };
  const before = { sent: 2000, replies: 50, prospects: 800 };
  const m = byKey(homeMetrics(now, before, 10, 5));
  assert.equal(m.sent.delta, -0.5);
  assert.equal(m.replies.delta, 0);
  assert.equal(m["reply-rate"].delta, (0.05 - 0.025) / 0.025);
  assert.equal(m["reply-rate-contact"].delta, (0.125 - 0.0625) / 0.0625);
  assert.equal(m.interested.delta, 1);
  assert.equal(m["interested-rate"].delta, (0.2 - 0.1) / 0.1);
});

test("what cannot be measured is null — a dash on the card, never 0%", () => {
  // Master Inbox unreadable: the two Interested tiles have no value.
  let m = byKey(homeMetrics({ sent: 100, replies: 5, prospects: 40 }, null, null, null));
  assert.equal(m.interested.value, null);
  assert.equal(m["interested-rate"].value, null);
  // Nothing sent, nobody emailed, no replies: no rate is invented.
  m = byKey(homeMetrics({ sent: 0, replies: 0, prospects: 0 }, { sent: 0, replies: 0, prospects: 0 }, 0, 0));
  assert.equal(m["reply-rate"].value, null);
  assert.equal(m["reply-rate-contact"].value, null);
  assert.equal(m["interested-rate"].value, null);
  assert.equal(m.interested.value, 0, "a real zero stays a zero");
  // People-emailed unknown: only that rate is missing.
  m = byKey(homeMetrics({ sent: 100, replies: 5, prospects: null }, null, 1, null));
  assert.equal(m["reply-rate"].value, 0.05);
  assert.equal(m["reply-rate-contact"].value, null);
  // No previous window: no delta anywhere.
  assert.ok(homeMetrics({ sent: 1, replies: 1, prospects: 1 }, null, 1, null).every((x) => x.delta === null));
  // A jump from zero is not a percentage.
  assert.equal(change(5, 0), null);
  assert.equal(ratio(5, 0), null);
  assert.equal(ratio(null, 5), null);
});

test("threads are counted once each, on the day of their newest label, in the business's day", () => {
  const day = (iso: string) => iso.slice(0, 10);
  const got = threadsByDay(
    [
      { target_id: "t1", assigned_at: "2026-10-10T15:00:00Z" },
      { target_id: "t1", assigned_at: "2026-10-12T09:00:00Z" }, // moved on to Introduction: counted on the 12th, once
      { target_id: "t2", assigned_at: "2026-10-12T23:00:00Z" },
      { target_id: "t3", assigned_at: "2026-10-11T01:00:00Z" },
      { target_id: "", assigned_at: "2026-10-11T01:00:00Z" },
    ],
    day,
  );
  assert.deepEqual([...got.entries()].sort(), [["2026-10-11", 1], ["2026-10-12", 2]]);
  // The day is whatever the caller's calendar says — Eastern, in the app.
  const eastern = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  assert.deepEqual([...threadsByDay([{ target_id: "t", assigned_at: "2026-10-12T02:30:00Z" }], eastern).keys()], ["2026-10-11"]);
});

test("a window sum includes both of its end days and nothing outside", () => {
  const m = new Map([["2026-10-06", 4], ["2026-10-07", 1], ["2026-10-13", 2], ["2026-10-14", 9]]);
  assert.equal(sumWindow(m, "2026-10-07", "2026-10-13"), 3);
  assert.equal(sumWindow(m, "2026-09-01", "2026-09-30"), 0);
});

test("the chart's points carry Analytics' volumes with Master Inbox's Interested in the Positive slot", () => {
  const points = chartPoints(
    [
      { date: "2026-10-11", sent: 9000, prospects: 3000, replies: 40, human: 31, positive: 99, bounces: 12 },
      { date: "2026-10-12", sent: 9500, prospects: 3100, replies: 55, human: 40, positive: 99, bounces: 7 },
      { sent: 1 },
      null,
    ],
    new Map([["2026-10-11", 6]]),
  );
  assert.deepEqual(points, [
    { date: "2026-10-11", sent: 9000, prospects: 3000, replies: 40, human: 31, positive: 6, bounces: 12 },
    // No Interested that day is a real zero — Analytics' own 99 is never shown under that name.
    { date: "2026-10-12", sent: 9500, prospects: 3100, replies: 55, human: 40, positive: 0, bounces: 7 },
  ]);
  assert.deepEqual(chartPoints(null, new Map()), []);
  assert.deepEqual(chartPoints({ points: [] }, new Map()), []);
});
