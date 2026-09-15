import type { MlsEntry } from "./baseline.ts";
import { mlsDisplayName } from "./format.ts";

/*
 * The Courted accounts table, assembled from the two state tables — pure, so
 * it can be tested without a database. courted-state.ts reads the rows and
 * hands them here.
 *
 * ---------------------------------------------------------------------------
 * WHY A UNION, AND WHAT IS STILL MISSING
 *
 * This used to be built from `mls_monitor_state` alone: one row per account
 * the 24-hourly MLS monitor had scanned. An account that had been added but
 * never scanned yet was simply not there — no row, no re-scrape button — and
 * an account whose login had failed on every monitor run since it was added
 * was invisible for exactly as long as it was broken.
 *
 * The configured accounts themselves live in the live service's Railway
 * environment (COURTED_EMAIL_n / COURTED_PASSWORD_n, read by
 * `readCourtedAccounts()`), and the only thing the service publishes about
 * them is a COUNT — `GET /api/status` → `courtedAccounts`. The Add-account
 * flow writes straight into those variables and stores nothing here. So the
 * emails cannot be listed from configuration.
 *
 * The widest honest list is therefore the UNION of the two tables the
 * schedulers write: `mls_monitor_state` (an account the monitor has scanned)
 * and `refresh_state` (an account the 15-day refresh has attempted — and it
 * attempts never-refreshed accounts FIRST, so a new account appears here
 * within one pace slot). Each side is left-joined onto the other. The count
 * from /api/status is carried alongside so the screen can say how many
 * configured accounts neither table has seen yet.
 */

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export type Rec = Record<string, unknown>;

/** REFRESH_WINDOW_DAYS on the live service. Not set there, so the default. */
export const REFRESH_WINDOW_DAYS = 15;

export interface CourtedAccount {
  email: string;
  /** Total agents this account can see across every MLS, at the last scan. */
  total: number | null;
  mls: MlsEntry[];
  /** From mls_monitor_state. Null when the monitor has never scanned it. */
  scannedAt: string | null;
  /** From refresh_state. */
  lastRefreshedAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
  /** Whole days since the last full re-scrape. null when never refreshed. */
  daysSinceRefresh: number | null;
  /** True when it has gone past REFRESH_WINDOW_DAYS — the scheduler is behind. */
  overdue: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

export function parseMls(value: unknown): MlsEntry[] {
  // The column is jsonb, so supabase-js hands back a parsed array. A string
  // would mean the column type changed under us; parse it rather than render
  // an empty list and call that "no MLS".
  let list: unknown = value;
  if (typeof value === "string") {
    try { list = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((m): m is Rec => Boolean(m) && typeof m === "object")
    .map((m) => {
      const code = str(m.code) ?? "";
      const name = str(m.name) ?? "";
      return { code, name, label: mlsDisplayName({ code, name }), count: num(m.count) };
    })
    .filter((m) => m.code !== "")
    // Biggest MLS first — that is the order the tool's own detectAccountMls
    // returns and the order the operator reads them in.
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
}

/**
 * One row per email seen by EITHER scheduler, most overdue first — the order
 * the refresh scheduler will actually work through, so the top row is the
 * account it does next.
 */
export function mergeAccounts(monitorRows: Rec[], refreshRows: Rec[], now: number): CourtedAccount[] {
  const monitorBy = new Map<string, Rec>();
  for (const r of monitorRows) {
    const email = str(r.email);
    if (email) monitorBy.set(email.toLowerCase(), r);
  }
  const refreshBy = new Map<string, Rec>();
  for (const r of refreshRows) {
    const email = str(r.email);
    if (email) refreshBy.set(email.toLowerCase(), r);
  }

  const emails = [...new Set([...monitorBy.keys(), ...refreshBy.keys()])];

  return emails
    .map((email) => {
      const mon = monitorBy.get(email);
      const ref = refreshBy.get(email);
      const lastRefreshedAt = ref ? str(ref.last_refreshed_at) : null;
      const ms = lastRefreshedAt ? Date.parse(lastRefreshedAt) : NaN;
      const daysSinceRefresh = Number.isFinite(ms) ? Math.floor((now - ms) / DAY) : null;
      return {
        email,
        total: mon ? num(mon.total) : null,
        mls: mon ? parseMls(mon.mls) : [],
        scannedAt: mon ? str(mon.scanned_at) : null,
        lastRefreshedAt,
        lastStatus: ref ? str(ref.last_status) : null,
        lastMessage: ref ? str(ref.last_message) : null,
        daysSinceRefresh,
        // Never-refreshed counts as overdue: the scheduler's own pickDueAccount
        // puts those first, so the screen should agree with it.
        overdue: daysSinceRefresh === null || daysSinceRefresh > REFRESH_WINDOW_DAYS,
      };
    })
    .sort((a, b) =>
      (b.daysSinceRefresh ?? Number.MAX_SAFE_INTEGER) - (a.daysSinceRefresh ?? Number.MAX_SAFE_INTEGER)
      || a.email.localeCompare(b.email));
}
