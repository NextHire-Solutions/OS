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
import { optionalEnv } from "@/lib/env";

/*
 * Client Health ("Shaurs") — Next 15, Supabase-backed, per-client outreach
 * health from Instantly + Master Inbox.
 *
 * Two paths, and which one runs depends on whether the read token is set:
 *
 *   /api/clients/status   x-admin-token: READ_ONLY_TOKEN. The good one —
 *                         returns {total, counts:{active,paused,churned}}
 *                         already aggregated.
 *
 *   /api/clients          public, no auth, ~200KB roster. The fallback. We
 *                         derive a count from it and say so in a note, because
 *                         a number with a caveat beats an empty card.
 *
 * This app has no URL state at all — the filter pills are pure useState — so
 * there are genuinely no deep links beyond root. `verified` exists on DeepLink
 * precisely so we don't invent `/?filter=risk` and ship a dead chip.
 */

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function loadStatus(ctx: ProbeContext) {
  const token = optionalEnv("CLIENT_HEALTH_READ_TOKEN");
  if (!token) return null;

  const res = await ctx.http(`${ctx.baseUrl}/api/clients/status`, {
    timeoutMs: ctx.policy.metricsTimeoutMs,
    headers: { "x-admin-token": token },
  });
  if (!res.ok) throw new Error(`clients/status returned ${res.status ?? "no response"}`);

  const body = asRecord(res.json);
  if (!body) throw new Error("clients/status returned a non-JSON body");
  return body;
}

async function loadRoster(ctx: ProbeContext) {
  const res = await ctx.http(`${ctx.baseUrl}/api/clients`, {
    timeoutMs: ctx.policy.metricsTimeoutMs,
  });
  if (!res.ok) throw new Error(`clients returned ${res.status ?? "no response"}`);

  const clients = asRecord(res.json)?.clients;
  if (!Array.isArray(clients)) throw new Error("clients returned an unexpected shape");
  return clients as Array<Record<string, unknown>>;
}

export const clientHealthConnector = defineConnector({
  id: "client-health",
  name: "Client Health",
  shortName: "Health",
  description: "Live client outreach health from Instantly and Master Inbox.",
  baseUrlEnv: "CLIENT_HEALTH_URL",
  home: "/",

  deepLinks: [
    { id: "dashboard", label: "Dashboard", path: "/", verified: true, keywords: ["clients", "churn", "health", "roster"] },
  ],

  env: {
    required: ["CLIENT_HEALTH_URL"],
    optional: ["CLIENT_HEALTH_READ_TOKEN"],
  },

  policy: { ...DEFAULT_POLICY },

  async reach(ctx) {
    const res = await ctx.http(`${ctx.baseUrl}/`, {
      timeoutMs: ctx.policy.reachTimeoutMs,
    });
    return classifyReach(res, ctx.policy.slowMs);
  },

  async metrics(ctx): Promise<MetricsResult> {
    const metrics: ToolMetric[] = [];
    const notes: Note[] = [];

    try {
      const status = await loadStatus(ctx);

      if (status) {
        const counts = asRecord(status.counts) ?? {};
        const churned = num(counts.churned);
        metrics.push(
          metric("total", "Clients", num(status.total), "compact"),
          metric("active", "Active", num(counts.active), "compact", { intent: "good" }),
          metric("churned", "Churned", churned, "compact", {
            intent: churned && churned > 0 ? "warn" : "neutral",
          }),
        );
        return { metrics, notes };
      }

      // No token configured — fall back to the public roster.
      const roster = await loadRoster(ctx);
      const production = roster.filter((c) => c.plan === "production").length;
      metrics.push(
        metric("total", "Clients", roster.length, "compact"),
        metric("production", "In production", production, "compact", { intent: "good" }),
      );
      notes.push(
        note(
          "info",
          "Unlocks active / paused / churned counts",
          "CLIENT_HEALTH_READ_TOKEN",
        ),
      );
      return { metrics, notes };
    } catch (error) {
      return {
        metrics,
        notes: [
          note("warn", error instanceof Error ? error.message : "Client metrics unavailable"),
        ],
        degraded: true,
      };
    }
  },
});
