import {
  DEFAULT_POLICY,
  defineConnector,
  metric,
  note,
  type MetricsResult,
  type Note,
  type ToolMetric,
} from "./types";
import { classifyReach } from "@/lib/http/classify";
import { clientStatuses } from "@/lib/tools/client-health/publish";

/*
 * Client Health ("Shaurs") — Next 15, Supabase-backed, per-client outreach
 * health from Instantly + Master Inbox.
 *
 * Reach still probes the live app's front door — that is what the status
 * board is asking about. The metrics no longer go through it: the workspace
 * holds Client Health's database now, and `clientStatuses()` answers exactly
 * what the tool's GET /api/clients/status did — {total, counts:{active,
 * paused, churned}} — without a hop to an app being switched off, and without
 * needing CLIENT_HEALTH_READ_TOKEN in this process at all.
 *
 * This app has no URL state at all — the filter pills are pure useState — so
 * there are genuinely no deep links beyond root. `verified` exists on DeepLink
 * precisely so we don't invent `/?filter=risk` and ship a dead chip.
 */

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
    optional: ["CLIENT_HEALTH_SUPABASE_URL", "CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY"],
  },

  policy: { ...DEFAULT_POLICY },

  async reach(ctx) {
    const res = await ctx.http(`${ctx.baseUrl}/`, {
      timeoutMs: ctx.policy.reachTimeoutMs,
    });
    return classifyReach(res, ctx.policy.slowMs);
  },

  async metrics(): Promise<MetricsResult> {
    const metrics: ToolMetric[] = [];
    const notes: Note[] = [];

    try {
      const status = await clientStatuses();
      const churned = status.counts.churned;
      metrics.push(
        metric("total", "Clients", status.total, "compact"),
        metric("active", "Active", status.counts.active, "compact", { intent: "good" }),
        metric("churned", "Churned", churned, "compact", {
          intent: churned > 0 ? "warn" : "neutral",
        }),
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
