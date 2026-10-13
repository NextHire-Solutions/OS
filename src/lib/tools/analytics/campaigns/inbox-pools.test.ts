import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_POOLS, cleanPools, mergeAssignments, poolNames, poolPreview, togglePool, unionIds, type PoolSummary } from "./inbox-pools.ts";

test("pools: trimmed, blanks dropped, one of each, exact names kept apart", () => {
  assert.deepEqual(cleanPools([" Zapmail ", "Zapmail", "", "  ", "Nicole Pool", "Nicole Pool 2", 7, null]), ["Zapmail", "Nicole Pool", "Nicole Pool 2"]);
  assert.deepEqual(cleanPools(["zapmail", "Zapmail"]), ["zapmail", "Zapmail"], "a tag is matched exactly upstream, so case is kept");
  assert.equal(cleanPools(Array.from({ length: 40 }, (_, i) => `P${i}`)).length, MAX_POOLS);
});

test("ticking and unticking a pool", () => {
  assert.deepEqual(togglePool([], "A"), ["A"]);
  assert.deepEqual(togglePool(["A"], "B"), ["A", "B"]);
  assert.deepEqual(togglePool(["A", "B"], "A"), ["B"]);
});

test("union: an inbox in two pools is one inbox", () => {
  assert.deepEqual(unionIds([[1, 2, 3], [3, 4], []]), [1, 2, 3, 4]);
  assert.deepEqual(unionIds([]), []);
});

test("attach preview: connected inboxes over the union; the dead are counted, not sent", () => {
  // Pool A = 1,2,3 (3 dead); pool B = 3,4. Union 1-4, connected 1,2,4.
  const p = poolPreview({ action: "attach", all: [1, 2, 3, 4], connected: [1, 2, 4], assigned: null });
  assert.deepEqual(p, { willSend: 3, dead: 1, onAlready: null, changes: 3 });
});

test("attach preview for one campaign: what is already on it does not count as a change", () => {
  const p = poolPreview({ action: "attach", all: [1, 2, 3, 4], connected: [1, 2, 4], assigned: [2, 9] });
  assert.deepEqual(p, { willSend: 3, dead: 1, onAlready: 1, changes: 2 });
  const none = poolPreview({ action: "attach", all: [1, 2], connected: [1, 2], assigned: [1, 2, 3] });
  assert.equal(none.changes, 0, "everything is already on: nothing to add");
});

test("remove preview: every tagged inbox is in play, and only what the campaign holds changes", () => {
  const blind = poolPreview({ action: "remove", all: [1, 2, 3, 4], connected: [1, 2, 4], assigned: null });
  assert.deepEqual(blind, { willSend: 4, dead: 1, onAlready: null, changes: 4 });
  const known = poolPreview({ action: "remove", all: [1, 2, 3, 4], connected: [1, 2, 4], assigned: [3, 4, 9] });
  assert.equal(known.changes, 2, "3 (dead, but attached) and 4 come off; 1 and 2 were never on");
  assert.equal(poolPreview({ action: "remove", all: [1], connected: [1], assigned: [] }).changes, 0);
});

const pool = (tag: string, results: PoolSummary["results"], inboxes = 10, skippedDisconnected = 0): PoolSummary => ({
  batchId: `b-${tag}`, tag, action: "attach", inboxes, skippedDisconnected, results,
});
const row = (campaignId: string, extra: Partial<PoolSummary["results"][number]> = {}) => ({
  campaignId, platform: "emailbison" as const, name: `C${campaignId}`, ok: true, applied: 10, ...extra,
});

test("merge: one row per campaign, applied added up, each pool's outcome kept", () => {
  const out = mergeAssignments("attach", [pool("A", [row("1"), row("2")]), pool("B", [row("1", { applied: 4, alreadyAttached: 3 }), row("2", { applied: 4 })], 4)]);
  assert.deepEqual(out.tags, ["A", "B"]);
  assert.equal(out.tag, "A");
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.results[0], { campaignId: "1", platform: "emailbison", name: "C1", ok: true, applied: 14, alreadyAttached: 3, error: undefined });
  assert.equal(out.inboxes, 14, "the sum when the union is not known");
  assert.equal(out.pools.length, 2);
});

test("merge: a campaign is ok only if every pool went through, and the error names the pool", () => {
  const out = mergeAssignments("attach", [
    pool("A", [row("1"), row("2")]),
    pool("B", [row("1", { ok: false, applied: 0, error: "refused" }), row("2")]),
  ]);
  const one = out.results.find((r) => r.campaignId === "1")!;
  assert.equal(one.ok, false);
  assert.equal(one.applied, 10, "pool A's inboxes did go on");
  assert.equal(one.error, "B: refused");
  assert.equal(out.results.find((r) => r.campaignId === "2")!.ok, true);
});

test("merge: two pools failing on one campaign keep both reasons", () => {
  const out = mergeAssignments("remove", [
    pool("A", [row("1", { ok: false, applied: 0, error: "x" })]),
    pool("B", [row("1", { ok: false, applied: 0, error: "y" })]),
  ]);
  assert.equal(out.results[0].error, "A: x · B: y");
});

test("merge: the same id on two platforms is two campaigns", () => {
  const out = mergeAssignments("attach", [pool("A", [row("1"), row("1", { platform: "instantly" })])]);
  assert.equal(out.results.length, 2);
});

test("merge: distinct counts over the union win over the sum", () => {
  const out = mergeAssignments("attach", [pool("A", [], 10, 2), pool("B", [], 8, 1)], { inboxes: 12, skippedDisconnected: 2 });
  assert.equal(out.inboxes, 12);
  assert.equal(out.skippedDisconnected, 2);
});

test("merge: a single pool reads exactly as it did before", () => {
  const single = pool("A", [row("1")], 10, 1);
  const out = mergeAssignments("attach", [single]);
  assert.equal(out.tag, "A");
  assert.equal(out.inboxes, 10);
  assert.equal(out.skippedDisconnected, 1);
  assert.deepEqual(out.results, [{ ...row("1"), error: undefined }]);
});

test("pool names read as a sentence", () => {
  assert.equal(poolNames(["A"]), "A");
  assert.equal(poolNames(["A", "B"]), "A and B");
  assert.equal(poolNames(["A", "B", "C"]), "A, B and C");
  assert.equal(poolNames(["A", "B", "C", "D"]), "A, B and 2 more");
  assert.equal(poolNames([]), "");
});
