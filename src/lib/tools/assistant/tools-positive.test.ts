import { test } from "node:test";
import assert from "node:assert/strict";

import { positivesOf } from "./tools-positive.ts";

const T = (client: string | null, status = "open") => ({ client, lead: "x", subject: "s", status });

test("positive = first marked Interested/Introduction in the period, unless corrected now; trash and earlier ones out", () => {
  const since = Date.parse("2026-11-20T00:00:00Z");
  const first = new Map([
    ["a", "2026-11-21T10:00:00Z"], // in the period, Introduction now → counts
    ["b", "2026-11-22T10:00:00Z"], // in the period, corrected to Not Interested → out
    ["c", "2026-11-10T10:00:00Z"], // first positive BEFORE the period (re-labelled since) → out
    ["d", "2026-11-23T10:00:00Z"], // in the period, but in trash → out
    ["e", "2026-11-24T10:00:00Z"], // in the period, Keep Warm now (not a correction) → counts
  ]);
  const now = new Map([["a", ["Introduction"]], ["b", ["Not Interested"]], ["c", ["Interested"]], ["d", ["Interested"]], ["e", ["Keep Warm"]]]);
  const threads = new Map([["a", T("Howe")], ["b", T("Howe")], ["c", T("LIV")], ["d", T("LIV", "trash")], ["e", T("LIV")]]);
  const rows = positivesOf(first, now, threads, since);
  assert.deepEqual(rows.map((r) => r.thread_id), ["e", "a"], "newest first");
  assert.deepEqual(rows.map((r) => r.labelNow), ["Keep Warm", "Introduction"]);
});
