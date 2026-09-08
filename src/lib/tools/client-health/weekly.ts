import "server-only";

import { loadDashboardClients } from "./loadDashboard";
import { derive, getMondayOf, weekKey, type DerivedRow } from "./derive";
import type { DashboardClient } from "./types";

/*
 * Client Health — the Weekly view, computed exactly as the tool computes it.
 *
 * The tool's own `derive()` and `loadDashboardClients()` are used verbatim, so
 * this cannot drift from the live app: same query, same rules, same numbers.
 * Only the presentation is ours.
 *
 * The summary below is a port of the counter loop in the tool's Dashboard.tsx.
 * Its two subtleties are easy to get wrong and are reproduced deliberately:
 *
 *   hidden clients are skipped entirely — off-roster, counted nowhere
 *   client_paused clients are skipped too, but counted on their own card
 *
 * Get that wrong and every headline number is inflated by twelve clients.
 */

export interface WeeklyRow {
  client: DashboardClient;
  derived: DerivedRow;
}

export interface WeeklySummary {
  total: number;
  risk: number;
  ok: number;
  done: number;
  intros: number;
  target: number;
  emails: number;
  clientPaused: number;
  plans: { minimum: number; production: number; partner: number };
  completionPct: number;
  /** Introductions per 1,000 emails, across clients that sent anything. */
  avgConv: number | null;
  convertedTotal: number;
  interestedTotal: number;
  /** Converted as a share of the whole funnel. Null when the funnel is empty. */
  intToIntroPct: number | null;
}

export interface ClientHealthWeeklyData {
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

  const rows: WeeklyRow[] = clients.map((client) => ({
    client,
    derived: derive(client, key),
  }));

  // --- the tool's counter loop, ported ------------------------------------
  let total = 0, risk = 0, ok = 0, done = 0;
  let intros = 0, emails = 0, target = 0, clientPaused = 0;
  let convNum = 0, convDen = 0;
  let convertedTotal = 0, interestedTotal = 0;
  const plans = { minimum: 0, production: 0, partner: 0 };

  for (const { client, derived } of rows) {
    if (client.hidden) continue;
    if (client.client_paused) {
      clientPaused++;
      continue;
    }
    total++;
    target += client.weekly_target;
    if (client.plan in plans) plans[client.plan as keyof typeof plans]++;
    if (derived.status === "risk") risk++;
    if (derived.status === "ok") ok++;
    if (derived.metTarget) done++;
    intros += derived.intros;
    emails += derived.emails;
    if (derived.emails > 0) {
      convNum += derived.intros;
      convDen += derived.emails;
    }
    for (const m of Object.values(client.metricsByWeek)) {
      convertedTotal += m.intros_corofy ?? 0;
      interestedTotal += m.interested_corofy ?? 0;
    }
  }

  const totalFunnel = convertedTotal + interestedTotal;

  return {
    weekKey: key,
    rows,
    summary: {
      total, risk, ok, done, intros, target, emails, clientPaused, plans,
      completionPct: target > 0 ? Math.round((intros / target) * 100) : 0,
      // A rate with no denominator is unknown, not zero.
      avgConv: convDen > 0 ? (convNum / convDen) * 1000 : null,
      convertedTotal,
      interestedTotal,
      intToIntroPct: totalFunnel > 0 ? (convertedTotal / totalFunnel) * 100 : null,
    },
    source,
    error,
  };
}
