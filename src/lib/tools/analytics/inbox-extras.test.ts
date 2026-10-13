import { test } from "node:test";
import assert from "node:assert/strict";

import { canSend, pooled, resolveAssigned, score, warmupRange, withExtras } from "./inbox-extras.ts";

test("a campaign can send when it is active, queued or launching — in any case", () => {
  for (const s of ["active", "Active", " Launching ", "QUEUED"]) assert.equal(canSend(s), true, s);
  for (const s of ["paused", "Completed", "draft", "archived", "", null, undefined]) assert.equal(canSend(s), false, String(s));
});

test("warmup range: the last N days ending today, across a month boundary", () => {
  assert.deepEqual(warmupRange("2026-10-13", 3), { start: "2026-10-10", end: "2026-10-13" });
  assert.deepEqual(warmupRange("2026-10-02", 7), { start: "2026-09-25", end: "2026-10-02" });
});

test("score: a whole number, or nothing — never a made-up zero", () => {
  assert.equal(score(100), 100);
  assert.equal(score(87.6), 88);
  assert.equal(score("42"), 42);
  assert.equal(score(0), 0, "a real zero stays a zero");
  for (const v of [null, undefined, "", "abc", NaN, {}]) assert.equal(score(v), null);
});

test("pooled: every item done once, results in order, never more at once than asked", async () => {
  let running = 0;
  let peak = 0;
  const out = await pooled([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.deepEqual(await pooled([], 3, async () => 1), []);
});

function fixture(campaigns: Record<number, number[]>, onInbox: Record<number, Array<{ id: number; status: string }>> = {}) {
  const calls = { walks: [] as number[], asks: [] as number[] };
  return {
    calls,
    inboxesOf: async (id: number) => { calls.walks.push(id); return campaigns[id] ?? []; },
    campaignsOf: async (id: number) => { calls.asks.push(id); return onInbox[id] ?? []; },
  };
}

test("assigned: one walk settles the shared pool; only the rest are asked one by one", async () => {
  // The real shape: every active campaign holds the same pool.
  const pool = [1, 2, 3, 4, 5, 6];
  const f = fixture({ 100: pool, 101: pool, 102: pool }, { 7: [{ id: 100, status: "paused" }], 8: [{ id: 555, status: "Active" }] });
  const assigned = await resolveAssigned({ inboxIds: [1, 2, 3, 4, 5, 6, 7, 8, 9], campaignIds: [100, 101, 102], ...f });
  assert.deepEqual([...assigned].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 8]);
  assert.deepEqual(f.calls.walks, [100], "not one walk per campaign");
  assert.deepEqual(f.calls.asks.sort((a, b) => a - b), [7, 8, 9]);
});

test("assigned: an inbox only on a paused or finished campaign is No", async () => {
  const f = fixture({ 100: [1] }, { 2: [{ id: 9, status: "paused" }, { id: 8, status: "completed" }] });
  const assigned = await resolveAssigned({ inboxIds: [1, 2], campaignIds: [100], ...f });
  assert.deepEqual([...assigned], [1]);
});

test("assigned: with many inboxes still unsettled another campaign is walked first, within the limit", async () => {
  const f = fixture({ 100: [1], 101: [2], 102: [3], 103: [4], 104: [5] });
  await resolveAssigned({ inboxIds: [1, 2, 3, 4, 5, 6, 7, 8], campaignIds: [100, 101, 102, 103, 104], askBelow: 2, maxWalks: 3, ...f });
  assert.deepEqual(f.calls.walks, [100, 101, 102], "stops at maxWalks");
  assert.deepEqual(f.calls.asks.sort((a, b) => a - b), [4, 5, 6, 7, 8]);
});

test("assigned: a second walk that settles nobody stops the walking", async () => {
  const f = fixture({ 100: [1], 101: [1], 102: [1] });
  await resolveAssigned({ inboxIds: [1, 2, 3, 4], campaignIds: [100, 101, 102], askBelow: 0, maxWalks: 9, ...f });
  assert.deepEqual(f.calls.walks, [100, 101]);
});

test("assigned: no campaign can send — nobody is assigned and nothing is asked", async () => {
  const f = fixture({});
  const assigned = await resolveAssigned({ inboxIds: [1, 2], campaignIds: [], ...f });
  assert.equal(assigned.size, 0);
  assert.deepEqual(f.calls, { walks: [], asks: [] });
});

test("assigned: an inbox on a campaign's list that is not ours is ignored", async () => {
  const f = fixture({ 100: [1, 999] });
  const assigned = await resolveAssigned({ inboxIds: [1], campaignIds: [100], ...f });
  assert.deepEqual([...assigned], [1]);
});

test("assigned: a failed read fails the whole answer rather than calling inboxes unassigned", async () => {
  const f = fixture({ 100: [1] });
  await assert.rejects(
    resolveAssigned({ inboxIds: [1, 2], campaignIds: [100], ...f, campaignsOf: async () => { throw new Error("EmailBison 500"); } }),
    /EmailBison 500/,
  );
});

test("assigned: progress counts the one-by-one asks", async () => {
  const f = fixture({ 100: [1] });
  const seen: Array<[number, number]> = [];
  await resolveAssigned({ inboxIds: [1, 2, 3], campaignIds: [100], concurrency: 1, onProgress: (d, t) => seen.push([d, t]), ...f });
  assert.deepEqual(seen, [[1, 2], [2, 2]]);
});

const row = (id: number | string, platform = "emailbison", assignedToCampaign: boolean | null = false) => ({
  id, platform, warmup3d: null as number | null, warmup7d: null as number | null, assignedToCampaign,
});

test("extras laid over the table: scores by inbox id, assigned exact for EmailBison", () => {
  const out = withExtras([row(1, "emailbison", false), row(2, "emailbison", true), row(3)], {
    warmup: { "1": [100, 97], "2": [0, null] },
    assigned: [1],
    asOf: "2026-10-13T12:00:00Z",
  });
  assert.deepEqual(out[0], { id: 1, platform: "emailbison", warmup3d: 100, warmup7d: 97, assignedToCampaign: true });
  assert.deepEqual(out[1], { id: 2, platform: "emailbison", warmup3d: 0, warmup7d: null, assignedToCampaign: false }, "the estimate said Yes; EmailBison says it is on no sending campaign");
  assert.deepEqual(out[2], { id: 3, platform: "emailbison", warmup3d: null, warmup7d: null, assignedToCampaign: false }, "no score on record keeps its dash");
});

test("extras never touch Instantly's rows, and no extras changes nothing", () => {
  const inst = row("a@b.com", "instantly", null);
  assert.deepEqual(withExtras([inst], { warmup: { "a@b.com": [50, 50] }, assigned: [], asOf: "x" }), [inst]);
  const rows = [row(1, "emailbison", true)];
  assert.deepEqual(withExtras(rows, null), rows);
});
