import "server-only";

import { httpProbe } from "@/lib/http/probe";
import { baseUrlEnv, optionalEnv, NotConfiguredError } from "@/lib/env";

/*
 * Client Health, read for the workspace to draw itself.
 *
 * The workspace renders these screens natively rather than embedding the tool.
 * That is the whole architecture: the live app keeps running untouched, and
 * the OS reads its data over the API it already publishes.
 *
 * Two reads, both token-authenticated:
 *
 *   /api/clients          the roster with plans, targets and status flags
 *   /api/metrics/weekly   emails sent and introductions, per client per week
 *
 * ---------------------------------------------------------------------------
 * STATUS IS DERIVED HERE, ONCE
 *
 * "At risk" and "on track" are judgements, not stored values, and the tool
 * makes the same judgement in its own UI. Deriving it in one place means the
 * workspace cannot drift from the tool by quietly using a different rule —
 * which is the exact failure mode the Consistency screen exists to catch.
 */

const TIMEOUT = 15_000;

export type ClientStatus = "at-risk" | "on-track" | "done" | "paused" | "churned" | "pending";

export interface WeeklyClient {
  id: string;
  name: string;
  plan: string | null;
  weeklyTarget: number;
  startDate: string | null;
  status: ClientStatus;
  /** Emails sent today, straight from the tool's own counter. */
  emailsToday: number | null;
  emailsSent: number | null;
  intros: number;
  interested: number | null;
  /** Introductions still owed this week. Never negative. */
  remaining: number;
  /** Introductions per 1,000 emails — the tool's own conversion measure. */
  conversion: number | null;
  lastIntroAt: string | null;
  portalActive: boolean;
}

export interface WeeklySummary {
  clients: number;
  atRisk: number;
  onTrack: number;
  done: number;
  paused: number;
  introsSent: number;
  introsTarget: number;
  completion: number | null;
  emailsSent: number;
  conversion: number | null;
  interested: number;
  byPlan: { minimum: number; production: number; partner: number };
}

export interface ClientHealthWeekly {
  weekKey: string | null;
  summary: WeeklySummary;
  clients: WeeklyClient[];
  unavailable: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

async function read(path: string) {
  const token = optionalEnv("CLIENT_HEALTH_READ_TOKEN");
  if (!token) throw new NotConfiguredError("CLIENT_HEALTH_READ_TOKEN");
  return httpProbe(`${baseUrlEnv("CLIENT_HEALTH_URL")}${path}`, {
    timeoutMs: TIMEOUT,
    headers: { "x-admin-token": token },
  });
}

/**
 * The status rule, matching the tool's own.
 *
 * Order matters: a hidden client is churned even if also paused, and a paused
 * client is paused regardless of its numbers. Only an active client is judged
 * on progress, and one with no target at all is pending rather than "done",
 * which would flatter the completion figure.
 */
function deriveStatus(input: {
  hidden: boolean;
  paused: boolean;
  target: number;
  intros: number;
  hasData: boolean;
}): ClientStatus {
  if (input.hidden) return "churned";
  if (input.paused) return "paused";
  if (input.target <= 0 || !input.hasData) return "pending";
  if (input.intros >= input.target) return "done";
  if (input.intros * 2 < input.target) return "at-risk";
  return "on-track";
}

export async function getClientHealthWeekly(): Promise<ClientHealthWeekly> {
  const empty: ClientHealthWeekly = {
    weekKey: null,
    summary: {
      clients: 0, atRisk: 0, onTrack: 0, done: 0, paused: 0,
      introsSent: 0, introsTarget: 0, completion: null,
      emailsSent: 0, conversion: null, interested: 0,
      byPlan: { minimum: 0, production: 0, partner: 0 },
    },
    clients: [],
    unavailable: null,
  };

  const [rosterRes, weeklyRes] = await Promise.allSettled([
    read("/api/clients"),
    read("/api/metrics/weekly?weeks=1"),
  ]);

  if (rosterRes.status === "rejected") {
    const e = rosterRes.reason;
    return { ...empty, unavailable: e instanceof Error ? e.message : "Client Health unavailable" };
  }
  if (!rosterRes.value.ok) {
    return { ...empty, unavailable: `Client Health returned ${rosterRes.value.status ?? "no response"}` };
  }

  const roster = asRecord(rosterRes.value.json)?.clients;
  if (!Array.isArray(roster)) return { ...empty, unavailable: "Unexpected roster shape" };

  // Latest week per client. The endpoint returns newest first, so the first
  // row seen for a client is the one we want.
  const latest = new Map<string, Record<string, unknown>>();
  let weekKey: string | null = null;

  if (weeklyRes.status === "fulfilled" && weeklyRes.value.ok) {
    const rows = asRecord(weeklyRes.value.json)?.metrics;
    if (Array.isArray(rows)) {
      for (const raw of rows) {
        const row = asRecord(raw);
        const id = str(row?.client_id);
        if (!id || latest.has(id)) continue;
        latest.set(id, row!);
        weekKey ??= str(row?.week_key);
      }
    }
  }

  const clients: WeeklyClient[] = roster.flatMap((raw) => {
    const c = asRecord(raw);
    const id = str(c?.id);
    const name = str(c?.name);
    if (!id || !name) return [];

    const week = latest.get(id);
    const target = num(c?.weekly_target) ?? 0;
    const intros = num(week?.intros) ?? 0;
    const emailsSent = num(week?.emails_sent);

    return [{
      id,
      name,
      plan: str(c?.plan),
      weeklyTarget: target,
      startDate: str(c?.start_date),
      status: deriveStatus({
        hidden: c?.hidden === true,
        paused: c?.client_paused === true,
        target,
        intros,
        hasData: week !== undefined,
      }),
      emailsToday: num(c?.emails_today),
      emailsSent,
      intros,
      interested: num(week?.interested_corofy),
      remaining: Math.max(0, target - intros),
      // Introductions per 1,000 emails. Null rather than 0 when nothing was
      // sent — a rate with no denominator is not zero, it is unknown.
      conversion: emailsSent && emailsSent > 0 ? (intros / emailsSent) * 1000 : null,
      lastIntroAt: str(week?.last_intro_at),
      portalActive: c?.portal_active === true,
    }];
  });

  const active = clients.filter((c) => c.status !== "churned" && c.status !== "paused");
  const introsSent = active.reduce((n, c) => n + c.intros, 0);
  const introsTarget = active.reduce((n, c) => n + c.weeklyTarget, 0);
  const emailsSent = active.reduce((n, c) => n + (c.emailsSent ?? 0), 0);

  const byPlan = { minimum: 0, production: 0, partner: 0 };
  for (const c of active) {
    if (c.plan === "minimum") byPlan.minimum++;
    else if (c.plan === "production") byPlan.production++;
    else if (c.plan === "partner") byPlan.partner++;
  }

  return {
    weekKey,
    summary: {
      clients: active.length,
      atRisk: clients.filter((c) => c.status === "at-risk").length,
      onTrack: clients.filter((c) => c.status === "on-track").length,
      done: clients.filter((c) => c.status === "done").length,
      paused: clients.filter((c) => c.status === "paused").length,
      introsSent,
      introsTarget,
      completion: introsTarget > 0 ? introsSent / introsTarget : null,
      emailsSent,
      conversion: emailsSent > 0 ? (introsSent / emailsSent) * 1000 : null,
      interested: active.reduce((n, c) => n + (c.interested ?? 0), 0),
      byPlan,
    },
    // Churned last, then by how far behind they are — the people who need
    // attention rise to the top without anyone sorting.
    clients: clients.sort((a, b) => {
      const rank = (s: ClientStatus) =>
        s === "at-risk" ? 0 : s === "on-track" ? 1 : s === "done" ? 2 : s === "pending" ? 3 : s === "paused" ? 4 : 5;
      return rank(a.status) - rank(b.status) || b.remaining - a.remaining || a.name.localeCompare(b.name);
    }),
    unavailable: null,
  };
}
