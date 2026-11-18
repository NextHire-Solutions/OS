import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYTICS_INSTANTLY_ON,
  INSTANTLY_OFF_MESSAGE,
  instantlyRead,
  isInstantlyJob,
  jobSwitchedOff,
  NO_INSTANTLY_ROWS,
  outcomePlatformsParam,
  sendingPlatformsParam,
} from "./instantly-switch.ts";
import { JOB_NAMES as JOBS } from "./sync/jobs.ts";
import { SCHEDULE, SCHEDULE_ENTRIES, dueJobsSince } from "./sync/schedule.ts";

/* Instantly switched off in Campaign Analytics (19 Nov 2026, the user's word); its code kept for later. */

test("it is off", () => {
  assert.equal(ANALYTICS_INSTANTLY_ON, false);
  assert.match(INSTANTLY_OFF_MESSAGE, /Instantly is switched off/);
});

test("every job that talks to Instantly is a sync-instantly-* job, and only those are switched off", () => {
  const instantly = JOBS.filter(isInstantlyJob);
  assert.equal(instantly.length, 14, instantly.join(", "));
  for (const job of JOBS) assert.equal(jobSwitchedOff(job), job.startsWith("sync-instantly"), job);
  for (const job of JOBS) assert.equal(jobSwitchedOff(job, true), false, `${job}, switched on`);
});

test("the schedule keeps every Instantly entry (code kept) but dispatches none of them", () => {
  assert.equal(SCHEDULE.filter((e) => isInstantlyJob(e.job)).length, 14);
  assert.equal(SCHEDULE_ENTRIES.filter((e) => isInstantlyJob(e.job)).length, 0);
  assert.equal(SCHEDULE_ENTRIES.length, SCHEDULE.length - 14);
  // A whole day, minute by minute: EmailBison's jobs still come due, Instantly's never do.
  const fired = new Set<string>();
  const day = Date.UTC(2026, 10, 19);
  for (let m = 1; m <= 24 * 60; m++) for (const j of dueJobsSince(new Date(day + m * 60_000), 1)) fired.add(j);
  assert.ok(fired.has("sync-senders") && fired.has("sync-replies"), [...fired].join(", "));
  assert.deepEqual([...fired].filter(isInstantlyJob), []);
  // Switched on, the same day fires them (the full schedule passed explicitly).
  const on = new Set<string>();
  for (let m = 1; m <= 24 * 60; m++) for (const j of dueJobsSince(new Date(day + m * 60_000), 1, SCHEDULE)) on.add(j);
  assert.equal([...on].filter(isInstantlyJob).length, 14);
});

test("an Instantly read switched off asks nothing and answers like an empty table", async () => {
  let asked = 0;
  const read = () => { asked++; return Promise.resolve({ data: [{ id: "x" }], error: null }); };
  assert.deepEqual(await instantlyRead(read), NO_INSTANTLY_ROWS);
  assert.equal(asked, 0);
  assert.deepEqual(await instantlyRead(read, true), { data: [{ id: "x" }], error: null });
  assert.equal(asked, 1);
});

test("sending figures: EmailBison alone, whatever an old link asks; switched on, null still means every platform", () => {
  for (const asked of [[], ["instantly"], ["emailbison", "instantly"]]) assert.deepEqual(sendingPlatformsParam(asked), ["emailbison"]);
  assert.equal(sendingPlatformsParam([], true), null);
  assert.deepEqual(sendingPlatformsParam(["instantly"], true), ["instantly"]);
});

test("outcomes: everything but Instantly — Direct stays in", () => {
  for (const asked of [[], ["instantly"], ["emailbison"]]) assert.deepEqual(outcomePlatformsParam(asked), ["emailbison", "direct"]);
  assert.equal(outcomePlatformsParam([], true), null);
});
