/*
 * The greeting.
 *
 * Worth its own test file for a small string, because the bug it replaced was
 * invisible in every screenshot: `new Date().getHours()` reads the LOCAL
 * clock, so the server (UTC) decided the greeting for everyone and the team
 * read "Good evening" from 2pm Eastern. It also broke hydration — React threw
 * #418 and regenerated the tree on every load from a non-UTC timezone.
 *
 * The property that matters is that the answer does NOT depend on the machine
 * running it. These tests set TZ explicitly to prove that.
 *
 *   node --test src/lib/workspace/greeting.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { greeting, hourInET } from "./greeting.ts";

test("the greeting follows Eastern time, not the machine's clock", () => {
  // 21:00 UTC is 17:00 EDT — afternoon in New York, evening in London. The
  // old code said "Good evening" to a US team at 5pm because the server is UTC.
  const t = new Date("2026-09-09T21:00:00Z");
  assert.equal(hourInET(t), 17);
  assert.equal(greeting(t), "Good afternoon");
});

test("the same instant gives the same greeting whatever TZ the process runs in", () => {
  // The actual hydration guarantee: server and browser must agree.
  const t = new Date("2026-09-09T21:00:00Z");
  const original = process.env.TZ;
  const answers = new Set<string>();
  try {
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Auckland", "Europe/London"]) {
      process.env.TZ = tz;
      answers.add(greeting(t));
    }
  } finally {
    process.env.TZ = original;
  }
  assert.equal(answers.size, 1, `disagreed across timezones: ${[...answers].join(" / ")}`);
});

test("the boundaries are noon and six", () => {
  // 16:00 UTC = 12:00 EDT, 22:00 UTC = 18:00 EDT.
  assert.equal(greeting(new Date("2026-09-09T15:59:00Z")), "Good morning");
  assert.equal(greeting(new Date("2026-09-09T16:00:00Z")), "Good afternoon");
  assert.equal(greeting(new Date("2026-09-09T21:59:00Z")), "Good afternoon");
  assert.equal(greeting(new Date("2026-09-09T22:00:00Z")), "Good evening");
});

test("midnight is morning, not evening", () => {
  // `hour12: false` renders midnight as "24" in some ICU builds, which would
  // greet the night shift "Good evening" at half past midnight.
  const midnightET = new Date("2026-09-09T04:00:00Z"); // 00:00 EDT
  assert.equal(hourInET(midnightET), 0);
  assert.equal(greeting(midnightET), "Good morning");
  assert.equal(greeting(new Date("2026-09-09T04:30:00Z")), "Good morning");
});

test("the switch to standard time does not shift the greeting by an hour", () => {
  // January: Eastern is UTC-5, not UTC-4. A hardcoded offset would read this
  // as 17:00 and say "Good afternoon".
  const winter = new Date("2026-01-15T23:30:00Z"); // 18:30 EST
  assert.equal(hourInET(winter), 18);
  assert.equal(greeting(winter), "Good evening");
});
