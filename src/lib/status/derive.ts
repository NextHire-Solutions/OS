import type { HealthState } from "@/lib/connectors/types";

/*
 * Precedence, worst wins:
 *   1. required env missing              -> unconfigured  (our fault; say so)
 *   2. reach says down                   -> down
 *   3. reach says unknown                -> unknown
 *   4. reach degraded OR metrics degraded-> degraded
 *   5. otherwise                         -> up
 *
 * A metrics failure NEVER produces `down`. The launcher's job is to get you
 * into the tool; a card reading "down" for an app that opens fine is how a
 * status colour stops meaning anything.
 */
export function deriveState(input: {
  configured: boolean;
  reachState: HealthState;
  metricsDegraded: boolean;
}): HealthState {
  if (!input.configured) return "unconfigured";
  if (input.reachState === "down") return "down";
  if (input.reachState === "unknown") return "unknown";
  if (input.reachState === "degraded" || input.metricsDegraded) return "degraded";
  return "up";
}

/** Worst-wins across the fleet, with `unknown`/`unconfigured` excluded from
 *  the headline — two of five tools are permanently unknown by design, and
 *  letting that suppress "All systems operational" would make the line useless. */
export function aggregate(states: HealthState[]): {
  state: HealthState;
  headline: string;
  breakdown: string;
} {
  const count = (s: HealthState) => states.filter((x) => x === s).length;

  const down = count("down");
  const degraded = count("degraded");
  const up = count("up");
  const unknown = count("unknown");
  const unconfigured = count("unconfigured");

  const parts: string[] = [];
  if (up) parts.push(`${up} operational`);
  if (degraded) parts.push(`${degraded} degraded`);
  if (down) parts.push(`${down} down`);
  if (unknown) parts.push(`${unknown} unknown`);
  if (unconfigured) parts.push(`${unconfigured} not configured`);

  const breakdown = parts.join(" · ");

  if (down) {
    return {
      state: "down",
      headline: down === 1 ? "1 tool is down" : `${down} tools are down`,
      breakdown,
    };
  }
  if (degraded) {
    return {
      state: "degraded",
      headline: degraded === 1 ? "1 tool is degraded" : `${degraded} tools are degraded`,
      breakdown,
    };
  }
  if (up) {
    return { state: "up", headline: "All systems operational", breakdown };
  }
  return { state: "unknown", headline: "Status unavailable", breakdown };
}
