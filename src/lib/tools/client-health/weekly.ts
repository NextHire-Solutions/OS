import "server-only";

import { loadDashboardClients } from "./loadDashboard";
import { getMondayOf, weekKey } from "./derive";
import { deriveRows, summarize, type WeeklyRow, type WeeklySummary } from "./summarize";
import type { DashboardClient } from "./types";

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
  /** Present only when server-rendered. See above — this is a hydration fix. */
  rows?: WeeklyRow[];
  summary?: WeeklySummary;
  source: "supabase" | "seed";
  error?: string;
}

export async function getWeekly(weekOffset = 0): Promise<ClientHealthWeeklyData> {
  const { clients, source, error } = await loadDashboardClients();

  const monday = getMondayOf(new Date());
  monday.setDate(monday.getDate() + weekOffset * 7);
  const key = weekKey(monday);
  const rows = deriveRows(clients, key);

  return { clients, weekKey: key, now: new Date().toISOString(), rows, summary: summarize(rows), source, error };
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
