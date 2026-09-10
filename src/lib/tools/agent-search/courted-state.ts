import "server-only";

import { getCorofySupabase } from "../corofy/supabase.ts";
import type { BaselineIndex, MlsEntry } from "./baseline.ts";
import { mlsDisplayName } from "./format.ts";

/*
 * The two state tables Agent Search's schedulers keep — read natively.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 *
 * The tool writes both of these every day and displays neither.
 *
 *   mls_monitor_state   one row per Courted login, holding the full MLS list
 *                       that account could see at the last scan, with an exact
 *                       agent count per MLS. Written by mls-monitor.js, which
 *                       runs every 24h (MLS_MONITOR_ENABLED=1 on Railway).
 *   refresh_state       one row per Courted login: when it was last fully
 *                       re-scraped, whether that succeeded, and the message.
 *                       Written by refresh.js (REFRESH_ENABLED=1), which picks
 *                       the most-overdue account so every account is re-pulled
 *                       within REFRESH_WINDOW_DAYS (default 15).
 *
 * The tool's MLS monitor screen diffs a fresh scan against a baseline held in
 * ONE BROWSER's localStorage. So it is empty on a new machine, disagrees
 * between machines, and is lost when site data is cleared — while the
 * authoritative baseline, written by the scheduler, sits in Supabase unread.
 * The nine accounts themselves are equally invisible: they live in Railway env
 * vars, and the tool's UI shows only how many there are.
 *
 * Reading them here is the one place this port is deliberately ahead of the
 * tool. It is marked as new in AGENT-SEARCH-PARITY.md rather than counted as
 * parity.
 *
 * Read-only. The schedulers keep writing on the live service.
 */

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
type Rec = Record<string, unknown>;
const rows = (data: unknown): Rec[] => (Array.isArray(data) ? (data as Rec[]) : []);

/** REFRESH_WINDOW_DAYS on the live service. Not set there, so the default. */
export const REFRESH_WINDOW_DAYS = 15;

export interface CourtedAccount {
  email: string;
  /** Total agents this account can see across every MLS, at the last scan. */
  total: number | null;
  mls: MlsEntry[];
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

export interface CourtedState {
  accounts: CourtedAccount[];
  /** Sum of every account's agent total. Accounts overlap, so this is a ceiling. */
  reachableAgents: number | null;
  /** Most recent MLS scan across all accounts. */
  lastScanAt: string | null;
  refreshWindowDays: number;
  error: string | null;
}

const DAY = 24 * 60 * 60 * 1000;

function parseMls(value: unknown): MlsEntry[] {
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

export async function getCourtedState(): Promise<CourtedState> {
  try {
    const sb = getCorofySupabase();
    const [monitor, refresh] = await Promise.all([
      sb.from("mls_monitor_state").select("email,mls,total,scanned_at"),
      sb.from("refresh_state").select("email,last_refreshed_at,last_status,last_message"),
    ]);

    if (monitor.error) throw new Error(monitor.error.message);
    // refresh_state failing is not fatal: the MLS list is still worth showing.
    const refreshBy = new Map<string, Rec>();
    for (const r of rows(refresh.data)) {
      const email = str(r.email);
      if (email) refreshBy.set(email.toLowerCase(), r);
    }

    const now = Date.now();
    const accounts: CourtedAccount[] = rows(monitor.data)
      .map((r) => {
        const email = (str(r.email) ?? "").toLowerCase();
        const ref = refreshBy.get(email);
        const lastRefreshedAt = ref ? str(ref.last_refreshed_at) : null;
        const ms = lastRefreshedAt ? Date.parse(lastRefreshedAt) : NaN;
        const daysSinceRefresh = Number.isFinite(ms) ? Math.floor((now - ms) / DAY) : null;
        return {
          email,
          total: num(r.total),
          mls: parseMls(r.mls),
          scannedAt: str(r.scanned_at),
          lastRefreshedAt,
          lastStatus: ref ? str(ref.last_status) : null,
          lastMessage: ref ? str(ref.last_message) : null,
          daysSinceRefresh,
          // Never-refreshed counts as overdue: the scheduler's own pickDueAccount
          // puts those first, so the screen should agree with it.
          overdue: daysSinceRefresh === null || daysSinceRefresh > REFRESH_WINDOW_DAYS,
        };
      })
      // Most overdue first. This is the order the refresh scheduler will
      // actually work through, so the top row is the account it does next.
      .sort((a, b) => (b.daysSinceRefresh ?? Number.MAX_SAFE_INTEGER) - (a.daysSinceRefresh ?? Number.MAX_SAFE_INTEGER));

    const totals = accounts.map((a) => a.total).filter((t): t is number => t !== null);
    const scans = accounts.map((a) => a.scannedAt).filter((s): s is string => s !== null).sort();

    return {
      accounts,
      reachableAgents: totals.length ? totals.reduce((a, b) => a + b, 0) : null,
      lastScanAt: scans.length ? scans[scans.length - 1] : null,
      refreshWindowDays: REFRESH_WINDOW_DAYS,
      error: null,
    };
  } catch (error) {
    return {
      accounts: [],
      reachableAgents: null,
      lastScanAt: null,
      refreshWindowDays: REFRESH_WINDOW_DAYS,
      error: error instanceof Error ? error.message : "Agent Search's database is unreachable",
    };
  }
}

/*
 * The server-side MLS baseline, in the shape the MLS monitor screen diffs
 * against — the same shape as the tool's own localStorage baseline
 * (`indexScan` in app.js): { email: { total, codes: { code: {name, count} } } }.
 *
 * Offering this alongside the browser baseline is the point: it lets the screen
 * answer "what changed since the scheduler last looked?" on a machine that has
 * never run a scan, which the tool cannot do.
 */

export function indexAccounts(accounts: CourtedAccount[]): BaselineIndex {
  const out: BaselineIndex = {};
  for (const a of accounts) {
    const codes: Record<string, { name: string; count: number }> = {};
    for (const m of a.mls) codes[m.code] = { name: m.name, count: m.count ?? 0 };
    out[a.email] = { total: a.total ?? 0, codes };
  }
  return out;
}
