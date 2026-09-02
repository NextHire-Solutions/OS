import { DEFAULT_POLICY, defineConnector } from "./types";
import { classifyReach } from "@/lib/http/classify";

/*
 * Database — the data browser. A genuine black box: no local source, no public
 * JSON route (both /api/health and /api/stats 307 to /login), no documented
 * deep links.
 *
 * So this connector does exactly one honest thing: prove the app is serving,
 * and offer a launch link. It has NO metrics probe at all, which is why
 * `capabilities.hasMetrics` is false — the UI uses that to render a truthful
 * "status not exposed" line instead of a row of em-dashes pretending to be
 * data that failed to load.
 *
 * We probe /login rather than / because / redirects there anyway; asking for
 * the destination directly saves a hop and gives a clean 200 to classify.
 */

export const databaseConnector = defineConnector({
  id: "database",
  name: "Database",
  shortName: "Database",
  description: "Browse and query the underlying records.",
  baseUrlEnv: "DATABASE_APP_URL",
  home: "/",
  blackBox: true,

  deepLinks: [
    { id: "home", label: "Browse", path: "/", verified: true, keywords: ["records", "query", "sql", "table"] },
  ],

  env: { required: ["DATABASE_APP_URL"], optional: [] },

  policy: { ...DEFAULT_POLICY },

  async reach(ctx) {
    const res = await ctx.http(`${ctx.baseUrl}/login`, {
      timeoutMs: ctx.policy.reachTimeoutMs,
    });
    return classifyReach(res, ctx.policy.slowMs);
  },

  // No metrics: nothing is exposed. Deliberately absent rather than an empty
  // implementation, so the UI can distinguish "no data available" from
  // "data fetch failed".
});
