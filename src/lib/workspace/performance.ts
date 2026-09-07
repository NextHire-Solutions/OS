import "server-only";

import { httpProbe } from "@/lib/http/probe";
import { baseUrlEnv, optionalEnv } from "@/lib/env";

/*
 * The Performance screen: client base, plan mix and movement.
 *
 * ---------------------------------------------------------------------------
 * WHAT CANNOT BE COMPUTED, AND WHY
 *
 * Client Health records churn as a BOOLEAN — `hidden` — with no date attached.
 * So "how many churned in July" has no answer anywhere in the stack, and never
 * will until a status-history table exists. The same goes for revenue: plans
 * have names and weekly targets but no price.
 *
 * The design greys both out, which is exactly right, and this returns null for
 * them rather than a zero. A zero in a churn column reads as "nobody left this
 * month", which is a confident claim we cannot make.
 *
 * Two consequences follow from the missing churn date and are worth stating
 * because they are easy to get wrong:
 *
 *   · `net` is Added minus Churned, so it is unknown too — not equal to Added
 *   · a running total of onboardings is NOT the client count at that time,
 *     because it never subtracts anyone. It is labelled as what it is.
 */

const TIMEOUT = 12_000;

export interface PlanBreakdown {
  plan: string;
  label: string;
  count: number;
  /** Introductions promised per week, from the plan's own target. */
  weeklyTarget: number | null;
}

export interface MonthRow {
  month: string;
  label: string;
  added: number;
  /** null, always, until churn carries a date. */
  churned: null;
  net: null;
  /** Cumulative onboardings — NOT the client count, which would subtract churn. */
  onboardedToDate: number;
  revenue: null;
}

export interface Performance {
  totals: {
    clients: number | null;
    active: number | null;
    paused: number | null;
    churned: number | null;
    addedLast90: number | null;
    /** Clients with no start_date, so the movement table under-counts by this. */
    undated: number;
  };
  plans: PlanBreakdown[];
  months: MonthRow[];
  unavailable: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const PLAN_LABEL: Record<string, string> = {
  production: "Production",
  minimum: "Minimum",
  partner: "Partner",
};

export async function getPerformance(): Promise<Performance> {
  const empty: Performance = {
    totals: {
      clients: null, active: null, paused: null, churned: null,
      addedLast90: null, undated: 0,
    },
    plans: [],
    months: [],
    unavailable: null,
  };

  const token = optionalEnv("CLIENT_HEALTH_READ_TOKEN");
  if (!token) return { ...empty, unavailable: "CLIENT_HEALTH_READ_TOKEN not set" };

  const res = await httpProbe(`${baseUrlEnv("CLIENT_HEALTH_URL")}/api/clients`, {
    timeoutMs: TIMEOUT,
    headers: { "x-admin-token": token },
  });
  if (res.status === 401) {
    return { ...empty, unavailable: "Client Health refused the read token" };
  }
  if (!res.ok) {
    return { ...empty, unavailable: `Client Health returned ${res.status ?? "no response"}` };
  }

  const rows = asRecord(res.json)?.clients;
  if (!Array.isArray(rows)) return { ...empty, unavailable: "Unexpected response shape" };

  const clients = rows.flatMap((raw) => {
    const row = asRecord(raw);
    if (!row) return [];
    return [{
      plan: typeof row.plan === "string" ? row.plan : "unknown",
      weeklyTarget: typeof row.weekly_target === "number" ? row.weekly_target : null,
      startDate: typeof row.start_date === "string" ? row.start_date : null,
      hidden: row.hidden === true,
      paused: row.client_paused === true,
    }];
  });

  // Status derivation matches Client Health's own: hidden wins over paused, so
  // a hidden-and-paused client counts once, as churned. Using a different rule
  // here would put two different totals on two screens.
  const churned = clients.filter((c) => c.hidden).length;
  const paused = clients.filter((c) => !c.hidden && c.paused).length;
  const active = clients.length - churned - paused;

  const planCounts = new Map<string, { count: number; target: number | null }>();
  for (const client of clients) {
    const entry = planCounts.get(client.plan) ?? { count: 0, target: client.weeklyTarget };
    entry.count += 1;
    // Targets vary per client; show one only when the whole plan agrees.
    if (entry.target !== client.weeklyTarget) entry.target = null;
    planCounts.set(client.plan, entry);
  }

  const plans: PlanBreakdown[] = [...planCounts.entries()]
    .map(([plan, { count, target }]) => ({
      plan,
      label: PLAN_LABEL[plan] ?? plan,
      count,
      weeklyTarget: target,
    }))
    .sort((a, b) => b.count - a.count);

  // --- movement, from start_date -------------------------------------------
  const dated = clients.filter((c) => c.startDate);
  const byMonth = new Map<string, number>();
  for (const client of dated) {
    const month = client.startDate!.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
  }

  let running = 0;
  const months: MonthRow[] = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, added]) => {
      running += added;
      return {
        month,
        label: new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }),
        added,
        churned: null,
        net: null,
        onboardedToDate: running,
        revenue: null,
      };
    });

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setUTCDate(ninetyDaysAgo.getUTCDate() - 90);
  const cutoff = ninetyDaysAgo.toISOString().slice(0, 10);

  return {
    totals: {
      clients: clients.length,
      active,
      paused,
      churned,
      addedLast90: dated.filter((c) => c.startDate! >= cutoff).length,
      undated: clients.length - dated.length,
    },
    plans,
    months: months.slice(-6),
    unavailable: null,
  };
}
