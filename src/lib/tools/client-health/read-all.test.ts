import { test } from "node:test";
import assert from "node:assert/strict";

import { readAll } from "./read-all.ts";

/* Pages through a table of `n` rows, capped at 1,000 per request like Supabase. */
function table(n: number, failAt?: number) {
  const asked: Array<[number, number]> = [];
  const page = (from: number, to: number) => {
    asked.push([from, to]);
    if (failAt != null && from >= failAt) return Promise.resolve({ data: null, error: { message: "boom" } });
    const end = Math.min(to + 1, from + 1000, n);
    return Promise.resolve({ data: Array.from({ length: Math.max(0, end - from) }, (_, i) => ({ i: from + i })), error: null });
  };
  return { page, asked };
}

test("reads every row past Supabase's 1,000, page by page", async () => {
  const t = table(2664);
  const r = await readAll<{ i: number }>(t.page);
  assert.equal(r.error, null);
  assert.equal(r.data.length, 2664);
  assert.deepEqual(r.data.map((x) => x.i), Array.from({ length: 2664 }, (_, i) => i));
  assert.deepEqual(t.asked, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test("an exact multiple of the page size ends on an empty page", async () => {
  const t = table(2000);
  const r = await readAll(t.page);
  assert.equal(r.data.length, 2000);
  assert.equal(t.asked.length, 3);
});

test("a cap stops reading after that many rows", async () => {
  const t = table(5000);
  const r = await readAll(t.page, { cap: 2600 });
  assert.equal(r.data.length, 2600);
  assert.deepEqual(t.asked, [[0, 999], [1000, 1999], [2000, 2599]]);
});

test("an error returns what was read so far, with the error", async () => {
  const t = table(5000, 2000);
  const r = await readAll(t.page);
  assert.equal(r.data.length, 2000);
  assert.equal(r.error?.message, "boom");
});
