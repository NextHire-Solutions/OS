import "server-only";

import { getCorofySupabase } from "../corofy/supabase.ts";
import type { BaselineIndex } from "./baseline.ts";
import { mergeAccounts, REFRESH_WINDOW_DAYS, type CourtedAccount, type Rec } from "./courted-accounts.ts";
import { scraper } from "./scraper.ts";

export { REFRESH_WINDOW_DAYS, type CourtedAccount } from "./courted-accounts.ts";

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
 * The accounts list is the UNION of the two tables, each left-joined onto the
 * other — see courted-accounts.ts for why, and for what still cannot be
 * listed (the configured emails themselves, which only exist in Railway).
 *
 * Read-only. The schedulers keep writing on the live service.
 */

const rows = (data: unknown): Rec[] => (Array.isArray(data) ? (data as Rec[]) : []);

export interface CourtedState {
  accounts: CourtedAccount[];
  /**
   * How many Courted logins the live service has configured — its own
   * `GET /api/status` → `courtedAccounts`. Null when it could not be asked.
   * More than `accounts.length` means some account has not been seen by
   * either scheduler yet.
   */
  configuredAccounts: number | null;
  /** Sum of every account's agent total. Accounts overlap, so this is a ceiling. */
  reachableAgents: number | null;
  /** Most recent MLS scan across all accounts. */
  lastScanAt: string | null;
  refreshWindowDays: number;
  error: string | null;
}

/** The configured count from the live service; never fatal. */
async function configuredCount(): Promise<number | null> {
  try {
    const r = await scraper.status();
    const n = r.ok ? r.body?.courtedAccounts : null;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function getCourtedState(): Promise<CourtedState> {
  try {
    const sb = getCorofySupabase();
    const [monitor, refresh, configured] = await Promise.all([
      sb.from("mls_monitor_state").select("email,mls,total,scanned_at"),
      sb.from("refresh_state").select("email,last_refreshed_at,last_status,last_message"),
      configuredCount(),
    ]);

    if (monitor.error) throw new Error(monitor.error.message);
    // refresh_state failing is not fatal: the MLS list is still worth showing.
    const accounts = mergeAccounts(rows(monitor.data), refresh.error ? [] : rows(refresh.data), Date.now());

    const totals = accounts.map((a) => a.total).filter((t): t is number => t !== null);
    const scans = accounts.map((a) => a.scannedAt).filter((s): s is string => s !== null).sort();

    return {
      accounts,
      configuredAccounts: configured,
      reachableAgents: totals.length ? totals.reduce((a, b) => a + b, 0) : null,
      lastScanAt: scans.length ? scans[scans.length - 1] : null,
      refreshWindowDays: REFRESH_WINDOW_DAYS,
      error: null,
    };
  } catch (error) {
    return {
      accounts: [],
      configuredAccounts: null,
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
