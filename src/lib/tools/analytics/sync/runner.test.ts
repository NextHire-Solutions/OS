import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runJob, setCursor, setCursorText, type JobFn } from "./runner.ts";

/*
 * A recording Supabase stub. Every builder method returns the builder, the
 * builder is thenable, and the resolved value depends on (table, verb):
 *
 *   sync_state.select → the state row under test (or null)
 *   sync_runs.insert  → { id: 7 }
 *   everything else   → { data: null }
 *
 * Only what runner.ts touches is modelled; anything else throws, so a new
 * call in the runner shows up as a test failure rather than a silent no-op.
 */
interface Call {
  table: string;
  verb: string;
  payload?: unknown;
  options?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

function stub(state: Record<string, unknown> | null) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, verb: "", filters: [] };
      calls.push(call);
      const result = () =>
        table === "sync_state" && call.verb === "select"
          ? { data: state }
          : table === "sync_runs" && call.verb === "insert"
            ? { data: { id: 7 } }
            : { data: null };
      const b: Record<string, unknown> = {};
      for (const verb of ["select", "update", "upsert", "insert"]) {
        b[verb] = (payload?: unknown, options?: unknown) => {
          // insert(...).select("id") — the first verb names the statement.
          if (!call.verb) Object.assign(call, { verb, payload, options });
          return b;
        };
      }
      for (const f of ["eq", "is"]) {
        b[f] = (...args: unknown[]) => {
          call.filters.push([f, ...args]);
          return b;
        };
      }
      b.maybeSingle = () => b;
      b.single = () => b;
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return b;
    },
  };
  return { sb: client as unknown as SupabaseClient, calls };
}

const find = (calls: Call[], table: string, verb: string) =>
  calls.filter((c) => c.table === table && c.verb === verb);

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test("a fresh job takes the lock, runs, and releases with the watermark", async () => {
  const { sb, calls } = stub(null);
  const seen: unknown[] = [];
  const fn: JobFn = async (ctx) => {
    seen.push(ctx);
    return { rowsWritten: 12, apiCalls: 3, watermark: "2026-09-15T00:00:00Z", detail: { campaigns: 4 } };
  };

  const outcome = await runJob("sync-entities", 2, fn, sb);

  assert.equal(outcome.status, "ok");
  assert.equal(outcome.rowsWritten, 12);
  assert.deepEqual(outcome.detail, { campaigns: 4 });
  assert.deepEqual(seen, [{ teamId: 2, cursorDate: null, cursorText: null, watermark: null }]);

  const [lock] = find(calls, "sync_state", "upsert");
  const locked = lock.payload as Record<string, unknown>;
  assert.equal(locked.job_name, "sync-entities");
  assert.equal(locked.team_id, 2);
  assert.ok(typeof locked.running_since === "string");
  assert.deepEqual(lock.options, { onConflict: "job_name,team_id" });

  const [release] = find(calls, "sync_state", "update");
  const released = release.payload as Record<string, unknown>;
  assert.equal(released.running_since, null);
  assert.equal(released.consecutive_failures, 0);
  assert.equal(released.last_error, null);
  assert.equal(released.watermark_at, "2026-09-15T00:00:00Z");
  assert.deepEqual(release.filters, [["eq", "job_name", "sync-entities"], ["eq", "team_id", 2]]);

  const [run] = find(calls, "sync_runs", "update");
  const closed = run.payload as Record<string, unknown>;
  assert.equal(closed.status, "ok");
  assert.equal(closed.rows_written, 12);
  assert.equal(closed.api_calls, 3);
  assert.deepEqual(run.filters, [["eq", "id", 7]]);
});

test("cursors persisted by the last run are handed to the job", async () => {
  const { sb } = stub({
    running_since: null,
    consecutive_failures: 0,
    cursor_date: "2026-09-01",
    cursor_text: "uuid-page-token",
    watermark_at: "2026-09-14T12:00:00Z",
  });
  let ctx: unknown;
  await runJob("sync-instantly-leads", 2, async (c) => ((ctx = c), {}), sb);
  assert.deepEqual(ctx, {
    teamId: 2,
    cursorDate: "2026-09-01",
    cursorText: "uuid-page-token",
    watermark: "2026-09-14T12:00:00Z",
  });
});

test("a live lock skips the run without touching the database", async () => {
  const { sb, calls } = stub({ running_since: ago(60_000), consecutive_failures: 0 });
  let ran = false;
  const outcome = await runJob("sync-replies", 2, async () => ((ran = true), {}), sb);

  assert.equal(ran, false);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.error, "already running");
  assert.equal(calls.length, 1, "only the state read");
});

test("a stale lock is stolen and the abandoned run is closed", async () => {
  const { sb, calls } = stub({ running_since: ago(11 * 60_000), consecutive_failures: 0 });
  const outcome = await runJob("sync-replies", 2, async () => ({ rowsWritten: 1 }), sb);

  assert.equal(outcome.status, "ok");
  const [abandon] = find(calls, "sync_runs", "update");
  const payload = abandon.payload as Record<string, unknown>;
  assert.equal(payload.status, "abandoned");
  assert.deepEqual(abandon.filters, [
    ["eq", "job_name", "sync-replies"],
    ["eq", "team_id", 2],
    ["is", "finished_at", null],
  ]);
});

test("five consecutive failures open the circuit", async () => {
  const { sb, calls } = stub({ running_since: null, consecutive_failures: 5 });
  let ran = false;
  const outcome = await runJob("sync-leads", 2, async () => ((ran = true), {}), sb);

  assert.equal(ran, false);
  assert.equal(outcome.status, "circuit-open");
  assert.match(outcome.error ?? "", /5 consecutive failures/);
  assert.equal(find(calls, "sync_state", "upsert").length, 0);
});

test("a failure keeps the old watermark and counts against the breaker", async () => {
  const { sb, calls } = stub({ running_since: null, consecutive_failures: 2, watermark_at: "old" });
  const outcome = await runJob("sync-outcomes", 2, async () => { throw new Error("feed 502"); }, sb);

  assert.equal(outcome.status, "error");
  assert.equal(outcome.error, "feed 502");

  const [release] = find(calls, "sync_state", "update");
  const payload = release.payload as Record<string, unknown>;
  assert.equal(payload.running_since, null);
  assert.equal(payload.consecutive_failures, 3);
  assert.equal(payload.last_error, "feed 502");
  assert.equal("watermark_at" in payload, false, "watermark only advances on success");

  const [run] = find(calls, "sync_runs", "update");
  assert.equal((run.payload as Record<string, unknown>).status, "error");
});

test("cursor writers scope to the job and team", async () => {
  const { sb, calls } = stub(null);
  await setCursor("sync-instantly-day-stats-backfill", 2, "2026-08-01", sb);
  await setCursorText("sync-instantly-leads", 2, null, sb);

  const [byDate, byText] = find(calls, "sync_state", "update");
  assert.deepEqual(byDate.payload, { cursor_date: "2026-08-01" });
  assert.deepEqual(byDate.filters, [["eq", "job_name", "sync-instantly-day-stats-backfill"], ["eq", "team_id", 2]]);
  assert.deepEqual(byText.payload, { cursor_text: null });
  assert.deepEqual(byText.filters, [["eq", "job_name", "sync-instantly-leads"], ["eq", "team_id", 2]]);
});
