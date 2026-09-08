import "server-only";

import { loadDashboardClients } from "./loadDashboard";
import { getMondayOf, weekKey } from "./derive";
import type { WeeklyRow, WeeklySummary } from "./summarize";
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
 * Deliberately carries the CLIENTS only — not the derived rows, and not the
 * summary.
 *
 * Both are a pure function of the clients and the week, so sending them would
 * be sending the same data twice. RSC's wire format dedupes shared references
 * and hid that; JSON does not, and the API route this also feeds was returning
 * 1.3 MB where 650 KB says the same thing.
 *
 * The screens derive with the same `deriveRows`/`summarize` the server would
 * have used, so the values are identical and hydration cannot mismatch.
 */
export interface ClientHealthWeeklyData {
  /** Every client, unfiltered. Each carries every week it has metrics for. */
  clients: DashboardClient[];
  /** The current week, decided by the server so every client agrees on it. */
  weekKey: string;
  source: "supabase" | "seed";
  error?: string;
}

export async function getWeekly(weekOffset = 0): Promise<ClientHealthWeeklyData> {
  const { clients, source, error } = await loadDashboardClients();

  const monday = getMondayOf(new Date());
  monday.setDate(monday.getDate() + weekOffset * 7);

  return { clients, weekKey: weekKey(monday), source, error };
}
