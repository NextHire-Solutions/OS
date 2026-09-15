import "server-only";

import { loadDashboardClients } from "./loadDashboard";
import { getMondayOf, weekKey } from "./derive";
import { deriveRows, summarize, type WeeklyRow, type WeeklySummary } from "./summarize";
import type { NamedCampaign } from "./clientForm";
import type { DashboardClient } from "./types";
import { syncHealth, type SyncHealth } from "./sync/health";
import { ttlCache } from "@/lib/cache/ttl";

/*
 * Client Health — the Weekly view, computed exactly as the tool computes it.
 *
 * The tool's own `derive()` and `loadDashboardClients()` are used verbatim, so
 * this cannot drift from the live app: same query, same rules, same numbers.
 * Only the presentation is ours.
 *
 * The full client list is handed to the browser rather than one week's rows.
 * That is what makes the week arrows, the filters and the search instant and
 * offline — every client already carries `metricsByWeek` for every week, so
 * changing week is a re-derive, not a round trip. It is also exactly how the
 * live tool behaves.
 */

export type { WeeklyRow, WeeklySummary } from "./summarize";

/*
 * The clients, and — only when server-rendering — the rows derived from them.
 *
 * ---------------------------------------------------------------------------
 * WHY `rows` IS OPTIONAL, AND WHY IT EXISTS AT ALL
 *
 * Rows are a pure function of the clients and the week, so sending both is
 * sending the same data twice: 1.3 MB where 650 KB says it. RSC's wire format
 * dedupes shared references and hid that; JSON does not.
 *
 * But `derive()` is NOT actually pure. It calls `daysSinceLastIntro`, which
 * reads `new Date()` and then `setHours` — the LOCAL midnight. On the server
 * that is UTC and in the browser it is the reader's timezone, so the two
 * disagree about how many days ago the last introduction was. Deriving on both
 * sides therefore renders "3d ago" against "2d ago" and React throws a
 * hydration error, having quietly rebuilt the tree.
 *
 * `derive()` is the tool's own file, copied verbatim so the numbers cannot
 * drift from the live app, and threading a clock through it would fork it.
 * So instead:
 *
 *   server-rendered screen   gets `rows` — the browser reuses the server's
 *                            values, so there is nothing to disagree about
 *
 *   lazily fetched screen    gets clients only and derives them itself. There
 *                            is no server HTML to match, so no mismatch is
 *                            possible, and the payload stays at 650 KB
 *
 * The common case is the small one: only the screen actually opened carries
 * rows, and only on its first paint.
 */
export interface ClientHealthWeeklyData {
  /** Every client, unfiltered. Each carries every week it has metrics for. */
  clients: DashboardClient[];
  /** The current week, decided by the server so every client agrees on it. */
  weekKey: string;
  /**
   * The server's clock at load.
   *
   * Distinct from `weekKey`, which is the MONDAY of the week on screen. Two
   * columns need actual today rather than the week's start: "Daily Emails
   * Sent" only counts when the stored date is today, and the billing sort
   * needs the next date from now. Using the Monday made every daily figure
   * compare as zero, so that column silently would not sort.
   *
   * Sent rather than read in the browser for the usual reason — the server and
   * the browser are two different clocks and hydration compares them.
   */
  now: string;
  /*
   * Every campaign name, for the Add / Edit form's auto-linking.
   *
   * Names and ids only. The tool ships the whole campaign objects because its
   * dashboard is one page and already has them; here they would be ~200 KB of
   * progress percentages and reply counts that only `autoMatchCampaignIds`
   * looks at, and it only reads the name.
   */
  instantlyCampaigns: NamedCampaign[];
  bisonCampaigns: NamedCampaign[];
  /** Present only when server-rendered. See above — this is a hydration fix. */
  rows?: WeeklyRow[];
  summary?: WeeklySummary;
  source: "supabase" | "seed";
  error?: string;
  /*
   * When the sync last ran and whether it worked, from `sync_runs` — the
   * tool's own audit table. Null when it could not be read (seed data, or a
   * database that predates the table), in which case the screens say nothing
   * rather than something wrong. Refreshed with the rest: `triggerSync`
   * invalidates this cache after every run, so "Synced just now" is true.
   */
  sync: SyncHealth | null;
}

const named = (list: { id: string; name: string }[]): NamedCampaign[] =>
  list.map((c) => ({ id: c.id, name: c.name }));

/*
 * Cached, because this was the slowest thing in the workspace.
 *
 * `loadDashboardClients()` paginates the whole 26-week `weekly_metrics` window
 * — 2,496 rows today — plus every client and campaign, and it ran on EVERY
 * render of /clients, /clients/biweekly and /clients/success. Measured against
 * production: 2,093ms to first byte, before the browser had parsed anything.
 *
 * Nothing about the numbers changes. The sync writes weekly metrics on its own
 * cadence, so a result that is up to a minute old is the same result; this
 * only stops three screens each paying two seconds to recompute an identical
 * answer. Every Master Inbox loader already works this way — see
 * `inbox/campaigns.ts`, which cites the same reason.
 *
 * Keyed by `weekOffset` so navigating to another week is its own entry rather
 * than serving last week's rows for this week.
 */
async function loadWeekly(weekOffset = 0): Promise<ClientHealthWeeklyData> {
  const [{ clients, allInstantlyCampaigns, allBisonCampaigns, source, error }, sync] =
    await Promise.all([
      loadDashboardClients(),
      // One small indexed read; a failure here must not take the dashboard down.
      syncHealth().catch(() => null),
    ]);

  const monday = getMondayOf(new Date());
  monday.setDate(monday.getDate() + weekOffset * 7);
  const key = weekKey(monday);
  const rows = deriveRows(clients, key);

  return {
    clients,
    weekKey: key,
    now: new Date().toISOString(),
    instantlyCampaigns: named(allInstantlyCampaigns),
    bisonCampaigns: named(allBisonCampaigns),
    rows,
    summary: summarize(rows, key),
    source,
    error,
    sync,
  };
}

/**
 * The same data with the derived rows removed, for the API the screens fetch.
 *
 * Halves the response, and is safe precisely because a fetched screen has no
 * server-rendered HTML to be compared against.
 */
export function withoutDerived(data: ClientHealthWeeklyData): ClientHealthWeeklyData {
  const { rows: _rows, summary: _summary, ...rest } = data;
  return rest;
}

export const getWeekly = ttlCache(loadWeekly, {
  ttlMs: 60_000,
  key: (weekOffset = 0) => String(weekOffset),
});
