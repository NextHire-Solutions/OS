import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabase } from "../supabase";
import { SYNC_EVERY_MINUTES } from "./schedule";
import { syncLockState } from "./lock";

/*
 * Sync health, read from what the sync writes.
 *
 * The tool never showed this — its dashboard had a ↻ button and a toast, and
 * "is the data fresh?" was answered by trusting the cron. With the cron gone
 * and the schedule depending on a browser being open, the screens need to say
 * when the numbers were last pulled, and whether the last pull worked.
 *
 * Source of truth is `sync_runs`: one row per source per run, with
 * `started_at`, `finished_at`, `ok` and `error` — the tool's own audit table
 * (migration 0001, sources widened in 0002 and 0003). Nothing new is written
 * for this; it reads the trail the sync already leaves.
 */

export type SyncSource = "instantly" | "bison" | "corofy";
export const SYNC_SOURCES: readonly SyncSource[] = ["instantly", "bison", "corofy"];

export interface SyncRunRow {
  source: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  error: string | null;
}

export interface SyncSourceHealth {
  source: SyncSource;
  /** Newest run of this source, finished or not. */
  lastStartedAt: string | null;
  /** Newest run that finished with ok=true. */
  lastSuccessAt: string | null;
  /** The newest run's error, when it failed. */
  lastError: string | null;
  /** True when the newest run has no finished_at — in progress, or abandoned. */
  inProgress: boolean;
  /** Never ran, or is silent for longer than four missed slots. */
  stale: boolean;
}

export interface SyncHealth {
  /** Newest `started_at` across every source — what isSyncDue reads. */
  lastStartedAt: string | null;
  /** Newest successful completion across every source — the "Synced 5 min ago" line. */
  lastSuccessAt: string | null;
  /** Any source whose newest run failed. */
  errors: string[];
  /** A run is executing in this process right now. */
  running: boolean;
  /** Some source has not succeeded within the staleness window. */
  stale: boolean;
  sources: SyncSourceHealth[];
}

/**
 * Four missed slots, matching the analytics port's rule for interval jobs
 * (health.ts there: `everyMinutes * 4`, floored at 45 minutes). One slow run
 * or one deploy straddling a slot is not an outage; four is.
 */
export const STALE_AFTER_MS = Math.max(SYNC_EVERY_MINUTES * 4 * 60_000, 45 * 60_000);

/** Pure: the health of a set of recent rows, newest first or not. */
export function summarizeRuns(rows: SyncRunRow[], now: Date, running = false): SyncHealth {
  const nowMs = now.getTime();
  const sources: SyncSourceHealth[] = SYNC_SOURCES.map((source) => {
    const mine = rows
      .filter((r) => r.source === source)
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    const newest = mine[0] ?? null;
    const lastOk = mine.find((r) => r.ok === true && r.finished_at) ?? null;
    const lastSuccessAt = lastOk?.finished_at ?? null;
    const successMs = lastSuccessAt ? new Date(lastSuccessAt).getTime() : NaN;
    return {
      source,
      lastStartedAt: newest?.started_at ?? null,
      lastSuccessAt,
      lastError: newest && newest.ok === false ? newest.error ?? "failed" : null,
      inProgress: Boolean(newest && !newest.finished_at),
      stale: !Number.isFinite(successMs) || nowMs - successMs > STALE_AFTER_MS,
    };
  });

  const newestStart = sources
    .map((s) => s.lastStartedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1) ?? null;
  const newestSuccess = sources
    .map((s) => s.lastSuccessAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1) ?? null;

  return {
    lastStartedAt: newestStart,
    lastSuccessAt: newestSuccess,
    errors: sources.flatMap((s) => (s.lastError ? [`${s.source}: ${s.lastError}`] : [])),
    running,
    /*
     * Bison and Corofy are optional sources — the sync skips them when their
     * variables are unset and writes no sync_runs row. A source that has NEVER
     * run is therefore not stale; only one that ran and then went quiet is.
     */
    stale: sources.some((s) => s.lastStartedAt !== null && s.stale),
    sources,
  };
}

/** The newest few rows per source is all the summary needs; 30 covers a day of three sources. */
const RECENT_ROWS = 30;

export async function syncHealth(db: SupabaseClient = getSupabase(), now: Date = new Date()): Promise<SyncHealth> {
  const { data, error } = await db
    .from("sync_runs")
    .select("source, started_at, finished_at, ok, error")
    .order("started_at", { ascending: false })
    .limit(RECENT_ROWS);
  if (error) throw new Error(error.message);
  return summarizeRuns((data ?? []) as SyncRunRow[], now, syncLockState().running);
}
