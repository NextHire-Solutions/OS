import assert from "node:assert/strict";
import { test } from "node:test";

import { shiftWeekKey } from "./weeks.ts";

// The bug only shows east of UTC, so pin the process there.
process.env.TZ = "Asia/Kolkata";

test("one week back from Monday 28 Sep is Monday 21 Sep — in an IST browser too", () => {
  assert.equal(shiftWeekKey("2026-09-28", -1), "2026-09-21");
  assert.equal(shiftWeekKey("2026-09-28", -4), "2026-08-31");
  assert.equal(shiftWeekKey("2026-09-28", 0), "2026-09-28");
  assert.equal(shiftWeekKey("2026-09-28", 1), "2026-10-05");
});
