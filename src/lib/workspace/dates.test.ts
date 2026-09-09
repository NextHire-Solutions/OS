/*
 * Hydration-safe timestamps.
 *
 * The property under test is not "does it format nicely" — it is that the
 * answer does not depend on the machine rendering it. That is the whole
 * reason this module exists, and it is invisible in every screenshot.
 *
 * This bug has shipped twice: the greeting read the server's clock and told a
 * US team "Good evening" from 2pm, and the inbox rendered 01:12 UTC where the
 * browser rendered 21:12, throwing React #418 three times in one pass.
 *
 *   node --test src/lib/workspace/dates.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { dayStamp, fullStamp, hourInET, shortStamp } from "./dates.ts";

/** Runs `fn` under several timezones and returns the distinct answers. */
function acrossTimezones<T>(fn: () => T): Set<T> {
  const original = process.env.TZ;
  const seen = new Set<T>();
  try {
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Auckland", "Europe/London"]) {
      process.env.TZ = tz;
      seen.add(fn());
    }
  } finally {
    process.env.TZ = original;
  }
  return seen;
}

const NOW = Date.parse("2026-09-09T18:00:00Z"); // 14:00 EDT

test("every formatter gives one answer whatever timezone the process runs in", () => {
  // The hydration guarantee: the server and the browser must agree.
  const iso = "2026-09-09T17:12:00Z";
  for (const [label, fn] of [
    ["shortStamp", () => shortStamp(iso, NOW)],
    ["fullStamp", () => fullStamp(iso)],
    ["dayStamp", () => dayStamp(iso)],
    ["hourInET", () => String(hourInET(new Date(iso)))],
  ] as const) {
    const answers = acrossTimezones(fn);
    assert.equal(answers.size, 1, `${label} disagreed: ${[...answers].join(" / ")}`);
  }
});

test("times render in Eastern, not UTC and not the machine's zone", () => {
  // 17:12 UTC is 13:12 in New York. Rendering 17:12 would be the old bug.
  assert.equal(shortStamp("2026-09-09T17:12:00Z", NOW), "1:12 PM");
  assert.equal(fullStamp("2026-09-09T17:12:00Z"), "Sep 9, 1:12 PM");
});

test("today shows a time, older shows a date", () => {
  assert.match(shortStamp("2026-09-09T17:12:00Z", NOW), /^\d{1,2}:\d{2} (AM|PM)$/);
  assert.equal(shortStamp("2026-09-01T17:12:00Z", NOW), "Sep 1");
});

test("the today/older boundary is exactly 24 hours, measured from the given now", () => {
  // Not from Date.now(). A formatter that read the clock would flip this
  // between the server render and hydration, which is the bug itself.
  const justInside = new Date(NOW - 86_400_000 + 60_000).toISOString();
  const justOutside = new Date(NOW - 86_400_000 - 60_000).toISOString();
  assert.match(shortStamp(justInside, NOW), /(AM|PM)$/);
  assert.doesNotMatch(shortStamp(justOutside, NOW), /(AM|PM)$/);
});

test("the switch to standard time is handled, not hardcoded as an offset", () => {
  // January: Eastern is UTC-5, not UTC-4. A fixed offset reads this an hour out.
  assert.equal(hourInET(new Date("2026-01-15T23:30:00Z")), 18);
  assert.equal(hourInET(new Date("2026-07-15T23:30:00Z")), 19);
});

test("midnight is hour 0, never 24", () => {
  // `hour12: false` renders midnight as "24" in some ICU builds.
  assert.equal(hourInET(new Date("2026-09-09T04:00:00Z")), 0);
});

test("a missing or unparseable timestamp is empty, never a fabricated date", () => {
  for (const bad of [null, undefined, "", "not a date"]) {
    assert.equal(shortStamp(bad, NOW), "");
    assert.equal(fullStamp(bad), "");
    assert.equal(dayStamp(bad), "");
  }
});
