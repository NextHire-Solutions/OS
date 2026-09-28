import "server-only";

import type { ReachResult } from "./types";

/*
 * "Is this tool reachable?" for a tool the OS runs itself.
 *
 * Once a standalone app is switched off, pinging its URL answers nothing
 * useful — the OS no longer depends on that app, it depends on the tool's
 * DATABASE. So the check is one tiny read there, timed, with the same
 * slow/down thresholds the HTTP probe uses.
 */
export async function databaseReach(
  read: () => PromiseLike<{ error: { message: string } | null }>,
  slowMs: number,
): Promise<ReachResult> {
  const started = performance.now();
  try {
    const { error } = await read();
    const latencyMs = Math.round(performance.now() - started);
    if (error) {
      return { reachable: false, httpStatus: null, latencyMs, state: "down", notes: [{ level: "error", text: `database: ${error.message}` }] };
    }
    return { reachable: true, httpStatus: null, latencyMs, state: latencyMs > slowMs ? "degraded" : "up" };
  } catch (e) {
    return {
      reachable: false, httpStatus: null, latencyMs: null, state: "down",
      notes: [{ level: "error", text: e instanceof Error ? e.message : "database unreachable" }],
    };
  }
}
