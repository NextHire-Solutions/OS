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

export interface ClientHealthWeeklyData {
  /** Every client, unfiltered. The browser derives the week it is showing. */
  clients: DashboardClient[];
  /** The week rendered on the server, so first paint needs no JavaScript. */
  weekKey: string;
  rows: WeeklyRow[];
  summary: WeeklySummary;
  source: "supabase" | "seed";
  error?: string;
}

export async function getWeekly(weekOffset = 0): Promise<ClientHealthWeeklyData> {
  const { clients, source, error } = await loadDashboardClients();

  const monday = getMondayOf(new Date());
  monday.setDate(monday.getDate() + weekOffset * 7);
  const key = weekKey(monday);

  const rows = deriveRows(clients, key);

  return {
    clients,
    weekKey: key,
    rows,
    summary: summarize(rows),
    source,
    error,
  };
}
