import "server-only";

import { httpProbe } from "@/lib/http/probe";
import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { mintAnalyticsSession } from "@/lib/connectors/upstream-auth/analytics-session";
import type { Reading, SourceSpec } from "./types";

/*
 * Fetching one number from one tool.
 *
 * Everything here goes over the tool's ordinary HTTP API — the same endpoints
 * the status board already uses. There is no database connection anywhere in
 * this app, so reconciliation can read but never write, and cannot corrupt a
 * tool's data even by mistake.
 *
 * ---------------------------------------------------------------------------
 * "NOT EXPOSED" IS A RESULT, NOT A FAILURE
 *
 * Several numbers people argue about are computed inside a tool and never
 * published — Client Health works out weekly emails-sent and intros from its
 * own tables and offers no endpoint for either. Those readers return a reading
 * with `unavailable: "not exposed over HTTP"` rather than being quietly left
 * out.
 *
 * That matters. Showing "we cannot compare this, and here is precisely what
 * would have to be added" turns a recurring argument into a small ticket.
 * Omitting the row would leave the argument exactly where it is.
 */

const TIMEOUT = 8_000;

type Reader = (spec: SourceSpec) => Promise<{ value: number | null; unavailable?: string; window?: string }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads Analytics' KPI band, which answers several concepts at once. */
async function analyticsKpis(field: string) {
  const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
  if (!secret) return { value: null, unavailable: "ANALYTICS_AUTH_SECRET not set" };

  const email = optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com";
  const token = await mintAnalyticsSession(secret, email);

  const res = await httpProbe(`${baseUrlEnv("ANALYTICS_URL")}/api/analytics/kpis?preset=30d`, {
    timeoutMs: TIMEOUT,
    headers: { cookie: `bsa_session=${token}` },
  });

  if (res.status === 401) return { value: null, unavailable: "session rejected (secret mismatch?)" };
  if (!res.ok) return { value: null, unavailable: `returned ${res.status ?? "no response"}` };

  const current = asRecord(asRecord(res.json)?.current);
  if (!current) return { value: null, unavailable: "unexpected response shape" };

  return { value: num(current[field]), window: "last 30 days" };
}

const READERS: Record<string, Reader> = {
  // --- Client Health -------------------------------------------------------
  "clients:roster": async () => {
    const res = await httpProbe(`${baseUrlEnv("CLIENT_HEALTH_URL")}/api/clients`, {
      timeoutMs: TIMEOUT,
    });
    if (res.status === 401) return { value: null, unavailable: "401 — needs a read token now" };
    if (!res.ok) return { value: null, unavailable: `returned ${res.status ?? "no response"}` };

    const clients = asRecord(res.json)?.clients;
    if (!Array.isArray(clients)) return { value: null, unavailable: "unexpected response shape" };
    return { value: clients.length };
  },

  "clients:active": async (spec) => {
    const token = optionalEnv("CLIENT_HEALTH_READ_TOKEN");
    if (!token) return { value: null, unavailable: `${spec.requiresEnv} not set` };

    const res = await httpProbe(`${baseUrlEnv("CLIENT_HEALTH_URL")}/api/clients/status`, {
      timeoutMs: TIMEOUT,
      headers: { "x-admin-token": token },
    });
    if (!res.ok) return { value: null, unavailable: `returned ${res.status ?? "no response"}` };

    const counts = asRecord(asRecord(res.json)?.counts);
    return { value: num(counts?.active) };
  },

  // Computed from weekly_metrics inside the app and never published. Naming it
  // here is the point: this is the endpoint that would have to exist.
  "clients:emails": async () => ({
    value: null,
    unavailable: "not exposed over HTTP — Client Health computes this internally",
  }),

  "clients:intros": async () => ({
    value: null,
    unavailable: "not exposed over HTTP — Client Health computes this internally",
  }),

  // --- Analytics -----------------------------------------------------------
  "analytics:sent": () => analyticsKpis("sent"),
  "analytics:replies": () => analyticsKpis("replies"),
  "analytics:human-replies": () => analyticsKpis("humanReplies"),

  "analytics:clients": async (spec) => {
    const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
    if (!secret) return { value: null, unavailable: `${spec.requiresEnv} not set` };

    const email = optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com";
    const token = await mintAnalyticsSession(secret, email);

    const res = await httpProbe(`${baseUrlEnv("ANALYTICS_URL")}/api/clients`, {
      timeoutMs: TIMEOUT,
      headers: { cookie: `bsa_session=${token}` },
    });
    if (!res.ok) return { value: null, unavailable: `returned ${res.status ?? "no response"}` };

    const body = res.json;
    const list = Array.isArray(body) ? body : asRecord(body)?.clients;
    if (!Array.isArray(list)) return { value: null, unavailable: "unexpected response shape" };
    return { value: list.length };
  },

  // --- Master Inbox --------------------------------------------------------
  "inbox:threads": async (spec) => {
    const token = optionalEnv("MASTER_INBOX_ADMIN_TOKEN");
    if (!token) return { value: null, unavailable: `${spec.requiresEnv} not set` };

    const res = await httpProbe(`${baseUrlEnv("MASTER_INBOX_URL")}/api/admin/thread-counts`, {
      timeoutMs: TIMEOUT,
      headers: { "x-admin-token": token },
    });
    // Its handler calls requireSession(), which has no service-role path, so a
    // redirect here is the expected outcome until that route grows a token path.
    if (res.status === 307 || res.status === 302) {
      return { value: null, unavailable: "route requires a user session, not a token" };
    }
    if (!res.ok) return { value: null, unavailable: `returned ${res.status ?? "no response"}` };

    const counts = asRecord(asRecord(res.json)?.counts);
    return { value: num(counts?.open) };
  },

  /*
   * Master Inbox DOES publish this, via /api/clients/intro-stats — per-client
   * counts of threads carrying the `Introduction` label, plus last_assigned_at.
   *
   * Worth noting how it authenticates: the proxy accepts `x-admin-token` equal
   * to Master Inbox's SUPABASE_SERVICE_ROLE_KEY. That is a full RLS-bypassing
   * database credential being spent to read a list of integers. It works, and
   * it is what exists today, but a narrow read-only token on this one route
   * would shrink the blast radius considerably. Flagged, not silently accepted.
   */
  "inbox:introduction-label": async (spec) => {
    const rows = await introStats(spec);
    if ("unavailable" in rows) return rows;
    return {
      value: rows.stats.reduce((sum, r) => sum + (num(r.count) ?? 0), 0),
    };
  },

  "inbox:clients": async (spec) => {
    const rows = await introStats(spec);
    if ("unavailable" in rows) return rows;
    return { value: rows.stats.length };
  },
};

/** Shared by the two readings that come out of the same endpoint. */
async function introStats(
  spec: SourceSpec,
): Promise<{ stats: Record<string, unknown>[] } | { value: null; unavailable: string }> {
  const token = optionalEnv("MASTER_INBOX_ADMIN_TOKEN");
  if (!token) return { value: null, unavailable: `${spec.requiresEnv} not set` };

  const res = await httpProbe(`${baseUrlEnv("MASTER_INBOX_URL")}/api/clients/intro-stats`, {
    timeoutMs: TIMEOUT,
    headers: { "x-admin-token": token },
  });

  if (res.status === 307 || res.status === 302) {
    return { value: null, unavailable: "token rejected — redirected to login" };
  }
  if (!res.ok) return { value: null, unavailable: `returned ${res.status ?? "no response"}` };

  const body = asRecord(res.json);
  const stats = body?.stats;
  if (!Array.isArray(stats)) return { value: null, unavailable: "unexpected response shape" };

  return { stats: stats as Record<string, unknown>[] };
}

export async function read(spec: SourceSpec): Promise<Reading> {
  const base: Omit<Reading, "value" | "unavailable" | "window"> = {
    tool: spec.tool,
    key: spec.key,
    label: spec.label,
    definition: spec.definition,
    origin: spec.origin,
    fetchedAt: new Date().toISOString(),
  };

  const reader = READERS[`${spec.tool}:${spec.key}`];
  if (!reader) return { ...base, value: null, unavailable: "no reader implemented" };

  try {
    return { ...base, ...(await reader(spec)) };
  } catch (error) {
    // A missing base URL throws from baseUrlEnv. One misconfigured tool must
    // not take the whole report down.
    return {
      ...base,
      value: null,
      unavailable: error instanceof Error ? error.message : "read failed",
    };
  }
}
