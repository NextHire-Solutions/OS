import "server-only";

import {
  type Connector,
  type Note,
  type ProbeContext,
  type ResolvedDeepLink,
  type ToolSnapshot,
} from "@/lib/connectors/types";
import { httpProbe } from "@/lib/http/probe";
import { deriveState } from "./derive";
import { NotConfiguredError, UnsupportedError, baseUrlEnv, isConfigured } from "@/lib/env";

/*
 * Runs one connector's two probes and assembles a snapshot.
 *
 * Reach and metrics run CONCURRENTLY, not in sequence. They are independent
 * questions and serialising them would double the worst-case wall time on the
 * exact cards that are already slowest.
 */
export async function probeConnector(connector: Connector): Promise<ToolSnapshot> {
  const now = new Date();
  const checkedAt = now.toISOString();

  const configured = isConfigured(...connector.env.required);

  const base = {
    id: connector.id,
    name: connector.name,
    shortName: connector.shortName,
    description: connector.description,
    checkedAt,
    stale: false,
    dataAsOf: null as string | null,
  };

  if (!configured) {
    const missing = connector.env.required.filter((v) => !isConfigured(v));
    return {
      ...base,
      href: "#",
      deepLinks: [],
      state: "unconfigured",
      reachable: false,
      latencyMs: null,
      httpStatus: null,
      metrics: [],
      notes: [{ level: "error", text: `Missing ${missing.join(", ")}` }],
      capabilities: {
        blackBox: Boolean(connector.blackBox),
        hasMetrics: Boolean(connector.metrics),
        metricsConfigured: false,
      },
    };
  }

  const resolvedBase = baseUrlEnv(connector.baseUrlEnv);
  const ctx: ProbeContext = {
    baseUrl: resolvedBase,
    http: httpProbe,
    policy: connector.policy,
    now,
  };

  const deepLinks: ResolvedDeepLink[] = connector.deepLinks.map((link) => ({
    ...link,
    href: `${resolvedBase}${link.path}`,
  }));

  const [reachOutcome, metricsOutcome] = await Promise.allSettled([
    connector.reach(ctx),
    connector.metrics ? connector.metrics(ctx) : Promise.resolve(null),
  ]);

  const reach =
    reachOutcome.status === "fulfilled"
      ? reachOutcome.value
      : {
          reachable: false,
          httpStatus: null,
          latencyMs: null,
          state: "down" as const,
          notes: [
            {
              level: "error" as const,
              text:
                reachOutcome.reason instanceof Error
                  ? reachOutcome.reason.message
                  : "Probe threw",
            },
          ],
        };

  const metrics = metricsOutcome.status === "fulfilled" ? metricsOutcome.value : null;

  const notes: Note[] = [...(reach.notes ?? []), ...(metrics?.notes ?? [])];

  if (metricsOutcome.status === "rejected") {
    notes.push({
      level: "warn",
      text:
        metricsOutcome.reason instanceof Error
          ? metricsOutcome.reason.message
          : "Metrics probe threw",
    });
  }

  const metricsDegraded =
    Boolean(metrics?.degraded) || metricsOutcome.status === "rejected";

  return {
    ...base,
    href: `${resolvedBase}${connector.home}`,
    deepLinks,
    state: deriveState({
      configured: true,
      reachState: reach.state,
      metricsDegraded,
    }),
    reachable: reach.reachable,
    latencyMs: reach.latencyMs,
    httpStatus: reach.httpStatus,
    metrics: metrics?.metrics ?? [],
    notes,
    dataAsOf: metrics?.dataAsOf ?? null,
    capabilities: {
      blackBox: Boolean(connector.blackBox),
      hasMetrics: Boolean(connector.metrics),
      metricsConfigured: connector.env.optional.every((v) => isConfigured(v)),
    },
  };
}
