import "server-only";

import type { Connector, ToolId, ToolSnapshot } from "@/lib/connectors/types";
import { CONNECTORS } from "@/lib/connectors/registry";
import { probeConnector } from "./orchestrator";

/*
 * Module-level TTL + stale-while-revalidate + single-flight + last-good.
 *
 * Deliberately NOT Next's `use cache`. Three things this needs that the
 * framework cache does not give:
 *
 *   1. SERVE-STALE-ON-ERROR. When Analytics 500s at 09:00 the right answer is
 *      last night's numbers with a "stale" badge, not an empty card.
 *   2. SINGLE-FLIGHT. Five open tabs at 09:00:00 must produce ONE fan-out of
 *      five upstream calls, not twenty-five.
 *   3. FLAP DAMPING. One dropped packet should not repaint a card red.
 *
 * Scope is per process, and it resets on deploy — the first request after a
 * deploy pays one fan-out. With multiple Railway replicas the upstream cost is
 * N x 5 requests/minute, which is negligible.
 */

interface Entry {
  snapshot: ToolSnapshot;
  freshUntil: number;
  staleUntil: number;
  consecutiveFailures: number;
}

const entries = new Map<ToolId, Entry>();
const inflight = new Map<ToolId, Promise<ToolSnapshot>>();

/** A tool must fail twice in a row before we promote it to `down`. */
const FAILURES_BEFORE_DOWN = 2;

function commit(connector: Connector, snapshot: ToolSnapshot, now: number) {
  const previous = entries.get(connector.id);
  const failed = snapshot.state === "down";

  const consecutiveFailures = failed ? (previous?.consecutiveFailures ?? 0) + 1 : 0;

  // Flap damping: on the first failure, keep showing the last good snapshot
  // marked stale rather than flipping the card to down.
  let effective = snapshot;
  if (failed && consecutiveFailures < FAILURES_BEFORE_DOWN && previous) {
    effective = {
      ...previous.snapshot,
      stale: true,
      checkedAt: snapshot.checkedAt,
      notes: [
        ...previous.snapshot.notes,
        { level: "info", text: "A probe failed; retrying before reporting an outage" },
      ],
    };
  }

  entries.set(connector.id, {
    snapshot: effective,
    freshUntil: now + connector.policy.ttlMs,
    staleUntil: now + connector.policy.staleMs,
    consecutiveFailures,
  });

  return effective;
}

function kickoff(connector: Connector): Promise<ToolSnapshot> {
  const existing = inflight.get(connector.id);
  if (existing) return existing; // <- single-flight

  const run = probeConnector(connector)
    .then((snapshot) => commit(connector, snapshot, Date.now()))
    .catch(() => {
      // probeConnector is written not to throw, but if it ever does, serve the
      // last good snapshot rather than propagating and blanking the page.
      const previous = entries.get(connector.id);
      if (previous) return { ...previous.snapshot, stale: true };
      throw new Error(`${connector.id}: probe failed with no cached snapshot`);
    })
    .finally(() => {
      inflight.delete(connector.id);
    });

  inflight.set(connector.id, run);
  return run;
}

export async function getSnapshot(
  connector: Connector,
  opts: { force?: boolean } = {},
): Promise<ToolSnapshot> {
  const now = Date.now();
  const hit = entries.get(connector.id);

  if (!opts.force && hit && now < hit.freshUntil) return hit.snapshot;

  // Stale but usable: return immediately and refresh in the background, so the
  // reader never waits on a slow upstream.
  if (!opts.force && hit && now < hit.staleUntil) {
    void kickoff(connector).catch(() => {});
    return { ...hit.snapshot, stale: true };
  }

  return kickoff(connector);
}

export async function getAllSnapshots(
  opts: { force?: boolean } = {},
): Promise<ToolSnapshot[]> {
  const results = await Promise.allSettled(
    CONNECTORS.map((connector) => getSnapshot(connector, opts)),
  );

  return results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];

    // Last-resort placeholder so one broken connector can never blank the grid.
    const connector = CONNECTORS[index];
    return [
      {
        id: connector.id,
        name: connector.name,
        shortName: connector.shortName,
        description: connector.description,
        href: "#",
        deepLinks: [],
        state: "unknown" as const,
        reachable: false,
        latencyMs: null,
        httpStatus: null,
        metrics: [],
        notes: [{ level: "error" as const, text: "Probe could not be completed" }],
        dataAsOf: null,
        checkedAt: new Date().toISOString(),
        stale: false,
        capabilities: {
          blackBox: Boolean(connector.blackBox),
          hasMetrics: Boolean(connector.metrics),
          metricsConfigured: false,
        },
      },
    ];
  });
}
