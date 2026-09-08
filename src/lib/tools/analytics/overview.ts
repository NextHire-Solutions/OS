import "server-only";

import { loadKpis, type KpiResponse } from "./kpis";
import { resolveFilters, toISODate } from "./query-params";
import { analyticsTeamId } from "./supabase";

/*
 * Campaign Analytics — the overview, computed exactly as the tool computes it.
 *
 * `loadKpis` and `resolveFilters` are the tool's own files, copied unchanged,
 * reading the tool's own database. So this screen and the live app cannot
 * disagree about what "7d" means, whether `to` is inclusive, or how a reply
 * rate is derived. Only the presentation is ours.
 *
 * Every number is read-only. The live Analytics app keeps running against this
 * same database — its scheduler and its eighteen jobs are untouched.
 */

export interface AnalyticsOverview {
  kpis: KpiResponse | null;
  range: { from: string; to: string };
  preset: string;
  /** Set when the read failed. The screen says so rather than showing zeros. */
  error: string | null;
}

/**
 * Loads the overview for a preset window.
 *
 * A failure returns rather than throws: Analytics being unreachable should
 * cost this screen, not the whole workspace. And it returns null KPIs rather
 * than zeroed ones — "we could not read this" and "you sent no email" are
 * different facts, and only one of them warrants a phone call.
 */
export async function getAnalyticsOverview(preset = "30d"): Promise<AnalyticsOverview> {
  const filters = resolveFilters(
    new URLSearchParams({ preset, compare: "1" }),
    toISODate(new Date()),
  );

  try {
    const kpis = await loadKpis(filters, analyticsTeamId());
    return {
      kpis,
      range: { from: filters.from, to: filters.to },
      preset: filters.preset,
      error: null,
    };
  } catch (error) {
    return {
      kpis: null,
      range: { from: filters.from, to: filters.to },
      preset: filters.preset,
      error: error instanceof Error ? error.message : "Analytics is unreachable",
    };
  }
}
