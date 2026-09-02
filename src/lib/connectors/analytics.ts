import {
  DEFAULT_POLICY,
  defineConnector,
  metric,
  note,
  type MetricsResult,
  type Note,
  type ProbeContext,
  type ToolMetric,
} from "./types";
import { classifyReach } from "@/lib/http/classify";
import { mintAnalyticsSession } from "./upstream-auth/analytics-session";
import { NotConfiguredError, optionalEnv } from "@/lib/env";

/*
 * Campaign Analytics — Next 16, EmailBison-backed, HMAC cookie auth.
 *
 * Two independent metric sources, on purpose:
 *
 *   /api/cron/status     Authorization: Bearer CRON_SECRET. Already exists for
 *                        the Railway cron dispatcher. Returns sync health with
 *                        per-job staleness. This is the ONLY upstream in the
 *                        whole stack that tells us how fresh its own data is,
 *                        and it needs no credential forgery.
 *
 *   /api/analytics/kpis  Cookie: bsa_session=<minted>. No bearer hatch on this
 *                        route and no CORS, so we mint the cookie. See
 *                        upstream-auth/analytics-session.ts.
 *
 * Either may fail alone. Neither failure makes the tool `down` — the whole
 * point of the launcher is to get you into the tool, and a card that says
 * "down" when the app opens fine teaches people to ignore the colour.
 */

interface KpiPayload {
  current?: Record<string, number | null | undefined>;
  deltas?: Record<string, number | null | undefined>;
}

interface SyncPayload {
  healthy?: boolean;
  degraded?: string[];
  neverRun?: string[];
  dataAsOf?: string | null;
}

/** Narrow an unknown JSON body without pulling in a schema library. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function loadKpis(ctx: ProbeContext): Promise<KpiPayload> {
  const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
  if (!secret) throw new NotConfiguredError("ANALYTICS_AUTH_SECRET");

  const email = optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com";
  const token = await mintAnalyticsSession(secret, email);

  const res = await ctx.http(`${ctx.baseUrl}/api/analytics/kpis?preset=7d`, {
    timeoutMs: ctx.policy.metricsTimeoutMs,
    headers: { cookie: `bsa_session=${token}` },
  });

  if (res.status === 401) {
    throw new Error("bsa_session rejected — ANALYTICS_AUTH_SECRET mismatch?");
  }
  if (!res.ok) throw new Error(`kpis returned ${res.status ?? "no response"}`);

  const body = asRecord(res.json);
  if (!body) throw new Error("kpis returned a non-JSON body");

  return {
    current: (asRecord(body.current) ?? {}) as KpiPayload["current"],
    deltas: (asRecord(body.deltas) ?? {}) as KpiPayload["deltas"],
  };
}

async function loadSyncHealth(ctx: ProbeContext): Promise<SyncPayload> {
  const secret = optionalEnv("ANALYTICS_CRON_SECRET");
  if (!secret) throw new NotConfiguredError("ANALYTICS_CRON_SECRET");

  const res = await ctx.http(`${ctx.baseUrl}/api/cron/status`, {
    timeoutMs: ctx.policy.metricsTimeoutMs,
    headers: { authorization: `Bearer ${secret}` },
  });

  if (!res.ok) throw new Error(`cron/status returned ${res.status ?? "no response"}`);

  const body = asRecord(res.json);
  if (!body) throw new Error("cron/status returned a non-JSON body");

  return {
    healthy: typeof body.healthy === "boolean" ? body.healthy : undefined,
    degraded: Array.isArray(body.degraded) ? (body.degraded as string[]) : [],
    neverRun: Array.isArray(body.neverRun) ? (body.neverRun as string[]) : [],
    dataAsOf: typeof body.dataAsOf === "string" ? body.dataAsOf : null,
  };
}

/**
 * A metrics probe can fail for two very different reasons, and conflating them
 * makes the status colour meaningless:
 *
 *   OUR fault    — we have no credential for it. The tool is fine. Report it
 *                  as an `info` note and do NOT degrade the card.
 *   THEIR fault  — the upstream errored, timed out or changed shape. That is a
 *                  real signal and does degrade the card.
 */
function describeFailure(
  outcome: PromiseSettledResult<unknown>,
  fallback: string,
): { note: Note; degrades: boolean } {
  const error = outcome.status === "rejected" ? outcome.reason : null;

  if (error instanceof NotConfiguredError) {
    return {
      note: note("info", `${fallback} — set ${error.varName} to enable`, error.varName),
      degrades: false,
    };
  }

  return {
    note: note("warn", error instanceof Error ? `${fallback} — ${error.message}` : fallback),
    degrades: true,
  };
}

export const analyticsConnector = defineConnector({
  id: "analytics",
  name: "Campaign Analytics",
  shortName: "Analytics",
  description: "EmailBison campaign performance, attribution and copy testing.",
  baseUrlEnv: "ANALYTICS_URL",
  home: "/analytics/campaign",

  deepLinks: [
    { id: "campaign", label: "Campaign", path: "/analytics/campaign", verified: true, keywords: ["kpi", "replies", "sent"] },
    { id: "infra", label: "Infrastructure", path: "/analytics/infrastructure", verified: true, keywords: ["domains", "inboxes"] },
    { id: "attribution", label: "Attribution", path: "/analytics/attribution", verified: true, keywords: ["outcomes", "revenue"] },
    { id: "campaigns", label: "Campaigns", path: "/campaigns", verified: true },
    { id: "clients", label: "Clients", path: "/clients", verified: true },
    { id: "schedule", label: "Schedule", path: "/schedule", verified: true },
  ],

  env: {
    required: ["ANALYTICS_URL"],
    optional: ["ANALYTICS_AUTH_SECRET", "ANALYTICS_SERVICE_EMAIL", "ANALYTICS_CRON_SECRET"],
  },

  policy: {
    ...DEFAULT_POLICY,
    metricsTimeoutMs: 9_000, // the KPI route is a real Postgres aggregate
    dataStaleAfterMs: 3 * 60 * 60_000,
  },

  async reach(ctx) {
    // /login is one of exactly three paths the upstream proxy lets through
    // unauthenticated (PUBLIC_PREFIXES = /login, /api/auth, /api/cron) and it
    // renders a real React page. A 200 here proves the Next server is serving,
    // not merely that Railway's edge answered.
    const res = await ctx.http(`${ctx.baseUrl}/login`, {
      timeoutMs: ctx.policy.reachTimeoutMs,
    });
    return classifyReach(res, ctx.policy.slowMs);
  },

  async metrics(ctx): Promise<MetricsResult> {
    const metrics: ToolMetric[] = [];
    const notes: Note[] = [];
    let dataAsOf: string | null = null;
    let degraded = false;

    const [kpis, sync] = await Promise.allSettled([loadKpis(ctx), loadSyncHealth(ctx)]);

    if (kpis.status === "fulfilled") {
      const current = kpis.value.current ?? {};
      metrics.push(
        metric("sent", "Sent (7d)", num(current.sent), "compact"),
        metric("reply_rate", "Reply rate", num(current.replyRate), "percent"),
        metric("positive", "Positive", num(current.positive), "compact", { intent: "good" }),
      );
    } else {
      const failure = describeFailure(kpis, "KPIs unavailable");
      degraded = degraded || failure.degrades;
      notes.push(failure.note);
    }

    if (sync.status === "fulfilled") {
      const health = sync.value;
      dataAsOf = health.dataAsOf ?? null;

      if (health.healthy === false) {
        degraded = true;
        const jobs = [...(health.degraded ?? []), ...(health.neverRun ?? [])];
        notes.push(note("warn", `Sync degraded${jobs.length ? `: ${jobs.join(", ")}` : ""}`));
      }

      if (dataAsOf && ctx.policy.dataStaleAfterMs) {
        const age = ctx.now.getTime() - Date.parse(dataAsOf);
        if (Number.isFinite(age) && age > ctx.policy.dataStaleAfterMs) {
          degraded = true;
          notes.push(note("warn", `Data is ${Math.round(age / 3.6e6)}h old`));
        }
      }
    } else {
      // Sync health is a nice-to-have; its absence is informational, not a
      // reason to paint the card. The KPI failure above is the real signal.
      notes.push(describeFailure(sync, "Sync health unavailable").note);
    }

    return { metrics, notes, dataAsOf, degraded };
  },
});
