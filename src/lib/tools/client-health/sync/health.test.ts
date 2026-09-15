/*
 * Sync health from sync_runs rows.
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/client-health/sync/health.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { STALE_AFTER_MS, summarizeRuns, type SyncRunRow } from "./health.ts";

const NOW = new Date("2026-09-15T14:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const row = (source: string, startedMin: number, ok: boolean | null, finishedMin: number | null = startedMin - 2, error: string | null = null): SyncRunRow => ({
  source, started_at: ago(startedMin), finished_at: finishedMin === null ? null : ago(finishedMin), ok, error,
});

test("the headline is the newest start and the newest success across sources", () => {
  const h = summarizeRuns([
    row("instantly", 5, true),
    row("bison", 5, true, 4),
    row("corofy", 20, true, 18),
    row("instantly", 35, true),
  ], NOW);
  assert.equal(h.lastStartedAt, ago(5));
  assert.equal(h.lastSuccessAt, ago(3), "instantly finished 2 minutes after it started");
  assert.deepEqual(h.errors, []);
  assert.equal(h.stale, false);
  assert.equal(h.running, false);
});

test("the newest failure is reported per source, with the previous success kept", () => {
  const h = summarizeRuns([
    row("instantly", 5, false, 4, "Instantly /api/v2/campaigns 429: slow down"),
    row("instantly", 20, true, 18),
  ], NOW);
  assert.deepEqual(h.errors, ["instantly: Instantly /api/v2/campaigns 429: slow down"]);
  const inst = h.sources.find((s) => s.source === "instantly")!;
  assert.equal(inst.lastSuccessAt, ago(18));
  assert.equal(inst.lastError, "Instantly /api/v2/campaigns 429: slow down");
});

test("an unfinished newest row is in progress, and does not count as a success", () => {
  const h = summarizeRuns([row("corofy", 1, null, null)], NOW);
  const c = h.sources.find((s) => s.source === "corofy")!;
  assert.equal(c.inProgress, true);
  assert.equal(c.lastSuccessAt, null);
  assert.equal(h.lastSuccessAt, null);
});

test("stale after four missed slots — but a source that never ran is simply optional", () => {
  const minutes = STALE_AFTER_MS / 60_000;
  const fresh = summarizeRuns([row("instantly", minutes - 5, true, minutes - 7)], NOW);
  assert.equal(fresh.stale, false, "bison and corofy never ran: not stale");
  const old = summarizeRuns([row("instantly", minutes + 10, true, minutes + 8)], NOW);
  assert.equal(old.stale, true);
  assert.equal(summarizeRuns([], NOW).stale, false, "an empty table is 'never synced', not 'stale'");
});

test("running comes from the caller — the lock, not the table", () => {
  assert.equal(summarizeRuns([], NOW, true).running, true);
});
