import type { HttpResult, ReachResult } from "@/lib/connectors/types";
import { note } from "@/lib/connectors/types";

/*
 * The one place HTTP semantics become health semantics.
 *
 * Three of the five tools sit behind an auth wall. A 401, a 403 and a 307 to
 * /login all mean the SAME thing for reachability: the process is up, the
 * proxy ran, the app is serving. Treating those as failures would paint the
 * whole dashboard red permanently, which is exactly how a status board earns
 * being ignored.
 */
export function classifyReach(result: HttpResult, slowMs: number): ReachResult {
  const base = { httpStatus: result.status, latencyMs: result.latencyMs };

  if (result.failure === "timeout") {
    return {
      ...base,
      reachable: false,
      state: "down",
      notes: [note("error", "No response within budget")],
    };
  }

  if (result.failure === "network") {
    return {
      ...base,
      reachable: false,
      state: "down",
      notes: [note("error", "Connection failed (DNS or TCP)")],
    };
  }

  const status = result.status as number;

  if (status >= 500) {
    return {
      ...base,
      reachable: false,
      state: "down",
      notes: [note("error", `Upstream returned ${status}`)],
    };
  }

  if (status === 429) {
    return {
      ...base,
      reachable: true,
      state: "degraded",
      notes: [note("warn", "Rate limited")],
    };
  }

  if (status === 404 || status === 410) {
    // Almost always OUR bug: a wrong base URL, or a route that moved.
    return {
      ...base,
      reachable: true,
      state: "unknown",
      notes: [note("warn", `Probe path returned ${status} — check the configured URL`)],
    };
  }

  const slow = result.latencyMs > slowMs;
  return {
    ...base,
    reachable: true,
    state: slow ? "degraded" : "up",
    notes: slow
      ? [note("warn", `Slow response (${result.latencyMs}ms) — possible cold start`)]
      : [],
  };
}
