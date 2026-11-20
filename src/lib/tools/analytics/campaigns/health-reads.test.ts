import assert from "node:assert/strict";
import { test } from "node:test";

import { readWarmupScores } from "./health-reads.ts";

/*
 * EmailBison's warm-up list, read in full or refused (independent review, 20 Nov): an inbox missing from it would
 * count as "too little warm-up mail to judge" and go onto a campaign unchecked.
 */

type Row = { id: number; warmup_score: number | null; warmup_emails_sent: number };
const PER = 15;
function fakeList(rows: Row[], o: { total?: number | null; dropOnFirstRead?: number[] } = {}) {
  let reads = 0;
  const calls: string[] = [];
  const request = async <T,>(path: string): Promise<T> => {
    calls.push(path);
    const n = Number(new URL(`https://x${path}`).searchParams.get("page"));
    if (n === 1) reads++;
    const shown = reads === 1 && o.dropOnFirstRead ? rows.filter((r) => !o.dropOnFirstRead!.includes(r.id)) : rows;
    const last = Math.max(1, Math.ceil(shown.length / PER));
    const meta = o.total === null ? {} : { total: o.total ?? rows.length, last_page: last, per_page: PER };
    return { data: shown.slice((n - 1) * PER, n * PER), meta } as T;
  };
  return { request, calls, reads: () => reads };
}
const rows = (n: number, score: (i: number) => number | null = () => 95): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, warmup_score: score(i), warmup_emails_sent: 40 }));

test("reads every page, with the 14-day window", async () => {
  const f = fakeList(rows(40));
  const m = await readWarmupScores(f.request, new Date("2026-11-20T12:00:00Z"));
  assert.equal(m.size, 40);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[0], /start_date=2026-11-06&end_date=2026-11-20&page=1/);
});

test("a score EmailBison leaves empty stays empty (unjudged), never 0", async () => {
  const m = await readWarmupScores(fakeList(rows(3, (i) => (i === 1 ? null : 92))).request);
  assert.deepEqual([...m.values()].map((v) => v.score), [92, null, 92]);
});

test("a list that comes back short is read again; inboxes that moved pages are then found", async () => {
  const f = fakeList(rows(31), { dropOnFirstRead: [17] });
  const m = await readWarmupScores(f.request);
  assert.equal(m.size, 31);
  assert.equal(f.reads(), 2);
});

test("still short after a second read: refused, so nothing is attached unchecked", async () => {
  const f = fakeList(rows(30), { total: 33 });
  await assert.rejects(readWarmupScores(f.request), /came back short \(30 of 33 inboxes\)/);
});

test("a list that doesn't say how long it is: refused", async () => {
  await assert.rejects(readWarmupScores(fakeList(rows(5), { total: null }).request), /didn't say how long it is/);
});
