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

/*
 * Agent Search — an Express service scraping Zillow + Courted for agent data.
 *
 * Black box: no local source, so no deep links beyond root. But it has the
 * best status endpoint in the stack — GET /api/status is public and returns
 * genuinely semantic health:
 *
 *   {"courted": true, "courtedAccounts": 8, "unblocker": "brightdata"}
 *
 * `courted: false` means the scraping session has expired, which is the actual
 * failure mode of this service — it stays up and serves 200s while quietly
 * scraping nothing. So a 200 alone is NOT health here, and this connector
 * derives `degraded` from the payload rather than the status code.
 */

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export const scraperConnector = defineConnector({
  id: "scraper",
  name: "Agent Search",
  shortName: "Scraper",
  description: "Sources agent data from Zillow and Courted.",
  baseUrlEnv: "SCRAPER_URL",
  home: "/",
  blackBox: true,

  deepLinks: [
    { id: "search", label: "Search", path: "/", verified: true, keywords: ["zillow", "courted", "scraper", "agents"] },
  ],

  env: { required: ["SCRAPER_URL"], optional: [] },

  policy: { ...DEFAULT_POLICY },

  async reach(ctx) {
    const res = await ctx.http(`${ctx.baseUrl}/api/status`, {
      timeoutMs: ctx.policy.reachTimeoutMs,
    });
    return classifyReach(res, ctx.policy.slowMs);
  },

  async metrics(ctx): Promise<MetricsResult> {
    const metrics: ToolMetric[] = [];
    const notes: Note[] = [];
    let degraded = false;

    const res = await ctx.http(`${ctx.baseUrl}/api/status`, {
      timeoutMs: ctx.policy.metricsTimeoutMs,
    });

    const body = asRecord(res.json);
    if (!res.ok || !body) {
      return {
        metrics,
        notes: [note("warn", `Status unavailable (${res.status ?? "no response"})`)],
        degraded: true,
      };
    }

    const accounts = num(body.courtedAccounts);
    const courted = body.courted === true;

    metrics.push(
      metric("courted_accounts", "Courted accounts", accounts, "compact", {
        intent: accounts === 0 ? "warn" : "neutral",
      }),
      metric(
        "unblocker",
        "Proxy",
        typeof body.unblocker === "string" ? body.unblocker : null,
        "text",
      ),
    );

    // The service serves 200s whether or not it can actually scrape, so these
    // two payload fields are the real health signal.
    if (!courted) {
      degraded = true;
      notes.push(note("warn", "Courted session invalid — scraping will fail"));
    }
    if (accounts === 0) {
      degraded = true;
      notes.push(note("warn", "No Courted accounts available"));
    }

    return { metrics, notes, degraded };
  },
});
